<a id="desktop-测试与验收规范"></a>
# Desktop Testing and Acceptance Guidelines

## Scope / Non-goals

This document guides the choice of standards gates, unit, render, typecheck, Electron e2e, and real-product acceptance. Fixtures and direct internal calls must not be presented as user paths.

## Source of truth

Run all `pnpm ops` commands below from the repository root. Desktop package scripts and hooks are internal domain recipes, not a second set of recommended user entry points.

`components/ui.render.test.ts` uses Playwright Chromium by default; when Chrome is installed locally, explicitly set
`PLAYWRIGHT_CHANNEL=chrome` to select that browser. This test choice does not install a browser or change the product host;
Chrome fixture results cannot be counted as Electron or Windows acceptance.

`renderFixture` uses Chromium provided by `@playwright/test`; installing Node dependencies does not mean the browser has been downloaded.
If the required revision is missing, after download authorization run the following from the repository root
`node apps/desktop/node_modules/@playwright/test/cli.js install chromium`, then rerun the original test.
Do not use the standalone `playwright` package CLI to infer the revision required by the test framework; the two may be different versions.
Archived fixtures resolve the current repository development environment by default through the Python Owner's `developmentPython`
(including `VENV` / CI context), without falling back to system `python3`; the caller remains responsible for explicit `TEST_PYTHON`.

See the [repository formatting guidelines](formatting.md) for source formatting and generated-artifact boundaries.

The scripts in `package.json`, test recipes in `scripts/ci/`, nearby `__tests__/`, source-adjacent tests, `e2e/`, and main's shoot/drive/workbench harness are the sources of truth for execution.
Desktop defaults to the pnpm version declared by the repository and `pnpm-lock.yaml`; `package-lock.json` is used for the explicit npm compatibility path. Both are real installation inputs and must be maintained together when dependencies change.

<a id="工程脚本接口"></a>
### Engineering Script Interfaces

**current (directory contract runs on request)**: `directory-test` is not part of the default quality/security build gate.
Only an explicit run of `pnpm ops ci test integration --scope desktop --suite native-contract`
requests the test through `runDirectoryContract: true`. Ordinary native compilation records
`contracts.directory: "not-requested"` in `build.json`; an unrun check is not counted as passing. It is recorded as
`passed` only after an explicitly requested successful run; any failure (including SIGKILL) keeps a nonzero exit. Other native contracts, security policies, signing, and artifact checks retain their existing requirements. This trigger policy was explicitly adjusted by the user; it is not an automatic SIGKILL exemption.
The default compilation has been verified on macOS; the same trigger policy still needs acceptance on a Windows host.

ops owns user parameters and cross-domain orchestration; Desktop package scripts are domain recipes and do not call root ops in reverse.
Install, development, check, test, and build scripts are grouped together; lifecycle hooks sit next to the commands they decorate, and grouping does not change trigger conditions.

| Interface | Execution Source of Truth / Boundary |
| --- | --- |
| `pretest` | `scripts/ci/pretest.cjs` sequentially runs toolchain, runtime/build contracts, standards, and i18n tests/checks, stopping on the first failure |
| `test` / `test:coverage` | `scripts/ci/test.cjs` owns the sole file inventory and native-file subset; `test` runs the full set, coverage runs its complement, both use local concurrency 1, and coverage does not implicitly add `pretest` |
| CI `desktop-unit` / `desktop-extra-node` | Root CI reads the same inventory; coverage runs the complement, and layered native probes enter the existing serial `desktop-extra-node` without c8. Both stages follow host serial policy; generic CPU quotas do not increase file concurrency. Quarantine, reports, and the separate pretest stage remain |
| `test:e2e:mr/live/update` | `scripts/ci/e2e.cjs` runs one `build` through the toolchain, then selects the original smoke/live/update projects; generic `test:e2e` still does not build |
| `package` / `package:check` / `package:distribution` | Respectively local packaging, candidate checking, and channel builds; the actual installer shares the builder's fixed smoke test, candidate-directory checks do not execute it, and Desktop `package:dist` prepares and delegates distribution dependencies |

