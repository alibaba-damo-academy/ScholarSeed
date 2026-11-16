---
id: research-dev-cli-inventory
title: "ops Development Tooling Inventory and Migration Ledger"
doc_type: research
category: architecture
status: draft
date: 2026-10-23
updated: 2026-10-26
keywords: [cli, toolchain, monorepo, worktree, packaging, test-gate]
summary: "Records the current state of development scripts, requirement classifications, mappings from legacy entry points, implicit consumers, and lifecycle relationships to inform the ops CLI technical design and the coordinated one-time migration."
related: [proposal-dev-cli]
code_refs:
  - "package.json"
  - "scripts/shared/desktop.cjs"
  - "scripts/shared/workspace.cjs"
  - "scripts/pre/toolchain.cjs"
  - "scripts/ci/test.cjs"
  - "apps/desktop/package.json"
  - "scripts/ci/affected.cjs"
  - "apps/serve/tests/run_all.py"
  - "scripts/cd/distribution.cjs"
  - ".github/workflows/ci.yml"
  - "scripts/shared/python.cjs"
  - ".gitlab-ci.yml"
---

<a id="ops-开发工具现状与迁移台账"></a>
# ops Development Tooling Inventory and Migration Ledger

This page preserves the historical migration audit. The legacy private exporter and its projection tests are no longer part of the current public quality set;
see [Repository and Knowledge Boundaries](repositories.md) for current ownership, and use `scripts/ci/test.cjs` as the source of truth for the actual set.

<a id="1-范围基线与使用方式"></a>
## 1. Scope, Baseline, and How to Use This Page

This page is a standalone inventory of the current state and migration record, not the current CLI user guide or architecture specification.
The [overview design](ops-cli.md) is the sole source of truth for technical goals, command tree, module responsibilities, permission policies, and acceptance boundaries.

Facts are based on the source baseline `92f949471` in this worktree and were collected on 2026-10-23;
coverage includes root and Desktop package scripts, repository tools, backend suite entry points, and related CI/build consumers.
This was a read-only source inventory: no product, model, installation, build, or release was run, and usage frequency was not inferred from logs.
When source changes later, verify the current implementation first; do not treat this snapshot as an enduring guarantee of executable behavior.

Section 2 records the current state and its impact. The retain/merge/internalize/defer dispositions in Section 3 are target decisions;
the “Target” columns in Sections 4 and 5 are mappings pending implementation, not executable capabilities; Section 6 records existing hook relationships.
This ledger contains neither per-iteration investigation logs nor raw runtime evidence, and grants no authority to delete legacy entry points or migrate them.
During the coordinated cutover, implementers update affected sources, consumers, acceptance status, and cleanup results. Accepted changes to technical mechanisms are also reflected in the overview design; do not duplicate the command tree or permission policy in both places.
Items marked retain/merge are in scope for this one-time cutover, with no compatibility period for legacy public aliases. Internalized items continue to be invoked by lifecycle or domain Owners. Deferred items are explicitly excluded from this cutover; they are not staged rollouts within the same scope. The classifications and target mappings below do not change this delivery model; legacy entry points in the factual snapshot remain current code behavior until implementation is authorized.
The target root script is named `ops`; `pnpm ops` is recommended and Node directly runs `scripts/ops-cli.cjs`.
There is no separate CLI directory, dependency package, bin, or dist. Preserve names such as root `dev`, Desktop `dev`, and `predev` in the current-state columns; do not misstate target renames as baseline behavior. The legacy public root `dev` is removed in the coordinated cutover, with its capability provided by `pnpm ops dev`.
The target top-level commands are `pre`/`dev`/`ci`/`cd`, with no parallel aliases such as `prepare`/`env`/`debug`/`quality`/`deliver`/`maintain`.
The scope has been narrowed to match the latest design: user-data operations are deferred; the CLI itself directly runs source-contract and regression tests, without compilation or artifact installation; existing controlled entry points remain.

<a id="2-现状与问题证据"></a>
## 2. Current State and Evidence of Problems

The project has accumulated many root `scripts/`, Desktop-local scripts, and scripts in root and subpackage `package.json` files.
The tools cover environment setup, development startup, testing, standards checks, builds, and delivery, but users encounter file paths, legacy aliases, and different wrapper layers, without a unified interface organized around “what task do I need to complete now?”
This design first addresses discoverability of entry points, distinguishing their meaning, and consolidating responsibilities; moving scripts elsewhere or reducing the file count is not the goal.

| Current state and evidence | User confusion or maintenance risk | General problem to solve |
| --- | --- | --- |
| Root and Desktop both expose `dev`, `test`, `docs:check`, and similar entry points, but their meanings and setup scopes differ | Users do not know which directory to run them from, whether they start the real product, or whether they include prerequisites | Make target, scope, and mode visible; consistently locate the target worktree and execution cwd |
| `clean`/`distclean`, `test`/`desktop:test`, and multiple release aliases coexist | Users must remember legacy names, and maintainers cannot easily tell which entry points can be merged | Merge genuinely equivalent entry points and record legacy consumers and cleanup targets for the same cutover |
| `package:dist` and `package:distribution` have similar names but different dependency setup and external invocation contracts | Mechanical renaming may change CI and delivery behavior | Preserve orchestration boundaries and keep the fixed smoke test with the shared installer builder |
| `workspace`/`desktop`/`toolchain` and local scripts form multiple layers of setup and forwarding | Parameters, package managers, processes, and environment handling are scattered; changes in multiple places can leave consumers behind | Give orchestration a single Owner, reuse common execution capabilities, and keep domain policy with its original Owner |
| Useful tools have no package alias, while hooks, libraries, and retired scripts are also mixed into directories | Browsing a directory does not reveal which files can be run and which are internal implementations | Register and discover capabilities consistently without turning every file into a public command |
| Names such as `doctor`, `health`, `template`, and `logs` do not fully express their effects | Downloads, writes to user configuration, or model costs may be mistaken for read-only checks | Help and pre-execution checks must state side effects, prerequisites, and permissions rather than relying on names |

Similar entry points and numerous forwarding layers indicate a need to inspect responsibilities; they do not prove that all implementations are duplicates.
Equivalent aliases have been verified, and setup chains that cannot be merged have also been identified. Each must be assessed for reuse, migration, retention, or deferral; do not remove necessary domain implementations or add a permanent forwarding layer in the name of “unification.”
The current-state evidence comes from [root scripts](../../package.json), [Desktop scripts](../../apps/desktop/package.json), and the corresponding [workspace](../../scripts/shared/workspace.cjs), [Desktop wrapper](../../scripts/shared/desktop.cjs), and [toolchain](../../scripts/pre/toolchain.cjs) implementations. Classifications, mappings, and consumer records appear in later sections of this page.

<a id="3-需求分类与目标处置"></a>
## 3. Requirement Classification and Target Disposition

All entries below are target mappings and do not mean the CLI has been implemented. The overview design maintains the sole interface contract; this page records current sources,
user goals, and migration dispositions. `pre` uses `doctor` and does not retain `pre check`; `ci` contains only `check`/`format`/`test`;
`cd` contains only `build local`/`release`. The four top-level commands with no arguments respectively perform complete environment setup, hot-reload development and debugging,
the core smoke test for the main flow, and construction of a locally runnable package; see Section 1.4 of the overview design. Tests are organized by type and `scope`.

| Requirement cluster | Disposition | Target boundary |
| --- | --- | --- |
| Four default top-level task chains | Add orchestration | `pre` prepares the environment required by the current worktree; `dev` runs the full product/HMR; `ci` follows the existing fixed smoke test; `cd` follows the existing local package flow. The default action is not help; specialized and default flows share Owners/recipes and do not duplicate chains |
| Environment diagnosis and focused checks | Consolidate discovery | `pre doctor` defaults to the existing doctor set; `--scope environment/toolchain/interpreter/deps/links` selects an exact recipe and does not auto-repair |
| Python/Node installation, link repair, configuration, cleanup | Retain explicit actions | `pre install/repair/config/clean`; retain distinct setup wrappers for Python `environment` and `desktop` |
| Full product, real browser UI, simulated workbench | Consolidate discovery; retain setup chain | `dev` defaults to an isolated product plus renderer HMR; add non-renderer watching/safe restart as a target capability, while current debug still requires restart. `browser` connects to the existing Serve; `--mock` is a separate simulation |
| Standalone Serve debugging and observation of the current instance | Retain in simplified form | `dev serve [--watch]`, `dev status`, `dev logs [--errors]`; logs target the current instance and do not create a missing file, an explicit behavior change |
| Configuration-based startup, launcher, preview/shoot of build artifacts | Defer ops wrapper | Retain original Owner entry points and actual consumers; root `desktop` has README references and must not be presented as equivalently handled by isolated `dev` |
| Trace UI and component discovery | Defer ops wrapper | Retain DamoATrace's native entry point and component Owner/Skill; do not duplicate implementation |
| Type/lint/docs/i18n/UI/Skill compliance | Consolidate discovery | `ci check` exposes focused checks; aggregate the existing Python checks under `--profile python`; enter format-specific checks only through `ci format` |
| Format checking and formatting | Consolidate entry point | `ci format` checks by default; only `--write` formats; handle missing tools according to the existing check/write modes respectively |
| ESLint fixes, derived documentation, i18n generation | Merge into owning command | `ci check lint desktop --fix`, `docs desktop --write`, and `i18n --generate` all write explicitly and are not folded into `format` |
| Fast core smoke test | Retain fixed set | `ci test smoke` follows the existing `scripts/ci/smoke.cjs`; cross-layer labels do not duplicate cases or allow scope pruning; measure speed |
| Unit/integration/API/E2E/visual tests | Organize by type and scope | Combine `unit`/`integration`/`api`/`e2e`/`visual` with `--scope desktop/serve/runtime/trace/tooling`; register exact combinations and fail on empty sets |
| Existing mixed tests and comprehensive quality flow | Retain existing sets | Untyped `ci test --scope` carries each existing mixed set; `--profile quality` carries the existing `ci:test` comprehensive flow and must not be mislabeled as unit |
| Real-model probes, impact recommendations, simulated reports | Keep with their respective responsibilities | `e2e/desktop model-probe` follows existing `health`; `ci test --affected` only recommends; `ci check preview-report` reads associated reports only |
| Local builds and artifact types | Consolidate discovery | `cd build local`, with `target` selecting `desktop/web/backend/wheels/trace/skills`; retain separate existing recipes for Desktop `app`/`dir`/`installer` |
| Release packages and release-candidate checks | Consolidate discovery | `cd build release` selects the `preview`/`release` channel; candidate `dir` follows existing `package:check` and is not a signed, releasable package |
| Distribution after smoke and installer acceptance | Retain distinct fixed chains | `release --workflow distribution` follows the existing distribution flow; `local --workflow package-acceptance` follows the existing full test → local dev package → real installation acceptance flow, and is not mislabeled as signed release |
| GitLab/Preview/coverage consumers | Retain and wire atomically | Handle CLI entry points that need no root install separately from native npm installation; use explicit context recipes and do not substitute test sets/reports |
| Office assets, identity, Electron runtime, hooks/locks/resolvers | Internalize | Managed by their original Owner/lifecycle; do not add user-facing leaves per file |
| CLI self-validation | Internalize | Node source-contract and regression tests; no separate package, compilation, or dist consistency check |
| User data/global links/`all` initialization, supply-chain/baseline changes | Defer | Retain original controlled entry points; do not run automatically through `clean` or CI, and do not restore retired scripts |
| External upload/release/deployment | Defer integration | CD builds do not grant release permissions; define interfaces, idempotency, artifact identity, and read-back separately |

