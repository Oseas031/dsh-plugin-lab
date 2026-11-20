
/**
 * REA compact MCP gateway.
 *
 * Presents a 3-tool catalog (rea_catalog / rea_describe / rea_invoke) over the
 * real rea-agents MCP server, so a client never has to pay for the ~3.1 MB
 * tools/list payload up front. The upstream server is spawned lazily and every
 * non-tool MCP method is forwarded verbatim.
 *
 * Env:
 *   REA_MCP_SCRIPT        path to rea.mjs            (default below)
 *   REA_NODE_BIN          node binary               (default process.execPath)
 *   REA_GATEWAY_MODE=full disable the shim (pass everything through)
 *   REA_GATEWAY_VERBOSE=1 log child stderr
 *   REA_GATEWAY_READY_TIMEOUT_MS
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the real REA MCP entry: explicit env, then the usual global npm roots. */
function findReaScript() {
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm', 'node_modules'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'nodejs', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
  for (const r of roots) {
    const p = join(r, 'rea-agents', 'scripts', 'rea.mjs');
    if (existsSync(p)) return p;
  }
  return null;
}
const REA_SCRIPT = process.env.REA_MCP_SCRIPT || findReaScript();
const REA_BIN = process.env.REA_BIN || 'rea';
const NODE_BIN = process.env.REA_NODE_BIN || process.execPath;
const VERBOSE = process.env.REA_GATEWAY_VERBOSE === '1';
const PASSTHROUGH = process.env.REA_GATEWAY_MODE === 'full';
const READY_TIMEOUT = Number(process.env.REA_GATEWAY_READY_TIMEOUT_MS || 300000);
const PROTOCOL = '2025-06-18';
const DEFAULT_LIMIT = 40;

const log = (...a) => { if (VERBOSE) process.stderr.write('[rea-gw] ' + a.join(' ') + '\n'); };
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let child = null;
let childRl = null;
let starting = null;
let isReady = false;
let seq = 0;
const pending = new Map();
let catalog = [];
let catalogByName = new Map();

const CLIP = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
};
const typeOf = (v) => {
  if (!v || typeof v !== 'object') return 'any';
  if (v.type) return Array.isArray(v.type) ? v.type.join('|') : v.type;
  if (v.anyOf || v.oneOf) return 'union';
  if (v.$ref) return String(v.$ref).split('/').pop();
  if (v.enum) return 'enum';
  return 'any';
};
const firstLine = (t) => CLIP((t.description || '').split('\n')[0], 160);

function signature(t) {
  const props = t?.inputSchema?.properties ?? {};
  const required = new Set(t?.inputSchema?.required ?? []);
  if (t?.inputSchema?.additionalProperties === true && Object.keys(props).length === 0) return '…(free-form)';
  const parts = Object.entries(props).slice(0, 10).map(([k, v]) => k + ':' + typeOf(v) + (required.has(k) ? '!' : ''));
  if (Object.keys(props).length > 10) parts.push('+' + (Object.keys(props).length - 10));
  return parts.join(', ');
}

function compactSchema(s, depth = 0) {
  if (!s || typeof s !== 'object' || depth > 6) return {};
  const out = {};
  for (const k of ['type', 'required', 'enum', 'minimum', 'maximum', 'format', 'default']) if (s[k] !== undefined) out[k] = s[k];
  if (s.description) out.description = CLIP(s.description, 120);
  if (s.items) out.items = compactSchema(s.items, depth + 1);
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'object') out.additionalProperties = s.additionalProperties;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = compactSchema(v, depth + 1);
  }
  if (s.anyOf) out.anyOf = s.anyOf.map(x => compactSchema(x, depth + 1));
  if (s.oneOf) out.oneOf = s.oneOf.map(x => compactSchema(x, depth + 1));
  return out;
}

/* ---------------- upstream child ---------------- */

function attachChild(c) {
  child = c;
  c.on('exit', (code, sig) => {
    log('child exit', code, sig);
    if (child === c) { child = null; isReady = false; starting = null; }
    for (const [id, p] of pending) { pending.delete(id); p({ error: { code: -32000, message: 'REA server exited (' + code + ')' } }); }
  });
  c.on('error', (e) => log('child error', e?.message));
  c.stderr.on('data', (d) => { if (VERBOSE) process.stderr.write('[rea] ' + d); });
  childRl = createInterface({ input: c.stdout });
  childRl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); p(msg); return;
    }
    if (msg.method === 'notifications/tools/list_changed') { isReady = false; }
    send(msg); // server-initiated notifications/requests reach the client as-is
  });
}

function request(method, params, timeoutMs = READY_TIMEOUT) {
  if (!child) return Promise.reject(new Error('REA server is not running'));
  const id = 'gw-' + (++seq);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
  });
}

