# dsh-plugin-lab

**DSH 插件开发者的实验环境：改完插件代码零重启验收。** 在真实 cordis boot + 真实 ToolsService/SystemPrompt
的子进程里挂载你的插件、跑你的验收场景，回传逐项 PASS/FAIL 与 verdict。与 DSH 桌面进程同一启动路径
（@deepseek-ai/dsh-app-boot 的 boot()），不是 mock。

自带最小示例：`example/fixture-plugin` + `example/scenarios/fixture.mjs`（`node selftest/run.mjs` 一键自测）。

## 发布物

每次发版把可校验的 tarball 挂在 [Releases](https://github.com/Oseas031/dsh-plugin-lab/releases)，
安装量以 release 资产下载数为准（GitHub Insights 的 clone 计数包含扫描器与镜像抓取，不代表有人安装）。

- v0.2.0 — `dsh-plugin-lab-0.2.0.tgz`（npm pack 产物；P0 加固版）
- v0.1.5 — `dsh-plugin-lab-0.1.5.tgz`（npm pack 产物）

## 安装

两种方式等价，二选一：

```bash
# 1) 从 GitHub 直装（拿到 main 的最新提交）
dsh plugin add github:Oseas031/dsh-plugin-lab

# 2) 从 npm 装（latest = 0.2.0，可钉版本）
npm i dsh-plugin-lab@0.2.0
```

npm 侧：包名 `dsh-plugin-lab`，维护者 `osea31`，`latest` 已指到 `0.2.0`。核对官方版本务必带 registry 参数——
本机 npm 若指向 `registry.npmmirror.com` 镜像，`npm view` 会显示滞后的旧版本：

```bash
npm view dsh-plugin-lab version --registry=https://registry.npmjs.org
```

装完仍需把包列入 profile 的 `dsh.profile.bundles`（见下）。

或直接装进 profile：profile package.json 加 `"dsh-plugin-lab": "file:<本包路径>"` 并列入 `dsh.profile.bundles`。
挂载后该 profile 所有会话可用 `lab.run` 工具（开发 profile 用；生产 profile 慎装——见 dsh.patch.yml）。

## 用法（会话内）

调用 `lab.run` 工具：

```json
{
  "target": "E:/x/dsh-foo",
  "config": { "anyConfig": true },
  "scenarios": ["E:/x/dsh-foo/scenarios/contract.mjs"],
  "timeoutMs": 120000,
  "keep": false
}
```

返回：`{ pass, total, passed, failed[], dshVersion?, durationMs, timedOut?, stdoutTail[], stderrTail[], jobDir?, cleanupFailed? }`。

`timedOut: true` 表示子进程超时被杀（此时 `failed` 会说明超时，`total/passed` 从 stdout 里回收已跑完的步骤，不再整份丢掉）。

## 用法（CLI，不进会话）

```bash
node runner/child.mjs job.json
# job.json = { dshRoot, ymlPath, jobDir, scenarioPaths[], targetEntry, targetConfig }
```

## 场景契约

```js
export default async ({ ctx, defs, step, jobDir, targetEntry, targetConfig }) => {
  const deny = ctx.tools.checkGuards({ name: 'your.tool', args: { ... } });   // 官方守卫链
  step('断言名', !!deny, deny?.reason);
  const def = defs.find(d => d.name === 'your.tool');                        // 官方 definitions()
  const out = await def.execute({ ... }, { name: 'your.tool' });             // 真执行
  step('真执行', out.ok === true);
};
```

## 工作原理

- 子进程 new 一个真实 cordis Context（boot()，与 DSH profile 同一启动函数）
- 目标插件按**绝对路径**挂载——改码即生效，下一次 lab.run 拿新的
- 官方 `@deepseek-ai/*` 服务经 `bareModuleBaseUrl` 从**本机 DSH 安装**解析（Loader 的官方内嵌通道）

## 安全边界

本包按设计会执行本地代码——它就是在子进程里 boot 真实 cordis 并挂载你指定的插件。唯一的
code-exec 点是 `lib/index.js` 里的那一次异步 `spawn`：argv 数组传参、`shell: false`、固定只跑
内置 `runner/child.mjs` + 刚写出的 `job.json`、超时 1–600000ms（默认 120s，0 视为默认）、4 MiB 输出缓冲、
独立 mkdtemp 工作目录、不继承 stdin、**子进程环境走白名单**（不继承宿主的 token/API key）。

超时会杀整棵进程树；正常结束时 runner 也会在写完 verdict 后回收自己 spawn 出来的孙进程，避免
孤儿进程留在机器上。临时目录清理失败会退避重试，仍失败则记进 `boot.log` 并返回 `cleanupFailed: true`。
无网络、无遥测、零 npm 依赖。静态扫描器一定会标 `child_process` 导入，那正是功能本体；
逐条约束与残余风险见 [SECURITY.md](./SECURITY.md)。

## 兼容性与许可边界

- MIT（本包代码）。**零 npm 依赖**：不声明、不分发任何 @deepseek-ai 私有包；运行时从用户自己的 DSH 安装解析。
- boot()/bareModuleBaseUrl 是 DSH 内部接口，无稳定性承诺。已实测：DSH 0.2.2-rc.3（selftest 全绿）。
  升级 DSH 后先跑 selftest；resolver 找不到 dsh-app-boot 会 fail-loud 并列出尝试过的路径。
- DSH 工具 output schema 不支持 type 数组（`['string','null']` 会被 assertSupportedJsonSchema 拒绝、
  插件激活失败）——可空字段别进 schema。

## 限制（诚实声明）

- lab 验证**插件契约层**（守卫链/工具注册/执行）；**预设组合层**（persona、工具面、技能根）
  仍需一次 DSH 重启做一次性确认。
- CI 上没有 DSH 安装时只能跑纯函数测试；lab 类测试标 `requires-DSH`（self-hosted runner 或本地跑）。

## License

MIT