Use Sections 2–3 of the overview design as the authority for CLI entry points and directory organization: consolidate existing workspace root dispatch by function into
`ops-cli.cjs`; reuse the original Owners for debug/toolchain/Python/formatting and domain runners. Clean up only duplicate wrappers with no consumers; do not move all scripts into the entry point or pre-create `commands/core` directories. The original installation hook bootstraps independently;
retain existing `npm ci`, and do not add an installation to CI jobs that currently omit root dependencies just to obtain the CLI. Migrate source and tool consumers together.

The four default chains are new user experiences and must not be described as already present in the baseline. `pre` reuses existing installation/diagnosis/
safe-link Owners and validates the required final environment; `ci` is not upgraded to quality/full, and `cd` is not upgraded to release or automatic
installation. Full-stack safe reload for `dev` remains to be implemented; current evidence covers only renderer HMR and standalone Serve watch. Host
Node/package-manager prerequisites, authorization for global tools, concurrency with active instances/dependencies, and permission for real model calls are not waived by automatic setup.

<a id="31-用户任务与职责矩阵"></a>
### 3.1 User Task and Responsibility Matrix

| User goal | Sole canonical command | Actual Owner | Prerequisites and side effects | Current sources/consumers |
| --- | --- | --- | --- | --- |
| Diagnose environment failures | `pre doctor` | toolchain diagnose | node/npm/uv/python/codex/electron; may restore the Codex cache; excludes the full manager/marker/link checks | doctor |
| Focused toolchain/interpreter/dependency/physical-link checks | `pre doctor --scope toolchain/interpreter/deps/links` | toolchain, python.cjs, symlinks.cjs | Retain each focused set; do not auto-install/repair; frontend remains an internal Node+npm subset | check:toolchain/check:python/check:symlinks, hooks, native CI |
| Environment setup/configuration/cleanup | `pre install/repair/config/clean` | Original Python/Toolchain/Configuration/Cleanup Owners | Only the original targets; explicit writes | Original installation/configuration/cleanup entry points |
| Product development/backend debugging/instance observation | `dev` and `browser/serve/status/logs` | debug, Desktop, both Vite servers, logs Owner | Preserve isolated/real/simulated identity; `browser` may start Vite before Serve; changes to log behavior require separate acceptance | dev, dev:web, dev:preview, Preview webServer, serve, logs |
| Source checks and fixed Python combination | `ci check` focused commands or `--profile python` | lint.py/mypy/tsc/standards/localization/reuse | Python combination is fmt-check → lint → mypy; does not diagnose environment or auto-fix | Original check/typecheck/lint/docs/i18n/UI entry points |
| Check/fix code formatting | `ci format [--write]` | scripts/ci/format.cjs | Default check does not install; write follows existing prepare-dev and formatting; reject mutually exclusive arguments early | fmt, fmt-check |
| Other explicit derivation/fixes | `fix`/`write`/`generate` modes on the relevant `ci check` target | ESLint/standards/localization | Only existing write scopes; does not update policy baselines or user data | lint:fix, docs:write, i18n:generate |
| Product Skill source and pack | `ci check skills product --mode source` | Serve prebundle | Compare source with compiled pack; does not depend on the encoding host or source snapshot | skills:verify |
| Core smoke test and comprehensive quality gate | `ci test smoke`; `ci test --profile quality` | ci/smoke.cjs, ci/test.cjs | The former is a fixed fast set; the latter preserves existing static/build/test and external modes; do not conflate them | ci:smoke, ci:test, GitLab |
| Layered and subsystem tests | `ci test <type> --scope <subsystem>` | Existing test Owners | Register each case once; keep existing mixed sets available without a type, and do not misrepresent them as unit/API | Desktop Node, Preview, Serve run_all, Trace, etc. |
| Model probes/change recommendations/reports | `e2e desktop model-probe`; `ci test --affected`; `ci check preview-report` | workspace health, affected.cjs, preview/report.ts | Preserve original costs/targets; recommendations do not execute tests, and reports do not decide acceptance | health, impact recommendation, simulated association report |
| Locally runnable packages and artifacts | `cd build local` | Desktop build/packaging and each artifact Owner | Required ad-hoc signing on macOS; no signing on Windows; the original app `electron-vite build` is not an installer | build/package/package:dir and other builds |
| Release packages and original fixed delivery chain | `cd build release`; `local --workflow package-acceptance` | Original package/distribution/ci:package | Formal signed channels; candidates cannot be released; full acceptance checks this locally built dev installer | release/package:dist/ci:package |

Aggregates and focused checks are explicit fixed combinations, not duplicate aliases; the default doctor set is not the union of all focused checks.
In doctor, `scope` identifies an environment target; in `ci test`, it identifies the Owner being tested. These are not globally shared parameters.
Test base types and the smoke label do not duplicate cases. Frontend is included in the Desktop scope; verify the actual inventory for its renderer suites.
The server concept maps to the actual Owner name `serve`; do not register a synonymous `server` command.

<a id="32-测试分类与构建迁移差异"></a>
### 3.2 Test Classification and Build Migration Differences

- The original Desktop test/coverage is mixed Node regression testing. Retain untyped `ci test --scope desktop` and the original
  `pretest` differences; classify the literature-search suite as unit and native-contract compilation as integration, and do not relabel the entire set as unit.
- Classify Preview contracts and simulated browser UI as `integration/desktop` suites `preview-contract` and `preview-ui`, respectively;
  existing screenshot evidence is not visual testing. Serve `run_all` contains contract and integration tests; retain its original set by default.
  The API layer must verify HTTP boundaries case by case. Do not rename all backend contracts as API tests and claim classification is complete.
- Register the source, setup, case set, permissions, and report for every valid type/scope/suite combination. When new API/visual combinations
  are not wired, mark them planned and report `UNSUPPORTED`; do not return an empty successful run. Visual testing requires a comparison baseline, environment, tolerance, and
  explicit result; baseline updates remain separately controlled. Smoke follows the original mandatory core set; verify speed using cold/warm host measurements and do not reduce cases.
- Map the original `ci:test` to `ci test --profile quality`, strictly preserving original parameters such as `--strict`/`--with-external`,
  exit behavior, and quarantine/budget/stage reports. Do not run only one layer because of the new classifications. `profile` is mutually exclusive with `type`/`scope`/`suite`.
- The original CI smoke and Playwright smoke are different sets: the former is `ci test smoke`; the latter is `e2e/desktop suite mr`,
  retaining the original build setup. `live`/`update` and real `model-probe` each affect cost/state and are not automatically included in the fast smoke test.
- `CD local` defaults to a local Desktop installer. Preserve the distinct build recipes for `target` and `stage`; do not pass the app CLI stage
  directly to `build.cjs`, which supports only `backend`/`dir`/`installer`. `release` defaults to a direct build on the formal release channel;
  the preview channel retains its original signing policy, and a release candidate is explicitly not publishable.
- The original `ci:package` source actually runs `ci:test --with-external` → `package` (type `dev`) → real E2E after installation,
  so map it to `cd build local --workflow package-acceptance`, not signed-release acceptance.
  `package:dist` still maps to `release --workflow distribution`; the builder runs the fixed smoke test for both direct and distribution installers.
- Local “unsigned” means only that formal release certificates/notarization credentials are not used: retain required macOS ad-hoc signing and protected runtime/
  nested verification; local Windows builds are unsigned. Formal preview/release builds fail without credentials and do not automatically downgrade to candidate.
- Defer ops wrappers for legacy configuration-based startup, launchers, artifact preview/shoot, and standalone tools; retain their original entry points/consumers.
  Migrate carried-over usage in the same cutover, with no compatibility period for synonymous old/new entry points. Changes to current-instance/missing-file log behavior require separate acceptance.

<a id="4-package-scripts迁移映射"></a>
## 4. package scripts Migration Mapping

The tables below cover both baseline `package.json` files item by item; names in the factual columns remain unchanged. Canonical targets are not necessarily executable yet;
the cutover wires them together in one revision and removes root public aliases whose capabilities have been carried over, with no compatibility-forwarding period.
Desktop domain scripts may remain as actual internal execution boundaries and must not be advertised as a second public command set.
Wrapper differences for different sources under the same canonical path are explicitly preserved through the overview design's local/ci recipes, not selected by switching `CI=1`.
The root's default local recipe retains the root wrapper; existing direct GitLab subpackage invocations are reproduced only in named ci recipes.
Update the corresponding rows when source/scripts inventories change; do not treat this snapshot as an everlasting guarantee of executable behavior.

<a id="41-根packagejson"></a>
### 4.1 Root package.json

Source: [root scripts](../../package.json). The table below states only the destination; setup order, identity, and permissions are defined by the overview design.
Verify actual behavior against Owner source, especially because `doctor`/`logs`/`config`/`probe` cannot be assumed read-only from their names.

| Current script | Disposition | Canonical target (omit `pnpm ops`) |
| --- | --- | --- |
| `postinstall` | Internalize | Retain installation/bootstrap hook; do not invoke ops before it is installed |
| `prepare:python` | Retain capability | `pre install python --mode desktop` |
| `dev` | Retain capability | `dev` (full product by default, following original isolated supervision) |
| `dev:status` | Retain capability | `dev status` |
| `test:debug` | Retain capability | `ci test --scope tooling --suite debug` |
| `dev:preview` | Retain capability | `dev browser --mock` |
| `test:preview` | Retain capability | `ci test integration --scope desktop --suite preview-contract` |
| `test:preview:ui` | Retain capability | `ci test integration --scope desktop --suite preview-ui` |
| `check:preview:bundle` | Retain capability | `ci check preview-bundle` |
| `build` | Retain capability | `cd build local --stage app` |
| `build:check` | Merge entry point | `cd build release --stage dir --candidate` |
| `package` | Retain capability | `cd build local` |
| `build:release` | Merge entry point | `cd build release` |
| `test` | Merge entry point | `ci test --scope desktop` |
| `ci:test` | Retain capability | `ci test --profile quality` |
| `ci:smoke` | Retain capability | `ci test smoke` |
| `ci:package` | Retain capability | `cd build local --workflow package-acceptance` |
| `typecheck` | Retain capability | `ci check types desktop` |
| `updater:test` | Retain capability | `ci test --scope desktop --suite updater` |
| `package:check` | Merge entry point | `cd build release --stage dir --candidate` |
| `release` | Merge entry point | `cd build release` |
| `package:distribution` | Merge entry point | `cd build release` |
| `package:dist` | Retain capability | `cd build release --workflow distribution` |
| `all` | Defer | Explicitly excluded from this cutover; retain the original standalone controlled entry point and do not include it in ops composite actions |
| `install:python` | Retain capability | `pre install python --mode environment` |
| `check:python` | Retain capability | `pre doctor --scope interpreter` |
| `skills:install` | Retain capability | `cd build local --target skills` |
| `skills:verify` | Retain capability | `ci check skills product --mode source` |
| `skills:check-links` | Retain capability | `ci check skills host --mode links` |
| `dependency-wheels` | Merge entry point | `cd build local --target wheels` |
| `damoatrace:contract` | Retain capability | `ci test --scope trace` |
| `damoatrace:check` | Retain capability | `ci test --scope trace --with-format-check` |
| `damoatrace:wheel` | Retain capability | `cd build local --target trace` |
| `agent-wheel` | Merge entry point | `cd build local --target wheels` |
| `doctor` | Merge entry point | `pre doctor` |
| `check:symlinks` | Retain capability | `pre doctor --scope links` |
| `repair:symlinks` | Retain capability | `pre repair links` |
| `check:toolchain` | Retain capability | `pre doctor --scope toolchain` |
| `ui-find` | Defer | Do not wrap in ops; retain the original component Owner/Skill entry point and complete parameters |
| `desktop:test` | Merge entry point | `ci test --scope desktop` |
| `desktop:e2e:mr` | Retain capability | `ci test e2e --scope desktop --suite mr` |
| `desktop:e2e:live` | Retain capability | `ci test e2e --scope desktop --suite live` |
| `config` | Retain capability | `pre config edit` |
| `config:template` | Retain capability | `pre config template` |
| `start` | Defer | Do not wrap in ops in this cutover; retain standalone startup after original `checkPython` → venv setup, not as an equivalent replacement for default `dev` |
| `desktop` | Defer | Do not wrap in ops in this cutover; retain configuration-based startup and README consumers; default `dev` does not enter this configuration-writing chain |
| `health` | Retain capability | `ci test e2e --scope desktop --suite model-probe` |
| `fmt` | Retain capability | `ci format --write` |
| `fmt-check` | Retain capability | `ci format` |
| `lint` | Retain capability | `ci check lint python` |
| `python:typecheck` | Retain capability | `ci check types python` |
| `check` | Retain capability | `ci check --profile python` |
| `serve` | Retain capability | `dev serve` |
| `serve:dev` | Retain capability | `dev serve --watch` |
| `logs` | Retain capability | `dev logs` (target the current isolated instance; do not create a missing log file) |
| `logs:errors` | Retain capability | `dev logs --errors` (same as above; retain the original filter and most recent 50 lines) |
| `trace-ui` | Defer | Do not wrap in ops; use DamoATrace's native serve entry point and retain its capability |
| `trace-ui:stop` | Defer | Do not wrap in ops; retain the Trace Owner's existing stop capability and original controlled entry point |
| `docs:check` | Retain capability | `ci check docs workspace` |
| `install:cmd` | Defer | Explicitly excluded from this cutover; retain the original standalone controlled entry point and do not include it in ops composite actions |
| `uninstall:cmd` | Defer | Explicitly excluded from this cutover; retain the original standalone controlled entry point and do not include it in ops composite actions |
| `clean` | Merge entry point | `pre clean` |
| `distclean` | Merge entry point | `pre clean` |
| `user-data:preview` | Defer | Explicitly excluded from this cutover; retain the original standalone controlled entry point and do not include it in ops composite actions |
| `user-data:delete` | Defer | Explicitly excluded from this cutover; retain the original standalone controlled entry point and do not include it in ops composite actions |
| `prepare` | Internalize | Retain installation/bootstrap hook; do not invoke ops before it is installed |

