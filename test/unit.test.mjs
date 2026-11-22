import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PKG_VERSION,
  PARAMETERS,
  RESULT_SCHEMA,
  normalizeTimeout,
  buildEnv,
  parseSteps,
  validateExtraServices,
  validateServiceConfigs,
  resolveServiceSpecs,
  runLab,
} from '../lib/index.js';
import { resolveDshRoot, resolveNodePath } from '../lib/resolve-dsh.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'dsh-plugin-lab.mjs');

function assertNoUnionTypeArrays(schema, path = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, idx) => assertNoUnionTypeArrays(item, path + '[' + idx + ']'));
    return;
  }
  if ('type' in schema) {
    assert.ok(!Array.isArray(schema.type), path + '.type 不能是联合数组（DSH assertSupportedJsonSchema 会拒绝）');
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k !== 'type' && v && typeof v === 'object') assertNoUnionTypeArrays(v, path + '.' + k);
  }
}

test('PKG_VERSION 与 package.json 一致，且 apply() wired 日志版本号一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(PKG_VERSION, pkg.version);

  const fakeHome = mkdtempSync(join(tmpdir(), 'plab-home-'));
  try {
    const script = [
      'import { apply } from ' + JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'index.js')).href) + ';',
      'const tools = [];',
      'apply({ tools: { register(def) { tools.push(def.name); } } }, null);',
      'console.log(JSON.stringify({ tools }));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()).tools, ['lab.run']);
    const lines = readFileSync(join(fakeHome, '.dsh', 'plugin-lab', 'boot.log'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].kind, 'wired');
    assert.equal(lines[0].tool, 'lab.run');
    assert.equal(lines[0].version, pkg.version);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('normalizeTimeout 全边界校验', () => {
  assert.equal(normalizeTimeout(undefined), 120000);
  assert.equal(normalizeTimeout(null), 120000);
  assert.equal(normalizeTimeout(0), 120000);
  assert.equal(normalizeTimeout(1), 1);
  assert.equal(normalizeTimeout(600000), 600000);
  assert.throws(() => normalizeTimeout(-1), /不能为负/);
  assert.throws(() => normalizeTimeout(12.5), /整数/);
  assert.throws(() => normalizeTimeout(Number.NaN), /有限数字/);
  assert.throws(() => normalizeTimeout(Number.POSITIVE_INFINITY), /有限数字/);
  assert.throws(() => normalizeTimeout(600001), /超过上界/);
});

