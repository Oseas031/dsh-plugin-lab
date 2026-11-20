import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 验收场景：REA compact gateway 的 MCP 契约。
 * 在 lab 的真实 cordis boot 子进程里跑，但不依赖 ctx —— 直接按 MCP 协议
 * 跟 gateway 子进程对话，断言「3 个元工具 + 全链路可用」。
 */
export default async ({ step, jobDir }) => {
  const gateway = join(dirname(fileURLToPath(import.meta.url)), '..', 'gateway.mjs');
  const child = spawn(process.execPath, [gateway], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stderr = [];
  child.stderr.on('data', d => stderr.push(String(d)));

  const pending = new Map();
  let seq = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); p(msg); }
  });
  const request = (method, params, ms = 300000) => new Promise((resolve, reject) => {
    const id = 'c' + (++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, ms);
    pending.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const textOf = (res) => (res?.result?.content ?? []).map(c => c.text ?? '').join('\n');

  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lab-rea-compact', version: '0' } });
    step('initialize 成功', init.result?.protocolVersion === '2025-06-18' && init.result?.serverInfo?.name === 'rea-compact', init.result?.serverInfo?.name ?? 'no result');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await request('tools/list', {});
    const tools = list.result?.tools ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(list));
    step('tools/list 只暴露 3 个元工具', tools.length === 3, 'tools=' + tools.map(t => t.name).join(','));
    step('tools/list 体积 <= 4 KB', bytes <= 4096, 'bytes=' + bytes);

    const cat0 = await request('tools/call', { name: 'rea_catalog', arguments: {} });
    const cat0Text = textOf(cat0);
    step('catalog 无参返回分组计数', /tools in \d+ groups/.test(cat0Text) && /inspect\(\d+\)/.test(cat0Text), cat0Text.slice(0, 80));

    const cat1 = await request('tools/call', { name: 'rea_catalog', arguments: { query: 'ghidra', limit: 5 } });
    const cat1Text = textOf(cat1);
    step('catalog 关键词检索生效', /match/.test(cat1Text) && cat1Text.includes('- '), cat1Text.split('\n')[0]);

    const desc = await request('tools/call', { name: 'rea_describe', arguments: { tools: ['binary_session'], schema: 'summary' } });
    const descText = textOf(desc);
    step('describe 返回 description + schema', descText.includes('Input schema') && descText.includes('"type"'), descText.slice(0, 60));

    const bad = await request('tools/call', { name: 'rea_invoke', arguments: { tool: 'no_such_tool_xyz', arguments: {} } });
    step('未知工具给候选而非静默失败', bad.result?.isError === true && /Candidates|Call rea_catalog/.test(textOf(bad)), textOf(bad).slice(0, 60));

    const inv = await request('tools/call', { name: 'rea_invoke', arguments: { tool: 'binary_session', arguments: {} } }, 400000);
    step('rea_invoke 真转发 tools/call', inv.result?.isError === false && (textOf(inv).length > 0 || !!inv.result?.structuredContent), 'isError=' + inv.result?.isError);

    const pr = await request('prompts/list', {});
    step('prompts/list 透明转发', !pr.error && Array.isArray(pr.result?.prompts) && pr.result.prompts.length > 0, 'prompts=' + (pr.result?.prompts?.length ?? 'err ' + pr.error?.message));

    const both = await Promise.all([
      request('tools/call', { name: 'rea_invoke', arguments: { tool: 'list_documents', arguments: {} } }, 300000),
      request('tools/call', { name: 'rea_invoke', arguments: { tool: 'inspect_adb_client', arguments: {} } }, 300000),
    ]);
    step('并发两次 invoke 都有响应', both.every(b => b.result && (b.result.content || b.result.structuredContent)), both.map(b => b.result?.isError).join('/'));
  } finally {
    try { child.kill(); } catch {}
    if (stderr.length) console.error('[gateway stderr] ' + stderr.join('').slice(0, 500));
  }
};
