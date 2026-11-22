import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARKER = join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

/** 定位本机 DSH 安装根（含 node_modules/@deepseek-ai/dsh-app-boot）。 */
export function resolveDshRoot(explicit) {
  // 显式给的根必须真的含 boot 标记：静默回退会让人以为用的是他指定的那份 DSH。
  if (explicit && !existsSync(join(explicit, MARKER))) {
    throw new Error('dsh-plugin-lab: 显式指定的 dshRoot 不含 ' + MARKER + ': ' + explicit);
  }
  const tried = [];
  const push = (p, src) => { if (p) tried.push({ p, src }); };
  push(explicit, 'config');
  push(process.env.DSH_LAB_DSH_ROOT, 'env DSH_LAB_DSH_ROOT');
  if (process.env.DSH_INSTALL_DIR) {
    push(join(process.env.DSH_INSTALL_DIR, 'resources', 'app', 'dsh'), 'env DSH_INSTALL_DIR');
  }
  if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'win per-user');
  if (process.env.PROGRAMFILES) push(join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'win program-files');
  push(join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'), 'home fallback');
  if (process.platform === 'darwin') {
    push('/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh', 'mac applications');
    push(join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app', 'dsh'), 'mac user applications');
  } else if (process.platform !== 'win32') {
    push('/opt/DeepSeek Harness/resources/app/dsh', 'linux opt');
    push('/usr/lib/deepseek-harness/resources/app/dsh', 'linux usr-lib');
  }
  for (const t of tried) {
    if (existsSync(join(t.p, MARKER))) return { root: t.p, source: t.src };
  }
  throw new Error('dsh-plugin-lab: 未找到 DSH 安装根（需含 ' + MARKER + '）。试过: ' + tried.map(t => t.p).join(' ; ') + '。可用插件 config.dshRoot 或环境变量 DSH_LAB_DSH_ROOT 显式指定。');
}

/**
 * 定位跑子进程用的 node：显式 > env > DSH 自带 runtime。
 * 0.2.0 起不再回退到 PATH 上的裸 'node' —— 那样 PATH 被改就会执行别的二进制，
 * 且没法保证版本与宿主一致；找不到就报清楚错误让人显式给 nodePath。
 */
export function resolveNodePath(explicit, _dshRoot) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('dsh-plugin-lab: 显式指定的 nodePath 不存在: ' + explicit);
    return explicit;
  }
  const envNode = process.env.DSH_LAB_NODE;
  if (envNode) {
    if (!existsSync(envNode)) throw new Error('dsh-plugin-lab: DSH_LAB_NODE 指向的文件不存在: ' + envNode);
    return envNode;
  }
  const tried = [];
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes');
  if (existsSync(runtimesDir)) {
    for (const name of readdirSync(runtimesDir)) {
      for (const rel of [['dependencies', 'node', 'bin', 'node.exe'], ['dependencies', 'node', 'bin', 'node']]) {
        const p = join(runtimesDir, name, ...rel);
        tried.push(p);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('dsh-plugin-lab: 找不到可用的 node（已试: ' + (tried.length ? tried.join(' ; ') : '无 ~/.dsh/dsh-runtimes') + '）。请用 config.nodePath / 参数 nodePath / 环境变量 DSH_LAB_NODE 显式指定，或确认 DSH 自带 runtime 已安装。');
}
