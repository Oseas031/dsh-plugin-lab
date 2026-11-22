import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshRoot, resolveNodePath } from './resolve-dsh.js';

/**
 * dsh-plugin-lab — DSH 插件开发者的实验环境。
 * lab.run：把目标插件放进一个全新的真实 cordis Context（真实 Loader + 真实 ToolsService/SystemPrompt，
 * 与 DSH 桌面进程同一 boot 路径）里挂载，跑你的验收场景，回传逐项 PASS/FAIL 与 verdict。
 * 改完插件代码直接重跑——零 DSH 重启。目标插件用绝对路径挂载，官方 @deepseek-ai/* 服务经
 * bareModuleBaseUrl 从本机 DSH 安装解析（不声明、不分发任何私有包）。
 *
 * 0.2.0 起：子进程用异步 spawn（不再阻塞宿主事件循环），超时硬上界，超时杀整棵进程树，
 * 环境变量按白名单传递，临时目录清理失败会留痕而不是静默吞掉。
 */
export const name = 'plugin-lab';
export const inject = ['tools'];

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const STATUS_GRACE_MS = 3000;
const SERVICE_PKG_RE = /^@deepseek-ai\/dsh-[a-z0-9-]+$/;
const DEFAULT_SERVICES = new Set(['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']);

/** 从包根目录 package.json 动态读取版本号，避免启动留痕硬编码漂移。 */
export function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const PKG_VERSION = readPackageVersion();

export const PARAMETERS = {
  type: 'object',
  properties: {
    target: { type: 'string', minLength: 1, description: '待验插件：包目录（需含 lib/index.js）或入口 .js/.mjs 文件路径；不能为空' },
    config: { type: 'object', description: '传给目标插件 apply(ctx, config) 的配置（可选）' },
    scenarios: { type: 'array', items: { type: 'string' }, minItems: 1, description: '场景文件路径列表（必须是文件）；场景导出 default async ({ctx, defs, step, jobDir, targetEntry, targetConfig}) => {}' },
    services: { type: 'array', items: { type: 'string' }, description: '额外挂载的 DSH 官方基础服务包名（仅允许 @deepseek-ai/dsh-*，如 @deepseek-ai/dsh-skill）' },
    timeoutMs: { type: 'number', minimum: 1, maximum: 600000, description: '子进程超时毫秒，取值 1–600000（默认 120000；传 0 也按默认处理，不再表示无超时）' },
    keep: { type: 'boolean', description: '保留临时 job 目录供检查（默认 false）' },
    dshRoot: { type: 'string', description: 'DSH 安装根（含 node_modules/@deepseek-ai/dsh-app-boot）；默认自动发现，探测失败时用它与 nodePath 显式指定' },
    nodePath: { type: 'string', description: '跑 lab 子进程用的 node 可执行文件；默认 DSH 自带 runtime，必须存在（不再回退到 PATH 上的裸 node）' },
  },
  required: ['target', 'scenarios'],
  additionalProperties: false,
};

export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    total: { type: 'number' },
    passed: { type: 'number' },
    failed: { type: 'array', items: { type: 'string' } },
    dshVersion: { type: 'string' },
    durationMs: { type: 'number' },
    timedOut: { type: 'boolean' },
    jobDir: { type: 'string' },
    cleanupFailed: { type: 'boolean' },
    stdoutTail: { type: 'array', items: { type: 'string' } },
    stderrTail: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'total', 'passed', 'failed'],
};

/** 校验额外注入的 DSH 官方服务包名，阻断路径遍历与任意包名，并自动去重/跳过默认服务。 */
export function validateExtraServices(services) {
  if (services === undefined || services === null) return [];
  if (!Array.isArray(services)) throw new Error('lab.run: services 必须是字符串数组');
  const seen = new Set();
  const out = [];
  for (const raw of services) {
    if (typeof raw !== 'string') throw new Error('lab.run: services 项必须是字符串');
    const name = raw.trim();
    if (!SERVICE_PKG_RE.test(name)) {
      throw new Error('lab.run: 非法服务包名（仅允许 @deepseek-ai/dsh-*）: ' + String(raw));
    }
    if (DEFAULT_SERVICES.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 超时参数归一：undefined/0 → 默认；负数、非整数、超上界 → 明确报错（不让原生 RangeError 冒到模型）。 */
export function normalizeTimeout(raw) {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('lab.run: timeoutMs 必须是有限数字');
  if (raw === 0) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(raw)) throw new Error('lab.run: timeoutMs 必须是整数毫秒');
  if (raw < 0) throw new Error('lab.run: timeoutMs 不能为负（收到 ' + raw + '）');
  if (raw > MAX_TIMEOUT_MS) throw new Error('lab.run: timeoutMs 超过上界 ' + MAX_TIMEOUT_MS + '（收到 ' + raw + '）');
  return raw;
}

/** 子进程环境白名单：基础变量 + DSH_* 中不含敏感词的键 + 调用方显式注入。 */
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'LANG', 'LC_ALL', 'HOME', 'SHELL', 'TERM', 'TZ', 'SDKROOT',
];
const SENSITIVE = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i;

export function buildEnv(extra) {
  const env = {};
  for (const key of ENV_ALLOW) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DSH_')) continue;
    if (SENSITIVE.test(key)) continue;
    env[key] = value;
  }
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** 杀整棵进程树：Windows 用 taskkill /T，POSIX 用进程组（子进程 detached 起）。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  } catch { /* 进程可能已退出 */ }
}

