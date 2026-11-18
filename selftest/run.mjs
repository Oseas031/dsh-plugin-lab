// 一键自测：真实 cordis boot 挂载 plugin-lab 本体 → lab.run → 孙进程挂载 example/fixture-plugin → 场景。
// 便携版：cordis.yml 运行时生成（含本机绝对路径，不进 git）；目标与场景路径相对本文件解析。
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DSH = process.env.DSH_LAB_DSH_ROOT || "C:/Users/ASUS/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh";
const { boot } = await import(pathToFileURL(join(DSH, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const bareBase = pathToFileURL(join(DSH, 'node_modules') + '/').href;
const yml = join(HERE, 'cordis.yml');
if (!existsSync(yml)) writeFileSync(yml, JSON.stringify([
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'plugin-lab', name: pathToFileURL(join(ROOT, 'lib', 'index.js')).href },
], null, 2));
const ctx = await boot('plugin-lab-selftest', yml, [], undefined, bareBase);
try {
  const defs = ctx.tools.definitions(undefined);
  const labRun = defs.find(d => d.name === 'lab.run');
  console.log('lab.run registered: ' + !!labRun);
  if (labRun) {
    const result = await labRun.execute({
      target: join(ROOT, 'example', 'fixture-plugin'),
      scenarios: [join(ROOT, 'example', 'scenarios', 'fixture.mjs')],
      timeoutMs: 120000,
    }, { name: 'lab.run' });
    console.log('verdict: pass=' + result.pass + ' ' + result.passed + '/' + result.total + ' dsh=' + String(result.dshVersion) + ' ' + result.durationMs + 'ms');
    for (const l of (result.stdoutTail || [])) console.log('  ' + l);
    if ((result.stderrTail || []).length) console.log('stderr: ' + result.stderrTail.join(' | '));
    process.exitCode = result.pass ? 0 : 1;
  } else { process.exitCode = 1; }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
}
