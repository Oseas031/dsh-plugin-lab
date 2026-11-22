# Changelog

本文件记录 `dsh-plugin-lab` 的版本变化。版本号本身不表示 npm 发布或远端 CI 状态；二者以各自的实际记录为准。

## [0.4.1]

### Fixed

- `resolveServiceSpecs()`：即使未在 `services` 数组中重复声明，仅通过 `serviceConfigs`（或 CLI `--service-config`）传入的 `@deepseek-ai/dsh-*` 扩展服务包也会自动加入挂载列表并应用对应配置。
- `runLab()` `dshHome` 隔离加固：拒绝将已存在的普通文件作为 `dshHome` 目录，并在创建隔离目录的同时自动创建并注入 `XDG_CONFIG_HOME`（`.config`）与 `XDG_DATA_HOME`（`.local/share`），防止读取或污染宿主 XDG 缓存/配置。
- `bin/dsh-plugin-lab.mjs` `parseJsonObject()`：读入 `--config` / `--service-config` 时剥离 UTF-8 BOM（`\uFEFF`），修复 Windows PowerShell 等工具生成的带 BOM JSON 文件解析失败问题。

## [0.4.0]

### Added

- 支持 `AbortSignal` 取消传播：`lab.run` 工具自动透传 `exec?.signal`，`runLab(args, { signal })` 与 `runChild()` 在预中止或运行中止时立刻查杀整棵子进程树并在结果与日志中返回 `aborted: true`（新增 `RESULT_SCHEMA.properties.aborted`）。
- 支持 `serviceConfigs` 与 `{ name, config }` 服务规格：新增 `validateServiceConfigs()` 与 `resolveServiceSpecs()`，允许为默认服务或额外 `@deepseek-ai/dsh-*` 服务传递 cordis 配置对象，继续阻断路径遍历与任意第三方包。
- 支持 `dshHome` 隔离：`PARAMETERS.dshHome` 与 CLI `--dsh-home <dir>` 为子进程注入独立的 `DSH_HOME`/`HOME`/`USERPROFILE`，避免实验室脚本读写宿主桌面环境目录；CLI 同步新增 `--service-config <json|file>`。
- `runner/child.mjs` 新增 `invokeBoot()` 包装层：启动失败或返回异常上下文时输出携带 `dshVersion` 与 `boot.length` 的运行时兼容性诊断。

### Changed

- `PARAMETERS.properties.services.items` 扩展为兼容字符串与 `{ name, config }` 对象的 `oneOf` Schema（严格遵守 DSH 无联合 `type` 数组约束）。

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