/** 异步跑子进程；不阻塞事件循环，超时杀树，输出有上限。 */
function runChild({ nodePath, runnerPath, jobPath, jobDir, timeoutMs, env }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolvePromise({ ...payload, timedOut, stdout, stderr, truncated });
    };
    try {
      child = spawn(nodePath, [runnerPath, jobPath], {
        cwd: jobDir,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return done({ error: e });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk; else truncated = true;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk; else truncated = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const grace = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done({ code: null, signal: 'SIGKILL' });
    }, timeoutMs + STATUS_GRACE_MS);
    child.on('error', (e) => done({ error: e }));
    child.on('close', (code, signal) => done({ code, signal }));
  });
}

function tailLines(text, n, width) {
  return String(text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n).map((l) => l.slice(0, width));
}

/** 超时/崩溃时从 stdout 里回收已经跑完的步骤，避免 total=0 把结果全丢掉。 */
export function parseSteps(stdout) {
  const steps = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(PASS|FAIL) \| ([^|]*)(?:\| (.*))?$/.exec(line.trim());
    if (!m) continue;
    steps.push({ name: m[2].trim(), pass: m[1] === 'PASS', detail: (m[3] ?? '').trim() });
  }
  return steps;
}

/** 临时目录清理：退避重试；仍失败则留痕并把路径交回调用方（不再静默）。 */
async function cleanupJobDir(dir, onFail) {
  for (const delay of [0, 60, 200, 500]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return true;
    } catch { /* 子进程可能仍持有句柄，重试 */ }
  }
  onFail?.(dir);
  return false;
}

const RUNNER_PATH = fileURLToPath(new URL('../runner/child.mjs', import.meta.url));

