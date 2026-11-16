---
id: proposal-dev-cli
title: "ops Development Tool High-Level Design"
doc_type: proposal
category: architecture
status: draft
date: 2026-10-23
updated: 2026-11-06
keywords: [cli, toolchain, monorepo, worktree, packaging, test-gate]
related: [research-dev-cli-inventory]
summary: "Address scattered scripts and package scripts, confusing usage, and potential duplication of responsibilities by using ops to unify task entry, command discovery, and orchestration, improving the development experience and maintainability while preserving lifecycle, CI, and cross-platform behavior."
code_refs:
  - "package.json"
  - "scripts/shared/desktop.cjs"
  - "scripts/shared/workspace.cjs"
  - "scripts/pre/toolchain.cjs"
  - "scripts/ci/test.cjs"
  - "apps/desktop/scripts/ci/test.cjs"
  - "apps/desktop/package.json"
  - "scripts/ci/affected.cjs"
  - "apps/serve/tests/run_all.py"
  - "scripts/cd/distribution.cjs"
  - ".github/workflows/ci.yml"
  - "scripts/shared/python.cjs"
  - "scripts/shared/source.cjs"
  - ".gitlab-ci.yml"
---

<a id="ops-开发工具概要设计"></a>
# ops Development Tool High-Level Design

Current repository ownership is defined by [Repository and Knowledge Boundaries](repositories.md): general knowledge and tools are maintained with the public source. The `cd/public`, overlay, and private-export steps in this page's historical migration record are not current product release entry points.

<a id="1-背景目标与总体方案"></a>
## 1. Background, Goals, and Overall Approach

<a id="11-背景与目标"></a>
### 1.1 Background and Goals

The number of root and local scripts and package scripts has grown. Entry points are scattered, similarly named commands have different meanings, users have difficulty choosing the right command, and shared orchestration risks being maintained more than once. ops improves usability and maintainability through a unified task interface and clear responsibility boundaries; moving files or mechanically reducing the number of commands is not the goal. See the [current-state and migration inventory](ops-cli-inventory.md) for the evidence, requirement categories, old-entry mapping, and consumer records. This document maintains only the technical approach, interfaces, and invariants; it does not duplicate the item-by-item inventory.

- Usability: Remember only `pnpm ops`; discover commands through task domains, layered help, and examples without first studying script paths.
- Clear semantics: Distinguish real/mock, check/modify, and ordinary tests/release acceptance so users know what will run and what it will affect before execution.
- Easier troubleshooting: Identify missing prerequisites, the failed step, the actual Owner, and the next action; a failed check must not silently install or repair anything.
- Maintainability: Command semantics, orchestration, execution primitives, and domain policy each have a single Owner; help, discovery, and invocation stay consistent.
- One-time migration: Commands, consumers, documentation, and tool source in this scope switch together in one delivery; there is no parallel compatibility period for old and new public entry points. Lifecycle, CI, and permission constraints remain unchanged.

Unified inclusion means that every development tool has an explicit owner and disposition; it does not mean that every script must move into the CLI source or become a user-facing leaf command. Retained and merged items enter the unified user interface; internalized items become traceable execution steps; deferred items record their original entry points and boundaries. Nothing is silently omitted, and nothing is forced open without a safe contract.

The CLI does not take over product business logic, the standalone Trace CLI, or external release systems. It does not build a plugin platform or general-purpose workflow engine, and a unified entry point alone is not claimed to reduce runtime cost or prove product acceptance.

<a id="12-总体方案与关键取舍"></a>
### 1.2 Overall Approach and Key Trade-offs

Use `scripts/ops-cli.cjs` as the repository's unified development entry point and necessary orchestration layer, running JavaScript directly with Node:

```text
用户任务 → pnpm ops → 命令解析与契约登记
                           ├─ 帮助/发现
                           └─ 前置与权限核验 → 任务编排 → 领域Owner稳定入口
                                                └─ 复用进程/路径/包管理器等执行基础能力
```

The CLI centrally manages public command names, scopes, prerequisite orchestration, argument boundaries, and error presentation. Domain Owners retain actual build, check, persistence, supply-chain, and security policies. Repository-level tool implementations and their consumers are consolidated in the same delivery; domain logic is not duplicated. After the switch, remove old public aliases included in scope. Installation hooks, bootstrap steps, and internal scripts genuinely consumed by domain Owners may remain, but they are not parallel old and new user-facing entry points.

| Approach | Trade-off |
| --- | --- |
| Organize package scripts and documentation only | Smaller initial change, but multi-package scopes, arguments, and preparation policies remain scattered; this does not solve the growing command-discovery and responsibility problems. |
| Add a new CLI that forwards each old public script | Adds complexity and preserves duplicate entry points. Not selected and not an external transition plan. |
| Unify the CLI contract and orchestration while retaining domain Owners (selected) | Provides a consistent experience and consolidates shared responsibilities. The cost is fully checking consumers, writing equivalent regression coverage, and integrating a one-time overall switch. |

Adding a command tree without consolidating duplicated orchestration is not completion; moving all scripts and breaking their original Owners is not completion either. The directory and source-execution design below serves this goal. It does not create a separate dependency package or a tool project that every contributor must compile.

<a id="13-入口方式与当前状态"></a>
### 1.3 Entry Point and Current Status

Place the CLI directly in the existing scripts directory. Its only Node entry point is `scripts/ops-cli.cjs`; do not create a separate CLI directory. The root package script targets `"ops": "node scripts/ops-cli.cjs"`.

Maintain CommonJS JavaScript source directly: no separate `package.json`, `bin`, file dependency, or `dist`; no TypeScript compilation, npm package publication, or exe generation. Contributors get the same-version entry point by pulling the source. Prepare Desktop/Python dependencies needed by actual tasks through the existing process; a lightweight entry point does not skip that preparation.

macOS and Windows both use `pnpm ops`; Node interprets `.cjs`, without relying on Bash or executable permission bits. Do not add a root launcher or provide a global `ops` command. Manage tool source and tests in the repository; use the `ops-cli` filename for the design and inventory while keeping the knowledge ID stable. This is not a replacement for the ScholarSeed product CLI or the standalone DamoCli.

This document defines the target contract; implementation of the unified entry point and consumer switch is in progress. Whether the source satisfies the contract must be determined by validating the final revision. The command list and design status do not mean that end-to-end, cross-platform, or release acceptance has passed.

Build operation requirements belong in the [Build Guide](../runbooks/build.md); cross-repository consumers and release handoff belong in the distribution coordination record. Do not restore the migrated `scripts/BUILD.md`.

GitLab wiring in this repository and migration of the standalone distribution repository are accepted separately. If the latter still consumes old root commands or unregistered combinations such as preview/resume, the overall delivery is blocked; restoring old aliases or renaming documentation cannot conceal this. See §8.3 of the inventory for upstream integration records.

```text
pnpm ops dev                                   # 隔离的完整产品：Electron + 真实后端
pnpm ops dev browser                           # 浏览器界面连接真实Serve
pnpm ops dev browser --mock                    # 浏览器模拟工作台
pnpm ops pre doctor --scope toolchain          # 诊断开发工具链
pnpm ops ci format --write                     # 显式格式化源码
pnpm ops ci test smoke                         # 固定核心冒烟集合
pnpm ops cd build local                        # 本地运行包，macOS保留必要ad-hoc
```

The CLI itself requires only the Node version declared by the repository and the selected package manager; do not add a root dependency-install step just to obtain the entry point. Do not temporarily download another CLI version when a package is missing, automatically install a global command, or create a separate workflow platform.

Reading order: §§1–3 describe responsibilities, directories, and source execution; §§4–6 define command interfaces, permissions, and execution invariants; §7 defines the one-time switch and acceptance. The itemized current-state and source mapping is maintained only in the separate inventory.

<a id="14-典型用法四个无参数入口"></a>
### 1.4 Typical Usage: Four No-Argument Entry Points

Each of the four top-level commands provides a complete default task chain without requiring users to understand subcommands first. “Complete” here means that the task is closed from prerequisites through result; it does not mean automatically invoking every other top-level command, every optional capability, or real-model acceptance.

```bash
pnpm ops pre    # 自动准备当前worktree所需开发环境，完成后退出
pnpm ops dev    # 启动完整产品并进入开发调试/热更新，Ctrl+C结束本任务
pnpm ops ci     # 执行主流程核心冒烟，输出明确结果
pnpm ops cd     # 构建当前宿主可运行的本地安装包，输出路径与校验结果
```

The usual order is pre→dev→ci→cd. `dev` is a long-running task; exit that instance after development before running `ci` or `cd`. Do not chain the four commands with `&&`. Each command can also run independently and does not depend on in-memory state left by the preceding command.

| No-argument entry point | Default chain | Boundary |
| --- | --- | --- |
| pre | Fixed `desktop-development` profile: verify host tools and target identity → check/safely repair repository links through the original Owner → prepare Desktop dependencies, the development Python environment, and local resources required to start development → final diagnosis | The profile is explicitly registered in the command recipe. It includes only required tools, dependencies, the Python development environment, and Office resources needed to start the development product; it excludes optional capabilities and credentials. Explicitly selecting `pre` permits registered downloads/cache writes and writes in the current worktree. It is repeatable and does not force reinstallation when nothing changed. It does not overwrite conflicting files, clean user data, write model credentials, or change global configuration. |
| dev | Original isolated supervision/dependency preparation → Electron + real backend → frontend HMR and development debugging → on exit, clean up this task's processes/locks | Preserve worktree identity. Do not call arbitrary restarts of the main process/preload/backend HMR; do not interrupt active conversations. |
| ci | Verify prerequisites for the original fixed smoke → core main-flow cases → report/cleanup determination | Same execution recipe as `ci test smoke`; does not expand to quality/full, format automatically, or call a model. |
| cd | Original local-build preparation → package app/backend → host installer → inventory/artifact verification and result | Same recipe as the default `cd build local` desktop/installer/direct. No formal release certificate signing, notarization, upload, or automatic installation of the generated package; retain necessary ad-hoc signing on macOS. |