test('buildEnv 白名单与敏感键隔离', () => {
  const saved = {
    DSH_API_KEY: process.env.DSH_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    DSH_SECRET_TEST: process.env.DSH_SECRET_TEST,
    DSH_PROFILE: process.env.DSH_PROFILE,
  };
  try {
    process.env.DSH_API_KEY = 'secret-dsh-key';
    process.env.OPENAI_API_KEY = 'secret-openai';
    process.env.GITHUB_TOKEN = 'secret-gh';
    process.env.DSH_SECRET_TEST = 'secret-val';
    process.env.DSH_PROFILE = 'desktop';

    const env = buildEnv({ CUSTOM_LAB_FLAG: 'yes' });
    assert.equal(env.DSH_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.DSH_SECRET_TEST, undefined);
    assert.equal(env.DSH_PROFILE, 'desktop');
    assert.equal(env.CUSTOM_LAB_FLAG, 'yes');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('parseSteps 从混合 stdout 回收 PASS/FAIL 步骤', () => {
  const out = [
    '[boot] starting...',
    'PASS | P0 挂载成功 | ok',
    '随机日志输出',
    'FAIL | P1 断言失败 | expected x got y',
    '===== plugin-lab: 1/2 =====',
  ].join('\n');
  const steps = parseSteps(out);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { name: 'P0 挂载成功', pass: true, detail: 'ok' });
  assert.deepEqual(steps[1], { name: 'P1 断言失败', pass: false, detail: 'expected x got y' });
});

test('validateExtraServices 白名单、去重与拒绝路径越界/任意包', () => {
  assert.deepEqual(validateExtraServices(undefined), []);
  assert.deepEqual(validateExtraServices(null), []);
  assert.deepEqual(
    validateExtraServices([
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-agent-instructions',
    ]),
    ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-agent-instructions'],
  );
  assert.throws(() => validateExtraServices('not-array'), /字符串数组/);
  assert.throws(() => validateExtraServices([123]), /字符串/);
  assert.throws(() => validateExtraServices(['']), /非法服务包名/);
  assert.throws(() => validateExtraServices(['lodash']), /非法服务包名/);
  assert.throws(() => validateExtraServices(['@evil/dsh-skill']), /非法服务包名/);
  assert.throws(() => validateExtraServices(['@deepseek-ai/../evil']), /非法服务包名/);
  assert.throws(() => validateExtraServices(['C:/Windows/System32']), /非法服务包名/);
});

test('resolveDshRoot 与 resolveNodePath 对显式坏路径 fail-loud', () => {
  const badDir = join(tmpdir(), 'no-such-dsh-root-' + Date.now());
  assert.throws(() => resolveDshRoot(badDir), /不含.*dsh-app-boot/);
  const badNode = join(tmpdir(), 'no-such-node-bin-' + Date.now());
  assert.throws(() => resolveNodePath(badNode, badDir), /不存在/);
});

test('PARAMETERS 与 RESULT_SCHEMA 含 P1 字段且不含 DSH 禁止的联合 type 数组', () => {
  assertNoUnionTypeArrays(PARAMETERS, 'PARAMETERS');
  assertNoUnionTypeArrays(RESULT_SCHEMA, 'RESULT_SCHEMA');
  assert.ok(PARAMETERS.properties.services);
  assert.ok(Array.isArray(PARAMETERS.properties.services.items.oneOf));
  assert.ok(PARAMETERS.properties.serviceConfigs);
  assert.ok(PARAMETERS.properties.dshHome);
  assert.ok(RESULT_SCHEMA.properties.aborted);
});

test('validateServiceConfigs 与 resolveServiceSpecs 支持混合写法并拒绝非法包/非对象配置', () => {
  assert.deepEqual(validateServiceConfigs(undefined), {});
  const merged = resolveServiceSpecs(
    ['@deepseek-ai/dsh-skill', { name: '@deepseek-ai/dsh-tools', config: { strict: true } }, { name: '@deepseek-ai/dsh-skill', config: { depth: 2 } }],
    { '@deepseek-ai/dsh-skill': { depth: 1, enabled: true }, '@deepseek-ai/dsh-system-prompt': { mode: 'bench' } },
  );
  assert.deepEqual(merged.defaultConfigs, {
    '@deepseek-ai/dsh-tools': { strict: true },
    '@deepseek-ai/dsh-system-prompt': { mode: 'bench' },
  });
  assert.deepEqual(merged.extras, [
    { name: '@deepseek-ai/dsh-skill', config: { depth: 2, enabled: true } },
  ]);

  assert.throws(() => validateServiceConfigs(['bad']), /纯对象/);
  assert.throws(() => validateServiceConfigs({ evil: {} }), /非法服务包名/);
  assert.throws(() => validateServiceConfigs({ '@deepseek-ai/dsh-skill': 'bad' }), /配置对象/);
  assert.throws(() => resolveServiceSpecs([{ name: '../bad' }]), /非法服务包名/);
  assert.throws(() => resolveServiceSpecs([{ name: '@deepseek-ai/dsh-skill', config: [] }]), /配置对象/);
});

function createFakeDshFixture(rootDir, { badBoot = false } = {}) {
  const appBootDir = join(rootDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib');
  mkdirSync(appBootDir, { recursive: true });
  writeFileSync(
    join(appBootDir, 'index.js'),
    badBoot
      ? 'export function getDshRuntimeVersion() { return "0.0.0-bad"; }\nexport async function boot() { return {}; }\n'
      : [
          'import { readFileSync } from "node:fs";',
          'export function getDshRuntimeVersion() { return "0.0.0-fixture"; }',
          'export async function boot(_app, ymlPath) {',
          '  const yml = JSON.parse(readFileSync(ymlPath, "utf8"));',
          '  return { tools: { definitions: () => [], yml }, fiber: { async dispose() {} } };',
          '}',
        ].join('\n'),
    'utf8',
  );
  const pluginFile = join(rootDir, 'fake-plugin.mjs');
  writeFileSync(pluginFile, 'export function apply() {}\nexport default { apply };\n', 'utf8');
  return { dshRoot: rootDir, pluginFile };
}

test('runLab: dshHome 隔离、serviceConfigs 落入 cordis.yml 与 keep=false 自动清理', async () => {
  const work = mkdtempSync(join(tmpdir(), 'plab-p1-home-'));
  try {
    const { dshRoot, pluginFile } = createFakeDshFixture(work);
    const isoHome = join(work, 'isolated-home');
    const scenario = join(work, 'check-env.mjs');
    writeFileSync(
      scenario,
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'export default async ({ ctx, step, jobDir }) => {',
        '  const yml = JSON.parse(readFileSync(join(jobDir, "cordis.yml"), "utf8"));',
        '  const skillEntry = yml.find(e => e.name === "@deepseek-ai/dsh-skill");',
        '  const toolsEntry = yml.find(e => e.name === "@deepseek-ai/dsh-tools");',
        '  step("env DSH_HOME/HOME/USERPROFILE 全部隔离", process.env.DSH_HOME === ' + JSON.stringify(isoHome) + ' && process.env.HOME === ' + JSON.stringify(isoHome) + ' && process.env.USERPROFILE === ' + JSON.stringify(isoHome) + ', process.env.DSH_HOME);',
        '  step("serviceConfigs 写入 cordis.yml", skillEntry?.config?.skillDirs?.[0] === "/tmp/skills" && toolsEntry?.config?.strict === true && ctx.tools.yml.length === 4, JSON.stringify(yml));',
        '};',
      ].join('\n'),
      'utf8',
    );
    const res = await runLab({
      target: pluginFile,
      scenarios: [scenario],
      services: ['@deepseek-ai/dsh-skill'],
      serviceConfigs: {
        '@deepseek-ai/dsh-skill': { skillDirs: ['/tmp/skills'] },
        '@deepseek-ai/dsh-tools': { strict: true },
      },
      dshHome: isoHome,
      dshRoot,
      nodePath: process.execPath,
    });
    assert.equal(res.pass, true, JSON.stringify(res));
    assert.equal(res.passed, 2);
    assert.equal(res.dshVersion, '0.0.0-fixture');
    assert.ok(existsSync(isoHome));
    assert.equal(res.cleanupFailed, undefined);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('runLab: AbortSignal 预中止与运行中中止均可杀树并置 aborted=true', async () => {
  const work = mkdtempSync(join(tmpdir(), 'plab-p1-abort-'));
  try {
    const { dshRoot, pluginFile } = createFakeDshFixture(work);
    const fastScenario = join(work, 'fast.mjs');
    writeFileSync(fastScenario, 'export default async ({ step }) => { step("ok", true); };\n', 'utf8');

    const preController = new AbortController();
    preController.abort();
    const preRes = await runLab(
      { target: pluginFile, scenarios: [fastScenario], dshRoot, nodePath: process.execPath },
      { signal: preController.signal },
    );
    assert.equal(preRes.pass, false);
    assert.equal(preRes.aborted, true);

    const slowScenario = join(work, 'slow.mjs');
    writeFileSync(slowScenario, 'export default async () => { await new Promise(r => setTimeout(r, 15000)); };\n', 'utf8');
    const runController = new AbortController();
    setTimeout(() => runController.abort(), 250);
    const runRes = await runLab(
      { target: pluginFile, scenarios: [slowScenario], dshRoot, nodePath: process.execPath, timeoutMs: 30000 },
      { signal: runController.signal },
    );
    assert.equal(runRes.pass, false);
    assert.equal(runRes.aborted, true);
    assert.ok(runRes.failed.some(f => /AbortSignal/.test(f)), JSON.stringify(runRes));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('runner invokeBoot 对不兼容的 boot() 返回给出清晰诊断', async () => {
  const work = mkdtempSync(join(tmpdir(), 'plab-p1-badboot-'));
  try {
    const { dshRoot, pluginFile } = createFakeDshFixture(work, { badBoot: true });
    const s = join(work, 's.mjs');
    writeFileSync(s, 'export default async () => {};\n', 'utf8');
    const res = await runLab({ target: pluginFile, scenarios: [s], dshRoot, nodePath: process.execPath });
    assert.equal(res.pass, false);
    assert.ok(res.stderrTail.some(l => l.includes('dsh-plugin-lab 兼容错误') && l.includes('0.0.0-bad')), JSON.stringify(res));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('CLI: --version、--help（含新选项）与非法参数校验', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  const vj = JSON.parse(v.stdout);
  assert.equal(vj.name, 'dsh-plugin-lab');
  assert.equal(vj.version, PKG_VERSION);

  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  assert.ok(h.stdout.includes('--service-config'));
  assert.ok(h.stdout.includes('--dsh-home'));
  assert.ok(h.stdout.includes('--scenario'));

  const missing = spawnSync(process.execPath, [BIN, '--target', ROOT], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);

  const badSvcCfg = spawnSync(
    process.execPath,
    [BIN, '--target', ROOT, '--scenario', join(ROOT, 'example', 'scenarios', 'fixture.mjs'), '--service-config', '[1,2]'],
    { encoding: 'utf8' },
  );
  assert.notEqual(badSvcCfg.status, 0);
  assert.ok(badSvcCfg.stderr.includes('JSON 对象'));
});

test('v0.4.1: serviceConfigs-only 自动挂载、dshHome XDG 隔离与非目录拒绝', async () => {
  const onlyCfgSpecs = resolveServiceSpecs(undefined, {
    '@deepseek-ai/dsh-skill': { depth: 3 },
    '@deepseek-ai/dsh-tools': { strict: true },
  });
  assert.deepEqual(onlyCfgSpecs.defaultConfigs, {
    '@deepseek-ai/dsh-tools': { strict: true },
  });
  assert.deepEqual(onlyCfgSpecs.extras, [
    { name: '@deepseek-ai/dsh-skill', config: { depth: 3 } },
  ]);

  const work = mkdtempSync(join(tmpdir(), 'plab-v041-'));
  try {
    const { dshRoot, pluginFile } = createFakeDshFixture(work);
    const notADir = join(work, 'regular-file');
    writeFileSync(notADir, 'not-a-dir', 'utf8');
    await assert.rejects(
      () => runLab({ target: pluginFile, scenarios: [join(work, 'missing.mjs')], dshRoot, nodePath: process.execPath, dshHome: notADir }),
      /不是目录/,
    );

    const isoHome = join(work, 'xdg-home');
    const scenario = join(work, 'check-xdg.mjs');
    writeFileSync(
      scenario,
      [
        'import { existsSync, readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'export default async ({ step, jobDir }) => {',
        '  const yml = JSON.parse(readFileSync(join(jobDir, "cordis.yml"), "utf8"));',
        '  const hasSkill = yml.some(e => e.name === "@deepseek-ai/dsh-skill" && e.config?.depth === 4);',
        '  const expectedCfg = ' + JSON.stringify(join(isoHome, '.config')) + ';',
        '  const expectedData = ' + JSON.stringify(join(isoHome, '.local', 'share')) + ';',
        '  step("serviceConfigs-only 挂载成功", hasSkill, JSON.stringify(yml));',
        '  step("XDG_CONFIG_HOME 与 XDG_DATA_HOME 隔离并已创建", process.env.XDG_CONFIG_HOME === expectedCfg && process.env.XDG_DATA_HOME === expectedData && existsSync(expectedCfg) && existsSync(expectedData), String(process.env.XDG_CONFIG_HOME));',
        '};',
      ].join('\n'),
      'utf8',
    );
    const res = await runLab({
      target: pluginFile,
      scenarios: [scenario],
      serviceConfigs: { '@deepseek-ai/dsh-skill': { depth: 4 } },
      dshHome: isoHome,
      dshRoot,
      nodePath: process.execPath,
    });
    assert.equal(res.pass, true, JSON.stringify(res));
    assert.equal(res.passed, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('v0.4.1 CLI: --config 与 --service-config 支持 UTF-8 BOM JSON 文件', () => {
  const work = mkdtempSync(join(tmpdir(), 'plab-v041-cli-bom-'));
  try {
    const { dshRoot, pluginFile } = createFakeDshFixture(work);
    const cfgFile = join(work, 'config-bom.json');
    const svcCfgFile = join(work, 'svc-bom.json');
    writeFileSync(cfgFile, '\uFEFF' + JSON.stringify({ marker: 'bom-ok' }), 'utf8');
    writeFileSync(svcCfgFile, '\uFEFF' + JSON.stringify({ '@deepseek-ai/dsh-skill': { tag: 'bom-svc' } }), 'utf8');
    const scenario = join(work, 'check-bom.mjs');
    writeFileSync(
      scenario,
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'export default async ({ targetConfig, step, jobDir }) => {',
        '  const yml = JSON.parse(readFileSync(join(jobDir, "cordis.yml"), "utf8"));',
        '  step("BOM config 解析正确", targetConfig?.marker === "bom-ok", JSON.stringify(targetConfig));',
        '  step("BOM service-config 生效", yml.some(e => e.name === "@deepseek-ai/dsh-skill" && e.config?.tag === "bom-svc"), JSON.stringify(yml));',
        '};',
      ].join('\n'),
      'utf8',
    );
    const r = spawnSync(
      process.execPath,
      [
        BIN,
        '--target', pluginFile,
        '--scenario', scenario,
        '--config', cfgFile,
        '--service-config', svcCfgFile,
        '--dsh-root', dshRoot,
        '--node', process.execPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pass, true);
    assert.equal(out.passed, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
