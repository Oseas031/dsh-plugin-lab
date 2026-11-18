// dsh-plugin-lab 子进程 runner：按 job.json 用真实 cordis boot 挂载目标插件并跑场景。
// job.json = { dshRoot, ymlPath, jobDir, scenarioPaths: [abs], targetEntry, targetConfig }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const ctx = await boot('plugin-lab', job.ymlPath, [], undefined, bareBase);
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
process.exitCode = verdict.pass ? 0 : 1;
