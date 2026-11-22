#!/usr/bin/env node
/**
 * dsh-plugin-lab 独立 CLI：不进 DSH 会话也可直接用真实 cordis boot 验收插件。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PKG_VERSION, runLab } from '../lib/index.js';

const USAGE = `用法: dsh-plugin-lab --target <path> --scenario <file> [options]

选项:
  --target <path>         待验插件目录（含 lib/index.js）或入口 .js/.mjs 文件
  --scenario <file>       验收场景文件（可重复传入或用逗号分隔）
  --config <json|file>    传给插件 apply(ctx, config) 的 JSON 对象或 JSON 文件路径
  --service <pkg>         额外挂载的 DSH 官方服务（@deepseek-ai/dsh-*，可重复或逗号分隔）
  --timeout <ms>          子进程超时毫秒（1–600000，默认 120000）
  --keep                  保留临时 job 目录供排障
  --dsh-root <dir>        显式指定 DSH 安装根
  --node <path>           显式指定子进程 node 可执行文件路径
  -v, --version           输出版本号
  -h, --help              显示帮助`;

function parseArgs(argv) {
  const opts = { scenarios: [], services: [], keep: false };
  const takeValue = (flag, idx, inline) => {
    if (inline !== undefined) return { value: inline, nextIdx: idx };
    const next = argv[idx + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new Error('缺少参数值: ' + flag);
    }
    return { value: next, nextIdx: idx + 1 };
  };
  const splitList = (raw) => String(raw).split(',').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') { opts.help = true; continue; }
    if (raw === '-v' || raw === '--version') { opts.version = true; continue; }
    if (raw === '--keep') { opts.keep = true; continue; }
    if (!raw.startsWith('--')) throw new Error('不支持的位置参数: ' + raw);

    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const { value, nextIdx } = takeValue(flag, i, inline);
    i = nextIdx;

    switch (flag) {
      case '--target': opts.target = value; break;
      case '--scenario': opts.scenarios.push(...splitList(value)); break;
      case '--service': opts.services.push(...splitList(value)); break;
      case '--config': opts.configRaw = value; break;
      case '--timeout': opts.timeoutMs = Number(value); break;
      case '--dsh-root': opts.dshRoot = value; break;
      case '--node': opts.nodePath = value; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  return opts;
}

function parseConfig(raw) {
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  let text = trimmed;
  if (!trimmed.startsWith('{') && existsSync(resolve(trimmed)) && statSync(resolve(trimmed)).isFile()) {
    text = readFileSync(resolve(trimmed), 'utf8');
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error('--config 不是合法 JSON: ' + String(e?.message ?? e));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--config 必须是 JSON 对象');
  }
  return parsed;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (opts.version) {
    console.log(JSON.stringify({ name: 'dsh-plugin-lab', version: PKG_VERSION }));
    process.exit(0);
  }
  if (!opts.target) {
    console.error('缺少必需参数 --target\n' + USAGE);
    process.exit(2);
  }
  if (opts.scenarios.length === 0) {
    console.error('缺少必需参数 --scenario\n' + USAGE);
    process.exit(2);
  }
  const result = await runLab({
    target: opts.target,
    scenarios: opts.scenarios,
    ...(opts.configRaw !== undefined ? { config: parseConfig(opts.configRaw) } : {}),
    ...(opts.services.length > 0 ? { services: opts.services } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    keep: opts.keep,
    ...(opts.dshRoot ? { dshRoot: opts.dshRoot } : {}),
    ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
