# Security boundary

dsh-plugin-lab is a developer tool: its job is to boot a real DSH/cordis context in a child
process and mount a plugin you point at. That means it **executes local code by design**. This
file states exactly where that happens and what constrains it, so a scanner (or a reviewer) can
match each flagged call site to a documented decision.

## The only code-execution point

`lib/index.js` — one asynchronous `spawn` call (single call site, wrapped in `runChild()`):

```js
spawn(nodePath, [runnerPath, jobPath], {
  shell: false,                       // argv array, never a shell string
  windowsHide: true,
  detached: process.platform !== 'win32',  // POSIX: own process group, so the tree can be killed
  stdio: ['ignore', 'pipe', 'pipe'],  // child does not inherit stdin
  cwd: jobDir,                        // fresh mkdtemp() directory
  env: buildEnv(config.childEnv),     // allowlist, not the parent's whole environment
});
```

Constraints that hold for every call:

| Constraint | Mechanism |
|---|---|
| No shell interpolation | `shell: false`; executable and args are separate argv entries |
| Executable is a local Node binary | `resolveNodePath()` accepts an explicit path, `DSH_LAB_NODE`, or the DSH-bundled runtime — it no longer falls back to a bare `node` from PATH |
| Exactly two arguments | the bundled `runner/child.mjs` and the `job.json` this tool just wrote |
| Bounded runtime | `timeoutMs` validated to 1–600000 ms (default 120000; `0` means default, not "no timeout") |
| Bounded output | 4 MiB per stream, then truncated with a flag |
| No event-loop stall | async `spawn` + Promise; the previous `spawnSync` froze the whole DSH process for the duration of the run |
| Tree cleanup on timeout | `taskkill /PID <pid> /T /F` on Windows, `process.kill(-pgid)` on POSIX; a 3 s grace timer forces settlement |
| Tree cleanup on success | the runner runs `taskkill /T /F` on itself (POSIX: kills its own group) **after** writing `verdict.json`, so processes a scenario spawned cannot outlive the run |
| Isolated working dir | `mkdtempSync(tmpdir()/plugin-lab-)`; removed with 4 backoff attempts, and a failure is logged to `boot.log` and returned as `cleanupFailed: true` instead of being swallowed |
| No inherited stdin | `stdio: ['ignore','pipe','pipe']` |

What the child then does is the documented product behaviour: create a cordis Context through the
same `boot()` the DSH desktop uses, mount `target` (absolute path), and run the scenario files
the caller listed. `target` and `scenarios` are therefore **caller-supplied local paths** — the
trust boundary is the user invoking `lab.run`, not the package.

## Environment handling

The child no longer receives the parent's whole environment. `buildEnv()` passes:

- a fixed base list (`PATH`, `SystemRoot`, `TEMP`/`TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `HOME`, `LANG`, `TZ`, …) so Node and the DSH runtime can start normally;
- `DSH_*` variables **except** any whose name matches `TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH`;
- anything the operator explicitly sets in `config.childEnv`.

API keys, tokens and credentials held by the host process are therefore not visible to mounted
third-party plugin code.

## Input validation

- `target` must be a non-empty string that exists, and must resolve to `*.js`/`*.mjs` or a
  directory containing `lib/index.js`; an empty string is rejected instead of silently resolving
  to the caller's working directory.
- `services` (optional) only permits `@deepseek-ai/dsh-[a-z0-9-]+` package identifiers or `{ name, config }` objects with pure object configs (deduplicated and skipping default services), blocking path traversal, absolute paths, and arbitrary npm packages.
- `serviceConfigs` (optional) validates every key against `@deepseek-ai/dsh-[a-z0-9-]+` and enforces plain-object configs before writing `cordis.yml`.
- `dshHome` (optional) creates an isolated directory and overrides `DSH_HOME`, `HOME`, and `USERPROFILE` solely inside the child process environment.
- `AbortSignal` propagation (`exec.signal` in tool execution and `opts.signal` in `runLab()`) kills the child process tree cleanly and surfaces `aborted: true`.
- every `scenarios` entry must exist **and be a file** (a directory is rejected up front).
- `timeoutMs` rejects negative, non-integer and >600000 values with a message, instead of letting
  Node's native `ERR_OUT_OF_RANGE` surface to the model.
- the standalone CLI (`bin/dsh-plugin-lab.mjs`) delegates directly to the same `runLab()` path, so
  every input guard, allowlisted env, and tree cleanup rule applies identically outside DSH sessions.

## What the package does not do

- No network access, no telemetry, no update checks.
- No npm dependencies at all: `@deepseek-ai/*` services are resolved from the user's own DSH
  installation at runtime; nothing private is declared, bundled or redistributed.
- No filesystem writes outside `os.tmpdir()` and `~/.dsh/plugin-lab/` (one `boot.log` line per
  mount, plus `cleanup-failed` records).
- No credential reads, and no credential inheritance into the child (see above).

## Residual risk (honest statement)

A child process running user-specified plugin code cannot be made "safe" by the parent. If you
would not run `node <some-plugin>` yourself, do not point `lab.run` at it. The package is a
development-profile tool; the README says so and `dsh.patch.yml` is scoped accordingly.

Static analyzers will always flag the `child_process` import here — it is the feature. This file
exists so the finding maps to a stated design decision instead of an unexplained hit.