The “required environment” for `pre` is the registered required-item list in the current development profile. It includes synchronization of the original full Python development environment, not just downloading the Python runtime. Do not claim that first-use resources for optional features, cross-platform cross-compilation, release signing/notarization credentials, or external-service authentication are prepared automatically. The CLI first requires a runnable Node and package manager. If a host tool is missing or has the wrong version, report the blocker through the original exact-version installation process; do not silently modify the global PATH or user configuration. For concurrent environment installation, or dependencies/interpreters in use by an active instance, the Owner must reject or wait; do not hot-modify a conversation environment. `pre doctor` remains diagnostic only; its failure does not automatically run `pre`. Specialized commands such as `pre install` do not call the full `pre` chain and create a loop.

Hot-reload requirements: renderer changes use the original HMR. For main/preload/backend changes, the debug Owner coordinates a safe restart. Preserve the existing instance if the build fails; defer during an active conversation/HIL, and do not use an unprotected forced restart. Acquire idle-restart permission atomically at the backend admission boundary to avoid a race where a new request arrives after checking that the backend is idle.
The development host has integrated non-renderer candidate compilation, a private idle-quiescence protocol, and transactional recovery. On macOS, build-failure preservation and idle restart after a fix have been observed. **Gap:** failure recovery as a whole, real-session behavior, and platform acceptance are not yet fully closed; deterministic orchestration regression tests cannot be treated as complete hot-reload acceptance.

Standalone `serve --watch` has integrated a private parent-child control channel: while busy, it preserves the pending-reload state and stops/rebuilds only after obtaining idle permission; if the control result is uncertain, it preserves the existing instance and waits for the user to exit explicitly. Deterministic and POSIX process-family regression tests do not replace real product-session acceptance. On Windows, only the original root-only exit guarantee exists; verification still needs to be completed.

The private parent-child process control channel now includes the `quiesce_if_idle` protocol and `BackendControl.quiesceIfIdle()`: it atomically attempts to close admission without interrupting a session, and on failure restores its own maintained generation. This is only a prerequisite for restart coordination. `main` has integrated an explicit development-marker control client: only when unpackaged, non-headless, and provided with a renderer development URL does it read the bootstrap from inherited stdin, handle idle/resume/exit by private generation, and drain through the normal exit chain. The development host drives this protocol by launching Electron directly with inherited stdin, without passing secrets through the package manager. The exit ACK first waits for the exact backend to drain, but does not replace proof that the Electron process family exited and the new instance became ready.

The Desktop candidate-compilation Owner reuses `desktopConfiguration` and the existing Vite compilation chain. It writes main/preload and protected assets to a separate candidate directory, does not enable watch or publish canonical output, and cleans up only this candidate on compilation failure. The publish transaction validates the candidate registered by this process and its full digest, stages publication on the same volume while retaining the old output, and rolls back on failure. It commits only after the new instance is ready; on failure it can roll back once the new instance is confirmed stopped. Stop permission is a prerequisite that internal callers must prove, not a user-supplied authorization flag.

The Desktop development host orchestrates these capabilities; root debug manages only worktree identity, locks, and top-level startup. On Windows, a private worker loading only Node built-in modules creates a startup barrier: Electron may be created only after the worker joins this task's native Job. Descendants inherit the Job, and an active count of zero is the proof of exit. The host reads the integrity proof for the registered candidate, publishes N-API libraries by content digest under this worktree's `node_modules/.cache/scholarseed-development/`, and then loads them. This avoids Windows locking canonical output that must be replaced: a matching digest reuses the existing copy, a new digest gets a new directory, and a loaded DLL is never overwritten. The running process holds a read lease on dependencies; the original `pre clean` reclaims them together after acquiring an exclusive lease, without a separate temporary-directory GC. This worker is not a user command or arbitrary script-execution entry point.

After cleanup, the host sends the lease holder a unique terminal-state proof over private IPC. An unknown result returns a dedicated status and retains the receipt, lease, and launcher lock. Without Job proof, it does not auto-reload or treat one process exiting as cross-platform acceptance. Wiring up the implementation does not mean native Windows startup, Job inheritance, and exit have been accepted.

On exit, clean up this task's watcher, timers, process subtree, and locks. If the underlying process exits with code zero but the lifecycle never observed renderer startup readiness, return an explicit startup failure; HTTP/CDP startup readiness is not business or model acceptance.

This explicitly changes the four no-argument groups from “help only” to “run the task.” Root `pnpm ops` still displays help; `pnpm ops pre/dev/ci/cd --help` and `help/list` never trigger preparation, startup, tests, or builds. Unknown arguments/subcommands produce errors and do not fall back to the default chain. A prerequisite failure in any chain stops later stages and preserves the actual exit code and diagnostics. Dangerous actions are not implicitly confirmed because there is no TTY or the command runs in CI. Other non-leaf commands without a registered default action still display help only.

<a id="2-scripts组织与职责"></a>
## 2. scripts Organization and Responsibilities

Do not create a standalone CLI project. Organize repository tools into directories by their actual `pre`, `dev`, `ci`, `cd`, and `shared` responsibilities. The user-facing command tree handles interaction; directories define implementation ownership. A same-named forwarding file is not required for every leaf.

```text
仓库根目录/
├── scripts/
│   ├── ops-cli.cjs            参数、帮助、目标身份、错误呈现与任务调度
│   ├── desktop.cjs            独立分发仓固定协议的参数映射与能力拒绝
│   ├── pre/                  工具链、仓库链接、配置及环境清理
│   ├── dev/                  desktop隔离开发、状态与日志；Serve监视器
│   ├── ci/                   format、lint、测试推荐、质量runner与docs检查
│   ├── cd/                   package验收、distribution编排及public投影工具
│   ├── shared/               commands、execution、source、lease与共享Owner API
│   ├── vendor/               冻结工具链资源，保留原供应链归属
│   └── __tests__/            ops入口与目录组织回归；各子Owner就近设__tests__
├── apps/desktop/scripts/     Desktop领域Owner不变，不上移产品构建策略
│   ├── pre/                  Electron安装、Office资源与开发身份准备
│   ├── dev/                  开发runner、候选编译、监督器与Windows worker
│   ├── ci/                   规范、UI/CSS、视觉与localization检查
│   ├── cd/                   构建、封装、签名、安装与制品核验
│   └── shared/               原生库、租约、摘要、目标及共享构建机制
├── docs/architecture/
│   ├── ops-cli.md            本概要设计
│   └── ops-cli-inventory.md  现状、映射与处置
└── package.json              scripts.ops = node scripts/ops-cli.cjs
```

Keep a small command-contract registry at the entry point for help/list/orchestration to share. It is neither a giant script that rewrites all tools nor a one-by-one forwarding layer for old root aliases. Reuse the original Owner for complex mechanisms; split out nearby modules only when orchestration has a genuinely independent responsibility. Do not pre-create `commands/core/dist` directories. Static registration is not arbitrary shell execution or a general-purpose workflow DSL.

Place tests and dedicated fixtures in `__tests__` within the owning implementation directory; do not create a parallel test tree. Keep root `scripts/__tests__` only for cross-layer entry-point tests. Directory moves must update relative imports, repository/package-root resolution, explicit test sets, installation hooks, builder callbacks, CI, public projections, and documentation together. The distribution entry described below is the only external-protocol exception; do not restore other old paths or per-command forwarding shells.

Package lifecycle names, call order, arguments, execution cwd, and exit/signal policies do not change as a result of reorganizing files.

Leave the standalone distribution repository unchanged: retain the `scripts/desktop.cjs` it probes and the three root interfaces `package:dist`, `package:check`, and `package:verify`. The first two map the old `--type preview|release` to `--channel`, selecting the original distribution workflow and candidate-directory check respectively; do not copy build policy. This is an external integration protocol the user explicitly requires retaining. Do not add a second interactive command tree; the everyday entry point remains `pnpm ops`.

The current Owner has no implementation for `--skip-check` or resuming an old checkpoint. These must fail explicitly with a nonzero status before invoking any Owner; do not discard the arguments, fall back to the old build, or consume historical results. Retaining the entry point does not mean these capabilities exist.

macOS and Windows continue to resolve paths through Node/pathlib. Move PS1/PSM1 files and their resources next to their owners while preserving file modes and newline requirements; a single-machine path regression is not Windows native-installation or process-family acceptance. The protected-compilation source inventory must enumerate the top-level implementations of these known task domains as well, without recursively allowing tests, vendor, or arbitrary directories. Preserve the existing rules for byte freezing, rejecting unknown source and compile-time tampering, and not publishing on failure.

