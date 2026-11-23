// 一键自测：真实 cordis boot 挂载 plugin-lab 本体 → lab_run → 孙进程挂载 example/fixture-plugin → 场景。
// 便携版：通过 resolveDshRoot() 自动发现本机 DSH 安装；cordis.yml 生成于系统临时目录并在结束时清理。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { TOOL_NAME, TOOL_NAME_RE } from '../lib/index.js';
import { resolveDshRoot } from '../lib/resolve-dsh.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DSH = resolveDshRoot().root;
const { boot } = await import(pathToFileURL(join(DSH, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const bareBase = pathToFileURL(join(DSH, 'node_modules') + '/').href;
const { validateJsonSchemaValue } = await import(new URL('@deepseek-ai/dsh-tools/lib/index.js', bareBase).href);
const tmpDir = mkdtempSync(join(tmpdir(), 'plugin-lab-selftest-'));
const yml = join(tmpDir, 'cordis.yml');
writeFileSync(yml, JSON.stringify([
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'plugin-lab', name: pathToFileURL(join(ROOT, 'lib', 'index.js')).href },
], null, 2));

const ctx = await boot('plugin-lab-selftest', yml, [], undefined, bareBase);
try {
  const defs = ctx.tools.definitions(undefined);
  const labRun = defs.find(d => d.name === 'lab_run');
  const nameValid = Boolean(labRun && labRun.name === TOOL_NAME && TOOL_NAME_RE.test(labRun.name));
  console.log('lab_run registered: ' + !!labRun + ' nameValid=' + nameValid);
  if (!nameValid) {
    process.exitCode = 1;
  } else {
    const baseResult = await labRun.execute({
      target: join(ROOT, 'example', 'fixture-plugin'),
      scenarios: [join(ROOT, 'example', 'scenarios', 'fixture.mjs')],
      timeoutMs: 120000,
    }, { name: 'lab_run' });
    const schemaErrs = validateJsonSchemaValue(labRun.output.schema, baseResult);
    console.log('verdict: pass=' + baseResult.pass + ' ' + baseResult.passed + '/' + baseResult.total + ' dsh=' + String(baseResult.dshVersion) + ' ' + baseResult.durationMs + 'ms schemaErrs=' + schemaErrs.length);
    for (const l of (baseResult.stdoutTail || [])) console.log('  ' + l);
    if ((baseResult.stderrTail || []).length) console.log('stderr: ' + baseResult.stderrTail.join(' | '));
    if (schemaErrs.length) console.log('schemaErrs: ' + schemaErrs.join('; '));

    const svcResult = await labRun.execute({
      target: join(ROOT, 'example', 'fixture-plugin'),
      scenarios: [join(ROOT, 'example', 'scenarios', 'fixture.mjs')],
      services: ['@deepseek-ai/dsh-skill'],
      timeoutMs: 120000,
    }, { name: 'lab_run' });
    const svcSchemaErrs = validateJsonSchemaValue(labRun.output.schema, svcResult);
    console.log('verdict(+dsh-skill): pass=' + svcResult.pass + ' ' + svcResult.passed + '/' + svcResult.total + ' ' + svcResult.durationMs + 'ms schemaErrs=' + svcSchemaErrs.length);
    process.exitCode = baseResult.pass && svcResult.pass && schemaErrs.length === 0 && svcSchemaErrs.length === 0 ? 0 : 1;
  }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
