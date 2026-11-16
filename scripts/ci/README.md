<a id="ci-脚本目的分工与使用方式"></a>
# CI Scripts: Purpose, Responsibilities, and Usage

This directory connects existing automated test and packaging entry points into a traceable quality workflow. It **does not fill test-coverage gaps or implement business functionality**. Each macOS / Windows runner executes and determines results independently; no cross-platform summary report is required.

See [Development and Delivery Entry Points](../../docs/runbooks/development.md#ci-模式临时隔离与质量结论) for the current quality-determination boundaries. This document describes current code behavior; the actual execution plan is defined by `planStages()` in `test.cjs`. It does not mean every platform has completed on-device acceptance.

<a id="从哪里开始"></a>
## Getting Started

Run from the repository root. First install the repository-required Node/npm, Desktop dependencies, Python `.venv`, Bun, and managed runtime toolchain. Scripts do not install dependencies for you; the `ci:test` entry point itself also depends on Desktop TypeScript.

| Command | Current behavior | Intended use |
| --- | --- | --- |
| `pnpm ops ci test smoke` | Runs the explicitly registered `smoke-unit` / `smoke-core` scope without temporary isolation | Quickly checks necessary logic and core real-data paths; does not replace full CI or release admission |
| `pnpm ops ci test --profile quality` | Offline tests with registered temporary isolation enabled | First validates executable deterministic flows without real models or SkillHub |
| `pnpm ops ci test --profile quality --strict` | Offline tests without temporary isolation | Checks whether isolated items can be restored; still does not run external-model or SkillHub acceptance |
| `pnpm ops ci test --profile quality --with-external` | Full-configuration mode without temporary isolation | Includes orchestrated real-model and SkillHub acceptance; missing configuration fails, with no automatic downgrade |
| `pnpm ops cd build local --workflow package-acceptance` | Full tests → fixed smoke → package → new-package E2E | Build-delivery gate; proceeds only after each prerequisite stage passes |
| `pnpm ops cd build release --workflow distribution <构建参数>` | Prepare dependencies → Desktop builder runs fixed smoke → release package | Smoke prerequisite before release packaging; does not replace full CI or release acceptance |

All package entry points share one fixed smoke run in the [Desktop builder](../../apps/desktop/scripts/cd/build.cjs); there is no skip parameter and old reports are not reused. `distribution` retains dependency preparation and does not run smoke a second time. Checks for `app`, `backend`, `dir`, and candidate directories do not trigger this gate. Standalone smoke requires dependencies to be prepared beforehand and the source fingerprint to remain unchanged before and after the run (the initial state may be dirty). `darwin` and `win32` use the same explicitly selected Python and Node cases; this does not change the full-CI platform execution plan, add platform skips, or relax decisions.

Both entry points support `--result <path>` to specify the final JSON report path, for example:

```sh
pnpm ops ci test --profile quality --result tmp/quality.json
pnpm ops cd build local --workflow package-acceptance --result tmp/ci-package.json
```

Use the root `pnpm ops` entry point, or that same entry point with `--package-manager npm` explicitly selected. The CLI creates a real package-manager context, and child stages inherit its `npm_execpath`; it does not fake npm identity. Do not directly run `node test.cjs` / `node package.cjs` without the required context. Package-acceptance workflows do not accept skip, offline, or cross-platform packaging parameters.

**A clean Git worktree is required before full `quality` execution.** `ci:test` checks the commit and worktree state at both the beginning and end; code changes during tests invalidate a passing conclusion. Write the specified report into an ignored artifact directory.

<a id="冒烟检查"></a>
## Smoke Checks

Run `pnpm ops ci test smoke` (or `pnpm ops ci`) from the root of a checkout whose dependencies are already prepared. The starting worktree may contain uncommitted changes; the starting and ending HEAD, index, and actual source fingerprint must match, and files must not be edited during the run. The report preserves the actual dirty state and fingerprint; do not treat a smoke result as release admission. First verify the repository-required Node, Python `.venv`, and Desktop test dependencies; the entry point does not install dependencies or download browsers. Missing dependencies are an environment failure and must not be replaced by skipping required items. A failure before the entry module loads may produce only stderr and a nonzero exit code; in that case, an old summary file is not a result from this run.

The former `ci:test:quick` has been removed; the command, profile, markers, and maintenance files are now consistently named smoke. Case scope and decision rules are unchanged, and 10 minutes remains the performance target. Smoke does not mean testing only successful paths and is not a faster substitute for full CI. The old `quick` profile and `tmp/ci-test-quick/` reports are historical evidence only; the new entry point does not read, migrate, or overwrite them.

The source of truth for selection is [smoke.json](smoke.json); execution in [smoke.cjs](smoke.cjs) reuses the existing runner and report adapter. `smoke-unit` checks necessary logic and protocols with fixed input and independent expected results. `smoke-core` retains real-data, cross-layer, or security-rejection paths. The manifest defines the specific Owner, stable identity, rationale, resources, real/mock boundary, and cleanup responsibility. Out-of-scope items are **not selected**, not passed or temporarily skipped. Smoke does not call real models, external services, or personal credentials; it does not represent acceptance of the renderer, native coordinator, packages, or model quality.

Current core selections include session artifacts, schema repairs, real literature delivery, HTTP activity, and startup/shutdown lifecycle. They cover reopen-and-read-back, idempotency, preserving data on conflict, transaction recovery, security rejection, and explicit release. Necessary unit scope includes file naming, side-effect guards, delivery projections, and smoke-infrastructure rules. Candidate evaluations in the manifest explain why real user paths were not selected; pure projection logic must not be described as real renderer acceptance.

The original 42 literature acceptance cases retain their identities and exact-selection entry point through `unittest.load_tests`; each business method runs in one new interpreter, with Home/TMP/Trace isolated before import. The parent proxy adds no business coverage and is not counted twice. The real child report, raw output, and exit status are stored in the outer case's `childObservation`. Parent-case duration includes subprocess orchestration; read the child report for actual business-stage timing. Independent Home/literature-library and real-connection-close checks cannot be replaced by random project IDs, SQLite transaction exit, or subprocess exit. Cleanup-check failure remains a failure; do not close the resource afterward and claim that the tested resource released itself.

Python suites retain their required-case baseline in `requiredCases`. Before execution, all identities (including dynamic, parameterized, and inherited cases) are automatically collected through the same unittest entry point in an independent isolated process, then frozen as this run's `expectedCases`. New cases are added automatically without maintaining a total count; a missing required case or duplicate identity fails during the prerequisite stage. Collection mode does not run fixtures, tests, or prefetch; its report contains no execution results. After execution, the complete set and pass status are still checked item by item; do not infer `expected` from execution results. New suites must still be registered with the runner and smoke selection; Node suites continue to use explicit `expectedCases` / `expectedCount`. Invalid markers, missing core selections, duplicate identities, unexpected skips/retries, collection failures, missing or truncated reports, and cleanup failures must all fail. State the risk and budget before adding a necessary scenario, then measure it; do not temporarily reduce coverage to meet the overall budget.

Smoke always writes its summary to `tmp/ci-smoke/quality.json`; each run's raw reports and logs are stored in a separate `tmp/ci-smoke-*` directory. The fixed summary is atomically overwritten, and concurrent runs sharing that summary are prohibited. Smoke uses its own `smoke` profile and does not write `tmp/ci-test/quality.json`; release-quality checks must reject smoke reports. Consumers must check the exit code, this run's identity, source state, planned and actual results, and evidence integrity, not just `verdict`.

At command completion, print PASS/FAIL directly, the observed pass/fail/skip counts (including prerequisite checks), total duration, and the report's absolute path. Print the summary after writing the report and cleaning up locks, and retain a final-line JSON object for machine consumption. Statistics do not change decision rules: report missing results separately, and executor or cleanup failure remains FAIL even if no test cases failed. If results are not yet available, show the counts as unknown; do not read a report from a concurrent run. If the report is unavailable, explicitly warn against using a historical file. Terminal total duration includes final report writing and lock cleanup, so its boundary differs from the duration snapshot in the JSON.

<a id="smoke-运行中进度与隔离用例并发"></a>
### Smoke Progress and Isolated-Case Concurrency

The Python stage uses a separate progress channel to report suite/case start, completion, and duration in real time. When no event arrives, it reports elapsed time and active cases every 10 seconds. Raw stdout/stderr and per-case JSON are still stored separately; progress text does not affect quality decisions.

Smoke concurrency capacity is controlled by `CI_SMOKE_JOBS` (an integer from 1–12, defaulting to 8 when unset). It changes capacity only, not the case manifest, timeouts, assertions, or quality gates. Suite and case concurrency use their budgets in separate phases; they must not be multiplied through nesting. Capacity is not the total OS process count; the coordinator and fixtures may also create subprocesses.

Execution rules:

- **Serial within a suite (default):** Ordinary unittest cases retain their original class/module fixtures and execution order; short logic cases do not start extra processes. Tests dependent on a shared fixture lifecycle must not be marked as isolated cases.
- **Parallel cases (explicit selection):** Only suites in `run_all.PARALLEL_CASE_SUITES` may enable this, and only their `IsolatedExecution` proxies may run in parallel. Currently, only literature delivery is selected; each case still has an independent process, Home, database, and cleanup check. Consecutive isolated cases form a group, submitted only when first accessed; an empty slot automatically takes the next case, while reports are still delivered to the standard unittest runner in original order.
- **Serial boundaries:** An ordinary case blocks parallel groups before and after it; a later group cannot run early. On early stop, first cancel tasks that have not started, then wait for all started subprocesses and check cleanup; failures in unvisited cases must also propagate.
- **Exclusive suites:** `RUNTIME_BINARY_EXCLUSIVE` and `NATIVE_COORDINATOR_EXCLUSIVE` mark suites that use a real runtime or account-level coordinator. Run them one at a time after the concurrent batch finishes. A random Home and new process cannot isolate fixed ports, registry keys, shared instances, or account-level locks. New tests of this kind must be registered as exclusive; do not mask conflicts with retries. Suites that enable case parallelism also exclusively consume the suite-execution budget.

Other entry points run cases serially by default. Preserve every case's original assertions, gates, and process-scope checks; do not skip, retry, or reduce cases.

For concurrent cases, `childObservation.executionMs` includes subprocess creation, execution, and report collection; the child report retains actual setup/test/teardown/cleanup durations. The outer case duration represents only waiting to consume results in order and cleanup; it is no longer equal to total subprocess execution time. Do not add overlapping subprocess durations and call the result wall-clock time.

<a id="总预算参考环境与验收"></a>
### Total Budget, Reference Environment, and Acceptance

The total budget is 900 seconds (15 minutes), owned exclusively by `budget.targetMs` in `smoke.json`. It leaves headroom for slower or resource-contended hosts but does not guarantee a pass under arbitrary load. Only the total wall-clock budget is relaxed; the case manifest, concurrency capacity, per-case timeouts, assertions, result completeness, and cleanup gates do not change.

The current reference host is macOS 15.7.4, 11 logical CPUs, 36 GiB RAM, Node v24.16.0, and Python 3.12.13, with dependencies preinstalled; the host is **not exclusive**. Windows must be verified separately; a macOS result does not imply a pass. Dependency installation is excluded from the execution budget, but preparation and cache conditions must be disclosed. Do not rely on undeclared warm-up or build artifacts from other tasks.

Performance conclusions must come from **three consecutive serial runs of the same final version**. Pause other heavy validation for this task, and record every sample, not just the fastest. Each run must take no more than 900 seconds from launching the package-manager command through writing the final report and normal exit, including prerequisite checks, preparation, execution, resource waits, and cleanup. Killing the process at the deadline is not a pass. The manifest owns the total budget; the command checks it after execution and lock cleanup, and the Desktop builder separately checks the complete smoke subcall. Packaging does not proceed if the budget is exceeded. Do not omit failure convergence even if it exceeds the budget. A summary before lock release is a snapshot; use terminal JSON, exit code, and external wall-clock time for final unlock/exit cost. Record external wall-clock time, report duration, exit code, cache/host load, stage costs, and a separate evidence directory; preserve each run's summary so later runs do not overwrite earlier samples. Do not claim the target is met until all three runs have been measured; use final-version evidence in the delivery record as the measurement source.

Timing interpretation: summary `phaseDurations` separately records preparation/selection, prerequisite-report writing, stage execution and waiting, and final integrity checks/decisions. `timingBoundary` states that final-summary writing and the lock lifecycle still count toward **external wall-clock time**. In opt-in Python reports, suite `timings` records queue waiting, preparation, process creation, child-process execution and waiting, scope checks, directory cleanup, and drain on failure; case `timings` records setup, test, teardown, cleanup, and total duration. A case is a subset of the child-process execution interval, and nested operations are attributed to their outer stage. Do not sum parallel-suite durations and call them whole-run wall time, or artificially split execution from system waits. Keep class/module fixtures and framework costs as an explicit unallocated interval; do not infer cleanup cost from the residual total duration.

Record the final three-run measurements, preparation/cache and host-load notes, command-exit evidence, and corresponding immutable run directories in the cumulative acceptance record for this same MR; retain them in an ignored local archive. Do not change the source version used for the completed three-run sample merely to backfill numbers. The final conclusion must be tied to the commit and all three original evidence sets; earlier M1 or rule-test timings are not substitutes for final samples.

<a id="失败排查与追加验证"></a>
### Failure Diagnosis and Additional Verification

- First inspect the exit code and this run's summary, then read raw reports and stdout/stderr for the failed stage. Distinguish assertion failures, missing environment prerequisites, timeouts, runner errors, and cleanup failures.
- Check source state at the beginning and end, differences between the manifest and actual collection, report summaries, and completion markers. Do not delete missing items, add retries, or relax criteria to force a pass.
- Each case has its own home, database, and workspace. Register resources for release immediately after acquisition; also clean up after partial initialization failures, and preserve original failures separately from cleanup failures. Do not rely on GC, forced exit, killing processes by name, or deleting active directories for cleanup.
- For data/transaction/persistence changes, add the owning data integration checks; for process, permission, lock, platform/native changes, add native and target-platform verification; for renderer/user interaction, add real render/E2E; package, external-model, and release requirements continue through the existing full entry points.
- Final integration still runs `pnpm ops ci test --profile quality` to check the original plan and report semantics. A passing smoke run cannot turn a baseline failure in the full entry point into a full green result. Record unrelated existing failures separately for comparison; do not automatically expand this task's scope.

<a id="为什么拆成这些文件"></a>
## Why the Scripts Are Split Across These Files

| File | Responsibility | Design rationale |
| --- | --- | --- |
| `test.cjs` | Declares the platform execution plan, checks prerequisites, runs tests, normalizes reports, and writes `quality.json` | Test frameworks produce different outputs; adapt them in the orchestrator rather than making business tests depend on CI rules |
| `verdict.cjs` | `judgeRun()` calculates `pass` / `fail` from stage, case, skip, and evidence states | Separates execution from decisions so deterministic tests can verify the rules; it is a module, not a standalone CLI |
| `quality.py` | pytest plugin that reports collected cases, results, subtests, retry counts, and collection errors | The pytest exit code alone is insufficient; we must know whether cases were omitted, collection failed, or retries occurred |
| `package.cjs` | Orchestrates pre-build tests, the existing packaging command, package-identity checks, and post-install E2E | Release depends on strict test evidence; source-app or old-build results cannot count as acceptance of a new package |
| `model.cjs` | Prepares real model configuration, checks the Office corpus, isolates the CI model home, and removes temporary credential copies | Configuration is a prerequisite, not a substitute for passing tests; avoid reading or contaminating a developer's runtime state |
| `skillhub.cjs` | Validates the test namespace, URL, read/write token files, version manifest, and ZIP digest, and prepares an independent cache | Avoid false external-acceptance results caused by incorrect permissions, test space, or drifting packages |
| `external-cases.json` | Precisely registers real-model E2E cases that offline mode is allowed to skip | Missing external credentials differ from product failure; arbitrary `skip` is not allowed |
| `quarantine.json` | Registers temporarily quarantined suites, stages, Node / Playwright cases, and reasons | Temporary containment must be explicit, auditable, and reversible; do not delete tests or change production logic to force a pass |
| `generate-office-corpus.cjs` | Generates the fixed DOC / DOCX / XLS corpus and digest manifest for maintainers | Generation requires LibreOffice, but CI uses the corpus in the repository and does not require LibreOffice on every machine |
| `*.test.cjs` | Verifies orchestration, decisions, model-data preparation, SkillHub, and package-validation rules | CI itself can falsely report green; maintain rule regressions separately from product cases |

This directory reuses existing entry points such as `apps/serve/tests/run_all.py`, Desktop unit tests, and Playwright; it does not duplicate test implementations. Package startup and operations are owned by `apps/desktop/e2e/package.spec.ts` and its fixtures.

<a id="执行链路与平台边界"></a>
## Execution Flow and Platform Boundaries

```text
ci:test
  prerequisites → build/validate Skill sources → current-platform Python/Node/Bun stages
                → Desktop build → source-app E2E → evidence checks → judgeRun → quality.json

ci:package
  ci:test --with-external → strictly validate quality.json
                          → pnpm ops cd build local → validate release-result.json and package digest
                          → package-project E2E → ci-package.json
```

`ci:test` preserves results from each stage wherever possible; if prerequisites or a dependency stage fail, affected stages are marked blocked, not falsely passed. `ci:package` is a serial gate: test failure prevents packaging, and packaging failure prevents package E2E.

| Behavior | macOS (`darwin`) | Windows (`win32`) |
| --- | --- | --- |
| Current execution plan | Skills, Python main and standalone suites, model/SkillHub stages, Desktop tests, and source E2E | Skills, Desktop tests, and source E2E; currently does not orchestrate the Python main suite or SkillHub stages from the macOS branch |
| Other-platform native cases | Designated Windows cases are marked not applicable according to the rules | Designated macOS cases are marked not applicable according to the rules |
| Post-package input | The `.dmg` built in this run | The `.exe` built in this run |

Linux is not a supported platform. Platform not-applicable cases, external-dependency skips, and temporary quarantine are three different rules. Do not treat macOS results as Windows acceptance or interpret the currently selected stages as complete coverage.

<a id="如何判断成功"></a>
## Determining Success

When report generation completes normally, `pass` corresponds to exit code `0` and `fail` to `1`. Callers must check both the exit status and JSON; a command may fail during startup or argument parsing and produce no final report.

`test.cjs` first parses each framework's results, then passes them to `judgeRun()`:

- The Python main suite checks planned / results / omitted against the summary verdict; pytest checks the collection manifest, results, and exit status.
- The Node stage parses test summaries and skips; temporary omissions are written separately to the report. Node test options must precede the test-file list so concurrency or skip options take effect.
- Playwright checks JSON structure, global errors, statistics, and per-case results. Source E2E explicitly sets `--retries=0`; retried results do not count as passes.
- The stage plan must be complete, ordered, and unique; case results must exactly match the expected set, with no duplicates, omissions, or unexpected results. Note: some stages derive expected cases from this run's report, not an independent inventory of all repository cases; this cannot prove coverage.
- Error exits, timeouts, missing reports, empty execution, and unallowed skips or retries all fail. Build stages without per-case reports are judged using command-level evidence; do not claim per-case coverage.
- Source must remain clean and the commit unchanged before and after the run; SHA-256 values recorded for stage reports must still match at final evaluation.

`package.cjs` does not trust `quality.verdict` alone: it also checks full mode, platform, commit, stage plan, and report presence, then reruns the decision rules. It next validates the build's platform, architecture, commit, package path, and SHA-256, and requires the designated post-install main-flow E2E to have actually run and passed.

<a id="报告在哪里应该读什么"></a>
## Report Locations and What to Read

By default, the quality summary is written to a fixed path and overwritten after each run; stage evidence remains in a separate run directory:

- `tmp/ci-test/quality.json`: final `ci:test` result (use `--result` to specify another path).
- `tmp/ci-smoke/quality.json`: independent smoke result; scope and report-path override options are not accepted, and raw evidence is retained in a separate run directory.
- `tmp/ci-package-*/ci-package.json`: final packaging-chain result; the same directory contains the pre-build `quality.json`, `release-result.json`, and package E2E report.
- Stage JSON and stdout/stderr logs are stored in the run directory. Playwright screenshots and traces must also be reviewed with Desktop's test-artifact directory.

At completion, the entry point writes a JSON summary containing `result`, `platform`, `commit`, and `verdict` to stdout, with progress on stderr. **`npm run` itself prints command instructions, so the entire terminal output is not pure JSON.** Automated consumers should prefer the file specified by `--result`.

Important `quality.json` fields: `schemaVersion`, `profile`, `validationScope`, `quarantine`, `skips`, `plannedStages`, `sourceClean`, `sourceAtEnd`, `reportsIntact`, `stages`, and `failures`. Read failure reasons first, then inspect the corresponding stage reports and logs.

Even if default quarantine mode returns `pass`, it means only that the `deterministic_with_declared_quarantine` scope passed; `--strict` is still an offline scope. **Neither means strict package acceptance passed.** `reviewAfter` in `quarantine.json` is a manual-review date; current code does not automatically restore cases when it expires.

<a id="测试数据与凭据"></a>
## Test Data and Credentials

- **Test workspace / user state:** Desktop fixtures create an isolated home, workspace, userData, sessions, and artifact directories for each case. Initialize them through public configuration; do not change production path precedence for tests. Repository test user state is not real-model authorization.
- **Office:** By default, use the [fixed corpus](../../apps/desktop/e2e/fixtures/office-corpus/) and verify its version manifest and file digests. For a custom corpus, set both `SCHOLARSEED_OFFICE_CORPUS` and `SCHOLARSEED_OFFICE_CORPUS_MANIFEST`. To maintain the corpus only, run `node scripts/ci/generate-office-corpus.cjs`, review the generated files and manifest, then commit them together; do not regenerate it on every CI run.
- **Local full mode:** Requires `config.json` and `model_profiles.json` under `SCHOLARSEED_REAL_HOME`, plus `SCHOLARSEED_ACTION_MODEL` and a different `SCHOLARSEED_ALTERNATE_MODEL`. Real tests use isolated runtime state, but the configuration source must still be valid.
- **Full CI mode:** `CI_PROJECT_DIR` enables CI configuration preparation; requires `SCHOLARSEED_CI_MODEL_CONFIG_FILE` and `SCHOLARSEED_CI_MODEL_PROFILES_FILE`. The script copies only model and connection configuration into a temporary model home, then removes copies it created at the end; it does not delete a real home provided locally. Native Codex credentials are not required; model configuration must provide a usable, explicit remote connection. Copying only these two JSON files does not migrate ChatGPT OAuth login state; subscription acceptance requires product login in the test instance.
- **SkillHub:** Current macOS full mode requires `SCHOLARSEED_CI_SKILLHUB_CONFIG`, `SCHOLARSEED_CI_SKILLHUB_MANIFEST`, `SCHOLARSEED_CI_SKILLHUB_PACKAGES`, `SCHOLARSEED_CI_SKILLHUB_NAMESPACE`, `SCHOLARSEED_CI_SKILLHUB_URL`, and distinct `SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE` / `SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE`. Token files must be ordinary files readable/writable only by their owner; use a dedicated test namespace.

Provide credentials through the runner's secure files or existing local configuration. Do not write them to the repository or treat a temporary home containing credentials as an uploadable artifact. If real configuration is missing, use the offline entry point rather than mocking a “successful model” as final acceptance.

<a id="修改这些脚本时"></a>
## When Changing These Scripts

When adding a stage, update the execution plan, report adapter, dependencies, and rule tests together. Any newly allowed skip must have a precisely registered reason; broad matching must not hide failures. Do not maintain pass counts that quickly drift in the README or claim that all CI is green.

Run the directory-rule regressions from the repository root:

```sh
node --test scripts/ci/__tests__/test.test.cjs scripts/ci/__tests__/smoke.test.cjs scripts/ci/__tests__/verdict.test.cjs scripts/cd/__tests__/package.test.cjs scripts/ci/__tests__/model.test.cjs scripts/ci/__tests__/skillhub.test.cjs
node --experimental-transform-types --test apps/desktop/e2e/fixtures/runtime.test.ts apps/desktop/e2e/fixtures/installer.test.ts
```

These are deterministic checks of orchestration and isolation; they do not replace `pnpm ops ci test --profile quality`, real Desktop workflows, or acceptance of a newly installed package.

<a id="chimp-出包与独立-e2e-job"></a>
## Chimp Packaging and Standalone E2E Job

The packaging job retains the existing command:

```sh
libutil build && libutil upload -f libinfo_lock.ini -y
```

`&&` ensures upload does not run if packaging fails. The job must preserve the command's nonzero exit status and must not append a separate batch line afterward. Existing pre-package smoke/native gates are still run by the build entry point; do not skip or relax them.

Run distribution-repository validation in a separate E2E job, from the distribution repository directory:

```sh
npm run ci && npm run test-e2e
```

Start the E2E job only after the packaging/upload job succeeds, and report validation results separately. Validation failure does not change the packaging/upload job's success status and must not be treated as validation passing. `npm run ci` prepares the upgrade baseline and test dependencies and runs controller tests; it does not package or upload.

External Chimp job configuration is outside this repository; split the jobs and set success dependencies in that task configuration. This repository document does not mean the online configuration has been changed, and no new release entry point is needed.
