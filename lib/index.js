import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshRoot, resolveNodePath } from './resolve-dsh.js';

/**
 * dsh-plugin-lab — DSH 插件开发者的实验环境。
 * lab.run：把目标插件放进一个全新的真实 cordis Context（真实 Loader + 真实 ToolsService/SystemPrompt，
 * 与 DSH 桌面进程同一 boot 路径）里挂载，跑你的验收场景，回传逐项 PASS/FAIL 与 verdict。
 * 改完插件代码直接重跑——零 DSH 重启。目标插件用绝对路径挂载，官方 @deepseek-ai/* 服务经
 * bareModuleBaseUrl 从本机 DSH 安装解析（不声明、不分发任何私有包）。
 */
export const name = 'plugin-lab';
export const inject = ['tools'];

const PARAMETERS = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '待验插件：包目录（需含 lib/index.js）或入口 .js 文件路径' },
    config: { type: 'object', description: '传给目标插件 apply(ctx, config) 的配置（可选）' },
    scenarios: { type: 'array', items: { type: 'string' }, minItems: 1, description: '场景文件路径列表；场景导出 default async ({ctx, defs, step, jobDir, targetEntry, targetConfig}) => {}' },
    timeoutMs: { type: 'number', description: '子进程超时毫秒（默认 120000）' },
    keep: { type: 'boolean', description: '保留临时 job 目录供检查（默认 false）' },
    dshRoot: { type: 'string', description: 'DSH 安装根（含 node_modules/@deepseek-ai/dsh-app-boot）；默认自动发现，探测失败时用它与 nodePath 显式指定' },
    nodePath: { type: 'string', description: '跑 lab 子进程用的 node 可执行文件；默认 DSH 自带 runtime 或 PATH 上的 node' },
  },
  required: ['target', 'scenarios'],
  additionalProperties: false,
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    total: { type: 'number' },
    passed: { type: 'number' },
    failed: { type: 'array', items: { type: 'string' } },
    dshVersion: { type: 'string' },
    durationMs: { type: 'number' },
    jobDir: { type: 'string' },
  },
  required: ['pass', 'total', 'passed', 'failed'],
};

export function apply(ctx, config) {
  // cordis 在 patch 条目没写 config 时会传 null；默认参数只兜 undefined，这里显式兜住。
  config = config ?? {};
  const runnerPath = fileURLToPath(new URL('../runner/child.mjs', import.meta.url));
  const log = (entry) => { try { (ctx.logger?.info ?? (() => {}))('[plugin-lab] ' + JSON.stringify(entry)); } catch {} };
  // wired 留痕：挂载即落一行，重启验收的机器判据（research-harness 同款模式）
  try {
    const bootDir = join(homedir(), '.dsh', 'plugin-lab');
    if (!existsSync(bootDir)) mkdirSync(bootDir, { recursive: true });
    appendFileSync(join(bootDir, 'boot.log'), JSON.stringify({ ts: new Date().toISOString(), kind: 'wired', tool: 'lab.run' }) + '\n', 'utf8');
  } catch { /* 留痕失败不拦挂载 */ }

  ctx.tools.register({
    name: 'lab.run',
    description: '插件实验环境（零重启验收）：在真实 cordis boot + 真实 ToolsService/SystemPrompt 的子进程里挂载目标插件并跑验收场景。改完插件代码直接重跑本工具即可，不用重启 DSH。返回逐项 PASS/FAIL 与总结 verdict。',
    parameters: PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const startedAt = Date.now();
      const dsh = resolveDshRoot(args.dshRoot ?? config.dshRoot);
      const nodePath = resolveNodePath(args.nodePath ?? config.nodePath, dsh.root);
      const target = resolve(args.target);
      let entry, label;
      if (/\.(m?js)$/.test(target) && existsSync(target)) { entry = target; label = basename(target); }
      else if (existsSync(join(target, 'lib', 'index.js'))) { entry = join(target, 'lib', 'index.js'); label = basename(target); }
      else { throw new Error('lab.run: 目标插件入口未找到（目录需含 lib/index.js，或直接给入口文件路径）: ' + target); }
      const scenarioPaths = args.scenarios.map(s => (isAbsolute(s) ? s : resolve(s)));
      for (const s of scenarioPaths) if (!existsSync(s)) throw new Error('lab.run: 场景文件不存在: ' + s);

      const jobDir = mkdtempSync(join(tmpdir(), 'plugin-lab-'));
      const entryFwd = entry.split('\\').join('/');
      const ymlEntries = [
        { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
        { id: 'tools', name: '@deepseek-ai/dsh-tools' },
        args.config === undefined
          ? { id: 'target', name: entryFwd }
          : { id: 'target', name: entryFwd, config: args.config },
      ];
      const ymlPath = join(jobDir, 'cordis.yml');
      writeFileSync(ymlPath, JSON.stringify(ymlEntries, null, 2), 'utf8');
      const jobPath = join(jobDir, 'job.json');
      writeFileSync(jobPath, JSON.stringify({ dshRoot: dsh.root, ymlPath, jobDir, scenarioPaths, targetEntry: entryFwd, targetConfig: args.config ?? null }), 'utf8');

      // 唯一 code-exec 点（见 SECURITY.md）：数组传参、不经 shell、限时限缓冲、不接 stdin。
      const r = spawnSync(nodePath, [runnerPath, jobPath], {
        encoding: 'utf8',
        timeout: args.timeoutMs ?? 120000,
        cwd: jobDir,
        shell: false,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutTail = String(r.stdout ?? '').slice(-4000);
      const stderrTail = String(r.stderr ?? '').slice(-1000);
      let verdict = null;
      try { verdict = JSON.parse(readFileSync(join(jobDir, 'verdict.json'), 'utf8')); } catch {}
      if (!verdict) {
        verdict = { pass: false, total: 0, passed: 0, failed: ['child 无 verdict（' + (r.error ? String(r.error.message ?? r.error) : 'exit=' + r.status + ' timeout=' + String(r.signal ?? '')) + '）'] };
      }
      const result = {
        pass: verdict.pass,
        total: verdict.total,
        passed: verdict.passed,
        failed: verdict.failed,
        durationMs: Date.now() - startedAt,
        stdoutTail: stdoutTail.split('\n').filter(Boolean).slice(-14),
        stderrTail: stderrTail.split('\n').filter(Boolean).slice(-6),
      };
      if (typeof verdict.dshVersion === 'string') result.dshVersion = verdict.dshVersion;
      if (!args.keep) { try { rmSync(jobDir, { recursive: true, force: true }); } catch {} }
      else { result.jobDir = jobDir; }
      log({ tool: 'lab.run', target: label, pass: verdict.pass, passed: verdict.passed, total: verdict.total });
      return result;
    },
  });
  log({ wired: true, note: 'lab.run 已注册；dshRoot/nodePath 每次调用时自动发现' });
}

export default { name, inject, apply };
