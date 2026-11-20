# rea-compact-gateway（dsh-plugin-lab 试验件）

把 rea-agents 的 207 个 MCP 工具收成 3 个元工具，tools/list 3,158,404 B → 2,022 B（-99.94%）。
本目录是**插件形态的试验件**：先在这里用 lab.run 验契约，验过再装 profile。

## 结构

| 文件 | 作用 |
| --- | --- |
| gateway.mjs | stdio MCP 网关：rea_catalog / rea_describe / rea_invoke，其余方法透明转发 |
| scenarios/contract.mjs | lab 验收场景：走真 MCP 协议断言 10 项契约 |
| dsh.patch.yml | 安装形态：insert dsh-mcp-client 指向 gateway.mjs |
| lib/index.js | 空插件入口，只为让包能被 dsh plugin add 识别 |

## 试验（零重启）

会话里调 lab.run：

    target: E:/dsh-plugin-lab
    scenarios: ['E:/dsh-plugin-lab/example/rea-compact-gateway/scenarios/contract.mjs']
    timeoutMs: 240000

断言项：initialize / tools-list 只 3 个 / <=4 KB / catalog 分组 / catalog 检索 /
describe / 未知工具给候选 / invoke 真转发 / prompts 转发 / 并发 invoke。

## 装到 profile（验过再做）

    dsh plugin add file:E:/dsh-plugin-lab/example/rea-compact-gateway

或把 dsh.patch.yml 的两条 insert 并进 profile 的 cordis.patch.yml。重启 DSH 生效。

## 回滚

    dsh plugin remove dsh-mcp-compact-gateway

或把宿主 cordis.patch.yml 恢复为备份（全量 207 工具）。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| REA_MCP_SCRIPT | 自动探测 APPDATA/npm/node_modules/rea-agents | 真 REA 入口 |
| REA_BIN | rea | 探测不到脚本时按命令名启动 |
| REA_GATEWAY_MODE=full | 未设 | 直通模式（不做裁剪） |
| REA_GATEWAY_VERBOSE=1 | 未设 | 打子进程 stderr |