| Existing function | Target handling | Boundary against duplication |
| --- | --- | --- |
| Arguments, help, discovery, errors/JSON, and scope selection | Centralize interaction in `ops-cli.cjs` | One registry; do not duplicate domain inventories or policies. |
| Workspace-root dispatch and cross-task ordering | Consolidate necessary orchestration at the entry point and clarify the original functions | Migrate consumers in the same change; remove dispatch with no consumers; do not leave a CLI → old root alias → dispatcher chain. |
| Executor/argv/cwd/preparation selection in the desktop wrapper | Reuse or consolidate into one shared implementation according to responsibility | Do not hand-write `spawn` in each command; the package manager still triggers real hooks. |
| debug locks/supervision/identity | Reuse the debug Owner | Do not duplicate startup/state mechanisms. |
| toolchain/Python/artifact/configuration/cleanup policies | Retain the actual Owners and clarify boundaries where needed | Do not duplicate version, path, download, or security rules; do not mechanically move whole files. |
| Desktop build/signing, Serve, Trace, and test runners | Keep them in their original domain modules or use verified child processes | Preserve their technology stacks; do not rewrite everything in JavaScript. |
| Installation hooks/first-run bootstrap | Original package scripts and repository-side modules | No CLI dependency; do not call third-party modules that have not yet been installed. |
| Duplicate wrappers and historical aliases | Remove in the same change after checking consumers | No permanent compatibility shells; retain explicitly deferred entry points as recorded in the inventory. |

<a id="3-源码执行与仓库身份"></a>
## 3. Source Execution and Repository Identity

<a id="31-node入口与依赖"></a>
### 3.1 Node Entry Point and Dependencies

The CLI itself runs `.cjs` directly with a supported Node version and built-in modules; basic parsing/help adds no runtime dependency. Top-level imports may use only Node built-ins and side-effect-free local modules. Loading must not run environment checks, download anything, probe the product, or load missing Desktop dependencies. Launch domain third-party tools through a stable boundary when the relevant task is explicitly run. If a third-party dependency is genuinely needed in the future, explain its benefits and its effect on root dependencies and CI without installation; do not silently violate this constraint.

Use the repository's source of truth for Node and package-manager versions; do not create a separate CLI version lock or package-release cycle. Version output may report the root project version and any available source identifier, but must not invent a separate release version. Missing optional Git identifiers must not block help. Node child processes use the verified `process.execPath`; Python and other tools are resolved by their Owners, with no fallback that guesses from PATH.

<a id="32-根script与参数"></a>
### 3.2 Root Script and Arguments

The root `package.json` recommends one user entry point and retains an internal script through which the actual package manager establishes execution identity:

```json
{
  "scripts": {
    "ops": "node scripts/ops-cli.cjs"
  }
}
```

`pnpm ops` does not depend on `node_modules/.bin`; the package manager passes arguments to the Node entry point without recursively invoking a same-named script. Do not add business `preops`/`postops`, so help/list cannot install or start the product. Domain tasks that need real lifecycle behavior still run through the selected package manager, preserving npm/pnpm-specific hooks, `ignore-scripts`, and argument-separator semantics. `ops-cli.cjs` handles only interaction, command selection, and necessary orchestration; reuse original modules for complex domain mechanisms rather than growing a giant script.

The root declares only the user-facing `ops` entry point; do not add a worker script or hidden worker arguments. When directly invoking Node and explicitly selecting npm/pnpm, the actual selected package manager runs the same ops script again to establish lifecycle identity. Child processes recognize the established execution context from the real package-manager environment and run domain steps directly, without bootstrapping again. Do not fake `npm_execpath`/user-agent or recursively call public `ops`. Do not mechanically remove installation `postinstall`/`prepare` hooks or entries explicitly deferred in the inventory as part of this switch.

Explicit CI recipes in Linux containers use the Python Owner's non-Desktop interpreter port: `uv` resolves the specified, already prepared venv offline and verifies its actual prefix and the project's `requires-python`; it does not search for a system interpreter or download a fallback. macOS/Windows continue to use the original Desktop runtime provenance check. CI context is not a general switch for skipping preparation/hooks.

Maintainers and other contributors run the same Git-managed source directly, with no compilation, committed build artifacts, installed-copy refresh, or local file dependency. Do not add a root installation step solely for the entry point. If an actual task lacks a dependency, it still fails according to its original recipe or installs it in an explicitly permitted preparation stage. A non-installation task must not silently install something merely because the entry point is lightweight.

<a id="33-仓库及worktree身份"></a>
### 3.3 Repository and Worktree Identity

Source modules locate themselves relative to the entry-point file. The execution target is still resolved from `cwd` or explicit `--repo` and validated against the root package, `scripts/ops-cli.cjs` entry point, and Desktop declaration, supporting worktree `.git` files. Do not infer the target from `node_modules`, package caches, or an outer `INIT_CWD`. Help and actual execution show the explicit target; each task specifies its cwd.

An absolute-path Node invocation from outside the repository must specify and validate `--repo`. Reject incompatible tool-source/target-repository combinations before side effects; do not silently combine orchestration from one checkout with domain scripts from another. Dangerous paths, user data, ports/locks/profiles continue to follow their original Owner rules; the entry-point path does not replace instance identity.

The CLI need not be reinstalled after pulling or switching branches, but exit commands running in that worktree before switching source. A running Node process does not automatically load new modules; hot replacement of orchestration is unsupported. Domain dependency/lock changes still follow the original installation rules. On Windows, cover file contention and failure recovery; interrupt only this task's subtree and never kill other worktrees forcefully.

<a id="34-源码验证"></a>
### 3.4 Source Verification

Use `node --test` to verify command contracts, orchestration, and execution primitives; tests must not compare script text alone as a substitute for behavior. CI runs source directly from a clean checkout and verifies that help does not depend on root/Desktop `node_modules`; it does not build or compare `dist`. Real tasks still require Owner-level verification of preparation chains, platforms, reports, and exit results. Reconsider packaging only for future cross-repository reuse or standalone release; do not introduce a separate package, `bin`, file dependency, or extra version synchronization merely to unify repository commands.

<a id="4-命令组织与接口"></a>
## 4. Command Organization and Interfaces

<a id="41-组织原则"></a>
### 4.1 Organization Principles

Organize commands by user task, not by file count. Assign tools to the following four dispositions; maintain each item's conclusion in the [requirement disposition inventory](ops-cli-inventory.md#3-需求分类与目标处置). This document defines only organizational rules. The target interface does not mean the CLI is implemented, and does not authorize removing old entry points.

| Category | Criteria | Delivery |
| --- | --- | --- |
| Retain | The object, effect, or permission is independent; merging would lose semantics. | Retain a discoverable standalone leaf or explicit mode; do not change the domain implementation's Owner. |
| Merge | Aliases or parameterizable variants of the same task whose behavior can be fully preserved. | Provide one canonical entry point; express differences with explicit subcommands/options. This does not mean merging implementations or preparation chains. |
| Internalize | A hook, resolver, cache, protocol adapter, or build stage with no independent user goal. | Make it a prerequisite of its owning command or an internal library; do not add a public command for every file. |
| Defer | Supply-chain/cross-repository permissions are complex, platform support is incomplete, capability is unimplemented, or value evidence is insufficient. | Explicitly exclude it from this scope and retain its original controlled entry point; this is not delayed wiring or a compatibility period for an included command. |

<a id="42-多级命令树"></a>
### 4.2 Multi-level Command Tree

The unified entry point is `pnpm ops`, with the task domains `pre/dev/ci/cd`. Organize by user task rather than flattening the script files. Not every path needs three levels, and do not add undocumented synonyms. The top-level default actions in §1.4 are explicit convenience entry points that select the same specialized recipe; they do not copy implementations, prerequisites, or reports, nor create a second task set.

| Top-level | Second-level responsibilities | Not responsible for |
| --- | --- | --- |
| pre | Full environment preparation by default; `doctor/install/repair/config/clean` are specialized. | `doctor` does not trigger automatic installation/repair; the default `pre` preparation scope is explicitly registered and does not check source quality. |
| dev | Full product by default; `browser/serve/status/logs`. | Do not treat startup or a mock scenario as product acceptance. |
| ci | Main-flow smoke by default; `check/format/test` are specialized. | No default `quality/full`, formatting, or model calls; do not repeat environment diagnosis. |
| cd | Locally runnable package by default; `build local/release` are specialized. | No formal signing/notarization/upload by default; retain necessary macOS ad-hoc signing. |