The `pretest` Owner owns the `standards` test recipe; root CI executes it even when temporary test isolation is enabled.
Its aggregated `visual`/`git` checks run only through this entry point and are not registered a second time in the `extra` stage.

**current**: Layered build/sandbox/menu, plugin, preference-persistence, DevTools, CDP relay, Browser, and Agent/search DOM checks are collected by the
[native subset declaration](../../scripts/ci/test.cjs).
Real-library assertions for native storage identity and legacy-directory migration also belong to this subset. At file scope, the compile Owner prepares the real library, so logic-test callers need not set its path manually; missing native-compilation prerequisites are reported as failures, not conditionally skipped.
Review other historically mixed files by responsibility; a coverage complement is not equivalent to a complete set of pure-logic tests. The original Owners retain responsibility for native dependencies and cross-platform acceptance.
Before native focus checks, confirm the host desktop is unlocked and interactive. If prerequisites are unavailable, preserve the failure/missing evidence; do not unlock automatically, simulate user activity, or relax focus assertions. Reverify after the environment is restored instead of repeatedly rerunning to get a green result.

Pure logic waiting/sampling may use [Node MockTimers](https://nodejs.org/download/release/v24.16.0/docs/api/test.html#class-mocktimers).
Destructured builtin-timer bindings must be synchronized and restored within the test scope using [syncBuiltinESMExports](https://nodejs.org/download/release/v24.16.0/docs/api/module.html#modulesyncbuiltinesmexports) to synchronize mocked and restored bindings. Preserve boundary, cancellation, and cleanup assertions. Do not use empty delays or change production waits/imports for isolation.
Clock helpers apply only to that logic-test file and do not prove native real-time behavior or host acceptance. Measure performance wall-clock time outside the mock scope; do not calculate runtime using a mocked Date.

Remove Desktop `package:installer`, `build:check`, `build:release`,
and `release`, which have no independent responsibility or active consumers. Use `package`, `package:check`, and `package:distribution` for those capabilities; users select them through ops.
Root `package:dist`, `package:check`, `package:verify`, and `scripts/desktop.cjs` are existing external-repository contracts, not duplicate aliases of the Desktop commands above, and are not removed. The original Owner retains signing, notarization, smoke-test, and acceptance prerequisites.

Engineering regression includes hook scheduling by real npm/pnpm in a temporary package with no dependencies, proving order, count, failure short-circuiting, and parameter boundaries. These temporary actions do not run the product and cannot establish Electron, installer, or Windows native acceptance.

Preparation, cleanup, timing, admission, and binding Native contracts for the macOS helper preserve stdout/stderr logs and write schema-1
`*-test.result.json` records containing the child-process PID, exit status, termination signal, and spawn error; PID is null when unavailable. Build-failure details retain these fields even when stderr is empty. A signal, startup error, or nonzero exit still blocks the build; do not rerun automatically or extend existing budgets. Uncertain process evidence for the real repair bridge remains a security rejection and must not be relabeled as archive failure or successful recovery; the independent archive-continuation contract does not replace real-machine exit eligibility. Correlate host diagnostics using the exact PID and executable; an XProtect framework warning alone cannot establish why a process was terminated.

Host endpoint security may reject a newly compiled program before the test entry point runs, even when strict ad-hoc signature verification passes;
valid signature does not mean execution is allowed. A timeout waiting for approval to run a single program, followed by default denial, can appear as SIGKILL with no test output. Diagnose this using the kernel exit reason and the security software's decision record for the exact program; the absence of code-signing or memory-error markers in kqueue is not sufficient to rule out this kind of rejection.

Before explicit authorization for a human execution confirmation is obtained, freeze the reviewed source, executable path, and SHA-256 inventory, and verify
the signature. Run only these exact artifacts with a fresh private fixture; record a rejection as a failure and do not replay automatically.
Then rerun the original full helper build and all 13 contract groups, checking each newly compiled artifact against the inventory.
Approval to run one test program does not authorize changing security policy, adding broad exceptions, deleting provenance, or switching launchers to evade rejection. Unattended tasks require a host with appropriate execution authorization; this development-host procedure does not replace acceptance of a formally signed App update or Windows product.

<a id="typescript-检查归属"></a>
### TypeScript Check Ownership

`tsconfig.json.references` is the project inventory; `scripts/ci/types.cjs` uses TypeScript's native config parser, preserving JSONC comments and trailing-comma support. The localization call checker reads the same inventory, so adding a project requires updating both package scripts and the scanner. `typecheck` runs serially and stops on failure; explicitly appended tsc arguments are still passed only to the final node project, preserving their original position in the web → node shell chain.

| Configuration | Ownership and Environment |
| --- | --- |
| `tsconfig.base.json` | Shared strict/noEmit/composite, Bundler resolution, and related options; does not unify environment or target |
| `tsconfig.node.json` | main/preload, original Node configuration and tests, ES2022; preserves the original checked files and environment |
| `tsconfig.web.json` | renderer, browser entry for mock UI, and nearby tests, ES2020/DOM; retains existing Node type compatibility and does not claim a pure-browser dependency graph |
| `tsconfig.tools.json` | Inherits the web checking environment for preview Vite plugins, mock services, reports, and validation; its actual type/value dependencies include DOM, so it is not a pure Node module |
| `tsconfig.test.json` | Root tests, both Playwright configs, Preview specs, E2E, and test closure; mixed Node/Electron and DOM test host, ES2020 target, runtime library types supplied by the existing host |

Nearby tests for existing src/main and renderer continue to be checked under ES2022 and ES2020 respectively; do not reduce environment verification for deduplication. Composite projects require imported source files to belong to a project too. The test config explicitly lists required main files rather than forcing unimported main composition roots and all preload files into the DOM environment. Maintain this declaration when a new test depends on a main file; `main/index.ts` remains fully checked by the node project without type-check exemptions.
Coverage regression verifies root configs, source, and tests against the actual file set in the compiler Program. Do not replace ownership checks with simple include-string matching or a blanket `src/**/*`. Shared contract closures may overlap across projects.

Development tooling was exercised on macOS this round, and Windows path, Node child-process, and package-manager compatibility was analyzed; this does not waive Windows native acceptance for product runtime, packaging, installers, signing, or updates.

Electron asar artifacts on macOS and Windows are self-contained: put npm packages required for building in `devDependencies`, and statically inline non-host dependencies of main and preload. Do not declare runtime npm dependencies, bundle `node_modules`, or relax closure checks. The build config disables the optional native `ws` extension; do not rely on runtime dynamic loading. When dependency classification changes, run `pnpm ops cd build release --stage dir --candidate` on a clean commit. Ordinary builds and closure unit tests do not replace real asar verification; record each platform's result separately.

Dependency or `overrides` changes must update both Desktop lockfiles. Use the Node/pnpm declared by the repository and run the following commands from the repository root; use a verified npm environment for the npm compatibility path:

```bash
pnpm --dir apps/desktop install --lockfile-only --ignore-scripts
pnpm --dir apps/desktop install --frozen-lockfile --lockfile-only --ignore-scripts
npm --prefix apps/desktop install --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix apps/desktop ci --dry-run --ignore-scripts --no-audit --no-fund
git diff -- apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/package-lock.json
```

The pnpm frozen-lockfile check and npm dry-run must exit with code 0 and no lockfile errors. Existing `node_modules`, passing unit tests, or a successful non-frozen install cannot replace these checks. CI's `desktop-lockfile` job repeats the npm check; post-install product acceptance is still performed separately for affected behavior.

## Current / Required / Gap / Advisory

- **current**: `pnpm ops ci test --scope desktop` aggregates deterministic main/renderer tests; `typecheck` covers web/tools/test/node projects through the solution; e2e and the Desktop harness cover real Electron paths.
- **current**: `scripts/ci/test.cjs` explicitly declares the TS contract for root files, `src/**`, `preview/`, and `e2e/fixtures/` for `test`/`test:coverage`; only `src/**` is recursive, and CI expands the same scopes without collecting `tmp/` baseline copies. Fixture contracts are not Electron E2E; other `.cjs/.mjs` entry points still run according to this inventory.
- **current**: The installer/runtime E2E fixture contracts run with coverage collection in `desktop-unit` and are not repeated in `desktop-extra-node`. Existing DMG isolation and Windows-not-applicable classification follow this single entry point; deduplication does not establish native mount acceptance.
- **current**: `test`, `test:coverage`, and CI `desktop-unit` execute files using the same serial constant owned by Desktop testing. The aggregate suite includes browser and Vite/native compilation; generic CPU quotas must not increase host file concurrency, and loosening per-test timeouts is not a substitute for controlled orchestration. Separate pure-logic and API stages still receive CPU quotas from their respective Owners.
- **required**: Multi-file Desktop tests MUST run through `pnpm ops ci test --scope desktop` or the domain entry `node scripts/ci/test.cjs`; `TEST_CONCURRENCY` owns file concurrency. MUST NOT assemble a “complete main command” with bare `node --test` and a glob to bypass this constant: without an explicit `--test-concurrency`, Node derives parallel child processes from `os.availableParallelism() - 1`. The aggregate suite includes browser and Vite/native compilation, and an individual child process can use multiple GB; full-core parallelism can exhaust physical memory on a small host and trigger system jetsam, worsening wall-clock time. If existing `pretest` failures block `npm test`, the correct workaround is to call `scripts/ci/test.cjs` directly—it does not include `pretest`, still injects the serial constant, and forwards parameters such as `--test-skip-pattern`. This does not apply to focused single-file tests.
- **current**: Renderer Vite tests that explicitly configure optimized caching use the file-scoped resource lifecycle registered by `src/test-helpers/render.ts`'s
  `renderServers` registers a file-scoped resource lifecycle. The cache is under Desktop's `node_modules/.vite-tests/`
random owned directory outside the renderer source root. Within a file, compiled caches are reused only by root/cacheKey, not business state. Existing plugins, service parameters, and browser isolation remain unchanged. The file after hook waits for creation, closes all registered services, verifies listeners have stopped, and then deletes its owned cache; cleanup failures are reported and the cache is retained for diagnosis.
`renderFixture` also uses a cache outside the source tree. This rule does not authorize deleting user data or other worktree resources, nor does it allow test-generated artifacts by excluding source inventory or expanding the protected-manifest limit.
- **current**: After Vite, packaging uses `scripts/cd/build.cjs` to check the complete main/preload module closure; `scripts/cd/verify.cjs` additionally checks asar, default optional-dependency boundaries, and shared browser Node for the exact App / read-only DMG. Node's original hash is checked before signing; after signing, verification uses the unsigned digest, architecture, version, and real driver transport.
- **required**: Put renderer build dependencies in devDependencies; main/preload must be complete bundles with only Electron/Node built-ins external. Shared Node applies only to bundled Python and must not affect development or explicitly external Python. The browser Skill's real product consumption path requires separate acceptance; transport probes do not replace it.
- **required**: Each change MUST run deterministic gates proportionate to the affected artifact. Desktop dependency changes MUST also validate lockfiles and `npm ci --dry-run`; renderer behavior changes MUST use the real product path and inspect screenshots/DOM/persisted results.
- **required**: Changes to standards/gates MUST run `pnpm ops ci check docs desktop`, `pnpm ops ci test --scope desktop`, `pnpm ops ci check types desktop`, and the corresponding domain regressions.
- **required**: Do not claim product acceptance based on a fake provider, static fixture, direct dispatch call, or hand-written bridge JSONL.
- **required**: Source-text regex assertions (`readFileSync` + `match`) MUST NOT exceed 30% of a single feature's total tests. Regex MUST pin semantic invariants (wiring, channel registration), not whitespace or statement order; new tests SHOULD prefer behavioral assertions.
- **required**: A newly added test fixture, builder, or eval scenario MUST have at least one consuming spec in the same MR; test infrastructure without a consumer must not be merged. See [test layers and shared contracts](../architecture/testing-strategy.md#测试分层与共享契约) for testability details, and the [LLM evaluation overview](../architecture/evaluation.md) for model evaluation.
- **gap**: Not all preview-grade complex components have full Electron interaction coverage; explicitly report them as unaccepted when evidence is missing.
- **advisory**: MAY run focused tests first for quick feedback, but must run the aggregate entry point before completion; report the command, error, and missing prerequisites on failure.

## Ownership / Dependency

Pure functions belong in nearby unit tests, component contracts in render tests, main/preload boundaries in their corresponding tests, and user-visible cross-layer behavior in Electron/real-backend paths. Tests must not change production precedence or persistence semantics for isolation.

See the [preview architecture](../architecture/preview.md#enforced-by) for layered verification boundaries in the product collaboration Web + mock workbench, and the [development plan](../work/plan/preview.md) for phases. Report preview-scenario regression, real Web-service integration, and real Electron acceptance separately. Full-page coverage must link the page inventory, scenarios, and consuming specs; native shells/substitute areas and unintegrated items do not count as complete interaction passes. Mock data does not prove real execution, saving, security authorization, or native-platform behavior.

<a id="内置浏览器验收"></a>
## Built-in Browser Acceptance

- **required**: When changing native overlays or web-content occlusion classification, regress the `native activity tooltips` case in `e2e/browser-cdp.spec.ts`, covering slight overlap with the literature overview on hover, pointer exit, and repeated switching. Verify that native web bounds/visibility, page dimensions, and scroll position remain unchanged, while also checking native tooltip content, theme, geometry, and dismissal. Failure display for text-only tooltips needs a deterministic test; do not assert only that the webpage remains visible while missing that it covers the tooltip.
- **current**: On macOS, this regression observed that `desktopCapturer.getSources()` causes the main window to lose focus. The native tooltip is dismissed according to its lifecycle, but simulated hover in the main renderer may retain the same DOM node. The test asserts the contract before capturing the composite image; the next round will restore interaction using real window focus and pointer exit/re-entry. Do not make production overlays ignore focus loss for screenshots, loosen stale-revision checks, or extend timeouts after merely hovering the same node again.
- **current**: `src/main/browser.test.ts` checks real Electron views, sessions, network isolation, rejection of external CDP for Agent-isolated tabs, and destruction. `e2e/browser-cdp.spec.ts` includes both a minimal Electron protocol probe and real Desktop acceptance. Real Desktop cases cover the left-side entry, address navigation, per-tab DevTools, restricted browser-level CDP, public-form DOM/input/click/screenshot in the same product instance, and reconnection after a DevTools conflict. The dual-principal protocol probe verifies that when a manual tab switches to Agent context, its target disappears and the old session becomes invalid, while other manual tabs remain controllable by Playwright. `e2e/browser-workbench.spec.ts` also checks dark theme, browser controls in narrow windows, and the standalone settings page. The probe alone is not product acceptance.
- **required**: `e2e/browser-workbench.spec.ts` and a real Desktop instance must continue to verify fixed top tabs, native-view boundaries, occlusion, and window lifecycle. External Playwright must also check that only browser webpage targets are discoverable, as well as invalid tokens and disable/reconnect behavior. An intermittent network failure cannot be replaced by passing an isolated case instead of the full regression suite.
- **required**: Final screenshots must be composite captures of the real product window on an unlocked desktop, including both the main renderer and native `WebContentsView`. `BrowserWindow.capturePage()` captures only the renderer and `webContents.capturePage()` captures only the webpage; neither alone proves the webpage's visual placement in the product. Open and inspect every saved screenshot.
- **required**: On Windows, first run `pnpm ops cd build local --platform win32 --arch x86_64` and verify Velopack Setup/full and `release-result.json`; then repeat navigation, DevTools, external Playwright, window-close/tray restoration, and screenshots on a real Windows machine. macOS builds or tests cannot replace this acceptance.
- **gap**: The macOS native download-directory chooser and restart-persistence case must be explicitly run on an unlocked desktop without a system credential prompt using `SCHOLARSEED_NATIVE_CHOOSER_E2E=1 npx playwright test e2e/browser-download.spec.ts --project=workbench -g 'chooser persists'`. The current host's Google Chrome for Testing keychain prompt obscures the directory chooser, so the test's default skip cannot be counted as a pass.
- **gap**: If macOS is locked, screen-recording permission is missing, or a Windows host is unavailable, record the exact blocker and independently passed checks; do not downgrade to protocol probes or split screenshots and present them as complete product acceptance.

<a id="正反例"></a>
## Examples and anti-patterns

```text
Good example: Change a Dialog → render contract + Playwright keyboard/focus + screenshot inspection
Bad example: Call only openDialog() and assert state=true, then claim the dialog experience passed
```

## Enforced by

CI/local entry points are `pnpm ops ci check docs desktop`, `pnpm ops ci test --scope desktop`, `pnpm ops ci check types desktop`, relevant Playwright tests, or the `scholarseed-desktop` harness.

## Update triggers

Update this document when the test aggregate entry point, e2e project, harness flag, real acceptance definition, or standards gate changes.

<a id="desktop-布局验收"></a>
## Desktop Layout Acceptance

Desktop layout acceptance follows the [window layout boundaries](../design/vibe-coding.md#desktop-窗口布局边界).
Use `WORKSPACE_WINDOW_SIZE` and `WORKSPACE_WINDOW_MINIMUM` from `src/window.ts`,
Use the real main window at default and minimum supported sizes; do not require 480px / 600px viewports below the native minimum.
Validate container split panes, long text, and text scaling within supported window sizes. Gather macOS and Windows evidence separately; screenshots made with `page.setViewportSize()` that bypasses native constraints do not establish product support.

## Stop condition

Once the smallest sufficient verification matrix is selected, proceed to the test source. If the environment blocks product acceptance, retain deterministic evidence and explicitly report it as unpassed; do not lower the bar and claim completion.

<a id="主界面就绪与启动截图"></a>
## Main Interface Readiness and Startup Screenshots

- **current**: `--shoot` and `--package-check` use `showInactive()` to display the real window without stealing focus, avoiding stale content in a hidden window. Before and after the scenario, `--shoot` waits for the real workbench and navigation controls to mount and for full-screen loading/error pages to disappear, rechecks across two animation frames, and requires two consecutive passing probes. On timeout it saves `workspace-not-ready.png` and exits nonzero; the diagnostic image is not successful acceptance evidence.
- **current**: `--package-check <result.json>` retains backend and renderer gates, additionally returns `workbench` and `readyMs`, and saves `<result.json>.png`; if the workbench is not ready, it fails and cleans up the backend through the existing exit path. `readyMs` measures only the main-interface probe phase, not full cold-start time.
- **required**: Manually inspect the final screenshot and confirm the home page is usable through real page interaction; DOM readiness alone does not prove screenshot pixels have updated. Signed-installation-package, first launch with an empty Store, and security-integrity checks remain part of existing packaging acceptance; development-mode screenshots cannot replace those gates.
