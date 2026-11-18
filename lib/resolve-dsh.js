import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARKER = join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

/** 定位本机 DSH 安装根（含 node_modules/@deepseek-ai/dsh-app-boot）。 */
export function resolveDshRoot(explicit) {
  const tried = [];
  const push = (p, src) => { if (p) tried.push({ p, src }); };
  push(explicit, 'config');
  push(process.env.DSH_LAB_DSH_ROOT, 'env DSH_LAB_DSH_ROOT');
  if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'win per-user');
  if (process.env.PROGRAMFILES) push(join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'win program-files');
  push(join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'home fallback');
  for (const t of tried) {
    if (existsSync(join(t.p, MARKER))) return { root: t.p, source: t.src };
  }
  throw new Error('dsh-plugin-lab: 未找到 DSH 安装根（需含 ' + MARKER + '）。试过: ' + tried.map(t => t.p).join(' ; ') + '。可用插件 config.dshRoot 或环境变量 DSH_LAB_DSH_ROOT 显式指定。');
}

/** 定位跑子进程用的 node：显式 > env > DSH 自带 runtime > PATH。 */
export function resolveNodePath(explicit, _dshRoot) {
  if (explicit && existsSync(explicit)) return explicit;
  const envNode = process.env.DSH_LAB_NODE;
  if (envNode && existsSync(envNode)) return envNode;
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes');
  if (existsSync(runtimesDir)) {
    for (const name of readdirSync(runtimesDir)) {
      for (const rel of [['dependencies', 'node', 'bin', 'node.exe'], ['dependencies', 'node', 'bin', 'node']]) {
        const p = join(runtimesDir, name, ...rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return 'node';
}