```text
pnpm ops                                                 # 目标组织；可执行组合以源码登记为准
├── help / version / list                                 # 查看用法、版本和已登记能力
├── pre                                                   # 默认自动准备当前worktree开发环境
│   ├── doctor [--scope environment|toolchain|interpreter|deps|links]
│   │                                                     # 默认沿原doctor诊断；scope选择一个环境专项
│   ├── install python [--mode environment|desktop] / deps # 显式准备Python开发环境或Desktop依赖
│   ├── repair links                                      # 修复可确认的仓库链接，冲突不覆盖
│   ├── config edit|template                              # 交互配置或写入配置模板，会影响用户配置
│   └── clean                                             # 仅清理当前worktree开发环境及指定产物
├── dev [--port <port>]                                    # 默认隔离完整产品：Electron + 真实后端
│   ├── browser [--mock]                                   # 默认连接真实Serve；mock为浏览器模拟工作台
│   ├── serve [--watch]                                    # 独立后端调试，不重启活跃对话实例
│   ├── status [--wait [--timeout <ms>]]                    # 查看/等待当前隔离实例，不代表业务验收通过
│   └── logs [--errors]                                    # 当前实例日志；可筛选告警/错误
├── ci                                                    # 默认执行主流程核心冒烟
│   ├── check [--profile python]                          # 无目标时帮助；python为原固定源码检查组合
│   │   ├── types desktop|python                          # TypeScript或mypy检查，不诊断解释器
│   │   ├── lint python|desktop [--fix]                    # 默认检查；仅Desktop支持原ESLint显式修复
│   │   ├── docs workspace|desktop [--mode full|structure|report] [--write]
│   │   │                                                 # 检查/报告；write仅Desktop原派生文档更新
│   │   ├── i18n [--mode check|gaps] [--generate]           # 资源/调用检查、缺口报告或显式生成派生产物
│   │   ├── ui                                            # 原生控件复用审计，不更新预算基线
│   │   ├── skills product [--mode source]
│   │   │                                                 # 产品源码/清单或宿主Skill内容引用检查
│   │   ├── preview-bundle                                # 检查生产产物未混入模拟工作台，不自动构建
│   │   └── preview-report <报告文件|->                    # 读取模拟场景关联报告，不判定测试通过
│   ├── format [paths...] [--check|--write]                # 默认只检查；write才修改Python源码
│   └── test [类型] [--scope <子系统>] [--suite <已登记套件>]
│       ├── smoke                                         # 固定快速核心集合，不能任意裁剪
│       ├── unit                                          # 单元测试，隔离被测单元
│       ├── integration                                   # 模块/数据/进程集成，保留契约测试
│       ├── api                                           # HTTP/API接口测试，不等同全部后端测试
│       ├── e2e                                           # 真实完整产品端到端测试，模式可能有费用/安装效果
│       └── visual                                        # 视觉基准比较；普通截图不算视觉回归
└── cd                                                    # 默认构建本地可运行安装包
    └── build
        ├── local [--target desktop|web|backend|wheels|trace|skills] [--stage app|dir|installer]
        │             [--workflow direct|package-acceptance]
        │                                                 # 默认本地Desktop安装包，无正式发行签名/公证
        └── release [--channel preview|release] [--stage dir|installer] [--candidate]
                    [--workflow direct|distribution]
                                                          # 发布包构建；明确签名及完整交付链，不自动上传
```

In the tree, text after `#` is explanatory; `|` denotes alternatives and `[]` denotes optional arguments. Do not copy and run a whole line. The main help prioritizes the common tasks below; discover advanced combinations in the help for the relevant command:

```text
pnpm ops pre doctor                            # 定位开发环境故障，不自动修复
pnpm ops pre doctor --scope interpreter        # 仅核Python开发解释器来源
pnpm ops dev                                   # 启动隔离的完整产品
pnpm ops dev browser                           # 浏览器界面连接真实后端
pnpm ops dev browser --mock                    # 启动浏览器模拟工作台
pnpm ops ci format                             # 检查格式，不修改源码
pnpm ops ci format --write                     # 显式格式化源码
pnpm ops ci test smoke                         # 原固定核心冒烟集合
pnpm ops ci test unit --scope desktop --suite literature-search
                                              # 已登记的Desktop专项单元集合，不冒充全部Desktop测试
pnpm ops ci test --scope desktop --coverage    # 原Desktop覆盖率集合，不额外套普通pretest
pnpm ops ci test api --scope serve --suite projects
                                              # 真实项目与资源读取契约，不调用模型
pnpm ops cd build local                        # 本地运行包；macOS保留必要ad-hoc签名
pnpm ops cd build release --channel release    # 正式渠道发布包构建，不上传
```

<a id="环境与工程检查"></a>
#### Environment and Engineering Checks

`pre` no longer has a `check` group; `doctor` is the unified way to discover environment checks. In `doctor`, `--scope` means only an environment target, not a subsystem filter for `ci test`. The default `environment` scope retains exactly the original `doctor` set of node/npm/uv/python/codex/electron checks and Codex-cache recovery side effects; it adds no links, deps marker, or full-manager checks. `toolchain`, `interpreter`, `deps`, and `links` each call the corresponding existing Owner specialization; shared checks do not mean the sets are equivalent. `frontend` remains only the Node+npm subset used internally by the original hook/CI; do not add a public leaf.

`ci check` handles source/asset compliance; `ci format` handles code formatting. Map the original fixed root-check flow to `ci check --profile python`, which reuses the specialized Owners and runs format check → Python lint → mypy in that order. It is not the full quality gate and accepts neither other targets nor arbitrary pruning. `ci check` without a target/profile displays help. Do not retain the public paths `ci check format`, `ci run`, or `ci write`.

`ci format` defaults to the same behavior as `--check`: it does not write source or automatically install tools. `--write` and `--check` are mutually exclusive. Follow the original formatter's isort/black/import rules; if a tool is missing, retain the original write-mode `prepare-dev` prerequisite and disclose it in help. ESLint `--fix`, Desktop docs `--write`, and i18n `--generate` are explicit write modes for their respective check targets; do not disguise them as formatting or provide a general `fix-all`. Register only the existing write scopes. Reject unsupported combinations, such as Python `lint --fix`, workspace docs `--write`, and mixing report/gaps with write modes, before side effects.

`pre doctor links` checks symbolic links actually registered in Git and their ordinary filesystem targets; it is not hard-coded to a particular host directory. Host checks for development Skills have moved to the internal source repository and are not part of the public CLI.

`docs workspace` defaults to `full`; it also supports `structure`, and structure mode must be given an explicit path. `desktop` defaults to `full` and supports `report`. Workspace structure checking calls `structure-core.mjs` through the repository's `scripts/ci/docs/structure-check.mjs` and does not depend on an internal Skill path. `skills product` defaults to `source`. A report does not mean quality has passed.

<a id="测试类型与子系统"></a>
#### Test Types and Subsystems

Test type is the execution method; scope is the subsystem under test. Maintain one case registry; do not create parallel desktop/server/frontend test subtrees. The canonical scopes are desktop, serve, runtime, trace, and tooling. Desktop includes renderer/main/preload/native; select frontend-specific cases through their registered suites. “Server” is a conceptual label; commands use the actual Owner name `serve`. A suite selects only an existing named set and cannot pass through an arbitrary script.

Each case has one base type and one Owner/scope. `smoke` is a curated cross-layer label, not a seventh base layer. During implementation, verify actual isolation and call boundaries. Do not relabel existing mixed Node sets or all Python contracts as `unit`, and do not treat every contract as an HTTP API. Run original mixed sets through registered recipes without a type, such as `ci test --scope desktop`, `ci test --scope serve`, and `ci test --scope trace`, preserving their original membership and preparation. An explicit type selects only verified cases of that layer; it does not implicitly run other layers in the same scope.

- Ordinary types `unit/integration/api/e2e/visual` require an explicit scope. Report unsupported type/scope/suite combinations as `UNSUPPORTED` before execution; an empty selection cannot pass. Without a type and a valid scope/profile, display help only.
- `smoke` follows the fixed inventory, required core cases, platforms, reports, and zero-skip criterion in `scripts/ci/smoke.cjs`; it does not accept scope, suite, coverage, or quality-specific parameters that prune the set. It is not the same set as the Playwright smoke project. Prove “fast” using cold/warm durations and core-case coverage on supported hosts; the CI Owner configures the duration budget, and do not claim the budget is met without measurement.
- `ci test --profile quality` retains the original comprehensive `ci:test` quality workflow and its existing parameters such as `--strict`/`--with-external`, including the original static/build/test stages rather than only unit tests. This fixed recipe cannot be combined with type/scope/suite/coverage. Do not add `ci run`. The original full (`--with-external`) mode still discloses model, network, installation, and authorization effects.
- The default Desktop mixed set retains ordinary `pretest`; `--coverage` follows the original coverage recipe and does not add ordinary `pretest`. Literature search is the `unit/desktop` `literature-search` suite and cannot be combined with coverage. Native unit tests and native-contract integration compilation are different suites; the latter may download a toolchain and clean up temporary artifacts created by this run.
- Register the original Preview contract and mock browser UI separately as `integration/desktop` suites `preview-contract` and `preview-ui`. Mock browser UI is neither full product E2E nor a visual-baseline comparison; preserve the original `webServer`/installation prerequisites.
- `e2e/desktop` defaults to the original general Playwright set and prerequisites. Suites `mr/live/update` follow the build → project-run chain of their corresponding original profiles; `live` may call a model, and `update` may change installation state. `model-probe` is a separate real `--say` chain recipe; retain the original health `scholarseed-desktop` entry point, configuration target, and exit code. Do not initialize configuration, add content assertions that did not previously exist, or include it in default dev/unit/coverage/smoke.
- `ci test --scope serve --list` lists only the original `run_all` suites and does not execute them. Named suites still preserve cwd/PYTHONPATH, concurrency, exclusivity, and reports. Trace defaults to the original contract set; `--with-format-check` adds only the original Trace format prerequisite.
- `ci test --affected [--base <ref>] [files...]` computes recommendations and fallback only; it does not execute tests and cannot be combined with execution type/scope/suite/profile. Output `kind=affected`; fallback 3 retains its original semantics.
- API registers only `serve --suite projects`. The original Serve runner executes its three existing contract suites for project read models, queries, and resource lists; this is not complete API coverage. It does not allow arbitrary case selection, model calls, or replacing the original continuous CI. `integration_serve` includes a real model and remains a separate real-path recipe. Screenshot files are not visual regression tests. `visual` requires a baseline, tolerance, theme/size/font environment, comparison result, and permission to update the baseline; do not auto-update baselines to make failures pass. Mark unwired combinations as `planned` in `list` and reject execution; do not register an empty “success” shell. Fully map existing consumers first; do not use the new categories to remove old cases.

<a id="本地与发布构建"></a>
#### Local and Release Builds

