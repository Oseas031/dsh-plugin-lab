# Changelog

本文件记录 `dsh-plugin-lab` 的版本变化。版本号本身不表示 npm 发布或远端 CI 状态；二者以各自的实际记录为准。

## [0.3.0]

### Added

- 新增可选参数 `services`（`lab.run` 工具与 `runLab()`）：允许在子进程 `cordis.yml` 中额外挂载官方 DSH 服务（如 `@deepseek-ai/dsh-skill`），并强制只放行 `@deepseek-ai/dsh-[a-z0-9-]+`，阻断路径遍历与任意包名，同时自动去重并跳过默认服务。
- 新增独立 CLI 入口 `bin/dsh-plugin-lab.mjs`（`dsh-plugin-lab`），支持 `--target`、`--scenario`、`--config`、`--service`、`--timeout`、`--keep`、`--dsh-root`、`--node`、`--version`、`--help`。
- 新增离线单测套件 `test/unit.test.mjs` 与 GitHub Actions CI 工作流 `.github/workflows/ci.yml`（Node 22/24）。

### Changed

- `lib/index.js` 从 `package.json` 动态读取 `PKG_VERSION` 写入 `wired` 日志，不再硬编码版本号；抽离并导出 `runLab()` 供工具与 CLI 共用。
- `lib/resolve-dsh.js` 新增 `DSH_INSTALL_DIR`、macOS 与 Linux 默认路径探测。
- `selftest/run.mjs` 移除硬编码本机路径，改用 `resolveDshRoot()`，并补充 `services: ['@deepseek-ai/dsh-skill']` 验证轮次。

## [0.2.0]

- 异步 `spawn` 替代 `spawnSync`（消除事件循环阻塞）；`timeoutMs` 限界（1–600000ms）；超时/退出杀整棵进程树；子进程环境变量白名单；清理临时目录失败显式上报 `cleanupFailed`；超时后从 stdout 回收已完成步骤。
