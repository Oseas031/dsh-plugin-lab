# Security boundary

dsh-plugin-lab is a developer tool: its job is to boot a real DSH/cordis context in a child
process and mount a plugin you point at. That means it **executes local code by design**. This
file states exactly where that happens and what constrains it, so a scanner (or a reviewer) can
match each flagged call site to a documented decision.

## The only code-execution point

`lib/index.js` — one `spawnSync` call:

```js
spawnSync(nodePath, [runnerPath, jobPath], {
  shell: false,          // argv array, never a shell string
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
  timeout: args.timeoutMs ?? 120000,
  stdio: ['ignore', 'pipe', 'pipe'],  // child does not inherit stdin
  cwd: jobDir,           // fresh mkdtemp() directory
});
```

Constraints that hold for every call:

| Constraint | Mechanism |
|---|---|
| No shell interpolation | `shell: false`; executable and args are separate argv entries |
| Executable is a local Node binary | `resolveNodePath()` only accepts an existing file, else the DSH-bundled runtime, else `node` |
| Exactly two arguments | the bundled `runner/child.mjs` and the `job.json` this tool just wrote |
| Bounded runtime | `timeout` (default 120 s) + 4 MiB output buffer |
| Isolated working dir | `mkdtempSync(tmpdir()/plugin-lab-)`, removed after the run unless `keep: true` |
| No inherited stdin | `stdio: ['ignore','pipe','pipe']` |

What the child then does is the documented product behaviour: create a cordis Context through the
same `boot()` the DSH desktop uses, mount `target` (absolute path), and run the scenario files
the caller listed. `target` and `scenarios` are therefore **caller-supplied local paths** — the
trust boundary is the user invoking `lab.run`, not the package.

## What the package does not do

- No network access, no telemetry, no update checks.
- No npm dependencies at all: `@deepseek-ai/*` services are resolved from the user's own DSH
  installation at runtime; nothing private is declared, bundled or redistributed.
- No filesystem writes outside (`os.tmpdir()`) and `~/.dsh/plugin-lab/` (one `boot.log` line
  per mount, used as the machine-checkable "wired" evidence).
- No credential reads, no environment scraping beyond the resolver's `DSH_LAB_*` variables.

## Residual risk (honest statement)

A child process running user-specified plugin code cannot be made "safe" by the parent. If you
would not run `node <some-plugin>` yourself, do not point `lab.run` at it. The package is a
development-profile tool; the README says so and `dsh.patch.yml` is scoped accordingly.

Static analyzers will always flag the `child_process` import here — it is the feature. This file
exists so the finding maps to a stated design decision instead of an unexplained hit.
