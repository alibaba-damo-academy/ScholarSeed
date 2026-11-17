<a id="开发启动与代码评审入口"></a>
# Development, Startup, and Code Review Entry Point

Use this page to prepare Worktree development, choose a startup path, or deliver a review. Detailed build mechanisms are maintained by the
[build Owner](build.md); version, payload, and signing parameters are not duplicated here.
Command descriptions do not authorize installation, startup, merging, release, or changes to user configuration; execute according to the current task's authorization.

For toolchain, language-mode, and directory-permission issues during Windows development startup, see
[Windows issues and solutions](windows.md); that page distinguishes environment recovery, existing code prerequisites, and the scope of real acceptance.

<a id="ci-模式-临时隔离与质量结论"></a>
<a id="ci-模式临时隔离与质量结论"></a>
## CI Modes, Temporary Quarantine, and Quality Conclusions

`pnpm ops ci test --profile quality` atomically overwrites the current run's summary at `tmp/ci-test/quality.json` by default; use `--result <path>`
to specify another location. Raw logs and stage reports remain in separate `tmp/ci-test-*/` directories,
which can be retrieved through the summary's `runDirectory`; overwriting the summary does not change evidence files from earlier runs.

[`ci:test` execution Owner](../../scripts/ci/test.cjs) defaults to `offline` and enables the exact quarantine list in
[`quarantine.json`](../../scripts/ci/quarantine.json); `--strict`
disables temporary quarantine but remains offline, and only `--with-external` selects `full`. A command name or zero exit code
alone cannot prove full product acceptance; first check the validation scope in the report for the same commit and platform.

The final `quality.json` contains `profile`, `quarantine`, `quarantinePolicy`,
`validationScope`, `skips`, the stage plan, and source/report integrity. Passing with temporary quarantine only means
the result passed within the `deterministic_with_declared_quarantine` scope; items not run from the list are
not fixed. The list's review date is a prompt to reassess, not an automatic runtime expiration or expansion of authorization.
Do not mirror specific case counts in long-lived documentation; the list is authoritative for exact identities, reasons, and review dates.

During UI transitions, with authorization, register volatile page-level E2E cases individually as `ui_transition_temporary_defer`,
while retaining Electron startup, reload, restart-after-exit, CSP, and native protocol checks; do not modify the original page assertions or timeouts.
The default offline command accepts these named quarantines; `--strict` does not enable quarantine. Do not call a default pass full page acceptance.

Stage progress logs contain ISO 8601 UTC timestamps (`Z`); the completion line adds stage duration in the form `duration=600.012s`,
from the same source as the report's `durationMs`. Serial and `CI_PARALLEL=1` paths use the same
format; skipped or blocked stages are not assigned fabricated execution durations. Child-process output is still written after the stage ends, so timestamps
do not mean that live in-stage output or heartbeats were added; consult `python-run-all.json` for individual suite durations.

[`verdict.cjs`](../../scripts/ci/verdict.cjs) rejects empty plans, missing stages, duplicate/missing results,
command failures, timeouts, missing reports, nonzero retries, platform/commit mismatches, and failed source/report integrity checks.
Quarantine skips are accepted only in offline mode when explicitly enabled and the identity/reason match exactly; external-dependency skips have a separate named contract in
[`external-cases.json`](../../scripts/ci/external-cases.json) and must not be conflated with
arbitrary failure exemptions. Do not expand the list or delete original tests to present failures as fully green.

For a focused check, use `node --test scripts/ci/__tests__/verdict.test.cjs`; it verifies the verdict function and does not run
full CI, a real model, Desktop, or an installer. A full run must be separately accepted according to current authorization, environment prerequisites, and the affected
Owner; old pass counts, screenshots, and commits from historical proposals are not proof of the current run.

<a id="验证分层与-ci-编排器"></a>
## Validation Layers and CI Orchestrator

Automated verification has two entry points with different responsibilities; they are not interchangeable:

- **`.gitlab-ci.yml` (MR gate)** runs discrete jobs: `fmt-check`, `lint`, `python:typecheck`,
  `desktop-unit-test` (`pnpm ops ci test --scope desktop --coverage`), `desktop-e2e-smoke` (`playwright --project=smoke`),
  `ci-package-macos`. These jobs expand globs in the shell, each has its own timeout, and **they do not go through the ci:test orchestrator**.
- **[`ci:test` orchestrator](../../scripts/ci/test.cjs) (`pnpm ops ci test --profile quality`)** is a multi-stage aggregate gate,
  carries the profile/quarantine/strict and quality.json evidence contracts from the previous section; local developers run it directly,
  and [`ci:package`](../../scripts/cd/package.cjs) requires `pnpm ops ci test --profile quality --with-external` (full) to pass before packaging,
  then validates quality.json before continuing. The orchestrator's offline/quarantine/parallel logic applies only to the `ci:test` path
  and does not change the behavior of discrete gitlab jobs.

The orchestrator's `desktop-pdfe` explicitly selects the migrated, required native PDFE regression in both platform plans, independently
checking the declared heading, report, and exit status without depending on a product model or temporary quarantine. The native package job consumes the same stage through the existing
full call chain; this does not mean an additional standalone MR job was added or that a remote pipeline has run.
It is not included in the fixed packaging smoke; the migration scope for other legacy UI checks remains owned by the test implementation plan.

The four-layer verification governance is organized by **when verification occurs** (not by runner project), arranging the entry points above into a chain with increasing feedback latency:

| Layer | Timing | Entry point | Key constraints |
|---|---|---|---|
| L1 Fastest | Immediate feedback during the editing loop (target <30s) | `node scripts/ci/affected.cjs [files...]`: git diff→focused test command, rules driven by [`affected.policy.json`](../../scripts/ci/affected.policy.json) (adjacent same-name tests / reverse lookup of consumer imports / Python suite import graph / static scan of IPC handle↔invoke); Python focus uses `run_all.py --only-suite` | If mapping fails, fall back to `pnpm ops ci test --profile quality` (offline); L1 accelerates feedback but is not an admission gate |
| L2 Fast | Before local commit + MR merge gate | Discrete gitlab jobs + local `pnpm ops ci test --profile quality` (offline+quarantine fast path) | **Merging into trunk/release requires `pnpm ops ci test --profile quality --strict`** (offline, without skipping quarantine), to prevent unhealthy tests from entering the release line through the fast path |
| L3 Full | Release version | `ci:package` → internal `ci:test --with-external` (full) → packaging → SHA verification → installed E2E | The full profile **must not use `--fast`**; release-level evidence semantics remain unchanged |
| L4 Main path | Core post-release path (target ≤30min) | `--say/--drive/--mode-check` harness | Requires an initialized home (first launch/login/onboarding/project/model profile ready); a fresh home fails fast. Channel checklist review is a release-runbook coordination item, not automation in this repository |

<a id="编排器性能决策记录"></a>
### Orchestrator Performance Decision Record

- **Stage-level parallel scheduling**: Current choice: explicitly enable `scheduleStages` topological scheduling with `CI_PARALLEL=1`, running independent dependency
  branches (Python chain / Desktop chain) concurrently and dividing the `cpus-1` core budget proportionally by weight into `CI_STAGE_QUOTA` to prevent core contention;
  the default remains serial, preserving historical behavior. Rationale: the two independent chains previously never overlapped, wasting wall-clock time when run serially. Rejected option: default full-core concurrency
  (measurements under two concurrent sessions showed desktop-unit concurrency increasing from 4→10 made runtime worse, 481s→600s; full-core concurrency yields positive gains only on an exclusively used machine).
  Required constraint: the per-stage `durationMs` contract in quality.json remains unchanged (runStage/schedule have the same shape, locked by unit tests);
  duration conclusions may cite only quality.json pairs from the same commit and profile on an exclusively used machine, not a reduced scope or estimates.
  Reassessment condition: if gitlab MR discrete jobs switch to the orchestrator, remeasure parallel gains and the core budget.
- **CPU-aware concurrency wiring**: `ciStageQuota(budget, fallback)` parameterizes desktop `--test-concurrency`
  and run_all `--jobs`; defaults are desktop 4 / run-all 8 (historical values), and parallel scheduling expands them explicitly through quotas without changing defaults.
- **Internal host checks**: Links, recording tools, and host cases for development Skills are maintained separately in the documentation source repository; public quality plans do not depend on the internal host.
  The internal host still requires evidence of actual invocation; passing links does not replace semantic acceptance. This does not waive public source documentation,
  component reuse, product Skills, or real product gates. Adding CI configuration does not prove a remote run has executed.
- **Product contract collection**: Offline PDF/source contracts for highlights are collected from the complete source directory through the existing pytest runner and continue after Python preparation in the existing contract gate; they do not depend on the default runtime pack, call a real model, or enter packaging smoke.
  The seven Trace modules retain their original Owner commands, while pytest in the same directory discovers real contracts; the default quality chain does not run the CLI twice.
  Real Trace source comparisons run only with explicit `--integration`; missing data fails, and user sources are not read automatically in the deterministic set.
- **Explicit collection and cleanup for desktop-unit**: `desktopCoverageArgs` expands globs from the same bounded list into actual files,
  avoiding a different collection scope from passing them directly to spawn; do not use `--test-force-exit`.
  The [render fixture](../../apps/desktop/src/test-helpers/render.ts) actually closes the browser, page context,
  and Vite server; cleanup failures remain failures. Handles left open after a test ends are investigated as leaks, not force-closed as a fallback to get green.

<a id="已知缺口以-qualityjson-与缺陷跟踪为准不在此镜像具体数量"></a>
### Known Gaps (quality.json and defect tracking are authoritative; specific counts are not mirrored here)