### 4.2 Desktop package.json

Source: [Desktop scripts](../../apps/desktop/package.json). Canonical targets in the table are discovery paths;
domain actions/hooks belong to internal Owners, and their implementations are not duplicated. Differences in prerequisites between local and existing ci recipes are selected by explicit context;
an unregistered ci recipe must not treat `context=ci` as a reason to skip all checks.

| Current script | Disposition | Canonical target (omit `pnpm ops`) |
| --- | --- | --- |
| `preinstall` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `pretest` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `docs:write` | Retain capability | `ci check docs desktop --write` |
| `docs:check` | Retain capability | `ci check docs desktop` |
| `postinstall` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `predev` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `dev` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `dev:web` | Retain capability | `dev browser` |
| `dev:preview` | Retain capability | `dev browser --mock` |
| `predev:preview` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `test:preview` | Retain capability | `ci test integration --scope desktop --suite preview-contract` |
| `test:preview:ui` | Retain capability | `ci test integration --scope desktop --suite preview-ui` |
| `check:preview:bundle` | Retain capability | `ci check preview-bundle` |
| `prebuild` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `build` | Retain capability | `cd build local --stage app` |
| `build:web` | Retain capability | `cd build local --target web` |
| `preview:web` | Defer | Do not wrap in ops in this cutover; retain original Web artifact preview and frontend prerequisites; this is not the `dev browser` development server or `--mock` |
| `test` | Retain capability | `ci test --scope desktop` |
| `native:contract` | Retain capability | `ci test integration --scope desktop --suite native-contract` |
| `test:native` | Retain capability | `ci test unit --scope desktop --suite native` |
| `test:coverage` | Retain capability | `ci test --scope desktop --coverage` |
| `test:literature-search` | Retain capability | `ci test unit --scope desktop --suite literature-search` |
| `prepreview` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `preview` | Defer | Do not wrap in ops in this cutover; retain original Electron artifact preview and prepreview; do not merge it with the simulated workbench |
| `shoot` | Defer | Do not wrap in ops in this cutover; retain toolchain → electron-vite build → electron . and original parameters; this does not represent screenshot/assertion and is not part of default `dev` |
| `bundle:backend` | Retain capability | `cd build local --target backend` |
| `package:dir` | Retain capability | `cd build local --stage dir` |
| `package:installer` | Merge entry point | `cd build local` |
| `typecheck` | Retain capability | `ci check types desktop` |
| `lint` | Retain capability | `ci check lint desktop` |
| `lint:fix` | Retain capability | `ci check lint desktop --fix` |
| `test:e2e` | Retain capability | `ci test e2e --scope desktop` |
| `test:e2e:mr` | Retain capability | `ci test e2e --scope desktop --suite mr` |
| `test:e2e:live` | Retain capability | `ci test e2e --scope desktop --suite live` |
| `test:e2e:update` | Retain capability | `ci test e2e --scope desktop --suite update` |
| `i18n:check` | Retain capability | `ci check i18n --mode check` |
| `i18n:dom:gaps` | Retain capability | `ci check i18n --mode gaps` |
| `i18n:generate` | Retain capability | `ci check i18n --generate` |
| `i18n:test` | Retain capability | `ci test --scope tooling --suite i18n` |
| `preshoot` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `predev:web` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `prebuild:web` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `prepreview:web` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `prepare:python` | Internalize | Retain as a domain/lifecycle entry point, called by a registered task recipe; not a second public CLI |
| `build:check` | Merge entry point | `cd build release --stage dir --candidate` |
| `package` | Merge entry point | `cd build local` |
| `build:release` | Merge entry point | `cd build release` |
| `package:check` | Merge entry point | `cd build release --stage dir --candidate` |
| `release` | Merge entry point | `cd build release` |
| `package:distribution` | Merge entry point | `cd build release` |
| `package:dist` | Retain capability | `cd build release --workflow distribution` |

<a id="5-额外工具与消费者"></a>
## 5. Additional Tools and Consumers

| Current tool/consumer | Target or disposition | Differences and acceptance |
| --- | --- | --- |
| toolchain frontend/dependencies/ensure | `pre doctor --scope deps`, `pre install deps`; internalize frontend | Checks do not auto-install; frontend retains the original Node+npm checks in the GitLab static job and four Web/Preview hooks, with no new uv requirement; the root hook still bootstraps |
| `scripts/shared/python.cjs` prepare (runtime download only) | Internalize/defer from public interface | Does not replace complete development environment setup; Linux must not call the Desktop release manifest to imply support |
| `scripts/ci/affected.cjs` | `ci test --affected` | Preserve recommendation, unmatched fallback, and exit semantics; verify existing grep/platform path assumptions through actual cross-platform acceptance |
| `apps/serve/tests/run_all.py` | `ci test --scope serve [--list]` | Preserve cwd/PYTHONPATH, exclusive suites, concurrency, and reports; prevent the two `tests` packages from shadowing each other |
| Preview `report.ts` | `ci check preview-report` | Associate reports from files/stdin; preserve original status and do not present them as execution results |
| `standards --report`, `reuse --report` | `ci check docs desktop --mode report`, `ci check ui` | Reports retain original fields/semantics; do not pass through baseline writes |
| Explicit file-structure tool | `ci check docs workspace --mode structure` | Require an explicit path; Node-only structure checks do not replace the full knowledge gate |
| Original full-parameter `ui-find` capability | Defer ops wrapper; retain original Owner/Skill entry point | Registry is the sole source of truth; use the complete original options and do not duplicate the component inventory |
| Original GitLab Python jobs | After checkout, use source entry point without adding root installation for CLI; explicit `context=ci` | Pass `PYTHON=3.12` explicitly through setup; `prepareDevelopmentEnvironment` skips native runtime download and synchronizes through uv. apt Node is still not pinned to the repository's Node version, and the actual Linux pipeline has not run; source wiring alone does not prove acceptance |
| GitLab subpackage typecheck/localization/coverage and other discrete jobs | Register all consumers and select local/ci recipe by actual source | Preserve original `ignore-scripts`, subpackage installation/explicit pretest, reports, timeouts, and `allow_failure`; do not force the full Desktop marker into jobs that did not have it |
| GitLab native `ci-package-macos/windows` jobs | Retain original root `npm ci` and actual hooks, followed by existing check/repair/check/installPython; canonical ops entry uses explicit npm executor, with root wrapper for default local | Do not add a CLI file dependency or pnpm root install, and do not manually replay hooks; original rootless jobs only prepare declared Node/pnpm |
| GitLab `desktop-e2e-smoke` (Linux Xvfb task in `.gitlab-ci.yml`) | Retain original real Electron build + Playwright smoke and wire each item through an explicit ci recipe | Preserve atomic package installation/Playwright dependencies/Xvfb/reports/criteria. Existing configuration does not prove a pass; compare unresolved Linux prerequisites against baseline and have the Owner address them. Do not delete the task, substitute static checks, or count platform rejection as completion |
| `npm_execpath` dependency and nested toolchain execution | Let the real package manager create one context | `pnpm ops` → explicit npm → nested prerequisites no longer read the old pnpm identity; do not forge environment variables |
| Coverage string parsing, Preview webServer | Update consumers in the same cutover | Use the same test inventory locally and in CI; changing only the root alias is insufficient |
| Public policy/overlay | Tool source-closure check | If the ops script is retained, include `ops-cli.cjs` and the domain source it actually invokes; if explicitly excluded, remove the entry point; dangling source paths are forbidden |
| CLI source tests | Internal contract and behavior regression | Run directly with Node; help/list must still work without root/Desktop dependencies; do not compare dist or add a user-facing CLI build command |
| Public/vendor/native/corpus and external distribution systems | Defer; retain original Owners | Do not claim cross-platform/release capability from filenames; CD integration requires a separate interface and authorization |

<a id="6-生命周期钩子关联"></a>
## 6. Lifecycle Hook Relationships

Current hook relationships are listed below. The table records the package managers' original relationships under their respective configurations; it does not mean the CLI must
run every hook again. Verify actual equivalence separately for npm/pnpm, `ignore-scripts`, and pre/post configuration.

| Package / hook | Original responsibility and target relationship | Migration constraints |
| --- | --- | --- |
| Root `postinstall` | toolchain ensure; root dependency installation | Retain first-install bootstrap; do not invoke ops or silently switch the existing package manager |
| Root `prepare` | husky; Git hook configuration | Unlike the retired symlink hook; do not accidentally delete or restore old scripts |
| Desktop `preinstall` | toolchain check; subpackage installation | Check the toolchain first; the CLI must not bypass it |
| Desktop `postinstall` | `electron.cjs`; subpackage installation | APFS clone/standard dist/independent identity, with Windows following upstream; refresh is not a routine check |
| Desktop `predev` | Office → prepare:python → toolchain → identity; isolated domain leaf for default `dev` | Preserve ordering and user environment overrides; do not skip root debug supervision/setup |
| Desktop `predev:web` | frontend; `dev browser` | Do not add Python/identity setup |
| Desktop `predev:preview` | frontend; `dev browser --mock` | Preview UI webServer is also a consumer, not just root scripts |
| Desktop `prebuild` | prepare:python → toolchain; actual build consumers such as `cd build local --stage app` | Do not confuse this with the build body's Office steps and avoid duplicate execution |
| Desktop `prebuild:web` | frontend; `cd build local --target web` | Preserve the Web artifact boundary |
| Desktop `prepreview` | prepare:python → toolchain → identity; Electron artifact preview deferred from ops wrapper | Different from `predev` Office setup |
| Desktop `prepreview:web` | frontend; Web artifact preview deferred from ops wrapper | Different from Electron preview |
| Desktop `preshoot` | toolchain; shoot entry point deferred from ops wrapper | Main flow remains build → electron; do not add full `predev` privately |
| Desktop `pretest` | toolchain → runtime/build-tool contracts → standards → i18n test/check; `ci test --scope desktop` | Do not automatically apply to `test:coverage`; the explicit CI pretest stage is another consumer |