CD publicly exposes only `build local/release`. Select the original artifact type with `target` and the build stage with `stage`; do not flatten `package`/`pipeline` or expose a command per artifact. The default target is `desktop`; for local desktop builds, the default stage is `installer`. `app` uses only the original `electron-vite build` application-build recipe; `dir` uses the original development unpacked-build recipe. `app` is a CLI stage name and must not be passed directly as a stage unsupported by the original `build.cjs`. `backend/web/wheels/trace/skills` each follow their original Owner's preparation and build. Only `desktop` accepts `app/dir/installer`; other targets reject these stages. `release` currently supports only `desktop`, with `release` as the default channel; `preview` and `release` retain their original channel identities.

| Build mode | Actual boundary |
| --- | --- |
| local Desktop | Original dev build; no formal-release signing identity or notarization credentials. On macOS retain required ad-hoc signing and original nested signing/verification; on Windows do not sign. Do not re-sign the protected runtime or weaken inventory and security checks. |
| release direct (default) | The release installer reuses the builder's fixed smoke. Formally sign for `preview`/`release`; notarize on macOS as required by the channel; fail if credentials are missing. |
| release distribution | Retain ensure → Python prepare-dev → release build. The builder runs the fixed smoke once; do not pass build arguments into smoke. |
| local package-acceptance | Full quality flow → fixed smoke → local dev installer → real post-install E2E. Do not upgrade this to a signed release package. Verify commit/platform/artifact path and SHA-256; do not substitute a historical package. |
| release --stage dir --candidate | Build/check the release-candidate directory through the original `package:check`; do not call it read-only or treat it as a releasable signed package. Follow original candidate rules and upload-rejection markers. |

`preview`/`release` share the `direct` and `distribution` recipes. Explicit `candidate` supports only `direct dir` and follows the original channel-aware candidate-check Owner. The CLI does not expose `--install` or `--skip-check`; preserve the original installation Owner's requirements and authorize them separately. Do not treat these as generic native passthrough. Maintain old arguments and unwired items on the external-distribution side in the distribution coordination record.

Register workflows as a closed set by build mode: `direct` is the default for each; `distribution` is release-only; `package-acceptance` is local-only. This is not an arbitrary workflow DSL and does not silently add every prerequisite. `candidate dir` must select the original `package:check` recipe and retain its update-URL source and validation; do not first run release-wrapper mandatory signing/update-URL selection and then pretend to skip it. The Desktop installer builder runs fixed smoke exactly once, independently of workflow; `app`, `backend`, `dir`, and candidate-directory checks do not run it. `package-acceptance` is only for a complete local Desktop installer and cannot be combined with release, candidate, dir, arbitrary targets, or pruned tests. Deterministic verification of channel wiring does not replace real signing and release acceptance for both channels. `candidate` is not an automatic downgrade after signing fails: it must be explicitly selected and preserve the original Owner's security/upload-rejection contract.

<a id="默认执行与保留边界"></a>
#### Default Execution and Retained Boundaries

The root entry point and ordinary non-leaf commands without a registered default action display help when invoked without arguments. `pre/dev/ci/cd` run the default chains in §1.4; `--help` and `list` run no task. Unknown subcommands/options produce an error and do not fall back to a default chain. No-TTY/CI does not auto-confirm; long-running tasks block or are interrupted according to their Owner's rules, and are not automatically backgrounded or used to call a model.

`dev/browser/--mock` retain their respective preparation chains. `browser` retains the original `SCHOLARSEED_SERVE_URL` → default endpoint source. It may start Vite before Serve; do not add an online probe/readiness gate, start a second backend, or degrade to mock. Vite readiness does not prove business success. `mock` does not consume a real backend target; reject explicitly conflicting options in advance.

`status` observes only the original isolated debug instance and preserves `wait`/`timeout` and 0/1/2 semantics. Only default `dev` supports `--port`. `serve [--watch]` preserves the original interpreter/Codex source, port, CASES, and listen scope; it does not restart an active conversation instance. `logs [--errors]` binds to the isolated instance in the current worktree rather than defaulting to the global Home; it preserves WARNING/ERROR and recent-50-line filtering. If logs are missing, report them unavailable and do not create a file. This is an explicit behavior change and requires real-host acceptance.

Wrapping the old root `start/desktop`, Desktop artifact `preview/shoot/preview:web`, component discovery, and Trace UI with ops remains deferred. Retain their original Owner entry points and real consumers; do not pretend to support them through an unused internal recipe. Root `desktop` has README consumers and calls `config(false)`, so it is not an equivalent replacement for isolated `dev`. `shoot` only runs build → electron; it does not represent a screenshot or assertion. Switch already adopted public usages such as root `dev/dev:preview` and Desktop `dev:web` together. Necessary domain scripts may remain internally but must not be promoted as a second entry point. User-data operations remain deferred. The CLI itself runs source tests only and does not define a build/artifact-check flow.

Integrating external upload/publish/deploy requires separately defining artifact identity, channel, permissions, idempotency, and readback; do not register an empty shell in this change.

<a id="43-ai与自动化调用契约"></a>
### 4.3 AI and Automation Invocation Contract

This section specifies an interface yet to be implemented; it does not mean an invokable CLI already exists. In ordinary mode, preserve native task stdio and exit codes; do not require every domain tool to be converted to JSON. Meta-commands and finite state queries provide machine interfaces. Each other leaf must declare whether it supports JSON result adaptation; reject unsupported commands before execution rather than running them and then reporting that their output cannot be encoded.

- Place global options before the command path: `--repo`, `--package-manager npm|pnpm`, `--context local|ci`, `--non-interactive`, and `--json`. Native passthrough is limited to `--` after an explicitly designated leaf.
- Machine calls use `pnpm --silent ops --json list` and `pnpm --silent ops --json version`. `silent` suppresses the package manager's script prefix; it does not disable domain logs. Help/list/version work without `repo`; actual repository tasks must be able to verify target identity. For affected tests, recommend `pnpm --silent ops --json ci test --affected --base <ref>`. JSON is a global output option, not a same-named leaf option; the adapter places the underlying affected command's original JSON payload in `data`.
- JSON output is one UTF-8 document containing `schemaVersion`, `kind`, canonical `command`, `repo`, `context`, and the corresponding `data`/`error`. The initial `schemaVersion` is 1; adding optional fields is backward-compatible, while incompatible field semantics require a version increase. `kind` distinguishes help/list/version/status/result/error/affected; a report must not be presented as an acceptance result.
- `list`/help disclose leaves, defaults, valid modes, platform/context, JSON/interaction support, prerequisites, and effect labels. Command discovery does not run probes, read credentials, or execute user code. Redact sensitive values in errors and actual arguments; do not output credentials or the body of user configuration.
- JSON stdout must not contain banners, color, progress, or native logs. Meta-commands and status use the CLI's own encoder. Only execution leaves with a result adapter may forward child logs to stderr/a separate evidence path and emit a JSON summary. Reject unsupported long-running/TTY tasks in JSON mode instead of changing their interaction behavior. Ordinary mode does not replace domain report protocols.
- Errors include `origin` (`cli`/`child`), a stable `code`, `failedStep`, `owner`, and `nextAction`, with sensitive content redacted. CLI argument errors exit 2; target/dependency/permission/unsupported-combination failures exit 1. Subcommands preserve their original exit codes. Distinguish CLI errors from child-process errors with the same code; do not normalize all failures to 1. Finite waits/timeouts preserve the Owner's original status and exit semantics.
- Stable CLI error codes are `INVALID_ARGUMENT`, `REPO_INVALID`, `PREREQUISITE_MISSING`, `PERMISSION_REQUIRED`, `UNSUPPORTED`, and `EXECUTION_FAILED`. A nonzero child-process failure uses `CHILD_EXIT`, with the original code in `data.exitCode`. Registered domain status codes retain their original `kind` and data representation (for example, 2 for a status wait and 3 when affected tests require an upgraded gate); do not normalize them to CLI errors or misinterpret matching codes as argument errors.
- With explicit `non-interactive`, no TTY, or CI, never wait indefinitely for input, a menu, or an editor. Missing required arguments, confirmation, or credentials are errors. Declare `UNSUPPORTED` for tasks that require interaction and have no existing non-interactive implementation. CI/non-interactive is not operational authorization and must not auto-confirm. Child processes must not inherit an open stdin that can wait forever. Report tasks needing file/stdin input consume it according to their registered boundary; handle interactive-task input and report input separately.
- Long-running tasks such as default `dev`, `browser/serve`, and log following declare blocking behavior, ownership, and interruption method; do not impose a common timeout or add background mode. Finite waits declare timeout and failure semantics. A status query must not claim business acceptance merely because “the process exists.”
- Pass native arguments unchanged as an argv array; do not rebuild them into a string. Each leaf registers its passthrough targets and policies for arguments that can affect behavior. Arguments that change the execution entry point, configuration, installation/model mode, path scope, baseline, or authorization must become explicit controlled options with effects recalculated, or be rejected. Do not permit an argument merely because it follows `--` when its impact cannot be determined; reject before side effects rather than rewriting arbitrary native-tool parsers.

<a id="5-权限与副作用契约"></a>
## 5. Permission and Side-Effect Contract

Permissions depend on actual effects, not names such as `pre/doctor/check`. For every leaf mode/context, register prerequisites, network access, source/host/external writes, model costs, installation, and process tags; combinations take the union of their effects. Help and real execution share this registry; do not create a separate “read-only” list.