- desktop-unit was locally observed on macOS to hang until the stage timeout; the root cause is that `squirrelstartup.test.ts` copies `/bin/sleep`
  as a fake ShipIt and then spawns it. On this macOS/arm64 machine, the copy enters an uninterruptible kernel state (`kill -9` cannot reap it),
  holding the runner until the timeout fallback. The Owner's focused fix direction is to have the probe spawn `/bin/sleep` directly or use a minimal stub; do not copy the binary.
  Reassess once the fix brings desktop-unit `durationMs` back down to a few minutes, so the actual gain from concurrency wiring can be observed.
- The performance and hang conclusions above come from BEFORE/AFTER quality.json pairs on an exclusively used machine, not estimates; the hang currently caps the benefit of parallel scheduling.

<a id="先定工作区和权限"></a>
## Establish the Workspace and Authorization First

From the target Worktree root, check the branch, tracked/untracked files, staging area, other work, and differences from the remote.
Run `git fetch origin` before making changes. The root `AGENTS.md` defines the current default development branch and Code MR target;
use the target explicitly specified by the user. Do not reset or recreate an existing task branch. First protect work in a dirty tree;
do not merge directly or use revert, hard reset, clean, or force-push to remove problems.

<a id="分支与-code-mr-交付"></a>
### Branches and Code MR Delivery

Use the current task's explicit source and target branches. Start task branches with `feature/`;
preview and release branches use `preview/<x.y.z>` and `release/<x.y.z>`. Native Git worktrees
are supported without a document-parent checkout or matching documentation revision.

Fetch the target before integration; preserve all unrelated edits and resolve conflicts forward.
Never force-push, revert a merge, delete dirty worktrees, or overwrite another task's index.
Review the final diff and actual verification results before committing explicit paths and pushing
the authorized internal or public remote. Creating a PR does not authorize merging or publishing.

A PR description records the problem, supported root cause, changed behavior, affected consumers,
actual commands/results, remaining gaps and related issues when applicable. Reuse an existing PR
for the same repository/source/target. Verify identity and authority, read back ambiguous writes,
and read back the final source/target/status. A missing tool or failed authentication is a blocker
for that platform action, not permission to bypass it. Internal platform integrations are optional
supplements and are not prerequisites for public development, tests, builds or review.

<a id="工具链与支持入口"></a>
## Toolchain and Support Entry Points

Take the Node and default pnpm versions from `.node-version` and the root/Desktop package declarations; npm/Yarn are allowed as compatible alternatives when actually invoked; take uv requirements from the root pyproject.
Do not copy personal nvm paths or pinned versions into operation guides, and do not install global tools to bypass checks. If the declared version is missing, install it using the authorization procedure below; do not lower the version check.
By default, use the repository-declared `pnpm@12.14.0`; when another package manager is genuinely required, you may run `npm ci` or `yarn install` in the target directory. Invoke routine development/build commands from the repository root:

```bash
pnpm ops dev
pnpm ops cd build local --stage app
pnpm ops cd build release --stage dir --candidate
```

<a id="worktree-初始化与-pnpm-前提"></a>
### Worktree Initialization and pnpm Prerequisites