/** 核心执行入口：供 lab.run 工具与独立 CLI 共用。 */
export async function runLab(args, opts = {}) {
  const config = opts.config ?? {};
  const log = opts.log ?? (() => {});
  const appendBootLog = opts.appendBootLog ?? (() => {});
  const startedAt = Date.now();
  if (!args || typeof args !== 'object') {
    throw new Error('lab.run: 参数必须是对象');
  }
  if (typeof args.target !== 'string' || !args.target.trim()) {
    throw new Error('lab.run: target 不能为空（给包目录或入口 .js/.mjs 路径）');
  }
  if (!Array.isArray(args.scenarios) || args.scenarios.length === 0) {
    throw new Error('lab.run: scenarios 必须是非空文件路径数组');
  }
  const timeoutMs = normalizeTimeout(args.timeoutMs);
  const extraServices = validateExtraServices(args.services ?? config.services);
  const dsh = resolveDshRoot(args.dshRoot ?? config.dshRoot);
  const nodePath = resolveNodePath(args.nodePath ?? config.nodePath, dsh.root);
  const target = resolve(args.target);
  if (!existsSync(target)) throw new Error('lab.run: 目标路径不存在: ' + target);
  let entry;
  let label;
  if (/\.[cm]?js$/i.test(target) && statSync(target).isFile()) { entry = target; label = basename(target); }
  else if (existsSync(join(target, 'lib', 'index.js'))) { entry = join(target, 'lib', 'index.js'); label = basename(target); }
  else { throw new Error('lab.run: 目标插件入口未找到（目录需含 lib/index.js，或直接给入口 .js/.mjs 文件路径）: ' + target); }
  const scenarioPaths = args.scenarios.map((s) => (isAbsolute(s) ? s : resolve(s)));
  for (const s of scenarioPaths) {
    if (!existsSync(s)) throw new Error('lab.run: 场景文件不存在: ' + s);
    if (!statSync(s).isFile()) throw new Error('lab.run: 场景必须是文件，不能是目录: ' + s);
  }

  const jobDir = mkdtempSync(join(tmpdir(), 'plugin-lab-'));
  const entryFwd = entry.split('\\').join('/');
  const ymlEntries = [
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    ...extraServices.map((pkgName, idx) => ({ id: 'svc-' + idx, name: pkgName })),
    args.config === undefined
      ? { id: 'target', name: entryFwd }
      : { id: 'target', name: entryFwd, config: args.config },
  ];
  const ymlPath = join(jobDir, 'cordis.yml');
  writeFileSync(ymlPath, JSON.stringify(ymlEntries, null, 2), 'utf8');
  const jobPath = join(jobDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify({ dshRoot: dsh.root, ymlPath, jobDir, scenarioPaths, targetEntry: entryFwd, targetConfig: args.config ?? null }), 'utf8');

  // 唯一 code-exec 点（见 SECURITY.md）：数组传参、不经 shell、异步不阻塞、限时限缓冲、不接 stdin、env 白名单。
  const run = await runChild({
    nodePath,
    runnerPath: RUNNER_PATH,
    jobPath,
    jobDir,
    timeoutMs,
    env: buildEnv(config.childEnv),
  });
  // 超时后子进程可能已写了一半，仍然尝试读 verdict
  let verdict = null;
  try { verdict = JSON.parse(readFileSync(join(jobDir, 'verdict.json'), 'utf8')); } catch {}
  if (!verdict) {
    const steps = parseSteps(run.stdout);
    const failedSteps = steps.filter((s) => !s.pass);
    const why = run.error
      ? String(run.error.message ?? run.error)
      : run.timedOut
        ? 'timeoutMs=' + timeoutMs + ' 超时，已杀进程树'
        : 'exit=' + String(run.code) + ' signal=' + String(run.signal ?? '');
    verdict = {
      pass: false,
      total: steps.length,
      passed: steps.length - failedSteps.length,
      failed: (failedSteps.length ? failedSteps.map((s) => s.name + (s.detail ? ' (' + s.detail + ')' : '')) : ['child 无 verdict（' + why + '）']),
    };
  }
  const result = {
    pass: verdict.pass,
    total: verdict.total,
    passed: verdict.passed,
    failed: verdict.failed,
    durationMs: Date.now() - startedAt,
    stdoutTail: tailLines(run.stdout, 14, 500),
    stderrTail: tailLines(run.stderr, 6, 500),
  };
  if (run.timedOut) result.timedOut = true;
  if (typeof verdict.dshVersion === 'string') result.dshVersion = verdict.dshVersion;

  if (args.keep) {
    result.jobDir = jobDir;
  } else {
    const cleaned = await cleanupJobDir(jobDir, (dir) => {
      appendBootLog({ kind: 'cleanup-failed', dir });
      log({ tool: 'lab.run', kind: 'cleanup-failed', dir });
    });
    if (!cleaned) { result.jobDir = jobDir; result.cleanupFailed = true; }
  }
  log({ tool: 'lab.run', target: label, pass: verdict.pass, passed: verdict.passed, total: verdict.total, timedOut: run.timedOut, timeoutMs });
  return result;
}

export function apply(ctx, config) {
  // cordis 在 patch 条目没写 config 时会传 null；默认参数只兜 undefined，这里显式兜住。
  config = config ?? {};
  const log = (entry) => { try { (ctx.logger?.info ?? (() => {}))('[plugin-lab] ' + JSON.stringify(entry)); } catch {} };
  const bootDir = join(homedir(), '.dsh', 'plugin-lab');
  const appendBootLog = (entry) => {
    try {
      if (!existsSync(bootDir)) mkdirSync(bootDir, { recursive: true });
      appendFileSync(join(bootDir, 'boot.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 留痕失败不拦主流程 */ }
  };
  // wired 留痕：挂载即落一行，重启验收的机器判据（research-harness 同款模式）
  appendBootLog({ kind: 'wired', tool: 'lab.run', version: PKG_VERSION });

  ctx.tools.register({
    name: 'lab.run',
    description: '插件实验环境（零重启验收）：在真实 cordis boot + 真实 ToolsService/SystemPrompt 的子进程里挂载目标插件并跑验收场景。改完插件代码直接重跑本工具即可，不用重启 DSH。返回逐项 PASS/FAIL 与总结 verdict。子进程异步执行（不阻塞 DSH），超时上限 600000ms，超时会杀掉整棵进程树。',
    parameters: PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    outputPresentationMeta: () => ({ title: 'lab.run' }),
    async execute(args) {
      return runLab(args, { config, log, appendBootLog });
    },
  });
  log({ wired: true, version: PKG_VERSION, note: 'lab.run 已注册；dshRoot/nodePath 每次调用时自动发现；子进程异步执行' });
}

export default { name, inject, apply };