The `prepare:python`, `toolchain run build`, and package-stage steps inlined in other ordinary Desktop scripts
are not named hooks, but remain part of the complete migration unit. Do not retain only the hooks in the table and omit inlined prerequisites.

<a id="8-脚本逐文件实施迁移清单"></a>
## 8. Per-File Script Migration Checklist

<a id="81-本次新增职责"></a>
### 8.1 Responsibilities Added in This Cutover

The following files were actually added in this cutover and are not included in the baseline count of 249 legacy files; test directories are consolidation locations for existing Owners, not a standalone CLI project.

| New path | Category / Owner | Actual consumers | Verification method |
| --- | --- | --- | --- |
| `apps/desktop/scripts/dev/supervision.mjs` | Development host / Desktop development tooling | Internal Desktop dev script; holds the complete environment lease through lease-runner; not a second user entry point | Behavioral regression for compile/drain/stop/publish/recovery and real Electron acceptance; no automatic reload on Windows without family proof |
| `apps/desktop/scripts/dev/__tests__/supervision.test.mjs` | Development-host orchestration regression / Desktop development tooling | Explicit Desktop test and coverage sets | Busy-candidate reuse, source changes, exit confirmation, unknown state, and failure recovery; not a substitute for real-session acceptance |
| `apps/desktop/scripts/dev/development.mjs` | Development candidate compilation / Desktop development host | Called by `supervision.mjs` for candidate compilation and publishing; integrated with isolated dev reload. Candidate API returns a native Buffer verified by ownership and frozen digest; the host publishes it to a content-addressed dependency cache in this worktree to avoid Windows DLL locks, and original `pre clean` reclaims it; no second user entry point | Reuses electron-vite configuration and Vite compilation; isolates candidate main/preload/protected outputs; on failure clears only its own directory and preserves canonical output. macOS has observed compile-failure survival and idle restart after recovery; Windows still requires real acceptance |
| `apps/desktop/scripts/dev/__tests__/development.test.mjs` | Candidate compilation behavior regression / Desktop development host | Explicit Desktop test and coverage sets; adds no pretest or recursive glob | Actual Vite build, path escaping, disabled watch, retained plugins, and failure cleanup; not product-session acceptance |
| `scripts/ops-cli.cjs` | User entry point / repository development tooling | Root `ops`; direct Node invocation with explicit manager context reuses the same script | Side-effect-free help, argument/error handling, real npm/pnpm context; no second worker script or parameter |
| `scripts/shared/commands.cjs` | Command contract and necessary orchestration / repository development tooling | `scripts/ops-cli.cjs` | Default chains, scope combinations, fail-fast invalid arguments, and Owner invocation recipes |
| `scripts/shared/execution.cjs` | Repository location and execution context / repository development tooling | `scripts/ops-cli.cjs`, `scripts/shared/commands.cjs` | Child-process exits/signals, real manager-context reuse, and argument validation |
| `scripts/__tests__/ops.test.cjs` | CLI behavior regression / repository development tooling | Explicit tooling test set | Calls, exit codes, JSON, and side-effect boundaries in isolated fixtures; not product acceptance |
| `scripts/ci/__tests__/routing.test.cjs` | Affected-test recommendation regression / repository test routing | Explicit tooling test set | Actual recommendation result for adjacent `__tests__` discovery, fallback, and unmatched targets |
| `scripts/shared/__tests__/interpreter.test.cjs` | Development interpreter resolution regression / Python toolchain | Explicit tooling test set after dependencies are ready | Controlled interpreter source, rejection of untrusted resolution, and actual host probes; not run during pre-install bootstrap |
| `scripts/shared/source.cjs` | Shared source identity / repository tooling | Fixed smoke and Desktop local/release builds | HEAD/index, actual source bytes, link boundary, and before/after stability; do not relax release clean requirements |
| `scripts/shared/__tests__/source.test.cjs` | Source identity regression / repository tooling | Explicit tooling test set | Dirty-state stability in temporary Git repositories, byte/type/stage/delete changes, hidden tracking markers, and rejection of out-of-bounds links |
| `scripts/shared/lease.cjs` | Worktree environment-resource read/write lease / repository development tooling | Python/Node setup, workspace clean, long-running Desktop development commands | Conflict matrix, canonical path aliases, concurrent writes, conservative retention on exceptions, and blocking before cleanup |
| `scripts/shared/permissions.cjs` | Private-state ACL verification / cross-platform development tooling | `scripts/shared/lease.cjs` | Windows ACL host verification not run; macOS rejects untrusted `SystemRoot` probe and Windows-specific ACL tests |
| `scripts/ci/docs/structure-check.mjs` | Explicit documentation-structure CLI / repository docs tooling | `ci check docs workspace --mode structure` | Reject unsafe paths; verify link/anchor/code_refs structure; reuse `structure-core.mjs` |
| `scripts/shared/__tests__/lease.test.cjs` | Worktree lease security regression / repository development tooling | Fixed tooling test set, Desktop test and coverage | Concurrent reads/writes, process failures, retained conflicts, and Node/Python setup boundaries |
| `apps/desktop/scripts/dev/runner.cjs` | Desktop dependency runtime read lease and process-tree supervision / Desktop development tooling | `dev`, `dev:web`, `dev:preview`, `preview`, `preview:web` scripts and their npm lifecycles | Real development startup/shutdown, POSIX process-group signal forwarding, and conservative retention of unconfirmed leases on Windows |
| `apps/desktop/scripts/dev/__tests__/lease.test.cjs` | Desktop development lease/interruption lifecycle regression / Desktop build tooling | Desktop `test`, `test:coverage`, GitLab desktop-unit coverage stage | Lock package entry resolution, read-lease lifecycle, POSIX Ctrl+C forwarding, and lease release; Windows tree shutdown requires Windows-host acceptance |
| `apps/desktop/scripts/dev/worker.cjs` | Private Windows startup barrier / Desktop development host | Job management for `supervision.mjs`; spawns Electron only after Job attachment succeeds, forwards bootstrap via stdin, and restricts IPC schema; not a user entry point or general-purpose executor | Parameter, permission, and error boundaries; real Windows Job and child-process shutdown still require Windows-host verification |
| `apps/desktop/scripts/dev/__tests__/worker.test.cjs` | Windows development startup-barrier regression / Desktop development tooling | Exact Desktop test/coverage set; not included in pretest | Real Node fixtures on macOS verify permissions, errors, parameters, and exit codes; counting actual Windows Job children requires `SCHOLARSEED_LEASE_LIBRARY` and a Windows host; conditional skipping is not acceptance |

Public-projection Python safety regression runs in GitLab’s explicit `public-projection` job and the full-quality
`python-public-projection` stage, selecting only `scripts/cd/public/__tests__/test_sync.py`;
It is not added to Desktop coverage/pretest and does not change the fixed smoke test or original test selection. The Python environment reuses the existing
development dependency setup (`pytest`; Serve dependency declarations provide PyYAML and packaging); the test also requires git, git-lfs, and Node.
Local dependency readiness does not prove that the container pipeline has run, and passing the public-projection test is not equivalent to a successful full-tree export.

New observation on the macOS development host on 2026-10-23: when candidate compilation failed, the original Electron PID `19531` and backend
PID `19574` remained running; the old instance was not stopped first. After restoring the source, log entry `tmp/ops-dev-runtime.log:1418`
records a successful restart while idle and clean; the screenshot `tmp/test_snapshot/ops-preload-recovered.png` was opened and checked by
the main thread, which verified the recovered interface. After exit, status was stopped and task processes and the lease were cleaned up. This evidence does not prove
active-session protection or Windows process-tree capability; Windows Job/worker source is wired, but real-platform acceptance remains outstanding.

<a id="82-既有文件处置"></a>
### 8.2 Disposition of Existing Files

This cutover adds a source-state policy: fixed smoke and local dev builds may start dirty, but must record the actual state and
the same source fingerprint before and after; full quality, preview/release/candidate, and installer acceptance workflows still require
a clean tree. The shared source-identity Owner owns this policy; it does not change core cases, signing, or release eligibility.

This table inventories the 249 files in the Git index at pre-implementation HEAD `92f949471a45161c162dfc4ec229f838a09d148f` (105 root scripts and 144 Desktop scripts);
86 existing tests were moved close to their original Owners under `__tests__`; non-test files retain their domain ownership, while public distribution and duplicate orchestration
are taken over by ops rather than mechanically relocating everything into `pre`/`dev`/`ci`/`cd`. Ignored bytecode and new ops source added in this cutover are excluded from the legacy file count.
The “Consumers” column comes from exact-path static references at the pre-implementation HEAD and does not prove the full call closure; a missing match does not mean a file can be deleted.
Sibling `require`/`import` references, dynamic manifests, and installation hooks must also be checked against the Owner in each row and the post-migration relative paths. The verification column lists
required verification methods; it does not mean acceptance on every platform listed here has passed. Original paths are retained as source evidence, not compatibility entry points.