For quick debugging across multiple Worktrees, use [isolated hot-reload debugging](#隔离热更新调试) below; do not rebuild/preview for every UI change.

New Worktrees use pnpm for frontend dependencies by default. Run `pnpm install --frozen-lockfile` from the repository root;
the root `postinstall` checks and installs Desktop dependencies through `scripts/pre/toolchain.cjs ensure`,
also using Desktop's `pnpm-lock.yaml` and `--frozen-lockfile`.
Subsequent `pnpm ops dev` / `pnpm ops cd build local --stage app` calls reuse this entry point. Changes to the lockfile, Desktop pnpm configuration, dependency declarations,
Node version, or package-manager version invalidate the installation marker. Explicit use of npm/Yarn still follows the compatibility branch
and does not automatically switch to pnpm because of the repository default.

Electron installation for the native macOS architecture is managed by `apps/desktop/scripts/pre/electron.cjs`: it first verifies the official
ZIP's SHA-256, then caches the unmodified, complete runtime and clones it with APFS CoW into each Worktree's standard
`node_modules/electron/dist`. The cache is under `electron-distributions/` within the artifact root resolved from
`SCHOLARSEED_ARTIFACT_CACHE`, isolated by version, platform, architecture, archive digest, and cache schema. Before reuse, it verifies the complete manifest of
files, permissions, and relative symlinks. Concurrent initialization is serialized; a corrupt cache fails explicitly and is not automatically deleted and rebuilt.
On lock timeout, first inspect the process corresponding to `owner.json`; do not delete a lock that still has a user.
Each Worktree retains its own directory and development identity. Windows, explicit Electron path/architecture/platform overrides, and forced
downloads still use the original installer. If the filesystem does not support cloning, it warns explicitly and falls back to the original independent installation; space savings are not guaranteed.
New Worktree dependency installation uses this path automatically; existing installations are retained by default and are not migrated in bulk. If an individual migration is necessary,
first stop Electron for the target Worktree, then run the following from the repository root:
`node apps/desktop/scripts/pre/electron.cjs --refresh [目标 Electron 包目录]` (the target Electron package directory). The command refuses a runtime that is still in use and
preserves an existing `Info.plist` for the same version; do not migrate in parallel while another task is starting that instance. The cache is not a product
distribution directory, is not a target for modifying signing inputs, and is not automatically reclaimed. Validation only on a macOS/APFS host does not prove
Windows machine acceptance.

The setup script for the local Codex environment is in `.codex/environments/environment.toml`;
maintain the generated configuration through the host's Settings → Local environments. This file may be ignored by the local Git exclude,
so do not assume it has been synchronized to other machines or existing Worktrees. The repository's shared configuration is the
[pnpm environment](../../.codex/environments/pnpm.toml); select this environment in the host before use. It contains no personal
nvm path, credentials, or `.env` linking steps, and does not overwrite existing personal environment configuration. The macOS setup retains the existing environment and credential
preparation steps: first check the toolchain with `node scripts/pre/toolchain.cjs check`, then change the root install command to `pnpm install --frozen-lockfile` and Python setup to
`pnpm ops pre install python`. On Windows, use the same commands in the host's corresponding platform script; do not copy
macOS nvm PATH, shell syntax, or `.env` linking steps.

Before installation, read-only check `node --version`, `pnpm --version`, the actual executable paths, and
the root/Desktop `toolchain.defaultPackageManager`. If pnpm is missing or its version does not match, stop dependency installation.
Explain to the user the required version, current path/version, npm registry in use, global installation target, and PATH
impact; the AI may perform the following installation only after receiving explicit approval for this task. Previous authorization, documentation, or initialization
scripts do not constitute installation authorization. Do not automatically modify the registry, credentials, shell configuration, or use `sudo`.

macOS (after confirming the current Node/npm environment and registry):

```bash
manager=$(node -p "require('./package.json').toolchain.defaultPackageManager")
npm install --global "$manager"
pnpm --version
command -v pnpm
```

Windows PowerShell (after confirming the current Node/npm environment and registry):

```powershell
$manager = node -p "require('./package.json').toolchain.defaultPackageManager"
npm install --global $manager
pnpm --version
Get-Command pnpm
```

Approval must cover the exact declared version and installation environment. Report failures or cases requiring elevated privileges, switching Node, or overwriting other
tools before proceeding; do not expand the scope on your own. If existing pnpm/pnpx is a Corepack link, prefer to preserve
the link. With user approval, install and set the default version in the shell above using `corepack install --global "$manager"`
(in PowerShell, use `$manager`), then check `pnpm --version`.
If npm reports `EEXIST`, do not use `--force` or delete the link. If the original approval covered only npm installation,
also obtain explicit approval before switching to Corepack. Do not run `corepack enable` and overwrite another package manager.
If Corepack itself cannot start, calls itself recursively, or its source cannot be verified, stop immediately; do not bypass this with internal modules or
forced overwrites. Explain the error and affected path, and obtain separate approval for the exact scope of repairing/backing up the link.
After success, resolve the actual path again and verify the declared version before continuing with
`pnpm install --frozen-lockfile`. With approval, you may also run a temporary exact version from the npm registry
(`npm exec --yes --package="$manager" -- pnpm ...`); this still downloads/caches
the tool, is not a read-only check exempt from approval, and does not replace pnpm already on PATH.

pnpm reuses dependency files through a shared content-addressed store on the same disk, while retaining each Worktree's independent
`node_modules` and Electron identity; do not symlink the entire directory to another Worktree.
Use pnpm's default store instead of setting up a private store in each Worktree; check the actual location with `pnpm store path`.
Electron downloads, Python, and build artifacts may still each consume disk space.
Existing npm installations and caches are not migrated or deleted automatically. Before switching an existing Worktree, stop its development process
and obtain explicit authorization for the migration scope; do not automatically clean other Worktrees, user data, or shared caches to save space.

Approval for Desktop install scripts is defined by `allowBuilds` in `apps/desktop/pnpm-workspace.yaml`,
and permits only exact dependency versions that have been reviewed. Unknown scripts continue to fail by default; do not bypass this with
`dangerouslyAllowAllBuilds` or by disabling `strictDepBuilds`. Review scripts again when dependencies are upgraded.

The root `scripts/shared/desktop.cjs` forwards Desktop scripts and runs installation if Electron dependencies are missing.
Desktop's predev/prebuild/packaging entry points prepare the repository Python environment and check the toolchain; this may access the network or write
runtime assets, so do not run them without authorization just to verify documentation during a read-only audit.
For complete dependency, installer, platform, and credential contracts, consult the build Owner directly; do not use a global launcher or manually started Serve
as a substitute for this Worktree's startup chain.

Before installing, switching, or starting the toolchain, check [bundled artifacts](build.md#内置制品) and
[Python distribution dependency sources](build.md#python-发行依赖来源): development and packaging use
the same reviewed Python/SQLite archive. Before changing the selected venv's base interpreter, first stop processes using it;
do not switch the base in the middle of a session. Runtime updates must update and verify the manifest together with all affected platform archives;
a version check on one machine does not replace the corresponding macOS/Windows build and product acceptance.

The target interpreter and venv path are selected by the [Python Owner](../../scripts/shared/python.cjs); `VENV` changes only
the environment location and does not prove the source is correct. `check:python` checks the actual Python/SQLite, platform/architecture, and
real base path; Desktop development also checks before starting Serve, including when `SCHOLARSEED_PYTHON` is explicit.
The explicit external-interpreter option `PYTHON` may be used for non-Desktop libraries/CI, but cannot be presented as evidence for the bundled runtime.
Locate console scripts installed by the target Python using its `sysconfig.get_path("scripts")`; do not guess that they are
next to the interpreter. For platform naming and startup constraints, read
[cross-platform implementation notes](build.md#跨平台实现注意事项); do not hand-assemble another entry point.

The standard requires Desktop and the root `serve` to use reviewed artifacts from the [Codex manifest](../../scripts/vendor/codex/manifest.json);
neither the host `PATH` nor external `SCHOLARSEED_CODEX_EXECUTABLE` may replace them.
The current successful resolution branch uses reviewed artifacts. However, root `serve`'s `workspace.cjs:121` does not yet check
the resolver's status/error: empty stdout injects an empty `SCHOLARSEED_CODEX_EXECUTABLE`, and the Adapter path `environment.py:89` → `provider.py:349` → `executable.py:54`
readiness probe and `process.py:194` startup fall back to the host PATH; the failure path is not yet fail-closed.
Verify the source before operating. If the source is unknown or resolution fails, stop the relevant startup/acceptance; do not bypass this with a global CLI,
and do not treat `/api/healthz` or Codex ready as provenance evidence. Fixing the implementation requires separate authorization from the relevant Owner.
For resolution details, read this page's [Built-in Codex Artifact Resolution and Cache Troubleshooting](#内置-codex-制品解析与缓存排障).
`doctor` reports actual versions, paths, and provenance, but it runs tool/interpreter probes; Codex resolution may also
restore artifacts, access the network, and write caches. It is not a read-only documentation check and its name does not automatically authorize running it.

The real `--say` route used by `health` is documented by the [workspace Owner](../../scripts/shared/workspace.cjs); this entry point does not call
the `config(false)` initialization step. Before running it, satisfy the [Home and harness initialization prerequisites](#初始化-home-与-harness-前提) below,
and verify the actual Home, an available model connection, and authorization to call the model. It starts/builds Desktop and may consume tokens;
do not interpret it using the old root command table's “bare LLM health-check” description, and do not reset configuration just to probe.
The user-facing installation/startup entry point is `pnpm ops`; the actual Owner still owns the policies:
`pnpm ops pre install python` syncs the development Python environment through `scripts/shared/python.cjs`; Skill prebundling uses a separate product Skill Owner.
The old symlink Git hooks auto-install entry point and its retirement-notice script have been removed; this does not mean the Husky hook in root `prepare` has also been retired.
Existing shared hooks are not cleaned automatically. Back them up before migration, manually remove only the verified `# scholarseed-symlink-fix`
project block, preserve third-party content and `core.hooksPath`, and do not let tests modify developer configuration.
Do not treat historical command summaries as descriptions of current side effects.

Before preparing Desktop startup or choosing a session-acceptance command, read this section, the following
[Home and harness initialization prerequisites](#初始化-home-与-harness-前提), and the startup-consistency,
model-authentication, and mode-selection contracts in the [Desktop Debugging Engineering Specification](development.md). The following describes parameter behavior verified from source; it is not the result of this startup or acceptance run.

The development entry point for `scholarseed-desktop` is [desktop.py](../../apps/serve/service/cli/desktop.py):
without harness arguments it runs `electron-vite dev`; the `--shoot`, `--say`,
`--mode-check`, and `--drive` arguments in scope here trigger a build first, then start the real main process and renderer with `electron . <flags>`.
`--attach <url>` / `SCHOLARSEED_SERVE_URL` only modifies the backend attachment target; it does not trigger a build.
Used alone, it still runs dev; only when combined with the harness arguments above does it follow the corresponding harness path.
Use this Worktree's entry point, not a
global launcher. Root `npm run desktop` currently does not forward command-line arguments when it invokes this Python module;
do not assume `npm run desktop -- --say ...` implements argument forwarding. Root `pnpm ops dev` forwarding npm arguments also does not guarantee Electron/CDP arguments take effect; verify the actual argv and listener according to the debugging Skill.

| Launcher argument | Current mechanism and evidence boundary |
| --- | --- |
| `--shoot` | Captures a scene from the real renderer; patching scene state and performing necessary clicks is not a complete business flow and cannot replace real conversation or HIL acceptance |
| `--say "<msg>"` | Sends one real conversation turn; when it encounters a real HIL card, it automatically operates permission/question controls. Confirm that this automatic operation is within the current authorization scope; an ordinary reply does not prove HIL was triggered |
| `--mode-check` | Selects `ask` permission mode, sends a real first turn, and verifies the session mode; the current request explicitly says not to execute tools, so this does not prove actual permission-card/HIL acceptance |
| `--drive <dir>` | Continuously reads `<dir>/cmd.jsonl` to drive the real UI and writes `<dir>/ack.jsonl`; subsequent actions must be determined by observations, not a fixed script presented as dynamic acceptance |
| `--attach <url>` / `SCHOLARSEED_SERVE_URL` | Attaches to an already-running Serve instead of starting a managed backend; the CLI writes the URL to the environment, and the main process reads it and probes health. A non-Vite path requires that Serve to host the matching renderer; proving only that remote healthz exists is insufficient |

[shoot.ts](../../apps/desktop/src/main/shoot.ts) writes development screenshots to this Worktree's
`tmp/test_snapshot/desktop/`; packaged mode instead uses `scholarseed-desktop-snapshot/` in Electron's temporary directory.
The `shot` action in [drive.ts](../../apps/desktop/src/main/drive.ts)
writes `<dir>/shots/<name>.png`, not to the default screenshot directory above. Open each image at its actual output path
and inspect the final state, stating what behavior each proves; the existence of a screenshot path or generation of a scene image does not prove the session passed.

The current managed startup uses the selected Python in [backend.ts](../../apps/desktop/src/main/backend.ts)
to execute `-m service.cli.serve --parent-stdin --host 127.0.0.1 --port <实际端口>
--auth-mode off --ownership-axis machine --log-level <实际级别>` (the actual port and log level); when a built renderer exists,
it also passes `--renderer-dist <目录>` (the renderer directory). Normal and harness startup both use these two fixed authentication/ownership parameters;
attach does not rewrite startup parameters for an external Serve. Do not infer the actual backend mode from old comments or entry-point names.

The main process waits for a successful `/api/healthz` response, `ok`, and the applicable browser-readiness strategy.
The current [health route](../../apps/serve/service/chat/api/routes.py) returns `stack`, runtime, and
readiness, but `ok: true` does not mean runtime readiness is true. Healthz alone, process startup, and
runtime ready cannot substitute for a real model response or feature/tool execution. Desktop account login is an optional enhancement;
local HTTP `auth-mode=off` neither proves nor disproves upstream model authorization. Session acceptance preserves the actual runtime
executable, model connection, credentials, and startup configuration; verify through the public UI/startup output without reading or injecting secrets.
Use the debugging Skill to distinguish authentication failures at the account API from those at the model upstream. Report startup, model response, and tool result separately.
If login is needed or credentials are missing, stop the corresponding flow and report the specific missing item; do not change authentication configuration to get a green result.

For routine debugging, follow the short decision path in the [Desktop Debugging Engineering Specification](development.md)
directly, without building first. Load the [manual startup exception](development.md) only for an authorized custom runtime, build-artifact acceptance, or a diagnosed argument-forwarding fault; startup failure alone does not authorize bypassing preparation or security checks.

<a id="隔离热更新调试"></a>
### Isolated Hot-Reload Debugging

The root development launcher points `SCHOLARSEED_CODEX_HOME` to `codex/` under this checkout's isolated Home,
so multiple development instances do not fall back to the user's shared `~/.codex` and contend for its maintenance lease. An inherited
`CODEX_SQLITE_HOME`, like other shared overrides, is rejected; user Codex configuration,
credentials, and databases are neither copied nor modified. This development-environment choice does not change the default storage policy for installed builds or directly started Serve.


**current**: Run from each Worktree root:

For the first launch or when the built-in Skill pack needs rebuilding, you can use `pnpm dev`: first run
`ops cd build local --target skills`, then run `ops dev` only if it succeeds; a pack failure stops startup.
Prebundling generates the artifact manifest from local Skill source and `skills/registry.json` without writing back to source.
Exit the current instance before running it; do not rebuild the pack during an active conversation. Routine hot reload with an existing pack remains available through `pnpm ops dev`.

```bash
pnpm ops dev
pnpm ops dev --port 19222
pnpm ops dev status
pnpm --silent ops dev status --wait --timeout 60000
pnpm ops ci test --scope tooling --suite debug
```

The first two commands are alternatives: one automatically chooses an available CDP port, while the other specifies a port explicitly; do not run them consecutively.
The entry point is owned by [debug.cjs](../../scripts/dev/desktop.cjs) and runs
`electron-vite dev` through the existing Desktop forwarder, retaining predev dependency/Python, toolchain, and identity preparation without skipping protected-resource builds.
The development candidate builds and atomically publishes the local page entry points for main, preload, and renderer. The main UI entry is not bundled and continues to use Vite HMR;
file URL pages such as menus, browser overlays, and the editor use local assets from `out/renderer`.
The first launch does not depend on previously hand-built renderer output; if compilation of any target fails, the candidate is not published.
Local pages are generated in a separate compiler process, whose module graph is released when compilation finishes; it does not run alongside the long-lived Vite service.
pnpm/Yarn script arguments are forwarded directly; npm inserts `--` after the script name to avoid sending Vite options to Electron.

| Object | Current isolation and reuse semantics |
| --- | --- |
| Worktree identity | Hash of the real absolute path; aliases for the same path count as one instance, and switching branches still reuses that Worktree's debugging state |
| Product Home / Electron profile | `~/.ss-debug/<hash>/home` and adjacent `electron/`; created on first use and retained across restarts, without copying normal user state or credentials |
| Default project workspace | At the current Worktree's `tmp/desktop-workspace/`, following the existing Desktop development default; do not manually point multiple instances at the same real project |
| Node / Python / Electron | Prepared independently for each Worktree; only package-manager content caches are shared, not the entire node_modules, venv, or build output |
| CDP / Serve / Vite | CDP automatically probes for a free local port; an explicitly occupied port is an error and is not taken over. Serve assigns a port automatically, while Vite increments according to its existing configuration |
| Duplicate startup | An exclusive launcher lock is created atomically before startup preparation; another invocation only prints the existing PID/CDP and does not reinstall, rebuild, or launch Electron again |

An interactive development instance also acquires Electron's profile single-instance lock; multiple Worktrees are isolated through their own
userData and are not run in parallel by skipping the single-instance lock. A protocol process launched by the browser has no Vite environment,
so it must first deliver the callback to the running profile through the single-instance event or existing inbox. Do not launch a separate development copy without
a static renderer. Headless checks retain their existing isolation semantics.

`pnpm ops dev status` returns status as read-only data: the canonical Worktree, Home/profile, launcher PID, state, CDP probe result,
renderer URL, and a directly executable Playwright connection command. If the app is not started, it does not install dependencies, create directories, or launch the app.
`running` means only that the launcher is alive and CDP is accessible; use `rendererReady` to determine connectability, not state alone.
`rendererReady: true` requires a unique business page target (excluding DevTools/blank pages, with a target ID and local development URL),
and that URL must return accessible Vite HTML. The receipt provides `renderer.id/url`, `reason`, and `attachCommand`.
This proves only that the target/document is connectable; it does not prove that the DOM is mounted, Serve is available, login state/model/business acceptance is ready. After connecting, take a real snapshot.
If there are multiple candidates, the result is `renderer_ambiguous`; the page is not guessed. CLI attach may select DevTools first,
so choose by `renderer.url` from `tab-list`; do not treat `/json/list` ordering as a Playwright tab index.

An ordinary query returns read-only JSON; exit code 0 means the query completed. `--wait` is also read-only and does not start the app or create runtime state:
the default wait is 60000 ms; `--timeout` can set 1–600000 ms. Probes/retries share the same overall time budget.
Exit code 0 means the renderer is connectable, 2 means the wait timed out (`timedOut: true`), and 1 means a state such as stopped/unknown/stale/orphaned
that cannot be continued automatically; the result retains `reason`, `probeError` (if any), and `waitedMs`.
Do not use infinite polling. If initially stopped, run dev only if startup is already authorized; while starting, use the budgeted wait command.

**required**: Start parallel instances through the root `dev` entry point; direct calls to lower-level Desktop dev, `preview`, or manual Electron are outside this deduplication protocol.
The lock means the launcher is alive/starting; it does not mean the window, CDP, or backend is ready. Check logs, actual argv, listener address, and renderer.
A race window remains between port probing and Electron binding. If another program takes the port, report a failure; do not assume the port was reserved permanently.
The entry point supervises the process tree it creates. On macOS it forwards exit signals through a dedicated process group and waits for the whole group to exit,
so Electron is not left running even if Vite exits early. On Windows, the development host first places the restricted Node worker into this task's
native Job, then allows Electron to start; it does not end other workspaces by process name or let the root entry point run `taskkill /T` prematurely.
Explicit exit terminates only its own Job. Automatic reload is allowed only after private idle admission and normal backend drain.
After the host confirms the Job's active-process count is zero, it sends a terminal proof through private IPC to the lease holder. Missing, duplicate, invalid proof,
or uncertain exit retains the lease and lock. The Windows root entry waits for bounded shutdown; on timeout it retains ownership information and does not claim cleanup is complete.
After `Ctrl+C` stops this entry point, release the lock only after confirming the process group exited and the CDP port was released; retain state. If this cannot be confirmed, keep the lock to prevent another startup.
If forced termination or a crash leaves an old lock, fail closed: first check the exact lock path in the output and confirm that this instance's Electron/Serve
have both exited, then manually delete that `launcher.json`. Do not automatically guess cleanup by PID or delete the entire Home/profile.
Startup is rejected if inherited Home, Trace/Codex home, external Serve, or default-workspace overrides could connect to shared state;
unset those shared overrides in the current terminal before startup. Root `dev` no longer offers a non-isolated startup branch.

**current**: Renderer TSX/CSS uses Vite HMR. The development host watches main/preload/backend, compiles first into an independent candidate
directory, then, once the source is stable, attempts atomic idle admission, drains and confirms the old process tree has exited, publishes the candidate, and starts the new instance.
If compilation fails, the original instance is retained. If busy, wait; if the result is unknown, stop automatic reload and retain this task's receipt; do not kill an active conversation.
Once the new instance is ready, commit the artifact transaction. Recovery after failure likewise requires proof of exact process exit and integrity of the old artifacts.
Do not directly enable electron-vite `--watch` / `--rendererOnly`: the former remains subject to the `protected_watch_unsupported`
restriction, while the latter may consume stale main-process artifacts. The candidate path reuses the existing configuration and native compilation Owner; it does not relax protected-asset rules.
**gap**: On macOS, compilation-failure retention, idle restart, and exit have been observed; active real conversations/HIL and the complete Windows Job
lifecycle still require their respective real acceptance, and cannot be inferred from deterministic regression tests or results on one platform.
`electron-vite preview` is the production build/preview path and does not provide Renderer HMR; final product acceptance still requires artifacts built from current source.
The first cold start still has preparation overhead; do not claim a fixed speedup factor before measuring it. Debug contract tests are included in Desktop's default
`test` / `test:coverage`; CI includes them in `desktop-unit` from the same coverage list, with each platform plan running it once.
`pnpm ops ci test --scope tooling --suite debug` is only a focused run, not the sole gate.
The default smoke `pnpm ops ci` allows a dirty starting tree, but the source fingerprint must match before and after the run. Full quality and
release admission still require clean source; do not call a smoke or focused test from a dirty workspace a full CI pass.

**current**: The new Desktop login callback uses a temporary `127.0.0.1` port for this instance and requires an account service that supports the new protocol.
Login in 0.3.1 using `scholarseed://` remains affected by system protocol associations; isolating Home/profile does not change the OS-level credential namespace.
New Desktop builds use a per-attempt loopback port and require the updated account service.
Desktop 0.3.1 retains OS-level deep-link routing; profile isolation does not isolate OS credential namespaces.
Both macOS and Windows use Node paths, ports, and locks. Windows process-tree shutdown and orphan backends still require native acceptance;
closing CDP alone does not prove the backend exited. Record real startup/HMR on macOS and native execution on Windows separately;
host validation on one platform does not prove product compatibility on the other. See the [Desktop Debugging Engineering Specification](development.md) for connection and observation procedures.

<a id="python-索引与锁文件排障"></a>
## Troubleshooting Python Indexes and Lockfiles

When changing Python dependencies or encountering a locked-sync rejection, first check the actual registry declarations in the root
[pyproject.toml](../../pyproject.toml)'s `[[tool.uv.index]]` and
[uv.lock](../../uv.lock); do not infer that lock identities match merely because the mirror names are the same.
The current project declares a default mirror without a trailing slash. The root comment records why past URL-format differences produced source-only noise;
it does not authorize automatically changing the lockfile or forcibly overriding developer configuration.

The `prepareDevelopmentEnvironment` function in the [installation Owner](../../scripts/shared/python.cjs) uses
`uv sync --locked` and preserves the passed environment. If neither `UV_DEFAULT_INDEX` nor `PIP_INDEX_URL`
is explicit, it also tries `pip3 config get global.index-url`; on success, it strips the trailing slash and passes the value as
`UV_DEFAULT_INDEX`. This is distinct from whether uv itself reads pip configuration: the project wrapper adds
an extra bridge, so do not claim every installation necessarily uses only the pyproject index. During troubleshooting, record the effective sources involved,
but do not include URLs containing credentials in logs or work records; this page does not infer uv's complete priority order without testing it.

Development sync writes to the environment and may download dependencies; do not use it for a read-only knowledge audit. Packaging's
[dependency export](../../scripts/shared/dependencies.py) uses locked export and checks the lockfile hash before and after export;
do not hide an export failure or lockfile change by retrying with a modified lock. Update the lock only after the relevant build/dependency Owner
confirms added dependencies and index policy, then separately accept the real installation and packaging. Historical requests saying “no protection needed” do not cancel current gates.

Locked dependency export is separate from download-source overrides. `uv export --locked` for the runtime closure and each build dependency group
uses the project's declared default index, preventing `UV_DEFAULT_INDEX` or `UV_INDEX_URL` from changing the locked source.
Export still checks consistency between the project and lockfile and retains dependency hashes. This restriction applies only to export; installation still uses the caller's configuration.


<a id="跨平台开发与验收"></a>
## Cross-Platform Development and Acceptance

First distinguish development-environment changes from product delivery by the affected object. Changes limited to local Worktree initialization, frontend dependency installation,
development commands, or toolchain documentation may be verified on the actual development host; **Windows acceptance is not required**.
If the host is macOS, use the real installation command, complete exit code, install logs, tool versions/paths, and relevant
executable probes as evidence. For this non-product behavior, there is no requirement to start the product, send model requests, or provide
product/host screenshots. Shared scripts must still not silently execute commands that apply only to another platform; state untested platforms accurately.
This exception does not apply to product runtime, native components, installers, updates, packaging, or distribution; those remain subject to the two-platform requirements below.

ScholarSeed supports both macOS and Windows. Changes to paths, permissions, processes, file locks, archives, executable
discovery, dynamic libraries, or installers must first define behavior on both platforms, then verify the affected deterministic gates and
real build/product flows separately; a result on one platform does not replace the other. Design or implementation notes should include a macOS/Windows
behavior matrix.

- On Windows, `stat.S_IMODE()` is not equivalent to POSIX `0644`/`0755`, and `chmod()` does not guarantee
- round-tripping POSIX permission bits; normalize permission semantics for regular/executable files through the owning helper, and apply them to both generated
  metadata and payloads.
- Resolve the target Python script directory using `sysconfig.get_path("scripts")`; do not assume console
  scripts live alongside the interpreter. Handle Windows `.exe`, `.cmd`, and `.bat` separately. Node child processes
  launching command scripts must use a supported path and must not pass untrusted arguments to a shell.
- Accept both LF and CRLF in external output. Use `pathlib.Path` / `node:path` for paths and `os.pathsep` / `path.delimiter` for PATH separators;
  do not apply POSIX string assumptions to Windows drive letters.
- POSIX capabilities such as `fcntl`, `flock`, Unix sockets, symlinks, and signals require explicit Windows
  implementations. Platform selection must still follow the file-header import rule; prefer cross-platform libraries or select platform modules at the composition boundary, and do not
  use lazy imports in the business layer to evade dependency boundaries.
- `os.O_DIRECTORY`, `os.O_NOFOLLOW`, `os.O_NONBLOCK`, `dir_fd`, xattrs, and
  raw directory file descriptors are POSIX semantics. `getattr(..., 0)` only avoids an exception; it is not a Windows
  implementation. The business domain must not make raw directory file descriptors a cross-platform contract; the platform filesystem boundary owns fixed directories, leaf opening, publication, replacement,
  and deletion.
- Windows handling of symlinks, junctions, and reparse points must be explicit. Modifying a path without protection after `Path.resolve()`
  or `lstat()` is check-then-use; use an atomic no-follow operation
  or fail safely. When converting native handles to Python/CRT file descriptors, specify access and sharing modes; in every success and
  failure path, transfer ownership only once and close all handles.
- Keep archive member names consistent across platforms; do not replace Windows `bsdtar` with Git GNU tar, or a
  `C:` path may be interpreted as a remote archive.
- Windows product acceptance must start a real installed or development Desktop and cover at least
  `/api/serve/sessions/open`, resource scanning, file creation/reading/renaming/replacement/deletion, restart recovery,
  and junction/reparse rejection. File existence, process startup, `/api/healthz`, or Codex `ready`
  alone cannot prove chat works.
- When the full gate is already red, run the same command against an unmodified baseline to distinguish pre-existing failures from regressions. This comparison does not turn red checks
  green and does not let a baseline comparison on one platform imply a pass on the other.

<a id="按改动选择命令与证据"></a>
## Choose Commands and Evidence by Change

<a id="构建与用户数据清理"></a>
### Build Cleanup and User-Data Deletion

`pnpm ops pre clean` cleans only the current repository's development virtual environment,
`apps/desktop/node_modules`, and `apps/desktop/out`; neither removes the user Home.
All targets are preflighted first; if preflight fails, nothing is deleted. `VENV` must not be empty, `.`, `..`, a path outside the repository, or a symlink;
an existing directory must contain a real `pyvenv.cfg` (including `home`) and match the Python interpreter identity; a source directory cannot be used instead.
The missing default `.venv` can be cleaned idempotently; a missing custom directory is rejected because its identity cannot be verified.
The development Desktop, browser development surface, Electron preview, and Serve runtime hold environment read leases. If a cleanup or installation writer
conflicts with them, the operation is rejected first; active processes are not terminated. If child processes or write state after an abnormal exit cannot be confirmed,
the lease receipt is retained for manual review; the tool does not delete the receipt automatically merely because a PID has exited.

User data must be handled separately: first run the read-only `npm run user-data:preview` and inspect the normalized absolute path,
existence status, and deletion scope for the entire directory (configuration, credentials, sessions, and assets). Then explicitly decide whether to run
`npm run user-data:delete -- --confirm "<预览中的完整路径>"` (the complete path shown in the preview). The confirmation text must match exactly;
relative paths, parent-directory escapes, the filesystem root, the system user Home, the repository and its ancestors or descendants,
and symlink targets or ancestors are not allowed. A missing, explicitly safe path is shown as `exists: false`; confirming deletion is an idempotent no-op.
Installation, tests, CI, and `distclean` do not invoke user-data deletion. Before deletion, stop users of that data root and back up its assets;
preflight is not an atomic isolation guarantee against malicious concurrent filesystem replacement. macOS uses `bin/python`; Windows
uses `Scripts/python.exe`. Native Windows junction/reparse handling and the root npm entry require separate acceptance.

The source of truth for user commands is the [ops CLI](../../scripts/ops-cli.cjs) and its [command recipes](../../scripts/shared/commands.cjs);
domain policies remain owned by the [Desktop executor](../../scripts/shared/desktop.cjs) and [workspace Owner](../../scripts/shared/workspace.cjs),
not a historical Wiki command table. Root `package.json` retains installation bootstrap and entries explicitly deferred in the ledger; do not treat old root aliases
as a unified user interface or infer that an ops command is registered because its name looks similar.

Documentation-structure rules are owned by [structure-core](../../scripts/ci/docs/structure-core.mjs).
The root JSON adapter and repository knowledge-governance CLI reuse the same implementation; root gates no longer import Skill-internal code.
Discovery scope, explicit paths, errors, and receipt contracts are unchanged. The development Skill entry point still requires an explicit `--root` and path;
the implementation migration does not expand scanning or trigger automatic writeback. The old Wiki check and generation commands have been removed.
`scripts/dev/serve.sh` remains an exec compatibility shim; no implicit invocation has been added.
The current quality pipeline's `python-public-engineering` check validates public documentation and the knowledge closure under the source root;
the Node tool set checks documentation entry points, structure, component conventions, and link fixes. It no longer runs the private historical exporter.
Before release, still verify the actual frozen artifacts, licenses, sources, and integrity. A dry run and local gates do not authorize release
and do not prove that remote CI, Windows installers, or the Skill's semantics in its actual host have been accepted.

`npm run install:cmd` is the explicit entry point for preparing, building, and installing command links; link decisions are owned by
[command-links](../../scripts/pre/commands.cjs). Select only a real, writable bin directory. Create only missing commands and leave links that point exactly to the current Worktree's venv unchanged. Same-name regular files, directories,
links from another repository, and links to another target (including dangling links) are all retained and reported as conflicts; do not switch to another bin directory to bypass a conflict.
Preflight all command conflicts and source identities first. A missing source executable is marked `skipped`; installation does not force-overwrite anything.
An existing exact link must also pass the source-identity check. If the source is missing, retain the link but mark it `skipped`, not `existing`.
The venv must be inside the current Worktree and have no symlink directory ancestor.

`npm run uninstall:cmd` does not install dependencies or create a bin directory; it deletes only links whose targets exactly match the current Worktree's
expected venv executable paths, and can verify ownership by path even if the source is missing. The same rules apply to historical names.
Files/links from another repository are marked `unowned` and retained; ownership cannot be inferred from the command name or from something “being a symlink.”
If the link target text contains parent traversal `..`, conservatively reject ownership so that an actual external path reached through symlink/`..` is not
mistaken for an in-repository path after lexical normalization. Do not use risky path normalization to guess that dangling or unknown targets are equivalent.
Output JSON lists paths that were created, retained, skipped, deleted, or unowned. Tests use temporary bin/venv directories only;
do not perform destructive acceptance against a real system bin. Windows currently has no global bin candidate, so installation fails explicitly;
a native Windows global-command solution is outside this batch's scope.

`pnpm ops ci format --write` and `pnpm ops ci format` have their single default Python scope maintained by the [formatter Owner](../../scripts/ci/format.cjs);
POSIX `scripts/ci/format.sh` is only a compatibility forwarder. The interpreter is resolved through the existing
developmentPython (macOS `bin/python`, Windows `Scripts/python.exe`); it does not fall back to the host Python.
If `fmt-check` lacks an interpreter/isort/black, it fails explicitly and prompts `pnpm ops pre install python --mode desktop`; it does not install anything.
An explicit `fmt` may prepare once through the existing Python Owner. Both modes retain the isort→black→import-header checks and failure codes.
For isolated acceptance or a shared dirty workspace, pass only task/temporary paths; do not run the default `fmt`, which may rewrite someone else's source.

`pnpm ops dev serve --watch` first verifies the Codex lookup exit status and non-empty path, then starts the
[serve watcher](../../scripts/dev/watch.py) with explicit argv; spaces/quotes/backslashes are not assembled into a shell command.
Python file changes trigger the old process to stop and then restart; if the child process exits on its own, its exit code is propagated. On POSIX the service is placed in
an independent process group; shutdown sends SIGINT→waits→sends SIGKILL to clean up that group. A daemon that deliberately escapes the process group is not covered.
Windows retains the existing startup and root-process-only cleanup boundary and emits a warning; it does not promise descendant cleanup and does not use
taskkill or an unverified JobObject fallback. Full Windows process-tree shutdown and native acceptance remain explicit gaps,
requiring a separate Owner solution and native exit/restart/descendant-lifecycle evidence; POSIX results are not a substitute.

| Change scope | Current verification route and evidence boundary |
| --- | --- |
| Python formatting, lint, types | `pnpm ops ci check --profile python` combines formatting, lint, and Python typing; for Desktop types use `pnpm ops ci check types desktop`. Each tool's scope is defined by its own script/configuration, not uniformly across the repository |
| Desktop types and interaction | `pnpm ops ci check types desktop` / `pnpm ops ci test --scope desktop` follow the Desktop Owner; accept product interactions separately under the local testing guide. Python checks do not establish that the renderer passed |
| Serve domain and cross-package contracts | [run_all.py](../../apps/serve/tests/run_all.py) determines registered, excluded, and serial suites; a reduced plan must state omissions. Suite names or old docstrings do not prove actual coverage |
| Installer and dependency boundary | `package:check` and the build guide verify the actual packaging path; the presence of a normal build or wheel does not prove installer closure, signing, or a real upgrade passed |
| Documentation and Skills | `pnpm ops ci check docs workspace` discovers current knowledge and outputs the actual inventory without scanning the old root Wiki; use `pnpm ops ci check docs desktop` for Desktop docs. See [knowledge rules](../architecture/knowledge.md#当前检查范围) for complete scope, exclusions, and named work-record prerequisites. Instruction Skills still require real invocation in their owning host; structural success does not prove semantics or acceptance |

Before adding or choosing tests, identify their Owner: Serve suites live under `apps/serve/tests/`; cross-package integration,
acceptance, and release gates live in the root `tests/`. Current Runtime contracts are in `tests/contract_runtime_*.py`,
not in test entry points for the removed Harness/SDK; local Trace tests are in
`packages/damoatrace/damoatrace/tests/`. Follow the existing `contract_*` / `e2e_*`
naming and actual entry points in the owning directory. A new Serve suite must be registered by its bare name in `run_all.py`'s `SUITES`; that runner
filters entries with a `tests.` prefix from the initial list. Root cross-package suites are registered explicitly in `PRODUCT_ROOT_SUITES`;
the presence of a file alone does not mean a gate discovers it.

Desktop E2E project and spec selection is determined by
[playwright.config.ts](../../apps/desktop/playwright.config.ts); do not reuse the old proposal with only
smoke/live groups: the current configuration also has workbench and update; package is registered only when
`SCHOLARSEED_CI_INSTALLER` is set. Selecting a project does not prove that a spec is included in its testMatch;
check both before running. Zero tests or skipped tests do not count as that feature passing.
The live seed for the [runtime fixture](../../apps/desktop/e2e/fixtures/runtime.ts) reads
`SCHOLARSEED_REAL_HOME`; if configuration or a model connection is missing, it returns a specific reason. What is copied is configuration and model profiles,
which does not prove runtime authentication succeeded. Continue to verify authorization, authentication, and initialization prerequisites for real turns according to the debugging Skill;
do not report a skip for missing prerequisites as a success. Do not commit configuration or credentials or include them in evidence attachments.
The [Electron fixture](../../apps/desktop/e2e/fixtures/electron.ts) uses `--drive` by default;
only `nativeWindowLifecycle` omits that argument. For window-close/tray paths, choose a real native lifecycle;
a harness that keeps the window alive cannot prove user close behavior.

From the repository root, run `python -m apps.serve.tests.run_all` using the actually installed Python environment
(the local default interpreter is `.venv/bin/python`; a Worktree may use a verified external venv without rebuilding the environment).
The runner sets a subprocess `PYTHONPATH` and isolated Home separately for Serve and root suites;
each suite's `TMPDIR`, `TEMP`, and `TMP` point to an independent physical temporary directory created through the native directory boundary.
On macOS the default is the physical root of `/tmp`; when `SCHOLARSEED_LEASE_TEST_ROOT` is explicitly set, both Home and
temporary directories use that isolation root and still go through native directory-permission checks. Choose a task-exclusive, safe, sufficiently short physical path
to avoid `/var` aliases or deep nesting triggering no-follow rejection or Unix socket path-length limits. Windows
retains its native temporary root and directory-admission semantics. Independent test fixtures should also use
physical paths; do not relax production storage or browser-profile link-rejection rules to accommodate test directories.
`--fast`, `--no-runtime-binary`, and `--exclude-suite` all reduce coverage; record omissions. `--report <path>` saves the actual plan, omissions, exit status, and verdict. The contract layer is not product acceptance;
some suites start real Serve or Runtime binaries, so do not treat the runner as an entirely side-effect-free probe.
Without `--fast`, the default also includes `integration_serve`, which sends real model turns and may consume tokens.
`SCHOLARSEED_INTEGRATION_CONFIG` must explicitly point to a valid real model configuration, and the corresponding model/
network call must be authorized; missing or invalid configuration causes failure. `--fast` omits this real integration suite; state the omission
and do not equate a reduced plan or its passing result with full acceptance.

`python -m apps.serve.tests.acceptance_all [a1 a2 a3 a4]` is the invocation shape of an existing entry point,
not a currently verified usable acceptance command: a1/a2 still call the old research/headless CLI,
and a3 still refers to the removed `damoagent` Harness. Do not restore the old implementation or treat the runner's existence as proof of the real path.
It reads real model configuration, creates an isolated Home, starts processes, and calls the model, which may consume tokens. Unknown arguments
(including `--help`) fall back to running everything when no suite matches; do not use it to probe availability. To choose a current Desktop
product flow, verify initialization, model, and authorization prerequisites below and in the debugging Skill.
Running a4 additionally requires explicitly configuring `SCHOLARSEED_ACTION_MODEL` with real credentials. Its file operations use the real
`Path.home() / ".scholarseed-acceptance" / "a4"`, recursively deleting
that path both before running and in `finally`, and creating/using a test directory there. A temporary `SCHOLARSEED_HOME` does not isolate this real user
path. Before running, verify the actual target, pre-existing data, and exact deletion authorization; model/product authorization does not automatically grant deletion
permission. Do not run if target or authorization safety prerequisites are unmet, and do not bypass protection by cleaning the directory first.
`apps/desktop/e2e/`, root acceptance, and package e2e may use a real LLM, Electron, Docker, or
OpenSandbox. Read their entry points and side effects first; test names do not automatically authorize running them. The actual module list for root Trace commands
`pnpm ops ci test --scope trace` / `pnpm ops ci test --scope trace --with-format-check` is in `scripts/shared/workspace.cjs`;
the former runs installation first, and the latter also runs formatting checks. Do not invoke them automatically just to check documentation.

For focused Python contracts, first inspect the actual imports in the owning runner and test modules: both the repository root and
`apps/serve` have a `tests` package, so the same package name may shadow another depending on cwd/PYTHONPATH.
The root CI orchestrator assigns each standalone pytest stage a unique task Home, Trace/Codex, and temporary directory before imports;
it does not copy user model configuration and disables bytecode writes before startup to avoid polluting reviewed scripts/packs. It cleans up after normal exit.
The stage result's `state` records the task directory and cleanup status:
cleanup failure must be nonzero; on timeout or process errors, retain the task directory and failure diagnostics rather than assuming the process tree has drained.
Running pytest bare does not provide this isolation automatically. Stateful focused diagnostics must also use the owning isolated entry point first;
do not borrow the real Home or use a failed test as a reason to clean up the user's databases or credentials.
Skill-script validation must also check the actual number of scanned files; zero files after default exclusions is not a lint/types
pass. Use the real scope specified by the Owner; do not expand ignore rules or claim the whole repository is green based on that output.
`contract_model_profiles` imports `tests.storage_permissions`, while PDF contracts also import an
`apps.serve.tests` fixture; do not mechanically copy another cwd/module-name setup. If imports fail, first check which
module and path were resolved; do not change production imports or install new dependencies to bypass the issue. For contracts that count PASS/FAIL themselves,
check both the failure count and exit status; a direct function call that raises no exception does not mean all assertions passed.

`fmt` edits files in place. Through the [formatter Owner](../../scripts/ci/format.cjs), `fmt-check`
only checks the existing interpreter, isort, black, and specified source files. If dependencies are missing, it fails and prompts explicit preparation;
it does not invoke the Python installation entry point. The check creates and removes a temporary Black cache, so do not describe it as causing zero writes to the entire
filesystem. Installation, configuration, and clean/distclean actions
must follow task authorization; do not automatically run the full check suite or clean the user's Home just for a documentation audit.

`health` currently drives the real Desktop `--say`; it is not an independent network probe. The specified response need not trigger a tool,
so success does not prove all tools/HIL/recovery paths. Record the actual command, code and uncommitted state, runtime environment,
and coverage results; dirty-tree contents can differ even at the same HEAD, so a commit name alone is insufficient to identify the tested version.

<a id="并行隔离与白屏排查"></a>
## Parallel Isolation and Blank-Window Troubleshooting

Keep `.venv`, Desktop dependencies, product Home, Electron profile, and Serve instances separate to avoid mixing them across Worktrees.
Before startup, select a supported runtime dedicated to this task; do not overwrite the user's normal Home.
Follow the debugging Skill for `SCHOLARSEED_HOME` selection and short-path restrictions; do not arbitrarily replace the actual model/credentials.
Using an authorized existing interpreter for static documentation checks does not mean product startup can borrow another Worktree's environment.

<a id="初始化-home-与-harness-前提"></a>
### Home Initialization and Harness Prerequisites

`--say` / `--drive` / `--mode-check` target an initialized Home: the first-launch landing page is closed,
the login dialog is closed, onboarding has been skipped or completed, at least one project exists, and a model profile is configured and available.
Closing the login dialog does not require logging into an account; model authorization must still be verified independently. If a fresh Home lacks these prerequisites, first attribute the
specific blocker; do not directly classify an unmounted Composer as a product regression, and do not skip actual first-launch acceptance.

The current `harnessBlocker` and `onSay` submission-failure branch in [App.tsx](../../apps/desktop/src/renderer/src/App.tsx)
provide the following foreground feedback keys:

| Feedback key | Unsatisfied prerequisite indicated |
| --- | --- |
| `foreground.harnessLanding` | First-launch landing page is not closed |
| `foreground.harnessLogin` | Login dialog is still open |
| `foreground.harnessGuide` | Onboarding is still blocking |
| `foreground.harnessNoProject` | No project exists |

These feedback values come from the `--say` submission-failure path. When runtime readiness is false, its
message or `foreground.runtimeNotReady` takes precedence; other unrecognized blockers use
`foreground.submitNotReady`. The original root rules and debugging Skill require fresh Home to name the specific unmet prerequisite.
Do not claim that all three harnesses currently use this classification consistently: `--mode-check` also has runtime preflight /
AI panel-not-ready failures, while `say` in `--drive` returns `typed` / `sent` acknowledgments through input/click actions.
The Skill summarizes a missing model profile as `runtimeNotReady`, but the current
[Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx) also distinguishes
the notice that no model is available from submission being blocked; do not classify every missing-model case under one foreground key. Retain the prerequisites and
requirement to name the diagnosis; verify the specific error against the actual UI, ack, and logs, and do not treat implementation differences as grounds to relax the requirement.

Fresh-Home acceptance must first initialize once through the normal UI, or use an isolated Electron instance with loopback CDP to drive real onboarding according to the
[harness prerequisites in the Application Operations Engineering Specification](development.md). Profile/Home isolation, short paths,
the post-build direct-start exception, and Playwright operations are maintained only by that Skill; this page does not duplicate the full procedure.
Choose normal UI/CDP when visible UI or login steps are required. Use the harness only when the model/runtime/authentication state under test is preserved
and the prerequisites are met. Command descriptions do not authorize initialization, login, model requests, or product startup.

For a Vite blank window, first check the actual renderer URL, listening process, and failed requests; do not diagnose it solely from DevTools
Autofill logs. `apps/desktop/endpoints.ts` owns the explicit loopback host, port, and cache directory;
`electron.vite.config.ts` uses these values and permits the listening port to increment. Before loading the development URL, the main process's `prepareRendererLoad`
clears the corresponding Chromium HTTP cache to prevent stale same-origin module graphs from persisting across instances.
These mechanisms address stale chunks/double listeners; they do not mean every blank window is caused by cache. Do not weaken update identity checks,
mask failures with automatic refresh, or change user configuration to achieve successful startup.

The dedicated Vite cacheDir here is separate only from the default `node_modules/.vite`; it is not a unique cache for every process or
Worktree. Multiple instances using the same configuration, or `node_modules` pointing to a shared directory,
may still share the actual prebundled path. Check path resolution and runtime versions first; do not infer isolation from a directory's “dedicated” name.
The Chromium HTTP cache and Vite prebundle cache are separate layers; `clearCache()` does not delete the dependency graph.
Do not clean other instances or user assets instead of verifying the failing request/source.

Renderer port conflicts are handled by Vite's listener retry; do not add a random-port algorithm that “probes and then binds.”
Electron reads the final `ELECTRON_RENDERER_URL`; do not decide that it connected to the right instance from the preferred port alone.
Backend `pickPort` currently first binds a system-assigned loopback port, then closes the probe socket and starts Serve.
This is not the same mechanism as Vite retries and does not prove there is no race between the two binds; still check actual health and logs.
The single-instance lock and port assignment are different constraints; do not treat historical prompt suggestions to bypass the lock as an ordinary startup method.

Serve's default development CORS allows specified HTTP loopback origins and their dynamic ports, retaining credentials;
when `cors_origins` is explicitly passed, the default regex is not added. Port changes must not open access to arbitrary origins or treat CORS
as authorization. See the affected check in the [CORS contract](../../apps/serve/tests/contract_cors.py);
real acceptance also requires occupying the preferred port before starting this task's instance, then checking the final URL, allowed/denied origins, and product flow.
Also see the [Serve assembly Owner](../../apps/serve/service/bootstrap.py): CORS is registered last as the outer layer,
so that denial responses returned early by authentication middleware still carry CORS headers, allowing the renderer to recognize authentication failure
instead of receiving only an undiagnosable network error. Changes to origin rules and middleware order must be verified separately. The existing
`contract_cors.py` checks only the health-route preflight on an unauthenticated instance; it cannot prove that real authentication denials,
explicit origin configuration, or product startup after occupying the port have passed.
This section preserves the mechanism and criteria, not command authorization or prior success claims from old plans.

<a id="macos-开发应用身份与副作用"></a>
## macOS Development App Identity and Side Effects

The current `predev/prepreview` scripts in the [Desktop package](../../apps/desktop/package.json)
call [identity.cjs](../../apps/desktop/scripts/pre/identity.cjs), not the old Make entry point.
Branch resolution uses the Worktree's Git state, and detached HEAD uses the short SHA; the name is `书深 · <身份>` (ScholarSeed · <identity>).
This is only a visible label for the development instance. It does not change the official product name or prove that Serve, Home, or sessions are isolated.

The system display name comes from the Electron bundle's plist, not only `app.setName()`. The script modifies
`CFBundleName/CFBundleDisplayName`, generates a stable development bundle ID from the passed bundle path,
registers the `scholarseed` URL scheme, and calls the macOS LaunchServices registration tool.
The branch name is passed as an execFileSync argument, not concatenated into a shell command; on non-macOS, main returns immediately.
Reinstalling dependencies may reset the bundle; a subsequent supported startup applies the identity again.

These actions have actual side effects: writing to dependencies and registering a system protocol. Do not run the script to verify documentation during a read-only audit.
If multiple Worktrees share or symlink to the same Electron dependency, bundle identity writes may affect each other;
Git branch labels and bundle path hashes do not provide technical isolation. Before startup, check the actual dependency, bundle path, and
owning instance. Do not modify user registrations or reinstall shared dependencies just to resolve a name collision.

The related [build contract](../../apps/desktop/scripts/cd/__tests__/build.test.cjs) uses an alternate runner to check
branch/SHA, arguments, display keys, and stable path identity; it does not accept Dock naming or real URL routing.
If a change here affects identity wiring, real macOS acceptance requires an authorized separate dependency/runtime. Check that the Dock,
process, and URL reach the instance; mocked system commands do not prove the result. When updating this script or startup hook,
also verify that the official product name remains unchanged and that the side effects above still apply. Windows does not use this macOS registration path.

<a id="http-请求延迟诊断"></a>
## HTTP Request Latency Diagnostics

[HTTP transport observation](../../apps/serve/service/platform/latency.py) records
`received`, `headers`, and `finished` along the existing request lifecycle. It contains only request ID, method, route template, and timing; it does not record
actual path parameters, query strings, request headers, body, or exception body. Fast requests are logged at DEBUG; slow response headers,
event-loop lag, and exceptions are logged at WARNING. Thresholds are constants owned by that module. The full lifetime of an SSE connection is not
time-to-first-byte; do not classify a request as slow merely because the subscription lasted a long time.

If both DEBUG and WARNING are disabled when a request is created, periodic sampling is not started for that request, and no server request ID
or thread limiter is queried. This decision remains fixed for that request; a level change applies to later requests. WARNING still retains
slow-response-header, event-loop-lag, and exception warnings; do not mistake root=WARNING for “observation disabled.”
`received.route` is always null, meaning routing has not yet occurred, not that the request is a 404. Later records use the route template after routing;
if a response exists but no route template is available, the value is `unmatched`; an unknown route before a response remains null.

After stopping an authorized task-isolated instance, use the existing logging switch to start detailed diagnostics temporarily:
`SCHOLARSEED_LOG_LEVEL=debug pnpm ops dev`. Do not change personal configuration or restart a session in progress.
Diagnostic field definitions:

- `started_at` is the ASGI ingress time; `headers_ms` is elapsed time from ingress until response headers are generated. It does not include
  Chromium connection queueing, waiting before TCP receipt, or full response-body transfer.
- `identity_wait_ms` is the wait from submitting identity work until an AnyIO worker thread starts; `identity_run_ms`
  is the execution time of that synchronous identity work. If identity work is not entered, the field is null; do not interpret it as zero duration.
- `identity_queued_ms`, `identity_started_ms`, `identity_finished_ms`, and `identity_resumed_ms`
  are all relative to ASGI ingress and mark submission, physical thread start/end, and resumption of the waiting coroutine, respectively. On cancellation, resumption does not mean
  the thread ended; the wait value includes event-loop/thread scheduling and cannot by itself be treated as limiter queue time.
- `thread_tokens`, `thread_borrowed`, and `thread_waiters` are shared thread-pool state at the time of the log sample,
  not peaks for the whole request; waits for other synchronous work inside the route may still be included in the remaining duration.
- `thread_borrowed_peak` and `thread_waiters_peak` add periodically sampled peaks during the request, but can still
  miss short peaks between samples; zero waiters at completion does not rule out earlier waiting.
- `loop_lag_ms` is the maximum lateness of timed callbacks during the request, including callbacks due but not yet run when response headers are generated or the request exits.
  It helps identify scheduling stalls but cannot replace a thread stack for a blocking function. `loop_sample_ms`,
  `loop_warning_ms`, and `headers_warning_ms` give the sampling interval and two independent thresholds; their defaults are
  250, 500, and 500 ms. The event-loop threshold compares lateness beyond the deadline; the header threshold compares
  absolute elapsed time since ingress. Do not conflate them. The point at which a stall triggers a warning depends on sampling phase; absence of `loop_lag`
  does not prove the block was under 500 ms, and `delay + interval` is not an exact total blocking duration.

Session-catalog GETs receive `x-scholarseed-diagnostic-id` by default. Feedback recording also covers other fetches to the configured Serve API and preserves any valid ID already set by the API client.
The ID is a random 32-character lowercase hexadecimal value. Serve rejects duplicates and noncanonical values and correlates it to its own
`request_id` using `client_request_id`. Other unrecorded requests and external URLs do not receive this header. The ID grants no authentication or admission rights.
The recording JSON's `correlationId` uses the same value as the Renderer `[http-latency]` log; logs contain no URL,
request headers, body, or exception text. XHR and requests initiated by Main are outside this client-side correlation scope.

Catalog diagnostics work with recording off. `app/api/timing.ts` captures `fetch_started`, `headers_received`,
`body_started`, `body_decoded` or `body_failed`, and `catalog_ready` or `catalog_failed`.
`main/latency.ts` observes `onSendHeaders`, `onResponseStarted`, `onCompleted` and `onErrorOccurred` for the
main window's configured backend catalog route. It records the shared ID and the native request ID.
It leaves `onBeforeRequest`, `onBeforeSendHeaders` and `onHeadersReceived` to their existing owners and
does not change requests, responses, CSP or authorization. The observer owns these stages for each Session
and disconnects when its window closes. Do not register another listener for the same stages. It retains up to
128 requests. Eviction or closure leaves the outcome unknown. Valid correlated HTTP and catalog-phase
records are logged at INFO, while other successful requests stay at DEBUG. No global log-level change is needed.

Use `client_request_id` to join renderer stages, native network events, the Serve `request_id` and catalog
stages. Route and timestamp proximity alone cannot identify a request. Time between renderer invocation and
native send can include preflight, connection and process scheduling. Time from native completion to JSON
availability can include more than decoding. Use the payload's wall-clock `timestamp_ms` to align processes
and monotonic `elapsed_ms` within a single process. Console prefixes can reflect receipt or write time.
Missing stages are unobserved, and the diagnostic data does not establish that a timeout was fixed.

`diagnostic_previous_write_ms` and `diagnostic_previous_write_event` describe the previous log write for the
same request and are null on the first record. Logging can overlap network and server work. Keep that I/O
separate from database timing and avoid simply adding or subtracting it. The renderer captures timestamps
immediately, emits `stages` on decode or failure, and logs catalog readiness separately. Native send is logged
immediately, while `response_started_*` is stored with completion or failure. A crash can leave renderer
stages unflushed even though the request started.

The recording probe uses a Resource Timing observer under an exclusive lease, retaining at most the latest 128 resource entries and
128 pending match records. On release, it disconnects and clears them without modifying the browser's global buffer. It stores `timeOrigin`, fetch invocation/
settle times, and DNS, connection, send, first-byte, and end times for a uniquely matchable resource. Overlapping requests to the same URL
are conservatively marked ambiguous. Do not guess phases when there is no entry, access is restricted/the request is cancelled, a long stream has not ended, or the entry was evicted by the budget; in particular, do not interpret a zero value
as zero latency. Add `Timing-Allow-Origin` for a valid diagnostic ID only when the response has already granted CORS access to the same origin;
this grants no additional origin or authentication permissions. This custom request header may trigger a CORS preflight,
and the interval before sending may also include DNS, connection setup, preflight, and browser scheduling; do not call all of that connection queueing.

At DEBUG level, the ASGI lifespan also maintains a process-level heartbeat and watchdog thread; it does not depend on an active HTTP
request. `loop_stall_id`, `loop_stall_started_at` (the last heartbeat before the stall, not the exact
blocking start time), `detected_at`, and `loop_recovered` from `loop_stall` can be correlated with matching IDs and times in requests.
`process_loop_lag_ms` is the lateness of a heartbeat beyond its expected execution time, not an exact blocking duration. Historical event
fields may remain until the next stall; do not assume every later request was affected merely because it has the same ID. The watchdog records at most
12 stack frames with file basenames/function names/line numbers; it does not read local variables, source code, or arguments, and stops when the lifespan exits. It needs
the Python GIL and host scheduling, so absence of a captured event does not prove there was no block. This thread is not started when DEBUG is disabled.

Align browser request-start/send timing with ingress records. If the browser times out but an independent connection returns quickly and that request
never arrived, first inspect the client-side connection queue. High identity wait, short execution, and low event-loop lag support thread-pool
queueing; high event-loop lateness supports an event-loop/process scheduling stall. Controlled load and contract calibration do not mean the original
incident has been reproduced; record actual versions, conditions, results, and evidence gaps, and do not hide the fault by relaxing timeouts.

<a id="反馈证据与截图隐私"></a>
## Feedback Evidence and Screenshot Privacy

[The feedback recording probe](../../apps/desktop/src/renderer/src/features/feedback-recorder/probe.ts)
installs under a single lease. dispose removes listeners and restores fetch/XHR only if the wrapper still belongs to this probe,
avoiding overwriting a later installer. Keep raw recorded steps separate from the user's description; network redaction is not screenshot redaction.

[Open feedback](../../apps/desktop/src/renderer/src/store.tsx) attempts a screenshot before mounting the dialog;
feedback still opens if capture fails. The [feedback form](../../apps/desktop/src/renderer/src/components/business/Feedback.tsx)
shows the screenshot as a prominent, independently removable pre-attachment, and merges it with manually added images on submission. The recording-entry toggle is separate from
the screenshot bridge; turning off the recording entry does not prove screenshots are disabled.

[The Main screenshot entry point](../../apps/desktop/src/main/index.ts) validates the sender and composites the visible native
WebContentsView layer; it is no longer merely the main renderer capturePage described in the old draft. This composite may include
sensitive content from web pages or trusted hosts; sender checks, password-input filtering, or body redaction do not establish pixel-level safety.
Inspect and remove sensitive attachments before submission; changing the capture policy additionally requires authorization and security review. This section does not prove that automatic
screenshots exclude every credential host. Regression checks separately cover recording installation/release, capture failure, preview/deletion, cancellation, and
feedback-package upload. Use the final composite image from the real product, not a renderer-only image or historical upload success, as evidence.

<a id="常见失败分流"></a>
## Common Failure Triage

| Evidence | Next step and boundary |
| --- | --- |
| Missing Desktop command or distribution metadata | Check whether startup used this Worktree's root entry point and whether the actual dependencies/venv belong to this Worktree; with authorization, repair through the original install path rather than installing a global command |
| Skill-pack sync failed / refused to replace non-Skill data | Verify ownership of the prebundle target and any manually maintained assets; back up and rebuild generated artifacts only after authorization is confirmed, and do not delete product Skill source of truth |
| Port occupied or URL does not correspond to the current process | Check PID, actual listener, and profile/Home; handle only this task's instance and do not stop other Worktrees or user processes |
| `protected_assets_unavailable` during compilation | Check whether frozen source, tests, or build inputs changed during startup; `protected.ts` rejects snapshot drift. Finish editing, wait for this startup to exit, confirm `dev status` is stopped, then restart from the root entry point and keep inputs unchanged during compilation. If it continues to fail, inspect frozen inputs and the compilation closure; do not disable validation or substitute old artifacts |
| Window opens but backend is unhealthy | Inspect logs from the same startup chain and actual healthz, then verify business prerequisites; do not start another Serve to mask the problem. Healthy status does not mean the session/model is usable |

<a id="交付和验收"></a>
## Delivery and Acceptance

<a id="内置-codex-制品解析与缓存排障"></a>
### Built-in Codex Artifact Resolution and Cache Troubleshooting

Artifact versions, platforms, and integrity are maintained by the [vendor manifest](../../scripts/vendor/codex/README.md);
actual resolution belongs to [Desktop runtime/codex.cjs](../../apps/desktop/runtime/codex.cjs), not
Adapter session execution or generic app components. Cold resolution verifies the archive's SHA256/SHA512, extracts the
complete platform runtime, publishes it to the final cache and compares file hashes, then performs an exact version probe, rechecks inventory, and writes a receipt.
Do not continue moving directories in an already executed staging area or assume resolution succeeded because “the final directory exists.”
If probing or inventory verification fails, no ready receipt is written and no executable path is returned; the next resolution treats the cache as incomplete.

| Platform | Cold-resolution publication and probe semantics | Verification requirements |
| --- | --- | --- |
| Windows | Publish unexecuted staging, then probe only at the final path; publication retains a bounded retry for file-lock contention | Contract tests, real cold startup, and Windows build acceptance |
| macOS | Likewise publish before probing; publication failure errors immediately without retry | Contract tests, real cold startup for the relevant architecture, and build acceptance |

The hot-cache path does not recalculate every file hash each time: it matches the receipt, checks that declared files exist, runs the version probe,
and repairs mode; it rebuilds only on failure. This source fact about the fast path is not a guarantee of complete
detection for every possible cache tampering. Do not describe it using the old claim of “hash verification on every run.” Do not delete user or other-instance caches to reverify it.

`publishRuntime` performs bounded retries only for Windows EPERM/EACCES/EBUSY; macOS and permanent
errors fail immediately. The [contract tests](../../apps/desktop/runtime/codex.test.cjs) for final-cache probe ordering and retry behavior
include simulated rename and source-order assertions; they are not real measurements of Defender/file-handle contention. Real distribution, cold startup, and cross-platform product acceptance remain owned by the build Owner;
Adapter readiness probes, this development artifact cache, and upgrade checks do not substitute for one another.

Choose checks according to the change's Owner: Desktop follows the [testing guide](../../apps/desktop/docs/quality/testing.md),
Serve follows its [local rules](../../apps/serve/AGENTS.md), and dependencies/packaging follow the build guide.
For a gate that is already red, run the same command on an unmodified baseline; do not attribute old failures to the new change or call a baseline failure a pass.
Product behavior requires a real product flow and final screenshots; documentation, protocol tests, healthz, and screenshots of source files do not replace acceptance.
This page only organizes entry points; it has not run installation, product startup, or cross-platform acceptance.