| Effect | Canonical entry-point examples | Execution boundary |
| --- | --- | --- |
| Effect | Canonical entry-point examples | Execution boundary |
| --- | --- | --- |
| Metadata/status/reports | help/list/version, `dev status`, `ci check preview-report` | Do not install, start processes, create user directories, or read credentials for command discovery; a report is not a quality pass. |
| Probes, cache/temp files, and quality reports | `pre doctor`, `ci check`, `ci format`, `ci test` | Disclose actual network/compilation/installation prerequisites; `check` does not guarantee that every leaf has zero side effects and must not auto-repair. |
| Environment/source writes | `pre install/repair/config`, `ci format --write`, fix/write/generate modes of `ci check`, `cd build local --target skills` | Explicitly select existing formatting, ESLint repair, or docs/i18n derived actions. Write only within registered Owner scopes; do not reset baselines. |
| Development startup/observation | Each development target under `dev` | Show the mode and process ownership; explicitly interrupt long-running tasks to end them; do not restart Serve during an active conversation. |
| Configuration and cleanup | `pre config`, `pre clean` | Configuration must be explicitly invoked; default `dev` does not enter the original `configured` configuration-write chain. `clean` is limited to the original development-environment scope; user-data operations are explicitly deferred. |
| Models, external services, app installation | `ci test e2e --scope desktop --suite model-probe`, corresponding E2E modes, external/full modes of `ci test --profile quality`, `cd build local --workflow package-acceptance` | Verify the exact target, credentials, budget/cost, and authorization for this run. Reject missing prerequisites; do not degrade to mock or present successful startup as business success. |
| Signing, notarization, release builds | `cd build local/release` | `local` retains necessary macOS ad-hoc signing and does not sign on Windows. `release` performs formal signing/notarization by channel and does not downgrade if credentials are missing. A build does not authorize upload/release/deployment. |
| External CD not yet integrated and controlled maintenance | Upload/release/deployment; deferred user-data/global-link/supply-chain/baseline changes | Before integration, verify the Owner, interface, idempotency, partial-failure behavior, and readback. Do not register shortcuts now or expand permissions through CI, no-TTY, or `--yes`. |

The CLI validates explicit inputs, targets, and actual system permissions; it cannot infer authorization from natural language. The host agent remains responsible for checking authorization for the user's current request. CI, `context=ci`, and `non-interactive` are not authorization declarations. There is no general `--yes`, `allow-all`, `fix-all`, or baseline reset; redact logs and errors. If a mode/argument's safety effect cannot be determined, reject it before side effects. Do not silently omit an in-scope task; scope changes must update the design, inventory, and delivery acceptance together.

For example, the original logs command may create an empty log, while target `dev logs` explicitly changes this behavior and requires real-host acceptance; `pre doctor` may restore artifacts; `config template` writes configuration; and `ci test e2e --scope desktop --suite model-probe` requests a model. Names do not prove a command is read-only. `browser --mock` and a real backend must register different preparation chains and effects.

<a id="6-生命周期ci-和跨平台不变量"></a>
## 6. Lifecycle, CI, and Cross-Platform Invariants

<a id="生命周期"></a>
### Lifecycle

The migration unit is “root wrapper → dependency preparation/check → environment configuration → package manager → hook → main command,” not merely replacing a leaf script. Wire the actual implementations moved into the CLI and their consumers atomically in the same change. Preserve the existing complete Desktop preparation boundary and debug supervision semantics; reuse domain implementations according to their Owners and do not add transitional forwarding shells.

Preserve how `PREPARATION_COMMANDS` distinguishes ensure from check, dev environment defaults and user-override precedence, Desktop cwd, stdio, npm's `--`, and pnpm argument-forwarding rules.

The selected package manager remains responsible for lifecycle execution; do not manually rerun a hook and then execute the same script. Preserve each package manager's current lifecycle and `ignore-scripts` semantics; do not add or omit steps in the name of “unification.” Preserve prerequisite order and variant differences for commands with modifiers. Do not rerun ordinary-test hooks for coverage just because the test sets are the same, and do not execute explicit CI prerequisites again through automatic package-manager hooks.

Installation hooks must not depend on the not-yet-installed CLI, which would cause an infinite loop during a fresh install. After migration, a single implementation belongs to the CLI or the actual domain Owner; retain old hooks only where real compatibility consumers require them.