| Original path | Target path/disposition | Category | Owner | Static path consumers (up to 3) | Verification method |
| --- | --- | --- | --- | --- | --- |
| `apps/desktop/scripts/acceptance.cjs` | `apps/desktop/scripts/cd/acceptance.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules/dynamic consumers | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/acceptance.test.cjs` | `apps/desktop/scripts/cd/__tests__/acceptance.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/archive_inventory.py` | `apps/desktop/scripts/cd/archive_inventory.py` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules/dynamic consumers | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/archive_inventory.test.cjs` | `apps/desktop/scripts/cd/__tests__/archive_inventory.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/archive_inventory_test.py` | `apps/desktop/scripts/cd/__tests__/archive_inventory_test.py` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/assembly.cjs` | `apps/desktop/scripts/cd/assembly.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/component-cache.cjs` | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/assembly.test.cjs` | `apps/desktop/scripts/cd/__tests__/assembly.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/branding.cjs` | `apps/desktop/scripts/cd/branding.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules/dynamic consumers | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/branding.test.cjs` | `apps/desktop/scripts/cd/__tests__/branding.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/browser.cjs` | `apps/desktop/scripts/cd/browser.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md` | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/browser.test.cjs` | `apps/desktop/scripts/cd/__tests__/browser.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules/dynamic consumers | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/build-state.cjs` | `apps/desktop/scripts/shared/build-state.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `docs/runbooks/windows.md`, `scripts/shared/dependencies.cjs`, `scripts/npm-installed-cache.test.cjs` | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/build.cjs` | `apps/desktop/scripts/cd/build.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `README_zh.md`, `docs/architecture/persistence.md`, `docs/index.md` | Original build/runtime contract and actual host probe |
| `apps/desktop/scripts/build.test.cjs` | `apps/desktop/scripts/cd/__tests__/build.test.cjs` (move) | Test | Desktop build/development tooling | `docs/runbooks/development.md`, `scripts/cd/public/README.md`, `scripts/cd/public/overlay.patch` | Original test set and relative-path/call-closure checks |
| `apps/desktop/scripts/bundle.cjs` | `apps/desktop/scripts/cd/bundle.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/assembly.test.cjs`, `scripts/cd/public/overlay.patch`, `work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/bundle.test.cjs` | `apps/desktop/scripts/cd/__tests__/bundle.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/bytecode.py` | `apps/desktop/scripts/cd/bytecode.py` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `.gitattributes`, `apps/desktop/scripts/shared/component-cache.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/bytecode.test.cjs` | `apps/desktop/scripts/cd/__tests__/bytecode.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/bytecode_test.py` | `apps/desktop/scripts/cd/__tests__/bytecode_test.py` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/cache.cjs` | `apps/desktop/scripts/cd/cache.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/cache.test.cjs` | `apps/desktop/scripts/cd/__tests__/cache.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/closure.cjs` | `apps/desktop/scripts/cd/closure.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md`, `work-records/proposals/2026-10-22/feedback-zip/plan.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/closure.test.cjs` | `apps/desktop/scripts/cd/__tests__/closure.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/compiler.cjs` | `apps/desktop/scripts/cd/compiler.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/compiler.test.cjs` | `apps/desktop/scripts/cd/__tests__/compiler.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/shared/component-cache.cjs` | `apps/desktop/scripts/shared/component-cache.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/component-cache.test.cjs` | `apps/desktop/scripts/shared/__tests__/component-cache.test.cjs` (explicitly registered) | Deterministic host integration test | Desktop build/development tooling | `apps/desktop/scripts/ci/test.cjs`, `scripts/cd/public/policy.json` | Regular coverage directly covers real ZIP and temporary-file cases; the build aggregate no longer imports it again, which does not represent native-artifact acceptance |
| `apps/desktop/scripts/compression.cjs` | `apps/desktop/scripts/cd/compression.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/shared/component-cache.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/compression.test.cjs` | `apps/desktop/scripts/cd/__tests__/compression.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/css.baseline.json` | `apps/desktop/scripts/ci/css.baseline.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/css.exceptions.json` | `apps/desktop/scripts/ci/css.exceptions.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | `.agents/skills/ui-component-reuse/SKILL.md` | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/css.mjs` | `apps/desktop/scripts/ci/css.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/digest.cjs` | `apps/desktop/scripts/shared/digest.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/electron.cjs` | `apps/desktop/scripts/pre/electron.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `docs/runbooks/development.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/electron.test.cjs` | `apps/desktop/scripts/pre/__tests__/electron.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/engine.cjs` | `apps/desktop/scripts/cd/engine.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/shared/component-cache.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/engine.test.cjs` | `apps/desktop/scripts/cd/__tests__/engine.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/enginecheck.test.cjs` | `apps/desktop/scripts/cd/__tests__/enginecheck.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/fontconfig.cjs` | `apps/desktop/scripts/cd/fontconfig.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/native/fontconfig/README.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/fonts.cjs` | `apps/desktop/scripts/cd/fonts.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `work-records/2026-10-13/office-font-duplicates-87640187/preparation.md`, `work-records/2026-10-13/office-font-duplicates-87640187/result.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/handoff.cjs` | `apps/desktop/scripts/cd/handoff.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/handoff.test.cjs` | `apps/desktop/scripts/cd/__tests__/handoff.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/identity.cjs` | `apps/desktop/scripts/pre/identity.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `docs/runbooks/development.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/installation-mutex.ps1` | `apps/desktop/scripts/cd/installation-mutex.ps1` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/installation.cjs` | `apps/desktop/scripts/cd/installation.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/installation.test.cjs` | `apps/desktop/scripts/cd/__tests__/installation.test.cjs` (move) | Test | Desktop build/development tooling | `scripts/BUILD.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/installer.test.cjs` | `apps/desktop/scripts/cd/__tests__/installer.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/lease.d.mts` | `apps/desktop/scripts/shared/lease.d.mts` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/lease.mjs` | `apps/desktop/scripts/shared/lease.mjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/legacy-files.json` | `apps/desktop/scripts/cd/legacy-files.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | `.gitattributes` | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/legacy.json` | `apps/desktop/scripts/cd/legacy.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/locales.cjs` | `apps/desktop/scripts/ci/locales.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/localization.mjs` | `apps/desktop/scripts/ci/localization.mjs` (retain Owner) | Quality implementation | Desktop quality | `apps/desktop/docs/work/i18n-verification.md`, `work-records/20260928-permission-switch-87153274/verification.md`, `work-records/20260929-office-recovery/verification.md` | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/localization/calls.mjs` | `apps/desktop/scripts/ci/localization/calls.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/calls.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/calls.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/components.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/components.test.mjs` (move) | Test | DesktopInternationalization | `apps/desktop/docs/work/plan/i18n-plan.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/localization/debt.json` | `apps/desktop/scripts/ci/localization/debt.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/localization/dom.d.mts` | `apps/desktop/scripts/ci/localization/dom.d.mts` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/localization/dom.mjs` | `apps/desktop/scripts/ci/localization/dom.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/dom.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/dom.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/engine.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/engine.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/examples.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/examples.test.mjs` (move) | Test | DesktopInternationalization | `scripts/public/overlay.patch` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/format.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/format.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/localization/gaps.mjs` | `apps/desktop/scripts/ci/localization/gaps.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/localization/git.mjs` | `apps/desktop/scripts/ci/localization/git.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/git.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/git.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/preferences.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/preferences.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/ci/localization/prettier.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/prettier.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/localization/resources.mjs` | `apps/desktop/scripts/ci/localization/resources.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/resources.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/resources.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/localization/source.mjs` | `apps/desktop/scripts/ci/localization/source.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/source.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/source.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/localization/staged.mjs` | `apps/desktop/scripts/ci/localization/staged.mjs` (retain Owner) | Quality implementation | Desktop quality | No exact path found; check sibling modules and dynamic consumers | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/ci/localization/staged.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/staged.test.mjs` (move) | Test | DesktopInternationalization | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/macho.cjs` | `apps/desktop/scripts/cd/macho.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/mutex.test.cjs` | `apps/desktop/scripts/cd/__tests__/mutex.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/native-contract.cjs` | `apps/desktop/scripts/ci/native-contract.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/native.cjs` | `apps/desktop/scripts/shared/native.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/native/README.md`, `docs/runbooks/windows.md`, `work-records/2026-10-13/office-font-duplicates-87640187/plan.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/native.test.cjs` | `apps/desktop/scripts/shared/__tests__/native.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/node.sh` | `apps/desktop/scripts/cd/node.sh` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/normalize.py` | `apps/desktop/scripts/cd/normalize.py` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/shared/component-cache.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/notarize.cjs` | `apps/desktop/scripts/cd/notarize.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `.env.example`, `scripts/cd/public/overlay.patch` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/notices.cjs` | `apps/desktop/scripts/cd/notices.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/office-assets.cjs` | `apps/desktop/scripts/pre/office-assets.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/office.test.cjs` | `apps/desktop/scripts/pre/__tests__/office.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/package.cjs` | `apps/desktop/scripts/cd/package.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/payload.cjs` | `apps/desktop/scripts/cd/payload.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/payload.py` | `apps/desktop/scripts/cd/payload.py` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `apps/desktop/scripts/shared/component-cache.cjs`, `apps/desktop/scripts/compression.test.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/payload.test.cjs` | `apps/desktop/scripts/cd/__tests__/payload.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/payload_test.py` | `apps/desktop/scripts/cd/__tests__/payload_test.py` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/probe.cjs` | `apps/desktop/scripts/shared/probe.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/cd/public/overlay.patch` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/python.test.cjs` | `apps/desktop/scripts/shared/__tests__/python.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/registration.cjs` | `apps/desktop/scripts/cd/registration.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/registration.ps1` | `apps/desktop/scripts/cd/registration.ps1` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/registration.psm1` | `apps/desktop/scripts/cd/registration.psm1` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/registration.test.cjs` | `apps/desktop/scripts/cd/__tests__/registration.test.cjs` (move) | Test | Desktop build/development tooling | `scripts/BUILD.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/registration.test.ps1` | `apps/desktop/scripts/cd/__tests__/registration.test.ps1` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/reuse.baseline.json` | `apps/desktop/scripts/ci/reuse.baseline.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/reuse.mjs` | `apps/desktop/scripts/ci/reuse.mjs` (retain Owner) | Quality implementation | Desktop quality | `apps/desktop/scripts/ci/find.mjs` | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/reuse.policy.json` | `apps/desktop/scripts/ci/reuse.policy.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/reuse.test.mjs` | `apps/desktop/scripts/ci/__tests__/reuse.test.mjs` (move) | Test | Desktop build/development tooling | `work-records/20260929-ai-project-breadcrumb/result.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/seal.cjs` | `apps/desktop/scripts/cd/seal.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `work-records/2026-10-13/office-font-duplicates-87640187/plan.md`, `work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/seal.test.cjs` | `apps/desktop/scripts/cd/__tests__/seal.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/setup.cjs` | `apps/desktop/scripts/cd/setup.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/setup.test.cjs` | `apps/desktop/scripts/cd/__tests__/setup.test.cjs` (move) | Test | Desktop build/development tooling | `apps/desktop/updater/README.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/shipit.cjs` | `apps/desktop/scripts/cd/shipit.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `work-records/proposals/2026-10-13/shipit-cleanup/plan.md` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/shipit.test.cjs` | `apps/desktop/scripts/cd/__tests__/shipit.test.cjs` (move) | Test | Desktop build/development tooling | `work-records/proposals/2026-10-13/shipit-preparation/plan.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/sign.cjs` | `apps/desktop/scripts/cd/sign.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/signer.cjs` | `apps/desktop/scripts/cd/signer.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/squirrel.cjs` | `apps/desktop/scripts/cd/squirrel.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/squirrel.test.cjs` | `apps/desktop/scripts/cd/__tests__/squirrel.test.cjs` (move) | Test | Desktop build/development tooling | `work-records/proposals/2026-10-13/shipit-preparation/plan.md` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/standards.baseline.json` | `apps/desktop/scripts/ci/standards.baseline.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | `scripts/public/policy.json` | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/standards.mjs` | `apps/desktop/scripts/ci/standards.mjs` (retain Owner) | Quality implementation | Desktop quality | `scripts/cd/public/policy.json`, `work-records/20260928-batch-metadata/result.md`, `work-records/20260929-office-recovery/verification.md` | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/standards.policy.json` | `apps/desktop/scripts/ci/standards.policy.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | `scripts/cd/public/policy.json` | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/standards.test.mjs` | `apps/desktop/scripts/ci/__tests__/standards.test.mjs` (move) | Test | Desktop build/development tooling | `scripts/cd/public/policy.json` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/target.cjs` | `apps/desktop/scripts/shared/target.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/BUILD.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/temporary-cleanup.cjs` | `apps/desktop/scripts/shared/temporary-cleanup.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/temporary-cleanup.test.cjs` | `apps/desktop/scripts/shared/__tests__/temporary-cleanup.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/toolchain.test.cjs` | `apps/desktop/scripts/cd/__tests__/toolchain.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/utils.cjs` | `apps/desktop/scripts/shared/utils.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/utils.test.cjs` | `apps/desktop/scripts/shared/__tests__/utils.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/velobundle.test.mjs` | `apps/desktop/scripts/cd/__tests__/velobundle.test.mjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/velopack-sign.cjs` | `apps/desktop/scripts/cd/velopack-sign.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/velopack-sign.test.cjs` | `apps/desktop/scripts/cd/__tests__/velopack-sign.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/velopack.cjs` | `apps/desktop/scripts/cd/velopack.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/velopack.d.mts` | `apps/desktop/scripts/cd/velopack.d.mts` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/velopack.mjs` | `apps/desktop/scripts/cd/velopack.mjs` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/velopack.py` | `apps/desktop/scripts/cd/velopack.py` (retain Owner) | Release security mechanism | Desktop release/installation | No exact path found; check sibling modules and dynamic consumers | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/velopack.test.cjs` | `apps/desktop/scripts/cd/__tests__/velopack.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/velopack_test.py` | `apps/desktop/scripts/cd/__tests__/velopack_test.py` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/verification-directories.py` | `apps/desktop/scripts/cd/verification-directories.py` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/verification-directory.cjs` | `apps/desktop/scripts/cd/verification-directory.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `scripts/updater.cjs` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/verify.cjs` | `apps/desktop/scripts/cd/verify.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/visual.mjs` | `apps/desktop/scripts/ci/visual.mjs` (retain Owner) | Quality implementation | Desktop quality | `scripts/cd/public/policy.json` | Original quality and i18n sets; do not change the baseline |
| `apps/desktop/scripts/visual.test.mjs` | `apps/desktop/scripts/ci/__tests__/visual.test.mjs` (move) | Test | Desktop build/development tooling | `scripts/ci/test.cjs`, `scripts/cd/public/policy.json` | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/vpk.cjs` | `apps/desktop/scripts/cd/vpk.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `scripts/BUILD.md` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/vpk.json` | `apps/desktop/scripts/cd/vpk.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/vpk.test.cjs` | `apps/desktop/scripts/cd/__tests__/vpk.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/wheels.cjs` | `apps/desktop/scripts/cd/wheels.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/wheels.json` | `apps/desktop/scripts/cd/wheels.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `apps/desktop/scripts/windows-runtime.cjs` | `apps/desktop/scripts/cd/windows-runtime.cjs` (retain Owner) | Domain mechanism/build bootstrap | Desktop build/runtime | No exact path found; check sibling modules and dynamic consumers | Baseline build/runtime contracts and actual host probes |
| `apps/desktop/scripts/windows-runtime.test.cjs` | `apps/desktop/scripts/cd/__tests__/windows-runtime.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `apps/desktop/scripts/windows-sign.cjs` | `apps/desktop/scripts/cd/windows-sign.cjs` (retain Owner) | Release security mechanism | Desktop release/installation | `.env.example`, `scripts/BUILD.md`, `scripts/cd/public/overlay.patch` | Original contract; native acceptance on affected platforms |
| `apps/desktop/scripts/windows-sign.test.cjs` | `apps/desktop/scripts/cd/__tests__/windows-sign.test.cjs` (move) | Test | Desktop build/development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/BUILD.md` | `docs/runbooks/build.md` (carries the upstream body migration; does not restore the old path) | Configuration/declaration/documentation | build operation guidelines | `.agents/skills/update-codex-packages/SKILL.md`, `.env.example`, `AGENTS.md` | Original consumers and structural/declaration checks |
| `scripts/affected.cjs` | `scripts/ci/affected.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `.agents/skills/test-quality/SKILL.md`, `docs/runbooks/development.md`, `scripts/ci/affected.test.mjs` | Original module contract and installation bootstrap behavior |
| `scripts/affected.policy.json` | `scripts/ci/affected.policy.json` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | `.agents/skills/test-quality/SKILL.md`, `docs/runbooks/development.md` | Original consumers and structural/declaration checks |
| `scripts/appicon.py` | `scripts/cd/icons.py` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/resources/ICONS.md` | Original module contract and installation bootstrap behavior |
| `scripts/artifacts.cjs` | `scripts/shared/artifacts.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `.agents/skills/update-codex-packages/SKILL.md`, `apps/desktop/docs/architecture/ownership.md`, `apps/desktop/runtime/codex.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/artifacts.test.cjs` | `scripts/shared/__tests__/artifacts.test.cjs` (move) | Test | Repository development tooling | `.agents/skills/update-codex-packages/SKILL.md`, `apps/desktop/package.json`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/check_import_position.py` | `scripts/ci/imports.py` (retain Owner) | Quality implementation | Repository quality | `scripts/ci/format.cjs`, `scripts/formatter.test.cjs` | Original formatting/static-check set |
| `scripts/ci/README.md` | `scripts/ci/README.md` (retain Owner) | CI orchestration/configuration | Repository CI | `work-records/proposals/2026-10-22/quick/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/affected.test.mjs` | `scripts/ci/__tests__/affected.test.mjs` (move) | Test | Repository CI | `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/distribution.cjs` | `scripts/cd/distribution.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `apps/desktop/package.json`, `package.json`, `scripts/ci/distribution.test.cjs` | Original stage/set/report/isolated identity |
| `scripts/ci/distribution.test.cjs` | `scripts/cd/__tests__/distribution.test.cjs` (move) | Test | Repository CI | `scripts/ci/test.cjs`, `scripts/ci/test.test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/events.cjs` | `scripts/ci/events.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | No exact path found; check sibling modules and dynamic consumers | Original stage/set/report/isolated identity |
| `scripts/ci/events.test.cjs` | `scripts/ci/__tests__/events.test.cjs` (move) | Test | Repository CI | `scripts/ci/test.cjs`, `work-records/proposals/2026-10-21/testing/plan.md` | Original test set and relative paths/helper closure |
| `scripts/ci/external-cases.json` | `scripts/ci/external-cases.json` (retain Owner) | CI orchestration/configuration | Repository CI | `docs/runbooks/development.md` | Original stage/set/report/isolated identity |
| `scripts/ci/generate-office-corpus.cjs` | `scripts/ci/generate-office-corpus.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `apps/desktop/e2e/fixtures/office-corpus/README.md`, `scripts/ci/README.md` | Original stage/set/report/isolated identity |
| `scripts/ci/model.cjs` | `scripts/ci/model.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | No exact path found; check sibling modules and dynamic consumers | Original stage/set/report/isolated identity |
| `scripts/ci/model.test.cjs` | `scripts/ci/__tests__/model.test.cjs` (move) | Test | Repository CI | `scripts/ci/README.md`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/package.cjs` | `scripts/cd/package.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `docs/runbooks/development.md`, `package.json`, `work-records/ci-package/2026-09-24/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/package.test.cjs` | `scripts/cd/__tests__/package.test.cjs` (move) | Test | Repository CI | `scripts/ci/README.md`, `scripts/ci/quarantine.json`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/progress.cjs` | `scripts/ci/progress.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | No exact path found; check sibling modules and dynamic consumers | Original stage/set/report/isolated identity |
| `scripts/ci/progress.test.cjs` | `scripts/ci/__tests__/progress.test.cjs` (move) | Test | Repository CI | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/ci/quality.py` | `scripts/ci/quality.py` (retain Owner) | CI orchestration/configuration | Repository CI | `work-records/proposals/2026-10-21/testing/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/quarantine.json` | `scripts/ci/quarantine.json` (retain Owner) | CI orchestration/configuration | Repository CI | `apps/desktop/e2e/fixtures/quarantine.ts`, `docs/runbooks/development.md` | Original stage/set/report/isolated identity |
| `scripts/ci/skillhub.cjs` | `scripts/ci/skillhub.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | No exact path found; check sibling modules and dynamic consumers | Original stage/set/report/isolated identity |
| `scripts/ci/skillhub.test.cjs` | `scripts/ci/__tests__/skillhub.test.cjs` (move) | Test | Repository CI | `scripts/ci/README.md`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/smoke.cjs` | `scripts/ci/smoke.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `package.json`, `scripts/ci/smoke.test.cjs`, `work-records/proposals/2026-10-22/quick/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/smoke.json` | `scripts/ci/smoke.json` (retain Owner) | CI orchestration/configuration | Repository CI | `apps/serve/tests/contract_runner.py`, `work-records/proposals/2026-10-22/quick/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/smoke.test.cjs` | `scripts/ci/__tests__/smoke.test.cjs` (move) | Test | Repository CI | `scripts/ci/README.md`, `scripts/ci/smoke.json`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/test.cjs` | `scripts/ci/test.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `apps/desktop/docs/architecture/testing-strategy.md`, `docs/runbooks/development.md`, `package.json` | Original stage/set/report/isolated identity |
| `scripts/ci/test.test.cjs` | `scripts/ci/__tests__/test.test.cjs` (move) | Test | Repository CI | `scripts/ci/README.md`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/ci/transport.test.cjs` | `scripts/ci/__tests__/transport.test.cjs` (move) | Test | Repository CI | `scripts/ci/test.cjs`, `work-records/proposals/2026-10-21/testing/plan.md` | Original test set and relative paths/helper closure |
| `scripts/ci/verdict.cjs` | `scripts/ci/verdict.cjs` (retain Owner) | CI orchestration/configuration | Repository CI | `docs/runbooks/development.md`, `work-records/ci-package/2026-09-24/plan.md` | Original stage/set/report/isolated identity |
| `scripts/ci/verdict.test.cjs` | `scripts/ci/__tests__/verdict.test.cjs` (move) | Test | Repository CI | `docs/runbooks/development.md`, `scripts/ci/README.md`, `scripts/ci/test.cjs` | Original test set and relative paths/helper closure |
| `scripts/cleanup.cjs` | `scripts/pre/cleanup.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `scripts/cd/public/test_sync.py` | Original module contract and installation bootstrap behavior |
| `scripts/cleanup.test.cjs` | `scripts/pre/__tests__/cleanup.test.cjs` (move) | Test | Repository development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/command-links.cjs` | `scripts/pre/commands.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `docs/runbooks/development.md`, `scripts/cd/public/test_sync.py` | Original module contract and installation bootstrap behavior |
| `scripts/command-links.test.cjs` | `scripts/pre/__tests__/commands.test.cjs` (move) | Test | Repository development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/debug.cjs` | `scripts/dev/desktop.cjs` (retain Owner) | Development/debugging mechanism | Repository instance/Serve debugging | `docs/runbooks/development.md`, `package.json`, `scripts/debug.test.cjs` | Original process/supervision/isolation contract |
| `scripts/debug.test.cjs` | `scripts/dev/__tests__/desktop.test.cjs` (move) | Test | Repository development tooling | `apps/desktop/package.json`, `package.json`, `scripts/ci/test.test.cjs` | Original test set and relative paths/helper closure |
| `scripts/dependencies.py` | `scripts/shared/dependencies.py` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/scripts/shared/component-cache.cjs`, `apps/serve/tests/contract_skill_dependencies.py`, `docs/runbooks/development.md` | Original module contract and installation bootstrap behavior |
| `scripts/desktop.cjs` | `scripts/shared/desktop.cjs` (retain Owner) | Mixed entry point/orchestration to be consolidated | Repository development orchestration | `apps/desktop/docs/architecture/ownership.md`, `docs/runbooks/development.md`, `package.json` | ops command contract and original setup chain |
| `scripts/docs/check.py` | `scripts/ci/docs/check.py` (retain Owner) | Documentation checks/resource | Repository knowledge checks | `docs/architecture/knowledge.md`, `docs/index.md`, `scripts/ci/docs/keywords.yaml` | Original documentation and structure set |
| `scripts/ci/docs/commands.test.cjs` | `scripts/ci/docs/__tests__/commands.test.cjs` (move) | Test | Repository knowledge checks | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/docs/frontmatter.py` | `scripts/ci/docs/frontmatter.py` (retain Owner) | Documentation checks/resource | Repository knowledge checks | `docs/architecture/knowledge.md` | Original documentation and structure set |
| `scripts/docs/keywords.yaml` | `scripts/ci/docs/keywords.yaml` (retain Owner) | Documentation checks/resource | Repository knowledge checks | `.agents/skills/design-solution/SKILL.md`, `docs/architecture/knowledge.md`, `scripts/cd/public/test_sync.py` | Original documentation and structure set |
| `scripts/docs/structure-core.mjs` | `scripts/ci/docs/structure-core.mjs` (retain Owner) | Documentation checks/resource | Repository knowledge checks | `.agents/skills/knowledge-governance/scripts/check.mjs`, `docs/runbooks/development.md` | Original documentation and structure set |
| `scripts/docs/structure.mjs` | `scripts/ci/docs/structure.mjs` (retain Owner) | Documentation checks/resource | Repository knowledge checks | No exact path found; check sibling modules and dynamic consumers | Original documentation and structure set |
| `scripts/ci/docs/structure.test.mjs` | `scripts/ci/docs/__tests__/structure.test.mjs` (move) | Test | Repository knowledge checks | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/ci/docs/test_check.py` | `scripts/ci/docs/__tests__/test_check.py` (move) | Test | Repository knowledge checks | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/docs/vocabulary.py` | `scripts/ci/docs/vocabulary.py` (retain Owner) | Documentation checks/resource | Repository knowledge checks | `docs/architecture/knowledge.md`, `scripts/ci/docs/keywords.yaml` | Original documentation and structure set |
| `scripts/format.sh` | `scripts/ci/format.sh` (retain Owner) | Quality implementation | Repository quality | `docs/runbooks/development.md` | Original formatting/static-check set |
| `scripts/formatter.cjs` | `scripts/ci/format.cjs` (retain Owner) | Quality implementation | Repository quality | `docs/runbooks/development.md`, `scripts/cd/public/overlay.patch`, `scripts/shared/workspace.cjs` | Original formatting/static-check set |
| `scripts/formatter.test.cjs` | `scripts/ci/__tests__/format.test.cjs` (move) | Test | Repository development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/git-hooks.test.cjs` | Deleted with the retired entry point | Test | Repository development tooling | No ongoing consumers | Do not retain a dedicated test for a retired prompt script with no remaining use; currently explicitlinkscheck/repair by original Owner verification |
| `scripts/install-git-hooks.sh` | Retired prompt script already deleted | retired entry point | Repository toolchain | Public-export registration removed | No current command invocation; Existing sharedhookssecurity migration guidance belongs in the development guide, Do not install or clean up automaticallyhooks |
| `scripts/lint.py` | `scripts/ci/lint.py` (retain Owner) | Quality implementation | Repository quality | `docs/architecture/persistence.md`, `scripts/shared/workspace.cjs`, `tests/release/contract_lint.py` | Original formatting/static-check set |
| `scripts/npm-installed-cache.cjs` | `scripts/shared/dependencies.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `scripts/cd/public/test_sync.py` | Original module contract and installation bootstrap behavior |
| `scripts/npm-installed-cache.test.cjs` | `scripts/shared/__tests__/dependencies.test.cjs` (move) | Test | Repository development tooling | `apps/desktop/package.json` | Original test set and relative paths/helper closure |
| `scripts/public/.gitignore` | `scripts/cd/public/.gitignore` (retain Owner) | Public preparation tooling/policy | Public export | No exact path found; check sibling modules and dynamic consumers | isolationsync/npmtests andoverlayapplication |
| `scripts/public/README.md` | `scripts/cd/public/README.md` (retain Owner) | Public preparation tooling/policy | Public export | `docs/architecture/ownership.md` | isolationsync/npmtests andoverlayapplication |
| `scripts/public/npm.mjs` | `scripts/cd/public/npm.mjs` (retain Owner) | Public preparation tooling/policy | Public export | No exact path found; check sibling modules and dynamic consumers | isolationsync/npmtests andoverlayapplication |
| `scripts/cd/public/npm.test.mjs` | `scripts/cd/public/__tests__/npm.test.mjs` (move) | Test | Public export | `scripts/ci/test.cjs`, `scripts/cd/public/README.md` | Original test set and relative paths/helper closure |
| `scripts/cd/public/overlay.patch` | `scripts/cd/public/overlay.patch` (retain Owner) | Public preparation tooling/policy | Public export | `apps/desktop/docs/architecture/evaluation.md` | isolationsync/npmtests andoverlayapplication |
| `scripts/cd/public/policy.json` | `scripts/cd/public/policy.json` (retain Owner) | Public preparation tooling/policy | Public export | `docs/architecture/ownership.md` | isolationsync/npmtests andoverlayapplication |
| `scripts/public/sync.py` | `scripts/cd/public/sync.py` (retain Owner) | Public preparation tooling/policy | Public export | `scripts/cd/public/README.md` | isolationsync/npmtests andoverlayapplication |
| `scripts/cd/public/test_sync.py` | `scripts/cd/public/__tests__/test_sync.py` (move) | Test | Public export | `apps/desktop/docs/architecture/evaluation.md`, `scripts/cd/public/README.md` | Original test set and relative paths/helper closure |
| `scripts/python.cjs` | `scripts/shared/python.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/package.json`, `apps/desktop/runtime/codex.cjs`, `apps/desktop/runtime/powershell.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/python.d.cts` | `scripts/shared/python.d.cts` (retain Owner) | Configuration/declaration/documentation | Adjacent domain | No exact path found; check sibling modules and dynamic consumers | Original consumers and structural/declaration checks |
| `scripts/ripgrep.cjs` | `scripts/shared/ripgrep.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/scripts/cd/build.cjs`, `apps/desktop/scripts/cd/bundle.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/serve-dev.sh` | `scripts/dev/serve.sh` (retain Owner) | Development/debugging mechanism | Repository instance/Serve debugging | `docs/runbooks/development.md` | Original process/supervision/isolation contract |
| `scripts/serve_watch.py` | `scripts/dev/watch.py` (retain Owner) | Development/debugging mechanism | Repository instance/Serve debugging | `docs/runbooks/development.md`, `scripts/test_serve_watch.py`, `scripts/shared/workspace.cjs` | Original process/supervision/isolation contract |
| `scripts/setup_config.py` | `scripts/pre/config.py` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `scripts/workspace.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/symlinks.cjs` | `scripts/pre/symlinks.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `scripts/shared/workspace.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/symlinks.test.cjs` | `scripts/pre/__tests__/symlinks.test.cjs` (move) | Test | Repository development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/test_serve_watch.py` | `scripts/dev/__tests__/test_watch.py` (move) | Test | Repository development tooling | No exact path found; check sibling modules and dynamic consumers | Original test set and relative paths/helper closure |
| `scripts/timing.cjs` | `scripts/shared/timing.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/scripts/cd/acceptance.cjs`, `apps/desktop/scripts/cd/branding.cjs`, `apps/desktop/scripts/cd/build.cjs` | Original module contract and installation bootstrap behavior |
| `scripts/timing.test.cjs` | `scripts/shared/__tests__/timing.test.cjs` (move) | Test | Repository development tooling | `apps/desktop/package.json` | Original test set and relative paths/helper closure |
| `scripts/toolchain-install.test.cjs` | `scripts/pre/__tests__/toolchain-install.test.cjs` (move) | Test | Repository development tooling | `apps/desktop/package.json`, `package.json` | Original test set and relative paths/helper closure |
| `scripts/toolchain.cjs` | `scripts/pre/toolchain.cjs` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `.agents/skills/test-quality/SKILL.md`, `.codex/environments/pnpm.toml`, `.gitlab-ci.yml` | Original module contract and installation bootstrap behavior |
| `scripts/updater-session.test.cjs` | `scripts/cd/__tests__/updater-session.test.cjs` (move) | Test | Repository development tooling | `apps/desktop/package.json` | Original test set and relative paths/helper closure |
| `scripts/cd/updater.cjs` | `scripts/cd/updater.cjs` (retain Owner) | Development/debugging mechanism | Repository instance/Serve debugging | `package.json` | Original process/supervision/isolation contract |
| `scripts/vendor/codex/README.md` | `scripts/vendor/codex/README.md` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `.agents/skills/update-codex-packages/SKILL.md`, `docs/runbooks/development.md` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/codex/manifest.json` | `scripts/vendor/codex/manifest.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `.agents/skills/update-codex-packages/SKILL.md`, `apps/desktop/runtime/codex.test.cjs`, `apps/serve/service/chat/service/subscriptions.py` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/fetch-vendor.sh` | `scripts/vendor/fetch-vendor.sh` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/powershell/manifest.json` | `scripts/vendor/powershell/manifest.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/python-build-standalone/README.md` | `scripts/vendor/python-build-standalone/README.md` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/python-build-standalone/manifest.json` | `scripts/vendor/python-build-standalone/manifest.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `apps/desktop/scripts/python.test.cjs`, `scripts/BUILD.md`, `scripts/cd/public/test_sync.py` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/COPYING` | `scripts/vendor/ripgrep/COPYING` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/LICENSE-MIT` | `scripts/vendor/ripgrep/LICENSE-MIT` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/README.md` | `scripts/vendor/ripgrep/README.md` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/UNLICENSE` | `scripts/vendor/ripgrep/UNLICENSE` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/manifest.json` | `scripts/vendor/ripgrep/manifest.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `scripts/cd/public/test_sync.py` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/ripgrep/aarch64-apple-darwin/rg` | `scripts/vendor/ripgrep/aarch64-apple-darwin/rg` (retain Owner) | Reviewed supply-chain binary | Desktop build resources | `scripts/shared/ripgrep.cjs`, `apps/desktop/scripts/cd/build.cjs`, `apps/desktop/scripts/cd/bundle.cjs` | Manifest platform/architecture resolution, SHA-256 validation, and explicit exclusion from public export |
| `scripts/vendor/texlive/README.md` | `scripts/vendor/texlive/README.md` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `docs/architecture/skills.md`, `work-records/proposals/2026-10-17/windows-tex-sandbox/plan.md` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/build-windows.ps1` | `scripts/vendor/texlive/build-windows.ps1` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `work-records/proposals/2026-10-17/windows-tex-sandbox/plan.md` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/build.sh` | `scripts/vendor/texlive/build.sh` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `scripts/vendor/texlive/README.md` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/discovery.patch` | `scripts/vendor/texlive/discovery.patch` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/engines.json` | `scripts/vendor/texlive/engines.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/engines.ps1` | `scripts/vendor/texlive/engines.ps1` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/engines.py` | `scripts/vendor/texlive/engines.py` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `scripts/vendor/texlive/README.md` | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/kpathsea.json` | `scripts/vendor/texlive/kpathsea.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/kpathsea.ps1` | `scripts/vendor/texlive/kpathsea.ps1` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | No exact path found; check sibling modules and dynamic consumers | Manifest sources/inventory and original supply-chain contract |
| `scripts/vendor/texlive/manifest.json` | `scripts/vendor/texlive/manifest.json` (retain Owner) | Supply-chain resource/implementation | Toolchain supply chain | `apps/desktop/protected.test.ts`, `apps/desktop/protected.ts`, `apps/desktop/runtime/texlive.cjs` | Manifest sources/inventory and original supply-chain contract |
| `scripts/wheel.py` | `scripts/cd/wheel.py` (retain Owner) | Domain mechanism/installation bootstrap | Repository toolchain/build | `apps/desktop/scripts/cd/wheels.cjs`, `docs/architecture/ownership.md`, `scripts/BUILD.md` | Original module contract and installation bootstrap behavior |
| `scripts/shared/workspace.cjs` | `scripts/shared/workspace.cjs` (retain Owner) | Mixed entry point/orchestration to be consolidated | Repository development orchestration | `docs/runbooks/development.md`, `open.md`, `package.json` | ops command contract and original setup chain |

<a id="83-上游整合补记2026-10-23"></a>
### 8.3 Upstream Integration Notes (2026-10-23)

During this implementation, the latest preview was first integrated into the current working branch, fast-forwarding HEAD from
`92f949471a45161c162dfc4ec229f838a09d148f` to
`501320305ff88b6be078c1eaa6bfb4011d794ca1` with 47 upstream commits, after which this task's uncommitted changes were restored.
The 249 legacy files and the “original path/static consumers” in Section 8.2 remain inventory facts from the old HEAD; their counts are not recalculated.
Only the destination for the original build-guide row reflects a remote migration. Current conventions follow the actual Owners; do not restore old files.

| Upstream or integration item | Current ownership and disposition | Current consumers and verification boundary |
| --- | --- | --- |
| Migration of `scripts/BUILD.md` | `docs/runbooks/build.md` is the current build specification | Root rules, development guidance, build scripts, and prerequisites for signing/release operations point to the new text; the old path remains only in the historical inventory |
| New distribution coordination guide | `docs/runbooks/distribution.md` owns client/standalone distribution repository/server handoffs | Wiring commands in this repository does not prove builds, uploads, or server releases in external repositories; the read-only check of the external repository remains at `cb29ba9b9226f6b4b0fc3a2e64ab966e9358a38d` |
| Documentation-check Owner update | `scripts/ci/docs/check.py` and the original test moved to `scripts/ci/docs/__tests__/test_check.py` | Carries forward upstream discovery scope and required content; build artifacts are not the canonical source and do not justify reducing source gates |
| Public projection and exclusion update | `scripts/cd/public/policy.json`, `overlay.patch`, and tests moved to `__tests__/test_sync.py` | Retains new upstream content exclusions and this task's ops projection; old paths are removed and new upstream exclusion assertions are preserved; historical drift across the full tree still requires separate verification |
| Current public overlay status (rechecked 2026-10-24) | Merged in `18d77f13d` on `shushen_release/mvp_v0.3_preview`; full-tree patch drift is fixed, and the retired automatic-upload patch was removed in a deletion commit | During implementation, a real export verified 986 npm versions, but a complete export remained blocked by unaudited binaries. Asset review, the Office corpus allowlist, and its review declaration are outside this ops-cli commit; do not bulk-add hashes or bypass scanning to allow release. The Git skip-patch issue in nested worktree output was found and fixed using isolated Git; mechanical tests do not replace a successful full-tree export |

The latest interface check distinguishes this repository from external ones: `.gitlab-ci.yml` now uses ops, while the local distribution repository's `build/build.py`
still selects root `package:dist` and `package:check`, appends `--type` for preview, calls nonexistent
`package:verify` to resume, and may append the currently unregistered `--skip-check`. These parameters cannot be silently ignored.
This was a snapshot of a cutover blocker at that time. On 2026-10-24, the user explicitly required leaving the external repository untouched and retaining the fixed protocol in the product repository;
see Section 8.5 for current handling, and do not use this historical snapshot to require changes to the external repository.

2026-10-23 macOS host verification: ran `pnpm ops dev serve --watch` from an independent physical home directory.
After updating only the mtime of a real watched source file (content SHA256 unchanged), the original Serve PID exited and a new PID started;
the service instance identity changed while the working directory remained the same. Ctrl+C released both generations of processes and the listening port.
This evidence proves only real backend idle reload and shutdown behavior. No model request was sent, and it does not prove protection of active conversations/HIL,
Electron main/preload coordination, or Windows child-tree shutdown. The first launch using a `/tmp` alias was rejected by the storage security boundary;
using the physical path succeeded. Path resolution and directory protection were not loosened for acceptance.

Direct, distribution, and explicit candidate `dir` flows for preview/release are now registered,
but external-repository consumers and checkpoint/skip-check are not yet closed. The original `--install` requirement
remains with the Desktop installation Owner; the CLI does not expose an install parameter. See the build guide and distribution coordination guide.
This work only integrates documentation and recorded gaps; it does not authorize changes to external repositories, builds, installation, uploads, or releases.

Later, on `2026-10-23`, the updated `shushen_release/mvp_v0.3_preview` was fast-forwarded from
`404e131d3bad1c1e387ed726d373a26fae9f0cb2` to
`682ed3b0a8e3a9549dbe0a2caef7fb53f37061f3`. The existing inventory and initial integration statistics remain historical snapshots
and do not represent the current repository-wide consumer list; recheck current worktree changes and their acceptance against that HEAD.

Subsequently, on `2026-10-23`, the latest remote `shushen_release/mvp_v0.3_preview` was fast-forwarded from
`682ed3b0a8e3a9549dbe0a2caef7fb53f37061f3` to
`3dd502cf583e1415ae82e4f6f7a9dc9157e3b8c8` (12 commits); the source SHA was rechecked as stable before integration,
and `git diff --check` passed afterward with no unmerged paths. The current CLI task's dirty changes were protected and restored through a named stash;
its acceptance must use this HEAD as the baseline.

This iteration continued by fast-forwarding remote `shushen_release/mvp_v0.3_preview` to
`fbe85189516e86fe5b289b01b91ba7a308aa76f9`. Existing staged, unstaged, and
untracked content was byte-for-byte compared before and after integration and preserved; the original worktree staging layers were not erased through restaging or overwriting. Earlier historical
records are not rewritten as acceptance for the new revision; subsequent real builds and host acceptance must use this HEAD and final worktree source.


<a id="84-按任务域组织脚本2026-10-24"></a>
### 8.4 Organizing Scripts by Task Domain (2026-10-24)

- Root script implementations were migrated by responsibility into `pre`, `dev`, `ci`, `cd`, and `shared`; only `ops-cli.cjs` remains as the root user entry point. `vendor` continues to hold frozen supply-chain resources.
- `cd` takes over cross-domain orchestration from the original `ci/package.cjs` and `ci/distribution.cjs`; docs checks belong under `ci/docs`, public projection tools under `cd/public`, without expanding public-export permissions or the asset allowlist.
- Desktop setup, development, checks, packaging, and shared mechanisms were grouped under the same responsibilities within `apps/desktop/scripts`; its build, signing, and native security policies were not moved upward.
- Tests and dedicated fixtures were placed near each Owner under `__tests__`; the root retains only the entry point and organization regression tests. New organization checks verify scripts and test sets under the actual package cwd, not just directory strings.
- The original-path column in Section 8.2 preserves historical inventory identity, while its target column carries the new paths from this cutover; lifecycle names, argument order, CI recipes, execution cwd, and signal/permission boundaries remain unchanged by migration.
- Relative imports, Python module names, build callbacks, PS1/PSM1, LF constraints, initialization configuration, generators, and public overlay were migrated in sync; no forwarding shells for old files were retained.
- Acceptance and remaining evidence gaps are recorded in the delivery record; the deferral boundaries for existing instances, the standalone distribution repository, Windows/real models/public asset review remain unchanged.

<a id="85-固定分发协议2026-10-24"></a>
### 8.5 Fixed Distribution Protocol (2026-10-24)

- Leave the standalone `scholarseed-distribution` repository unchanged. The product root retains the probed `scripts/desktop.cjs`;
  its three npm interfaces are `package:dist`, `package:check`, and `package:verify`, while ops remains the everyday entry point.
- `package:dist` maps to `cd build release --workflow distribution`; `package:check`
  maps to `cd build release --stage dir --candidate`; legacy `--type` maps to `--channel`.
  The canonical parser continues validating version, result path, and signing-material parameters; no arbitrary argument passthrough channel is added.
- `package:verify` explicitly rejects resuming a legacy checkpoint; `--skip-check` explicitly rejects skipping acceptance.
  The current Owner lacks these capabilities, so their presence as commands does not mean they are available; do not present a rebuild or old result as a resume.
- Tests are placed near the root in `__tests__/desktop.test.cjs` and added to the existing CI set. Verify the protocol using the actual parameter-generation function from the unmodified distribution repository,
  recording evidence separately for normal builds, candidate checks, and unsupported capabilities.
- Section 8.4's “ops only at root, no legacy entry points” describes the historical organization state for that iteration. The external-protocol exception in this section follows the user's newer requirement;
  do not restore other old paths. Only this task's portion of the six files previously added to the distribution repository by mistake was cleaned up.

<a id="86-desktop-工程接口优化2026-10-26"></a>
### 8.6 Desktop Engineering Interface Improvements (2026-10-26)

This section records the implementation and remaining verification from this iteration; it does not rewrite historical mappings above as current capabilities. The product
worktree baseline is `2099b41eb47e56ddf4a92f4cf9c5c0890b530158`; fetch only, without merging new remote commits.
The original location, versions, downloads, cache, and trust policy for `scripts/vendor` are outside this adjustment; the standalone distribution repository is read-only.

| Inventory item | Baseline / disposition in this iteration | Consumers and preserved boundaries |
| --- | --- | --- |
| Desktop scripts | 51 entry points and 11 actual hooks; 47 entry points after removing 4 duplicate aliases with no independent responsibility | `package:installer` → `package`; `build:check` → `package:check`; `build:release` / `release` → `package:distribution`. Update the setup allowlist in sync; add no compatibility aliases |
| `pretest` long chain | Extracted to Desktop `scripts/ci/pretest.cjs`, which owns the ordered checks and contract-file list | Prerequisite for local test; the ordinary CI pretest stage and quarantine's existing split consume the same contract set; preserve fail-fast behavior |
| test / coverage | Desktop `scripts/ci/test.cjs` is the sole test-file inventory | Shared by local Node/c8 and root CI; remove coverage string parsing without deleting tests, changing glob scope, or increasing local file concurrency |
| E2E | `scripts/ci/e2e.cjs` combines build and run steps for mr/live/update | Project suites remain smoke/live/update; do not merge generic `test:e2e`, Preview Playwright, and real-product acceptance |
| Generated-code paths | Fixed virtual main/preload references accidentally changed in closure tests during source-file migration | Resolve against artifact layout rather than test source directory; after writing artifacts to disk, load them with Node from a different cwd; native fixtures read the Owner inventory; do not change the production verifier or security criteria |
| Public projection | Synchronized the package, pretest Owner, and its tests' overlay; added independent-consumer regression | Preserve the difference between private 5 steps and public 3 steps; do not change freeze policy, allowlist, verification command, or existing user projection-policy changes |
| Distribution protocol | Retained the three root package compatibility entry points and Desktop `package:dist` | External repository currently invokes distribution/candidate through root ops; setup, fixed smoke, signing, and result admission for full distribution remain unchanged |
| Module references | No aliases; retain literal relative imports | 38 cross-root references in 24 production CJS files and 3 ESM references, pointing to 10 targets; public exports and bootstrap static closure remain traceable without an extra resolver |

The TypeScript baseline was checked using the compiler Program: node has 330 roots / 384 in-repository source files,
and web has 1024 roots / 1072 in-repository source files; root Playwright, 4 root tests, and 68 E2E TS files
are outside both Programs. The two baseline configurations both pass actual `tsc --noEmit -p`, but that does not prove omitted files are correct.
This iteration added a shared base configuration, a mixed simulated-host `tools` project, and a `test` project; the solution is the shared inventory for type and i18n checks.
The node root/Program is unchanged; web is now 955 / 1002, with 69 roots moved to tools/test, preserving the original ES2020
environment. tools has 960 / 1008; test has 1152 / 1203 (including JSON; regression checks dynamically verify the detailed type inventory).
The Program union of TS-class files in the repository grew from 1320 to 1418, with none removed: the original 68 E2E files, 5 root test/Playwright files,
22 previously untyped tests under src root and 1 `settings.ts`, plus 1 each for new `application.d.cts` and `electron.test.ts`. The original 141 node and remaining 281 web
test roots still retain their respective environment checks; Node tests are not all changed to a browser target. Type errors in newly included tests
were fixed through precise fixture declarations, DOM generics, and necessary narrowing prerequisites; strictness was not reduced and no failing file was excluded.

Protective regression tests are under Desktop `scripts/ci/__tests__/` and included in the sole test inventory. Real npm/pnpm temporary
empty-dependency fixtures check hook scheduling; they do not replace product or native Windows acceptance. The engineering interface has been switched; the full
gate still has pre-existing failures reproduced against HEAD, which the user confirmed should be tracked separately. This does not support a claim that the full repository is green or that
product/release acceptance is complete; evidence, remaining issues, and scope exceptions are in the delivery summary (non-public execution/provenance record omitted).
The user limited this iteration to exercising engineering tooling on macOS and analyzing Windows compatibility; Windows native acceptance
requirements for the product and packaging remain unchanged, and development-tool verification does not replace product evidence on both platforms.
