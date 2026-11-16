# AGENTS.md - ScholarSeed

Read the applicable directory's `AGENTS.md` before non-trivial work. These files
are the maintained project rules; edit their physical sources directly.

## Task Knowledge Routing

Owner 或知识位置不明时，按任务意图查 [知识索引](docs/index.md)，只追加适用正文；
已有有效 Skill 直达链接时不绕回全库导航。索引不替代本文件任何硬约束；自动加载被
截断或上下文不完整时，工作前补读本文件相关规则及目标目录的 `AGENTS.md`。
问题现象已明确且需要专题直达时，按需查[症状级知识路由](docs/runbooks/triage.md)，
不把它作为所有任务的默认必读。
知识治理、回写与归属判断读 [唯一规范正文](docs/architecture/knowledge.md)；
新增或修改 Markdown 图片引用遵守[图片路径规则](docs/architecture/knowledge.md#markdown-图片引用)。
历史命令和授权不继承为本次权限，未核验结论不写成能力，规范与源码冲突不自动取消安全要求。
脚本模块导入与路径别名先读 [作用域和实施约束](docs/architecture/ops-cli.md#脚本模块导入与别名)，
再核最近package.json的真实声明；无声明时不使用规划别名，不以别名绕过Owner边界。
开发工作流 Skill 只在文档内源仓维护，不随源码分发，也不是公开开发的前提。
产品 `skills/community/` 仍由源码仓持有。文档、工具与产品分别走实际检查和宿主/产品验收，
链接或元数据通过不证明语义、真实调用或完整验收通过。

## What This Repo Is

Independent packages, primary Electron Desktop, no root wheel. Before boundary
or distribution changes read [current ownership](docs/architecture/ownership.md).
Do not use import registration or Git submodules/gitlinks to restore removed
packages. Enterprise is private; Lattice and DamoCli are separate repositories.

## Working Constraints

### Open-Source Language

For content intended for the public [ScholarSeed repository](https://github.com/alibaba-damo-academy/ScholarSeed),
use English by default for documentation, code comments and product copy. Provide
documentation in both English and Chinese, and keep the two versions consistent
when changing them. This requirement does not change the language of internal-only
materials or prohibit localized product copy.

### Git Revert And Worktree Rules (hard gate)

- Never execute `git revert` for any commit. Never revert a merge commit by
  `git revert -m`, reverse-applying its diff, or an equivalent operation. For an
  ordinary commit that must be undone, explain the impact and require the
  developer to perform the revert manually; resolve merge problems forward or
  ask the developer to choose a recovery path.
- Before changing files, fetch the remote; preserve unrelated tracked and
  untracked work. Use the developer's named branch in the main checkout by
  default; use a worktree only when requested or isolation is necessary.
- Merge only when authorized for that source and destination. Verify the source
  has not moved, validate the integrated result, and never force-remove a dirty
  worktree. Read [分支与 Code MR 交付](docs/runbooks/development.md#分支与-code-mr-交付) for the
  branch, worktree, commit, push and MR procedure.
- Keep internal URLs out of Git commit messages. Before committing or merging,
  check the final subject, body, and trailers, including merge and squash
  messages and text copied automatically from review descriptions. Remove
  internal code review, issue, and document URLs; keep useful text and public
  links. Save any internal links needed for traceability in internal work records.
  Git 提交说明不得包含内网链接。提交或合并前检查最终标题、正文和尾注，包括合并、squash
  和平台从 MR 描述自动带入的内容。移除内网评审、工单和文档 URL，保留有用文字及可公开链接；
  需要追溯的内网链接只留在内部工作记录中。

### Review delivery

Use the current task's source and target branches. Fetch before changes, preserve unrelated work,
and use ordinary Git pushes only. PR creation does not authorize merge, release, upload or issue
status changes. Verify the actual remote, identity, source, target and resulting review record.
Public development and review must work from this repository alone, including native Git worktrees.
Never require an internal platform, a parent repository, or paired documentation SHA for ordinary development.

### Task Scope And Verification

Read-only reviews, explanations, and proposed edits do not authorize file changes,
formatting, product launches, or releases. Ordinary investigation does not itself
require a proposal; use the architecture criteria below and the user's requested
deliverable to decide whether one is needed.

For a PR, verify the live platform tool and its authority. Do not treat a missing tool, network
failure or permission denial as authentication loss. If a write result is uncertain, read it back
before retrying. Push through Git; never force-push or substitute remote file editing for a push.

After edits, select verification for the artifacts and behavior actually changed.
Documentation needs its relevant document checks. Instruction-only skill changes
need an actual invocation in their host and inspection of its transcript/tool
evidence; changes to ScholarSeed product behavior or bundled skills still require the
corresponding real product flow. A small diff does not waive applicable acceptance.

Every completed product feature or product defect fix needs final-revision, real-runtime screenshot
evidence of the affected result, including a diagnostic surface for non-visual
behavior. Open and inspect each screenshot, state what it proves and give its
absolute local path. Keep it ignored unless explicitly requested as a deliverable.
If it cannot be produced, report the blocker and do not claim completion; neither
screenshots nor deterministic tests replace the other.
Development-environment-only changes use actual host commands, installation logs
and executable probes as acceptance evidence; unrelated product startup or host
screenshots are not required. See the development-environment scope below.

### Real Product Verification

Product behavior requires the real user-facing flow, not just source, type or
contract checks. Select it through [按改动选择命令与证据](docs/runbooks/development.md#按改动选择命令与证据)
and the applicable Owner; Desktop conversation/HIL work also reads the
[Desktop 调试 工程规范](docs/runbooks/development.md).
Preserve the actual runtime, model credentials and user configuration; never
restart Serve mid-conversation. A healthy HTTP endpoint alone does not prove
a real session or model turn. Trigger instruction-only Skills in their host;
validate DamoCli only in its separate repository.

If environment, credentials or network block the real flow, report the exact
command, error and missing prerequisite. Continue independent authorized work,
but do not substitute a mock or claim product acceptance.

### No Fake Acceptance

Fixtures, fake providers, preselected tool calls, hand-written bridge events,
direct internal dispatch and static/component screenshots are not product
acceptance. The supported Desktop `--say`/`--drive` harness counts only when
it drives the real renderer, backend and model through the product path.

### No Production Changes for Test Isolation

Isolate tests through runtime state and existing public startup paths, never by
altering production behavior solely for a test. Do not change workspace/registry
precedence, configuration fallbacks, paths, sessions or persistence because a
test sets `SCHOLARSEED_*` or uses fixed data. If normal use reproduces a bug,
prove it and fix the domain invariant; otherwise adjust isolated initial state
or test orchestration. Never overwrite or migrate the user's real state.

### Path Source Of Truth

For paths, persistence or migrations read [persistence §§1–4](docs/architecture/persistence.md).
Use the owning resolver and connection boundary, not Runtime, TypeScript path
derivation or removed `DAMOAGENT_HOME` fallbacks. Preserve user data and extra
columns; no version-driven rebuild or credentials in project data.

### Removed Harness Boundary / Zero Forwarding Shells

Runtime is a contract/Gateway distribution, not an agent Harness. Do not recreate
`core`, `work`, `sdk` or `bench` as forwarding shells or package data. Check the
built wheel, update consumers of moved symbols, and keep contract, Gateway,
Trace and vendor execution in their respective Owners.

### Code Engineering Rules (hard gates)

- Keep imports at file head; lazy, dynamic and type-only imports are dependency
  edges, not boundary escapes. Only a genuine circular bottom re-export or a
  test's pre-`SCHOLARSEED_HOME` isolation import may use a marked exception
  (`# noqa: E402` / `# isort: skip_file`) with its reason.
- Put thresholds, ports, keys, modes, path fragments and status values in the
  owning constants, `Enum` or config (logger text excepted). Shared protocol
  values belong in Runtime contracts. Use a registry, policy, port or data for
  genuine variation rather than hardcoding the next flow into a core branch.
- **Bridge contract changes** to registered operations, schemas or exported guidance must regenerate
  the affected bundled product operations Skill references. Follow the
  [Skill adaptation guide](skills/ADAPTATION.md#4-验证真实边界), review the generated diff, and run
  `pnpm ops cd build local --target skills` before delivery.
- **File names prefer a single descriptive word** (`catalog.py`, not
  `build_catalog_helper.py`); use underscores only when one word cannot capture
  the responsibility. Single-word naming is statically guarded.
- Place files by Owner: Runtime contract/Gateway, Trace, adapter and Serve
  business each stay in their own package; locate an owner before adding a file.
  Helpers belong in that owner's `utils.py`.
- Renderer features/components/shell/app: MUST read [Desktop AGENTS](apps/desktop/AGENTS.md) and [components: 原生控件复用棘轮、Ownership / Dependency](apps/desktop/docs/design/components.md). UI first; no banned native controls/look-alikes/count increases/unlisted debt, wrong Owner/missing double registration, policy widening or hand-edited baseline.

### Desktop-Specific Security

Before Desktop CSP, Session callback, NSIS, privilege or update handoff work,
read [Desktop local rules](apps/desktop/AGENTS.md) and their linked Owner
contracts. The Windows worker/wrapper conflict remains unresolved: do not
relax the stricter security boundary or bypass native package acceptance.

### Desktop Visual Defaults

Every UI task first MUST read [DESIGN](apps/desktop/DESIGN.md), then [vibe: Required、滚动、浮层、Enforced by、Stop condition](apps/desktop/docs/design/vibe-coding.md).
Evidence is not inference; Values only in design; gates never replace real themes/narrow-window/keyboard/interaction.

### Cross-Platform Engineering (hard gate)

ScholarSeed supports macOS and Windows. Changes involving paths, permissions,
processes, locks, archives, executable discovery, native libraries or installers
MUST read [跨平台开发与验收](docs/runbooks/development.md#跨平台开发与验收), define both
platform semantics and verify affected gates and real flows on each target.
One OS never proves the other; a baseline-red gate is not green.
Development-environment-only work (local Worktree setup, dependency installation
and developer tooling) requires verification on the actual development host,
not mandatory Windows acceptance. This exception does not cover product runtime,
native packaging, installers, updates or distribution, and never proves Windows
product compatibility.

### Architecture First, Then Problem-Oriented Speed

Identify the owning abstraction and class of problem before applying a local
patch. Ship the minimal milestone at the right boundary, keep variation
extensible, and validate the real behavior; a passing local case is not done.

### Evidence Over Guessing (debug / build / proposal / reading code)

Read current source before concluding; old proposal paths and signatures are
hints, not authority. For runtime faults use [Engineering guide](packages/damoatrace/README.md)
and product logs, citing trace span evidence rather than hand-parsing JSONL.
If evidence is absent, add instrumentation or run the real flow; never infer
behavior from a file name or remembered tree layout.

### Root-Cause Fixes Only — No Surface Debugging, No Suppression

Fix the root cause, not the symptom. Do not delete features, shrink requirements
or tests, swallow errors or tweak thresholds to hide a fault. If a fix fails,
collect deeper real request, trace and state evidence before another patch.

### Formatting Before Done

For covered Python edits, run `pnpm ops ci format --write` and confirm `pnpm ops ci format`;
documentation-only work does not trigger formatting. Validate generated product
Skill code through its prebundle contract, not by rewriting generated files.

## Proposal And Development Flow

For architectural, cross-boundary or long-horizon proposals, read
[Engineering guide](docs/runbooks/development.md) before coding.
Use current source and Owner contracts, explicit design alternatives and observable
acceptance criteria. A read-only review writes no proposal; a local bug may not
need one, but still needs real verification.
## Engineering Entry Points

Development workflow Skills live in private supplements, not this checkout. Public development
uses the local AGENTS, Owner contracts and tools without a private Skill host or parent repository.
Before product Skill packaging or discovery changes, read [Skill ownership](docs/architecture/skills.md).
Optional host instructions do not replace design, contracts or real acceptance.
Renderer 页面、组件或交互视觉变更另读 [UI 复用 工程规范](apps/desktop/docs/design/components.md)；
纯状态与协议改动按 Desktop Owner 入口定位，不为其强制加载组件流程。
Use the current task's authorized materials for reports and artifacts; external download, upload,
release and user/host configuration still need authorization.

Starting, resuming, interrupting or modifying a persisted registered workflow run
requires authorization for that operation and scope; an existing explicit user
instruction satisfies it unless a second confirmation is required. Ordinary
Skill steps, read-only research and in-task subagents are not registered runs.
Before requesting approval, identify the run, inputs/outputs, cost, risks and
artifacts; while waiting, continue independent authorized work.

## Testing And Validation

Distinguish deterministic contract tests, real-state integration and end-to-end
product acceptance; none substitutes for another. Before tests, read
[按改动选择命令与证据](docs/runbooks/development.md#按改动选择命令与证据).
Real models or real-path deletion require their exact authority and prerequisites.
For proposal/long-horizon acceptance, also read
[design-solution 的验证规则](docs/runbooks/development.md); use observed
state and complete lifecycle evidence, not a fixed script or a reduced gate.
## User Entry Points

Before any local installer build, version/channel change, upload or release, MUST read
[BUILD: applicable channel, MVP-specific limits, distribution duties and result contract](docs/runbooks/build.md).
Reading the guide does not authorize signing, publishing, changing credentials or user configuration.

### Python Distribution Boundary

Before toolchain, installer or Python distribution work, read
[工具链与支持入口](docs/runbooks/development.md#工具链与支持入口) and
[BUILD](docs/runbooks/build.md). Installation, cleanup, PATH/config changes and
real-model calls are not read-only; verify exact executable provenance and
platform requirements. Stop on unknown source or resolver failure; health/ready
alone is not provenance or authorization. Never change a live environment
mid-conversation.

Before product Skill pack/update/validation, read
[Skill 边界](docs/architecture/skills.md), [产品适配指南](skills/ADAPTATION.md)
and [BUILD 的冻结与制品核验](docs/runbooks/build.md). Keep reviewed bundled and user
roots separate; never bundle user assets, silently download or treat partial/
failed scans as safe. Validate exact frozen inventory and real lifecycle.

Old root paths and ignored build residue are not source; when encountered, read
[current ownership](docs/architecture/ownership.md#当前仓库地图) before using them.

## 测试与快照目录约定

- Test owners and snapshot paths: [开发验收入口](docs/runbooks/development.md#按改动选择命令与证据).
  Keep screenshots and runtime artifacts ignored; never commit them by default.
- `tmp/research/` is itself the workspace root; do not create nested workspace
  aliases there. Never read or clean `tmp/manage-cc-hosts/`.
- Knowledge belongs to [its Owner](docs/architecture/knowledge.md); `work-records/`
  contains only plans, prompts and brief results, not raw evidence. Migration
  must verify actual consumers and semantics, not only structural checks.