The [lifecycle inventory](ops-cli-inventory.md#6-生命周期钩子关联) records all hook and inline-prerequisite relationships. Verify current source and consumers during implementation; the inventory does not replace evidence from actual package-manager configuration or execution.

Protect development-environment resources with shared leases. Python preparation and Desktop dependency installation hold exclusive leases on the directories they actually write. Development Desktop, the browser development surface, Electron preview, and Serve hold read leases on the environments they use while running. `pre clean` deletes only after obtaining an exclusive lease on the target directory. On concurrent conflict, fail directly; do not kill processes or infer lease expiration from a PID. If an abnormal exit leaves uncertainty about whether the process tree stopped or writes completed, retain the lease receipt and ask for manual inspection; do not auto-clean merely because the PID exited. This lock constrains only repository commands integrated with this Owner; it does not claim to protect against external processes that bypass the CLI or directly modify files.

<a id="执行context与准备语义"></a>
### Execution Context and Preparation Semantics

Global `--context local|ci` defaults to `local` and selects a bounded, registered source recipe; do not switch automatically based on CI environment variables. `local` means the original root-wrapper semantics, not “a human-operated host,” and may also be used in CI; it preserves check/ensure, environment defaults, and hooks. Register `ci` only for leaves where existing CI consumers genuinely differ, exactly reproducing the original job's direct subpackage invocation and explicit prerequisites; it is not a skip-preparation switch. Both contexts share domain actions and test sets. Differences are limited to verified source-specific wrappers/preparation and are disclosed explicitly in help and JSON.

If a leaf has no `ci` recipe, `context=ci` must return `UNSUPPORTED`; do not accept and ignore it. CI still verifies Node, target identity, actual required dependencies, paths, and permissions. For example, the original GitLab jobs for `types desktop` and Desktop coverage call the subpackage directly with `ignore-scripts`, unlike the full Desktop marker check in the old root wrapper.

A CI recipe must not add a full Desktop installation/marker that the original job did not have, nor automatically run or omit job prerequisites just to deduplicate them. GitLab jobs that need the distinct recipe explicitly pass `context=ci`; native jobs with no difference retain `local`, so do not add `context=ci` uniformly to every CI invocation. Preserve original installation order, `allow_failure`, timeouts, artifacts, and reports.

<a id="包管理器选择与依赖身份"></a>
### Package-Manager Selection and Dependency Identity

The package manager that starts the CLI and the task executor are separate. Selection precedence is explicit `--package-manager npm|pnpm` → verifiable runtime context → repository default `pnpm`. Explicit npm can override the startup context introduced by `pnpm ops`. Reject contradictory identity fields or version mismatches. Do not guess the installation method from the simultaneous presence of lockfiles, and do not silently convert existing npm dependencies to pnpm or vice versa.

The selected executor must be used throughout the entire call graph. The CLI uses the verified package manager's real `run` to create an internal execution context. The fixed internal adapter entry belongs to repository source/the actual execution Owner, not a deleted public root alias. Nested prepare, toolchain, and CI stages all use the real `npm_execpath`/`user_agent`. Do not use npm only for the first `spawn` and then read inherited pnpm identity in later stages; do not fake npm variables as proof that execution went through the package manager.

Establish the context once. The package manager invokes the same root ops script and does not bootstrap again. Continue validating command, recipe, and repo inputs; this is not a permission backdoor. Reuse the toolchain Owner to adapt argv differences rather than hand-writing shell concatenation in every leaf.

Installation/check tasks verify the manager, version, and dependency markers according to their original recipe. Update dependencies through the original Owner only when `prepare/install` is explicit. A valid CI recipe without hook installation uses its original prerequisites and does not pretend to generate a complete development marker. Regression coverage must include the pnpm entry → explicit npm → nested prerequisite/CI stage path, as well as pnpm invocation without an explicit override.

<a id="ci自举既有linux任务与消费者切换"></a>
### CI Bootstrap, Existing Linux Jobs, and Consumer Switch

CLI loading depends only on supported Node and repository source; do not run `checkToolchain` while loading or displaying help. CI needs only the declared Node/pnpm and original task executor prepared; do not add root dependency installation just to obtain the entry point.

| Original job source | Wire to source entry point | Prohibited changes |
| --- | --- | --- |
| Python, static/coverage, Xvfb, and other jobs that did not originally install root dependencies | Use `pnpm ops` after checkout; prepare atomic packages/tools as before. | Do not add root install for the CLI, trigger Desktop installation through root postinstall, or treat entry-point availability as proof that business prerequisites are met. |
| macOS/Windows and other jobs that already ran root `npm ci` | Preserve the original `npm ci`, hooks, and subsequent check/repair/installPython order; have ops explicitly select npm as task executor. | Do not remove installations required by the original task, add a second pnpm root install, or manually replay hooks. |

Continue maintaining root/Desktop dependencies and locks according to their actual consumers; removing a CLI dependency package does not mean ignoring domain lockfile changes. Verify entry-point and executor provenance in both job types. There is no CLI `bin`, installed-copy version, or artifact-digest refresh.

Current GitLab includes Linux Python jobs, static/coverage jobs that install only subpackages, and the real-host `desktop-e2e-smoke` chain of Xvfb → subpackage install → Playwright dependencies → Electron build → smoke. All must connect to the source entry point and exact toolchain without adding root installation for the CLI or using an unpinned apt Node version as if it met the declared requirement. Register each original job and CI recipe; do not omit Electron consumers by claiming “Linux is only static checks.” Preserve the Xvfb task's original steps, sets, reports, and failure criteria, wiring it through explicit CI recipes for `cd build local --stage app` and `ci test e2e --scope desktop` respectively. Do not delete it, replace it with a static substitute, or claim the switch is complete merely by rejecting that combination.

Existing job configuration is not evidence of support or a passing result. If Linux Electron or its Python/dependency prerequisites are not closed, record the actual failure against the same-version baseline. The responsible Owner must resolve it, or the user must explicitly authorize a scope adjustment; until then, block the overall switch. Do not weaken tests or implicitly expand Linux product-support commitments to make the tool migration appear successful.

General development/native quality gates and installers remain supported on macOS/Windows. Linux gets restricted recipes only for the named existing CI consumers; reject other combinations in advance. This is not a new Linux product platform.

The Python Owner must provide an explicit non-Desktop CI environment resolver port. `PYTHON` is an input used to create/select the environment; later execution must resolve and verify the actual interpreter, version, and dependencies in `VENV`. Do not treat `PYTHON=3.12` as an absolute executable path, fall back to system Python, or construct venv paths in CLI JavaScript. `developmentPython` currently always resolves through the Desktop distribution manifest, and the Linux path is not yet closed. This Owner wiring and real Linux job verification block the overall switch; do not describe an existing old job as an established platform capability or expand the Desktop manifest.

Coverage script strings used to be a CI data interface; the Desktop test Owner's single manifest now owns this data. Package scripts provide only short entry points, and CI no longer parses their text. When changing the manifest structure, update every consumer. Public projections are also consumers: after moving private prerequisites to a new Owner, update the corresponding implementation and tests in the overlay while preserving public/private check differences. Do not merely refresh package context, and especially do not change freeze policy to bypass source drift.

Preserve pretest differences, test sets, concurrency, quarantine, budgets, stage IDs, and reports. Switch GitLab, Preview `webServer`, and documentation/Skill references together. Remove old public aliases and root ops recursive callbacks in the same change, except for the fixed distribution protocol. Verify CLI source contracts and regressions directly with Node tests; do not depend on build artifacts or incidentally trigger product release.

The domain Owner controls host-resource policy for the test system: the Desktop mixed complement follows its local serialization constant, which the generic CI CPU quota does not override. Other CPU stages continue using the existing quota; do not add a second scheduler.

<a id="跨平台与安全"></a>
### Cross-Platform and Security

On macOS, use explicit executable paths and argv arrays. On Windows, distinguish exe/cmd/bat and reuse supported package-manager boundaries; do not concatenate user input into a shell command.

Paths must cover spaces, Chinese characters, drive letters, Git worktree `.git` files, and LF/CRLF. Preserve cwd, environment precedence, stdio, TTY, exit codes, and Ctrl+C process-tree cleanup. Clean up only child processes owned by this task; do not kill processes by global name or restart Serve during an active conversation. Electron APFS sharing continues to follow the macOS Owner only; Windows installation paths and behavior remain unchanged.

Release, signing, upload, model calls, deferred user-data deletion, and global command installation each retain their own authorization boundary. A unified CLI grants no additional permissions. See [Development and Acceptance](../runbooks/development.md#跨平台开发与验收) for platform requirements.

| Behavior | macOS | Windows | Shared failure and acceptance contract |
| --- | --- | --- | --- |
| Source entry point | Run Node on `scripts/ops-cli.cjs` through a pnpm script. | The same script is interpreted by Node as `.cjs`; no Bash/exe or POSIX executable bit is needed. | A clean checkout can run help/list without root/Desktop dependencies; actual tasks still verify their own prerequisites. |
| Child processes and arguments | Use argv arrays with `shell: false` for native executors. | Prefer supported Node CLI entry points; cmd/bat go only through the toolchain platform boundary. | Never concatenate user input into a shell string. cmd wrappers need explicit escaping/rejection rules covering spaces, Chinese characters, quotes, and shell metacharacters; reject unverified combinations. |
| Interrupt and exit | Reuse debug's task-specific process group and bounded wait. | The development worker joins a native Job before starting Electron; active counts and private terminal-state proof establish exit without emulating POSIX group signals. Real-platform verification remains pending. | After normal exit, main-process failure, or Ctrl+C, inspect the actual subtree and locks. Handle only this task's process family. If exit cannot be confirmed, retain diagnostic state and do not claim cleanup. |
| Source updates and domain dependencies | Update source through Git, with no separate CLI installation. | Same, covering running processes and file contention. | Exit the current task before updates; do not hot-replace loaded modules. Domain installs follow original serialization/lock rules; reject external concurrency conflicts and do not force-kill other worktrees. |
| Development-environment use and cleanup | Running processes hold read leases on VENV/Node dependencies; cleanup and installation writers are mutually exclusive. | Same semantics, with protected Windows ACLs for lease directories and receipts; no native Windows verification was done in this round. | Shared reads may run concurrently; a write conflicts with any overlapping read/write. Fail closed if identity/ACL cannot be verified. Retain receipts for abnormal process trees for manual verification; do not auto-reclaim. |
| Path and identity | Normalize real paths; do not locate by package cache. | Cover drive letters, case sensitivity, junction/reparse points, and file contention. | Include cases for subdirectories, independent worktrees, `--repo` outside the repository, and LF/CRLF. Dangerous paths reuse the owning Owner's security checks. |

Development hosts cover macOS arm64/x64 and Windows x64. Linux covers the named existing CI consumers above, including the configured Xvfb Electron smoke, but the presence of that configuration proves neither that it actually passes nor that Linux is a supported product platform. Identical JavaScript source does not prove cross-platform behavior; reassess when adding native dependencies. Run design verification and product acceptance as required by each Owner. Name any untested platform explicitly; do not use macOS results as proof that Windows or Linux CI is complete.

If the overall switch includes an actual consumer on a platform, do not release it until that consumer is verified. Do not lower the product's two-platform acceptance bar.

<a id="desktop-领域配方与检查配置"></a>
### Desktop Domain Recipes and Check Configuration

Organize Desktop `package.json` by installation, preparation, development, checks, tests, and builds; keep hooks next to their main commands. ops does not inline Desktop details, and Desktop does not call ops in reverse. Long commands are handled by this Owner's `pretest.cjs`, `test.cjs`, and `e2e.cjs`: launch with Node argv, use a fixed package cwd, inherit stdio/env, and short-circuit on failure. Signal exits follow shared execution semantics; do not normalize interruption to ordinary failure.

Only the Desktop test runner declares test-file inventories and bounded globs; local ordinary/coverage runs and root CI read the same source. Do not parse package command strings. CI still runs prerequisites independently and preserves the original concurrency quota, quarantine, stage ID, c8 coverage scope, and reports. Parameterize E2E build prerequisites and project selection; do not turn the general Playwright entry point into an automatic build. The [Desktop test Owner](../../apps/desktop/docs/quality/testing.md#工程脚本接口) maintains lifecycle and retained interfaces; see the [current-state inventory](ops-cli-inventory.md#86-desktop-工程接口优化2026-10-26) for removal and consumer mapping.

The TypeScript solution's references are the project list for checks. The type runner and i18n checker read the same source; common strict-check options belong to the base configuration, while each project retains its runtime environment and target. Closures of real Programs may overlap. Do not remove environment checks for directory tidiness, mask errors with global Node/DOM types, or exclude newly discovered failing files. Complete type coverage does not mean Electron builds, installers, or cross-platform runtime acceptance are complete.

<a id="脚本模块导入与别名"></a>
### Script Module Imports and Aliases

**Status: Not adopted after this round's evaluation.** Neither the root nor Desktop declares Node `imports`; no active or proposed alias syntax is provided for copying. Nearby modules use `./` and `../`; cross-Owner dependencies retain explicit literal relative imports at the top of the file. Renderer/Vite/TypeScript resolution configuration does not replace module resolution for directly executed CommonJS/ESM.

The evaluation baseline covers 38 cross-root references in production Desktop CJS and 3 in ESM, across 10 targets. Native `imports` are package-private mappings: Desktop does not inherit root `imports`, and a relative target cannot cross its own package root. Cross-package aliases would therefore also require an explicit `createRequire` entry point; adding two declarations alone is insufficient. Public-export fixtures and packaged-bootstrap checks currently track only static relative-import closures. A custom resolution entry point would also require upgrading dependency-graph analysis, or dependencies could be missed during copying or checking. There are also `pre` and `dev` targets; do not disguise them as `shared` responsibilities just to unify names. In this round, retaining traceable dependencies is simpler than adding a resolution layer.

Reconsider `#tooling/*` and `#desktop-scripts/*` if shared tools become a genuinely independent package Owner or the unified dependency graph can recognize native `imports` and explicit `createRequire`. Declarations, resolution entry points, all consumers, CJS/ESM scanners, and tests must switch in the same milestone. Do not add installation or compilation prerequisites; use no `NODE_PATH`, `NODE_OPTIONS` preload, global loader, or arbitrary dynamic specifier; and do not use aliases to bypass Owner dependency boundaries.

Module resolution does not apply to Python, vendor, filesystem, or spawn paths; those remain the responsibility of their owning resolvers. The `main`/preload/renderer in a frozen installer and an independent Electron bootstrap must not implicitly depend on repository-root source. Code copied or generated into a separate directory must not assume the original package scope exists. Future implementation must separately cover bootstrap without `node_modules`, direct Node, `node --test`, npm/pnpm, different cwd/worktrees, and native Windows. Do not allow it by adding a hidden preload environment; fixed smoke, signing, and full acceptance remain unchanged.

AI Coding should first read the nearest `package.json` to the calling file and its actual declarations, then read the owning Owner. This section records why aliases were not adopted and the conditions for reconsidering them; do not create a second alias configuration. Root AGENTS retains navigation only.

Node rule reference: [Node 24.16 package imports](https://nodejs.org/download/release/v24.16.0/docs/api/packages.html#subpath-imports).

<a id="冒烟与本地构建的源码状态"></a>
### Source State for Smoke and Local Builds

`pnpm ops ci` / `ci test smoke` and `pnpm ops cd` / `cd build local` may start with uncommitted worktree changes; a commit is not required to get development feedback. This policy applies only to fixed smoke and local dev builds. It does not relax the clean-worktree requirement for full quality, package-acceptance workflows, preview/release, or candidates.

Allowing a dirty worktree does not permit changing source while a task is running. The shared source-identity Owner records the actual HEAD, clean/dirty state, and source fingerprint, covering paths, types, and actual contents in the index, tracked files, and unignored new files. Do not follow external links or write file contents into reports. Fail if the starting and ending commit/fingerprint differ, snapshot collection fails, or evidence is missing. Ignored logs, dependencies, caches, and artifacts are not source changes.

Full-content collection treats `ctime` as a read-race signal, not as source-content identity. If only `ctime` changes, read at most three times while file identity, permissions, size, and `mtime` remain unchanged; compare each content digest and require metadata to remain stable before and after the final read. Actual content changes, file replacement, or continued instability all fail; do not skip smoke or retry test cases. This accommodates metadata-only writes such as macOS extended-attribute scanning without relying on or modifying security-software configuration. Binary assets in development snapshots use the same content-hash and read verification; do not substitute size/mtime/ctime for actual contents. Extended-attribute-only changes do not change source identity, while same-size content changes with restored mtime are still detected. The development fingerprint policy is upgraded to `development-content-v2` and is not mixed with old metadata snapshots or full release snapshots. Do not add file-type exemptions or skip consistency comparisons.

Reports and local build results must truthfully retain dirty state and source identity. Do not present a dirty worktree as clean or identify an uncommitted version by HEAD alone. Passing dirty smoke does not qualify a release; a dirty local package is not thereby releasable. Core cases, integrity, zero-skip/retry, cleanup, platform, and local ad-hoc signing criteria remain unchanged.

<a id="7-整体切换与验收"></a>
## 7. Overall Switch and Acceptance

<a id="71-体验与可维护性的完成标准"></a>
### 7.1 Completion Criteria for Usability and Maintainability

Fewer commands, moved files, or passing documentation checks do not independently prove improvement. Use the observable results below to determine whether design goals have been achieved. Record actual results after implementation; do not claim an efficiency-improvement percentage at the design stage.

| Goal | Observable acceptance result |
| --- | --- |
| Users can find the right entry point | Startup, preview, targeted tests, and build tasks are discoverable using only `pnpm ops help/list`, with real/mock and scope made clear; users do not need to inspect script directories first. |
| Users can predict effects | Help and actual execution agree on prerequisites, writes, network, model/installation, and other effects. Uncertain items are labeled clearly; no false read-only guarantee is made. |
| Users can handle failures | Missing Python, source entry/module, dependency-identity conflicts, and tool failures identify the actual cause and recommended action; the CLI does not automatically switch managers, delete data, or download itself. |
| Usage is consistent across platforms | After installation on macOS/Windows, users follow the same command path. Platform differences are handled at the platform boundary or explicitly rejected; ordinary users need not choose script variants. |
| New tools do not spread duplication | Adding a task adds only its contract and necessary implementation. Help/list and orchestration agree; no synonymous root forwarding chain or copied domain inventory is added. |
| Shared responsibilities genuinely converge | Orchestration and execution primitives for included tasks have one Owner; remove old public aliases and their consumers together, without compatibility forwarding chains. |
| Behavior and maintenance cost are verifiable | Compare old and new entry points on corresponding versions, package-manager configurations, and hosts; lifecycle/CI/error results do not regress, and unaccepted scope remains explicit. |

<a id="72-一次性交付门槛"></a>
### 7.2 One-Time Delivery Gate

Implementation may be divided into development tasks and internal commits, but verification must occur only on the integration branch. After all in-scope commands, consumers, and tool source are ready, deliver the overall switch in one MR; do not enable it externally by task domain in stages.

| Required before switching | Release condition |
| --- | --- |
| Scope and contract closed | Every retained/merged item has an implemented target; every internalized item has an Owner; deferred items are explicitly excluded; there are no unexplained omissions or empty shells. |
| Source entry point ready | `ops-cli.cjs` and the root ops script are synchronized. Help/list work from a clean checkout without CLI compilation/installation; original installation bootstrap does not depend on the CLI. |
| Atomic wiring of orchestration and consumers | Update the CLI, GitLab Linux/native jobs, Preview, documentation/Skills together; no consumer remains on an old public alias. Separately pass entry-point, local, and CI recipes without a new root installation. |
| Standalone distribution consumers closed | Switch the actual distribution repository version to registered ops calls. State and verify preview, check, resume, and skip-check individually; changes to this repository's GitLab are not a substitute for external-repository acceptance. |
| Lifecycle and platform verified | Verify hooks, package managers, arguments, cwd/env, interruption, and worktree isolation on each platform actually affected; do not claim gaps passed. |
| Tests, builds, and dangerous operations verified | Preserve coverage/CI sets and the direct-build, smoke-distribution, and local-package-install acceptance chains. Verify/baseline-compare Linux Python resolution and the existing Xvfb Electron chain individually. Pass configuration, model, installation/cleanup boundaries; exclude user-data and external-CD integrations that remain deferred. |
| Old public entry points retired | Remove migrated old aliases and distribution logic with no consumers in the same change. Retain necessary hooks/internal domain entry points by name, but do not continue promoting them as old user-facing entry points. |

If any in-scope gate is unmet, do not treat partial command integration as completion of the switch. Deferred items retain their original controlled flow only because they are explicitly out of scope; this does not authorize a dual-track in-scope migration. Recover from switch failures according to repository Git constraints; do not automatically revert or delete user environments. Do not change the default user entry point until the overall switch passes.

Verification evidence has three layers: deterministic tests for commands/paths/errors; tests of real toolchains and filesystem state; and affected real development, CI, or product flows. Cover cold/warm installation, npm/pnpm, ignored lifecycle hooks, prerequisite failure, main-process failure, interruption, concurrency, package install/update contention, missing packages, and repository/package-version conflicts. Run source directly through `pnpm ops` from a clean checkout; help/list must not install root or Desktop dependencies. Cover two worktrees, subdirectories/explicit `repo`, source updates after branch switches, and Windows file contention. Do not substitute syntax checks for real execution. Exit active tasks before source updates; do not hot-replace orchestration. For every command, verify hook count/order, main-command argv/cwd/env, failure short-circuit, and exit result; cover actual npm/pnpm and `ignore-scripts` configurations. Accept development-environment changes on the actual host; do not claim Windows compatibility when untested. After touching product packaging/runtime, perform dual-platform acceptance as required by the relevant Owner. Record existing red results separately from same-version baselines; do not lower criteria.

Acceptance for new interfaces also includes: each specialized path is unique and fully registered/inventoried; the four default chains reuse the same Owner and execution recipe as their corresponding specialized commands without duplicate prerequisites; help/unknown arguments do not trigger default execution; pre idempotency and concurrency boundaries, renderer HMR, and safe restart/active-conversation protection for non-renderer changes each pass; mode/platform/context combinations are decidable and unsupported combinations are rejected in advance; no empty shells or recursive old aliases; meta-commands run no probes/read no credentials; explicit write modes do not reach budget baselines; native passthrough does not widen Owner, path, cost/installation, or acceptance mode.

Verify AI calls with the locked pnpm version: machine-readable stdout parses independently and contains no logs; meta-commands do not require Python; unknown commands, missing prerequisites, nonzero child exits, and status 2 each have clear origin/code; missing input with no TTY does not hang; report stdin is separate from interactive stdin; long-running tasks are not disguised as finite JSON tasks; and help-disclosed effects match actual argv.

CI must actually cover the CLI entry point without root installation, atomic-package `ignore-scripts`, local/CI recipe differences, nested identity after switching from a pnpm entry to npm, and real Linux venv resolution. Static documentation checks do not replace these implementation acceptance checks. The existing Linux `desktop-e2e-smoke` requires a same-version baseline, corresponding recipe, and actual result. Do not replace red results with static checks or a bare “platform unsupported.” Changing the scope of an existing job requires a separate explicit decision; do not implicitly reduce it.

External upload, public push, and supply-chain reconstruction still require separate interfaces and authorization; do not implement them incidentally while removing old commands. These are the observable release criteria for the overall delivery. Implementation and verification are in progress; passing an individual command, document, or regression does not mean all user flows, external consumers, and cross-platform acceptance are complete.

<a id="8-待冻结决策"></a>
## 8. Decisions to Freeze

- Minimum command registration for `ops-cli.cjs`, feature-based reuse boundaries, and source/target repository compatibility criteria.
- Node/pnpm versions, source-entry test matrix, branch-switch handling, and Windows file-contention acceptance.
- Extension interface for the package-manager selector, Windows cmd/bat argument-safety rules, and the actual verification environment.
- Consumer inventory for the single switch, reasons for retaining necessary internal entry points, permission-tag registration, and dangerous-command confirmation contract.
- Exact case classification and coverage verification for test type/scope/suite; cold/warm smoke budget; and capability status for unwired api/visual combinations. Do not claim an existing suite under a new name.

Freeze these decisions before overall-switch acceptance. This document does not authorize dependency installation, changes to existing hooks/CI, release execution, or user-data migration. The CLI is being developed in a separately authorized implementation task. Its completion status is determined by actual source, consumer migration, and real verification evidence; it must not be inferred from the existence of this high-level design.
