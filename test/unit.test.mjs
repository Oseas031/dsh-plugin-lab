import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('PARAMETERS 与 RESULT_SCHEMA 不含 DSH 禁止的联合 type 数组', () => {
  assertNoUnionTypeArrays(PARAMETERS, 'PARAMETERS');
  assertNoUnionTypeArrays(RESULT_SCHEMA, 'RESULT_SCHEMA');
  assert.ok(PARAMETERS.properties.services);
});

test('CLI: --version、--help 与缺参数报错校验', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  const vj = JSON.parse(v.stdout);
  assert.equal(vj.name, 'dsh-plugin-lab');
  assert.equal(vj.version, PKG_VERSION);

  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  assert.ok(h.stdout.includes('--service'));
  assert.ok(h.stdout.includes('--scenario'));

  const missing = spawnSync(process.execPath, [BIN, '--target', ROOT], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
});