async function refreshCatalog() {
  const all = [];
  let cursor;
  for (let page = 0; page < 30; page++) {
    const res = await request('tools/list', cursor ? { cursor } : {}, 300000);
    if (res.error) throw new Error('tools/list: ' + (res.error.message || JSON.stringify(res.error)));
    all.push(...(res.result?.tools ?? []));
    cursor = res.result?.nextCursor;
    if (!cursor) break;
  }
  catalog = all;
  catalogByName = new Map(all.map(t => [t.name, t]));
  log('catalog', catalog.length, 'tools');
}

async function ensureReady() {
  if (isReady && child) return;
  if (starting) return starting;
  starting = (async () => {
    const c = REA_SCRIPT
      ? spawn(NODE_BIN, [REA_SCRIPT, 'mcp'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(REA_BIN, ['mcp'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: true });
    attachChild(c);
    const init = await request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'rea-compact-gateway', version: '1.0.0' },
    });
    if (init.error) throw new Error('REA initialize: ' + (init.error.message || JSON.stringify(init.error)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await refreshCatalog();
    isReady = true;
  })();
  try { await starting; } catch (e) { starting = null; isReady = false; throw e; }
  starting = null;
}

/* ---------------- meta tools ---------------- */

const META_TOOLS = [
  {
    name: 'rea_catalog',
    description: 'List REA tools compactly: name(required!:type, optional:type) — one-line purpose. Use it before rea_invoke instead of guessing tool names. With no query it returns group counts; filter with query and/or group, then page with offset/limit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring(s) matched against tool name and description; space-separated terms AND together.' },
        group: { type: 'string', description: 'Restrict to one group, the tool name prefix before the first underscore (e.g. inspect, analyze, trace, compare, capture, list, get, open, read, search).' },
        limit: { type: 'integer', minimum: 1, maximum: 120, description: 'Max rows returned (default 40).' },
        offset: { type: 'integer', minimum: 0, description: 'Pagination offset (default 0).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rea_describe',
    description: 'Return the full description and input schema for 1-8 REA tools by exact name. schema:"summary" (default) trims annotations; "full" returns the upstream JSON Schema verbatim for complex tools.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'Exact tool names from rea_catalog.' },
        schema: { type: 'string', enum: ['summary', 'full'], description: 'Schema detail level (default summary).' },
      },
      required: ['tools'],
      additionalProperties: false,
    },
  },
  {
    name: 'rea_invoke',
    description: 'Call one REA tool by exact name with its arguments object. Returns the tool result unchanged (content, structuredContent, isError).',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact REA tool name, e.g. inspect_native_instruction.' },
        arguments: { type: 'object', description: 'Arguments object matching the tool schema; omit or {} when the tool takes none.', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function groupsOf(tools) {
  const m = new Map();
  for (const t of tools) {
    const g = t.name.split('_')[0];
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function callCatalog(args) {
  await ensureReady();
  const query = String(args?.query ?? '').trim().toLowerCase();
  const group = String(args?.group ?? '').trim().toLowerCase().replace(/\*$/, '');
  const limit = Math.min(120, Math.max(1, Number(args?.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(args?.offset ?? 0) || 0);

  let rows = catalog;
  if (group) rows = rows.filter(t => t.name.split('_')[0].toLowerCase() === group);
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    rows = rows.filter(t => {
      const hay = (t.name + ' ' + (t.description ?? '')).toLowerCase();
      return terms.every(term => hay.includes(term));
    });
  }

  if (!query && !group) {
    const gs = groupsOf(catalog).map(([g, n]) => g + '(' + n + ')').join(', ');
    return textResult(
      'REA ' + (catalog.length) + ' tools in ' + groupsOf(catalog).length + ' groups:\n' + gs +
      '\n\nCall rea_catalog with {query} or {group} to list rows, then rea_invoke {tool, arguments}.' +
      '\nGroups group by the name prefix before the first underscore.'
    );
  }

  const page = rows.slice(offset, offset + limit);
  const head = 'REA ' + catalog.length + ' tools — ' + rows.length + ' match' + (rows.length === 1 ? '' : 'es') +
    (query ? ' for "' + query + '"' : '') + (group ? (query ? '' : ' in group "' + group + '"') : '') +
    ' — showing ' + (page.length ? offset + 1 : 0) + '-' + (offset + page.length) + ' of ' + rows.length + '.';
  const body = page.map(t => '- ' + t.name + '(' + signature(t) + ')' + (firstLine(t) ? ' — ' + firstLine(t) : '')).join('\n');
  const tail = offset + page.length < rows.length ? '\n\nmore: rea_catalog {query:"' + (query || '') + '", group:"' + (group || '') + '", offset:' + (offset + page.length) + '}' : '';
  return textResult(head + '\n\n' + body + tail);
}

async function callDescribe(args) {
  await ensureReady();
  const names = Array.isArray(args?.tools) ? args.tools.filter(x => typeof x === 'string') : [];
  const mode = args?.schema === 'full' ? 'full' : 'summary';
  const chunks = [];
  for (const name of names.slice(0, 8)) {
    const t = catalogByName.get(name);
    if (!t) {
      const near = catalog.filter(x => x.name.includes(name) || name.includes(x.name)).slice(0, 6).map(x => x.name);
      chunks.push('### ' + name + '\nUnknown tool. ' + (near.length ? 'Did you mean: ' + near.join(', ') : 'Call rea_catalog first.'));
      continue;
    }
    const schema = mode === 'full' ? JSON.stringify(t.inputSchema ?? {}, null, 1) : JSON.stringify(compactSchema(t.inputSchema ?? {}));
    chunks.push('### ' + t.name + '\n' + CLIP(t.description ?? '(no description)', 2000) + '\n\nInput schema (' + mode + '):\n' + schema);
  }
  if (!chunks.length) return textResult('Pass tools: ["exact_name", ...]', true);
  return textResult(chunks.join('\n\n'));
}

async function callInvoke(args) {
  await ensureReady();
  const name = String(args?.tool ?? '').trim();
  if (!name) return textResult('Pass tool: "exact_name".', true);
  let a = args?.arguments ?? {};
  if (typeof a === 'string') {
    try { a = a.trim() ? JSON.parse(a) : {}; } catch { return textResult('arguments must be a JSON object.', true); }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return textResult('arguments must be an object.', true);

  if (name.startsWith('rea_')) {
    return textResult('rea_invoke cannot call the meta tools; use them directly.', true);
  }
  if (!catalogByName.has(name)) {
    const near = catalog.filter(x => x.name.includes(name.split('_').pop())).slice(0, 6).map(x => x.name);
    return textResult('Unknown REA tool "' + name + '". ' + (near.length ? 'Candidates: ' + near.join(', ') : 'Call rea_catalog first.'), true);
  }
  const res = await request('tools/call', { name, arguments: a }, 900000);
  if (res.error) return textResult('REA error: ' + (res.error.message || JSON.stringify(res.error)), true);
  const r = res.result ?? {};
  return { content: r.content ?? [], structuredContent: r.structuredContent, isError: r.isError === true };
}

/* ---------------- dispatch ---------------- */

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion && ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: { listChanged: false }, prompts: {} },
      serverInfo: { name: 'rea-compact', version: '1.0.0', title: 'REA (compact catalog gateway)' },
      instructions: 'REA reverse-engineering server behind a compact gateway: discover with rea_catalog, inspect with rea_describe, run with rea_invoke. If any skill or instruction says to call mcp__rea__<name> (or lists an mcp__rea__* tool that is not in the catalog), call rea_invoke with tool:"<name>" and the same arguments. REA targets are local artifacts unless a tool says otherwise.',
    });
  }
  if (method.startsWith('notifications/')) {
    if (child) child.stdin.write(JSON.stringify(msg) + '\n');
    return;
  }
  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') {
    if (PASSTHROUGH) { const r = await request('tools/list', params ?? {}); return r.error ? fail(id, -32603, r.error.message) : ok(id, r.result); }
    return ok(id, { tools: META_TOOLS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    try {
      if (PASSTHROUGH) { const r = await request('tools/call', params); return r.error ? fail(id, -32603, r.error.message) : ok(id, r.result); }
      let result;
      if (name === 'rea_catalog') result = await callCatalog(params?.arguments ?? {});
      else if (name === 'rea_describe') result = await callDescribe(params?.arguments ?? {});
      else if (name === 'rea_invoke') result = await callInvoke(params?.arguments ?? {});
      else { const r = await request('tools/call', params); return r.error ? fail(id, -32603, r.error.message) : ok(id, r.result); }
      return ok(id, result);
    } catch (e) {
      return ok(id, textResult('Gateway error: ' + (e?.message ?? String(e)), true));
    }
  }

  // Everything else (prompts, resources, completions, ...) is forwarded verbatim.
  try {
    await ensureReady();
    const r = await request(method, params ?? {});
    if (r.error) return fail(id, r.error.code ?? -32603, r.error.message ?? 'upstream error');
    if (!isRequest) return;
    return ok(id, r.result);
  } catch (e) {
    if (isRequest) return fail(id, -32603, e?.message ?? String(e));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg.id !== undefined) fail(msg.id, -32603, e?.message ?? String(e));
  });
});
rl.on('close', () => { try { child?.kill(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { child?.kill(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { child?.kill(); } catch {} process.exit(0); });
