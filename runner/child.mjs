// dsh-plugin-lab 子进程 runner：按 job.json 用真实 cordis boot 挂载目标插件并跑场景。
// job.json = { dshRoot, ymlPath, jobDir, scenarioPaths: [abs], targetEntry, targetConfig, killTreeOnExit? }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const jobPath = process.argv[2];
if (!jobPath) { console.error('usage: node runner/child.mjs <job.json>'); process.exit(2); }
const job = JSON.parse(readFileSync(jobPath, 'utf8'));
const dshRoot = job.dshRoot;
const appBootUrl = pathToFileURL(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href;
const bareBase = pathToFileURL(join(dshRoot, 'node_modules') + '/').href;
const { boot, getDshRuntimeVersion } = await import(appBootUrl);

const startedAt = Date.now();
let dshVersion = null;
try { dshVersion = typeof getDshRuntimeVersion === 'function' ? getDshRuntimeVersion() : null; } catch {}

const results = [];
const step = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: String(detail ?? '') }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

/**
 * 场景里可能 spawn 出孙进程（守护进程、watch 子进程等）。宿主等的是本进程，
 * 本进程退出后这些孙进程会变成孤儿留在用户机器上，所以退出前整棵进程树一起收掉。
 * 先落盘 verdict，再自杀式清理：父进程以 verdict.json 为准，不看本进程退出码。
 */
function reapDescendants() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-process.pid, 'SIGKILL');
  } catch { /* 已经没有可杀的，或权限不足；不拦退出 */ }
}

/** 调用 DSH app-boot 并附带清晰的运行时兼容诊断（dshVersion / boot.length）。 */
async function invokeBoot(bootFn, ymlPath, bareBase, ver, bootUrl) {
  if (typeof bootFn !== 'function') {
    throw new Error('dsh-plugin-lab 兼容错误: app-boot 未导出 boot 函数 (dshVersion=' + String(ver) + ', url=' + bootUrl + ')');
  }
  let ctx;
  try {
    ctx = await bootFn('plugin-lab', ymlPath, [], undefined, bareBase);
  } catch (err) {
    throw new Error(
      'dsh-plugin-lab boot() 调用失败 (dshVersion=' + String(ver) + ', boot.length=' + bootFn.length + '): '
      + String(err?.message ?? err)
    );
  }
  if (!ctx || !ctx.tools || typeof ctx.tools.definitions !== 'function') {
    throw new Error(
      'dsh-plugin-lab 兼容错误: boot() 返回异常上下文 (dshVersion=' + String(ver) + ', boot.length=' + bootFn.length + ', hasTools=' + Boolean(ctx?.tools) + ')'
    );
  }
  return ctx;
}

const ctx = await invokeBoot(boot, job.ymlPath, bareBase, dshVersion, appBootUrl);
try {
  const defs = ctx.tools.definitions(undefined);
  for (const s of job.scenarioPaths) {
    try {
      const mod = await import(pathToFileURL(s).href);
      await (mod.default ?? mod.run)({ ctx, defs, step, jobDir: job.jobDir, targetEntry: job.targetEntry, targetConfig: job.targetConfig });
    } catch (e) {
      step('场景异常 ' + s, false, String(e && e.message || e).slice(0, 300));
    }
  }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
}
const failed = results.filter(r => !r.pass);
const verdict = { pass: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.map(f => f.name + (f.detail ? ' (' + f.detail + ')' : '')), dshVersion, durationMs: Date.now() - startedAt };
writeFileSync(join(job.jobDir, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8');
console.log('===== plugin-lab: ' + verdict.passed + '/' + verdict.total + ' =====');
if (job.killTreeOnExit !== false) reapDescendants();
process.exitCode = verdict.pass ? 0 : 1;
