---
id: arch-knowledge-principles
title: "Project Knowledge System: Design Principles and Governance Standards"
doc_type: architecture
category: architecture
status: active
date: 2026-09-01
updated: 2026-10-14
keywords: [architecture, scholarseed, skill, toolchain]
summary: "Aims to help AI locate information precisely, understand it progressively, and act efficiently: AGENTS governs mandatory constraints and routing, docs governs knowledge and decisions, Skills govern workflows, and tools govern deterministic execution; defines boundaries for development write-backs and periodic governance."
code_refs:
  - "AGENTS.md"
  - "apps/desktop/docs/README.md"
  - "scripts/"
---

<a id="项目知识体系设计与治理"></a>
# Project Knowledge System Design and Governance

<a id="1-定位目标与适用场景"></a>
## 1. Purpose, Goals, and Applicable Situations

This page defines principles for organizing, discovering, maintaining, and governing project knowledge. It does not orchestrate routine development tasks. Its goal is to help AI and developers locate needed information accurately, understand constraints as needed, invoke tools efficiently, and write useful experience back to the correct Owner. Historical cleanup is a means of reducing retrieval noise, not an end in itself.

Task effectiveness comes first: ensure that knowledge, ownership, safety, and verification prerequisites are correct before reducing irrelevant reads and rework; workflows, directories, or invocation counts cannot substitute for actual task outcomes. Closing the loop on knowledge discovery and supporting workflows, evaluating real-world effectiveness, and retiring historical directories are three independently verifiable and deliverable areas; they need not wait for one another to be fully completed. A local blocker does not prevent delivery of independent results, but passing a stage does not mean the overall work is complete or waive other required acceptance.

Read this page when governing knowledge or changing its organization or entry points. Routine development only needs to consult it as needed to determine knowledge ownership, add decisions, or resolve conflicts between standards; every task is not required to load it in full. This page does not replace applicable `AGENTS.md` files, automatically start periodic tasks, or grant permission to modify, delete, or perform external operations.

The current implementation is established by source code, configuration, and actual verification results. Documents explain and provide navigation; filenames, dates, IDs, `active`, `implemented`, or historical claims of success do not prove that content is valid. When a standard conflicts with the implementation, investigate and report why; do not automatically waive safety constraints based on the code's current state.

<a id="2-职责边界与组织方式"></a>
## 2. Responsibility Boundaries and Organization

**AGENTS governs mandatory constraints and routing; docs governs knowledge and decisions; Skills govern task workflows; tools govern deterministic execution; work records provide work summaries.**

| Layer | Responsibilities | Should not handle |
| --- | --- | --- |
| Root `AGENTS.md` | Project boundaries, safety and authorization rules, minimal routing, and stop conditions that every task must know | Domain implementation details, lengthy operating procedures, historical logs |
| Local `AGENTS.md` | Constraints that must be followed when working in that directory and domain entry points | Duplicating root rules or knowledge owned by others |
| `docs/` and domain documents | Current mechanisms, interfaces, invariants, limitations, decision rationale, and verification basis | A second fixed execution workflow or runtime-state records |
| Development Skills in the source repository | Task triggers, inputs, steps and branches, progressive loading, tool selection, acceptance, and stop conditions; not a prerequisite for public source development | Duplicating domain knowledge or inventing authorization |
| Tools, scripts, CLI, and MCP | Deterministic queries, operations, and checks, with explicit inputs, outputs, and failure semantics | Implicit business decisions, bypassing permissions, acting as the authority on knowledge |
| `work-records/` | Concise summaries of this work's plan, Prompt, completed items, verification conclusions, and open issues | Per-turn logs, detailed audits, raw evidence or intermediate artifacts; automatically proving current capabilities |

Determine whether a rule is mandatory by asking whether omitting it could cause any task to exceed its scope or take an incorrect action, not by how often it appears. Put content that applies only to a specific directory or task in a local entry point, docs, or a Skill, and preserve discoverable routing; never lose a safety rule merely to shorten an entry point.

Organize project knowledge primarily by feature and code Owner. Root docs provides a unified knowledge map and holds genuinely cross-domain shared knowledge. Feature entry points link to shared contracts and client- and server-side knowledge according to the change scope. Maintain mechanisms, constraints, decision rationale, and verification basis near their Owners by default, rather than scattering one domain's knowledge across architecture, runbooks, and decisions. Connect valid existing subsystem docs or package READMEs through navigation; do not force migration or duplication. Split pages only when content size and independent maintenance needs justify it, and create directories as needed. Documents explain “what it is, why, and what constraints apply”; Skills orchestrate “the steps for the current task.” Do not maintain two copies of the same workflow; have the Skill refer to the relevant commands and mechanism descriptions.

<a id="知识组织架构图"></a>
### Knowledge Organization Diagram

The diagram below shows the knowledge entry points in the current repository; it is not a directory template to create. Navigate directly from the root rules or a matching Skill to the actual Owner first; consult `docs/index.md` only when the Owner is unclear. Consult `docs/runbooks/triage.md` when symptom-based troubleshooting needs finer routing. Create only pages that are actually needed; do not migrate or duplicate content merely to match the diagram.

```text
project root/
├── AGENTS.md                         Global mandatory constraints and knowledge routing
├── docs/
│   ├── index.md                      Routes by task and Owner; does not duplicate body text
│   ├── architecture/
│   │   ├── knowledge.md              Knowledge system design and governance principles
│   │   ├── ownership.md              Cross-system boundaries, dependencies, and Owners
│   │   └── …                         Other shared architecture contracts
│   ├── runbooks/                     Development delivery, flow diagnostics, and optional symptom routing
│   └── features/                     Current feature knowledge; index.md points to applicable pages
├── apps/<应用>/、packages/<包>/        Knowledge maintained near the code Owner
│   ├── AGENTS.md                     Local mandatory constraints and knowledge entry point
│   ├── README.md                     App or package usage and public boundaries
│   └── docs/                         Valid domain docs linked from the root index
├── scripts/                          Cross-domain shared tools; domain tools belong to their Owner
└── work-records/                     Plans, Prompts, and work summaries; no intermediate artifacts
```

Root [docs/index.md](../index.md) is a concise discovery entry point by task and Owner, not a central repository for all body text.
Symptom-based routing is centralized in the [diagnostic table](../runbooks/triage.md) and loaded as needed only when the symptoms are clear; it links only to the Owner's body text and does not contain a second copy of mechanism standards. Choose one body-text location for each topic, either in `docs/features/` or an existing Owner document; other entry points link to it. Do not copy feature knowledge separately by architecture, troubleshooting, or decision type. Do not copy shared engineering standards into every feature directory either.
Cross-feature decisions belong to the shared Owner; record feature-internal decisions near the feature, and split them into a topic page only when independent maintenance is truly needed.

The `features/<功能>/index.md`, `requirements.md`, `evaluation.md`, and
`technical/` structures below are optional when a complex feature **needs to be split**; they do not imply that these files currently exist in the repository.
Continue using a flat feature page when it works. Route to the existing body text from `docs/index.md` first, and split it as needed only when requirements, evaluation, and technical plans truly have different maintenance Owners or reading boundaries.

Feature knowledge has three layers: product requirements, evaluation basis, and technical plans. The product manager maintains `requirements.md`, recording confirmed, pending, and canceled requirements and linking scenarios to acceptance criteria with stable requirement IDs; the current implementation must not replace product goals. The evaluation owner maintains `evaluation.md`, links requirement IDs, and describes normal, abnormal, boundary, and security scenarios, observable decision criteria, and actual test entry points; record each run's conclusions as a summary and keep detailed execution evidence in a local ignored directory. Developers maintain technical plans, link relevant requirements and evaluation points, and distinguish mechanisms already implemented from designs awaiting implementation and scope not yet accepted. These roles assign knowledge responsibilities; they do not automatically grant AI permission to modify requirements or evaluation standards.

Entry points use a concise current status and reading route to distinguish implemented mechanisms, still-applicable requirements, and acceptance gaps. Trace historical process through links to work records; do not maintain execution logs at entry points or treat historical success claims as current capabilities.

Use a single `technical.md` for a simple feature. When overall collaboration and local implementation truly need separate maintenance, use `technical/index.md` and `technical/<owner>.md`; do not maintain both body-text structures at once. The overall plan records only responsibility boundaries, collaboration relationships, and shared contracts. Each Owner document records the internal mechanisms, constraints, failure semantics, and verification basis of its module. `desktop` and `serve` are examples of current project Owners; name other modules according to their actual ownership rather than grouping them broadly as client or server. Do not create pages for Owners that are not involved. Link to existing Owner documents when they suffice; do not add duplicate implementation descriptions.

Record key decisions alongside the corresponding plan: the current choice, rationale, rejected alternatives, necessary constraints, and conditions for reevaluation. Put cross-platform decisions in the overall plan and local decisions in the corresponding Owner document. Do not add `design.md` or `decisions.md` by default; split out a page only when a major decision truly needs independent maintenance or cross-feature references, and link it from the owning entry point.

When modifying Desktop, read the applicable general standards, relevant product requirements and evaluation points, applicable contracts in the overall plan, and Desktop technical knowledge. For a purely visual adjustment, add only the related requirements and evaluation points; do not scan all requirements. When changing IPC, APIs, data structures, or security boundaries, also read the knowledge and implementation of affected Owners; “client-only” work does not exempt cross-platform invariants. Select each branch according to the task; do not load everything. When no Skill matches, follow the Owner entry point.

<a id="各层读取与更新规则"></a>
### Read and Update Rules by Layer

The table below is a maintenance contract for the organizational structure, not a requirement to perform every step on every occasion. If an example path does not exist, use the actual Owner entry point; do not create a shell or assume body text exists. Reading rules do not add operational permissions. An update trigger means the knowledge impact must be checked; any actual write remains subject to the authorization for the current task.

| Knowledge location | When and what to read | When and what to update |
| --- | --- | --- |
| Root `AGENTS.md` | Use the loaded global rules for each task; do not reread unchanged body text when context is complete | Update when global mandatory boundaries, safety rules, or routing change; do not promote domain details to global mandatory rules |
| Local `AGENTS.md` | Read applicable rules before working in its scope; do not read guides for other directories by default | Update when this directory's hard constraints, Owner, or entry point changes; do not copy root rules |
| Root `docs/index.md` | Search by task intent when the Owner or knowledge location is unclear; do not return to the full-library navigation when a Skill gives a valid direct link | Update links and necessary summaries when knowledge pages are added, moved, removed, or their Owners change; do not duplicate body text |
| `docs/runbooks/triage.md` | Consult the relevant entry only when the problem symptoms or failure are clear and finer routing is needed | Update routing when the target Owner's body text or anchor changes; do not copy mechanism, safety, or acceptance content |
| `architecture/knowledge.md` | Read relevant principles for knowledge governance, organizational changes, or ownership decisions; routine development is not required to load it | Update when governance principles, layered responsibilities, or maintenance rules change by agreement; do not record one-off cleanup results |
| System maps and shared engineering documents | Read relevant contracts when work involves cross-domain boundaries, the corresponding technology stack, or shared commands | The corresponding Owner updates them when system responsibilities, dependencies, shared standards, command prerequisites, or failure semantics change |
| Feature `index.md` | Read when first locating a feature, checking its current status, or choosing the requirements, evaluation, and Owner scope to read | Update navigation when feature scope, actual status, maintenance responsibility, or knowledge routing changes; do not duplicate body text or describe unaccepted capabilities as complete |
| `requirements.md` | Read relevant requirements and applicable acceptance criteria when changing product behavior, evaluation, or a plan | After the product manager confirms a requirements change, update statuses and ID links; check affected evaluation and plans; do not change product goals without authorization |
| `evaluation.md` | Read relevant scenarios and decision criteria when designing a plan, selecting verification, or evaluating capability | When requirements, risks, or verification capabilities change, the evaluation owner updates it and checks requirement coverage; do not hide failures by lowering standards or duplicate one-off results |
| `technical.md` or `technical/index.md` | Read the current overall plan and applicable responsibility boundaries, shared protocols, and cross-platform invariants | Developers update it according to the confirmed plan and actual implementation; when contracts change, check all consumers and link requirements and evaluation; do not relax them independently on one platform |
| `technical/<owner>.md` and technical topic pages | When modifying an Owner, read its mechanisms, local decisions, and verification entry points; add necessary knowledge from other Owners when their contracts are affected | Developers update it when the module's mechanisms, limitations, decisions, or verification basis change; sync affected contracts in the overall plan and do not copy other modules' internal facts |
| App/package READMEs and local docs | Read the actual Owner's body text through root-index or Skill links; read the public usage contract when using a package independently | Update near the source when the app or package's public interface, mechanisms, usage prerequisites, or limitations change; do not copy them to a higher level |
| `SKILL.md` and `references/` | Read the workflow for a matching task; load references only when the corresponding step needs them | Update when triggers, steps, reading routes, tool calls, or acceptance rules change; point to knowledge body text rather than copying mechanisms and decisions |
| Tool scripts and invocation contracts | Before execution, confirm parameters, prerequisites, permissions, side effects, and failure handling; read implementation further only when help is insufficient or troubleshooting | When parameters, outputs, exit status, side effects, or platform behavior change, the tool Owner syncs implementation, documentation, tests, and Skill call sites |
| Work records | Read the summary to resume work or learn what is complete; do not load historical process by default | Update the summary when a phase completes or the plan changes; keep detailed evidence in a local ignored directory, retain original failures, and do not rewrite summaries as current standards |

When one change affects multiple layers, update only the affected body text and routing; do not mechanically update every file. When multiple tasks govern the same knowledge page concurrently, designate one writer and have other tasks return recommendations and evidence. Before writing, check the current content and diff to avoid overwriting someone else's changes.

Verify knowledge updates together with the corresponding implementation or workflow changes: check factual basis, scope, links, and consumers; perform the corresponding acceptance when Skills, tools, or product behavior are involved. Delivery notes list the knowledge updated, reasons no update was needed, or gaps still requiring verification. When writing is unauthorized, report the proposed update; do not silently leave outdated knowledge or change it without authorization.

Writing design decisions back during feature development is part of delivery, not optional cleanup: when mechanisms, interfaces, invariants, rejected alternatives, or verification basis change, update the decision record in the corresponding Owner document. A code or workflow change triggers this check when merged; missing write-back means delivery is incomplete. `proposal`, `wiki/`, and `work-records/` are planning, historical, and local collaboration materials; they do not replace the Owner's knowledge source of truth. Once a decision is accepted, move its durable content into the corresponding Owner body text and route to it from the index; do not treat a draft location or ignored directory as established knowledge. Track defects, hangs, and regressions in defect tracking, not in knowledge body text.

Maintain only one body-text source of truth for each knowledge item; navigation and indexes hold only summaries and links. Route entry points to actual existing Owner documents; do not infer that migration is complete from a target directory. Locate Desktop standards through its [local documentation entry point](../../apps/desktop/docs/README.md), Runtime contracts through the [package README](../../packages/runtime/README.md), and Trace constraints through its [package guide](../../packages/damoatrace/AGENTS.md).

Maintain project rules directly in the `AGENTS.md` files at each level. Maintain development Skills and host discovery links in the internal documentation source repository; do not copy them into the source repository or create forwarding entry points there. Public engineering commands do not depend on these internal assets.

<a id="3-知识发现与渐进加载"></a>
## 3. Knowledge Discovery and Progressive Loading

Applicable entry points and matching Skills determine the reading path; not every task is required to traverse the same document chain:

1. Use the applicable `AGENTS.md` files already loaded to check task scope, authorization, and directory boundaries. Do not reread identical body text because of aliases or symbolic links; check again if a file has changed or context is insufficient.
2. Select the applicable workflow based on task intent and the Skill's trigger description, and first read its required instructions. If no Skill matches, follow the Owner entry point directly; do not require a new Skill for a one-off small task.
3. Load necessary docs for the current step: first check paths, titles, summaries, or metadata, then read relevant body text. Read fully when relying on safety constraints or a complete protocol; do not take excerpts out of context.
4. Locate the current source, configuration, and verification entry points, then perform authorized actions. Expand to historical records and external materials only when tracing causes, verifying historical decisions, or troubleshooting.
5. Stop expanding once the current step's information requirements are met; read additional material within bounds if new issues arise during execution. Successful discovery does not waive subsequent implementation, verification, or safety requirements.

Skills should state what knowledge to read at each phase, when to read more, and when to stop, and link to domain body text rather than copying it. Their references may contain workflow-specific templates and invocation examples, but must not establish another set of architecture standards. Verify tool availability against the live inventory, help, and invocation results; the presence of a configuration file does not prove that MCP is connected or that an interface or authorization is valid.

AGENTS, docs, and Skills express requirements and execution conventions; they do not replace actual enforcement mechanisms for tool parameter validation, permissions/sandboxing,
state machines, or concurrency control. Handoffs should preserve concrete artifacts, sources, applicable conditions, and open items; a natural-language summary or a prompt's claim of compliance does not prove that isolation, independent review, or post-merge verification has been completed.

Entry-point governance also checks the host's actual loading boundaries: record the byte counts and symbolic-link topology of applicable entry points, host version, and verifiable instruction-loading settings; use evidence from the real host to determine which constraints were loaded and which need to be read separately. File length, passing link checks, or alias deduplication do not prove complete automatic injection. Do not convert byte counts to tokens or assume all hosts use the same limit. When truncation occurs or evidence is insufficient, state the gap and read necessary constraints before the relevant action; do not treat missing rules as invalid.

Reading cost is not the same as command count: also check scope, output volume, duplicate or irrelevant content, failures, and rework. Locate paths before reading named excerpts, and constrain query scope and output volume to the current task. If output exceeds processing capacity, state that it is incomplete and read targeted additional material; do not use excerpts to omit necessary safety rules or complete protocols. The mere appearance of truncation wording does not prove the tool actually truncated output. Record the raw tool result and upstream exit status; do not let a successful final pipeline command hide a failure.

When shortening entry points, first distinguish global stop conditions, local hard constraints, and on-demand knowledge by scope; place the latter two with their actual Owners while preserving task-discoverable routing. Before and after migration, check rule coverage and reading paths for representative tasks; independent review cannot compare only file sizes. Do not create superficially shorter entry points by deleting safety rules, broadening host configuration, or duplicating body text. Until the actual host has been retested, report only structural remediation; do not claim loading problems are resolved or development efficiency has improved.

Prefer existing tools for repeatable, deterministic actions. Tool contracts describe inputs, outputs, prerequisites, side effects, permissions, exit status, and failure handling; Skills select and check execution workflows, and scripts must not be treated as opaque black boxes. Put cross-system tools under a shared Owner and domain scripts under their module or Skill; do not create a general-purpose platform solely to promote reuse.

<a id="4-知识内容与决策要素"></a>
## 4. Knowledge Content and Decision Elements

Architecture and design documents supplement intent that code cannot clearly express: goals, division of responsibilities, key choices and tradeoffs,
boundaries that must be preserved, and when to revisit decisions. Put goals, the overall plan, and decisions first, followed briefly by necessary source-code basis and verification
entry points. Use source code to verify the current state and identify gaps; do not turn files, classes, or functions into a document skeleton,
or copy Skill execution steps. Prioritize making the plan easy for people to confirm and helping AI determine where to implement and how to evolve it.

The unit to retain is information useful for future development, not the original file. Retained content must have a current purpose and verifiable basis:

- Current responsibilities, dependency direction, interfaces, data ownership, and actual runtime mechanisms.
- Safety constraints, cross-platform differences, failure consistency, and invariants that remain valid.
- Currently usable knowledge for development, verification, builds, delivery, and troubleshooting.
- Necessary rationale and counterexamples for current technical decisions, to prevent repeating approaches proven wrong.
- Capability limitations, unverified scope, and risks, to avoid stating gaps as guarantees.

Current documents explain, as needed, responsibilities and non-goals, mechanisms, constraints, limitations, source and verification entry points, maintenance Owner, and update triggers. Use the actual package or module as the Owner; do not infer ownership from Git authors. Do not manually state counts that can be enumerated from source code. Identify the version, time, environment, and limits on generalization for observational data. The existence of code does not mean real acceptance has passed.

Choose decision-record elements according to complexity; do not require a long template: **Problem and applicability conditions → current choice → key tradeoffs and rejected alternatives → necessary rationale and invariants → current limitations → reevaluation conditions → source and verification basis**. Prefer maintaining mechanisms and rationale in the same Owner document; create a separate short decision page only when they cannot naturally fit there.

When only some of a historical proposal's rationale remains valid, extract the useful information; keeping the entire proposal is not required. Retain only sources and necessary arguments from external research that actually support a decision; do not describe a paper's conclusions as product capabilities. Plans that have not been implemented do not belong in the current architecture; track still-confirmed requirements and risks as concise current items with their Owners.

For extracted summaries, lessons, and review conclusions, retain their sources, applicability conditions, and limitations still needing verification. Do not use summaries to overwrite raw
failure evidence, or treat model self-evaluation, a voting majority, or confidence thresholds as verification of actual behavior. A successful retrieval does not prove
that a constraint was loaded or followed. Before choosing text, indexes, or relationship graphs, demonstrate an actual discovery gap and maintenance benefit; do not create a memory runtime, graph, or second knowledge service merely because an external system uses a particular format.

<a id="markdown-图片引用"></a>
### Markdown Image References

When adding or modifying local image references in repository Markdown, always make paths explicitly start with `./` and resolve them relative to that Markdown file: use `![说明](./reference.png)` (where the alt text means “description”) in the same directory, `./assets/image.png` for a subdirectory, and `./../assets/image.png` across directory levels. The same applies to local `src` values for HTML images. Do not use a bare filename, an absolute repository-root path, or a developer worktree path. Check that the target file exists and verify that the published site resolves the path relative to the document; the path format alone does not prove that online rendering was verified.

Preserve the source URL of external HTTPS images; do not download them without authorization just to satisfy the local-path format. Runtime reports displayed only locally and not committed use absolute local image paths according to the client rendering contract; do not use that convention for repository requirements or design documents. Apply this rule to references touched in future work; do not bulk-rewrite frozen historical inputs or original reports.

<a id="5-开发过程中的知识回写"></a>
## 5. Knowledge Write-Back During Development

`work-records/` stores only plans, Prompts, and work summaries: what was done, verification conclusions, commit or MR
locations, and unresolved issues. Summarize records by phase; do not create a report for each turn, file, or tool invocation. Keep intermediate artifacts such as detailed audits, migration inventories, full review text, runtime logs, screenshots, and candidate snapshots in an ignored local task directory, outside Git. A summary may point to evidence and identify gaps, but local files must not be the team's sole recovery instructions. Durable knowledge belongs in the actual Owner's docs; cleanup must not overwrite raw failure evidence or turn an unverified result into a pass.

The following changes trigger a knowledge-impact check; they do not require a new document for every code change:

- Responsibilities, dependencies, public contracts, data ownership, security boundaries, or capability limitations change.
- Prerequisites, parameters, outputs, or failure handling for startup, verification, build, or delivery commands change.
- Outdated knowledge, missing decision rationale, or repeatable troubleshooting experience is discovered.
- Similar tasks recur and reusable steps or deterministic actions are not yet covered by a Skill or tool.

Locate the existing Owner before deciding where to update: write mandatory constraints and routing back to AGENTS, mechanisms and rationale to docs, execution steps to a Skill, and deterministic actions to tools. Work records only summarize verification conclusions and evidence locations; retain one-off raw evidence in an ignored local task directory. Update existing body text when it covers the topic; do not create duplicate pages. Follow the actual maintenance and verification rules for Skill or tool changes.

Write-backs distinguish verified facts, design constraints, inferences, and unverified matters. Preserve necessary rationale concerning credential admission and revocation, user-data retention, platform security differences, native web pages and product overlays, stream consumption and cancellation terminal states, and artifact and update permissions. Unfinished acceptance and security risks must be carried forward as trackable items; cleanup of old records must not make them disappear.

Requirement IDs / Check IDs in an existing PRD must be unique and stable within their requirements, and must never be reused. Evaluations reference IDs already present in the corresponding requirements; technical plans do not create product IDs of their own. Each Evaluation contract declares only one environment;
Check / Scenario identifiers are unique within their defined scope, and every Check must trace to a
Requirement ID or Check ID in its corresponding PRD. Evaluation machine contracts declare only Observation requirements. A
Test must not be the sole basis for passing, and deterministic checks must not include product-semantic decision rules. Document migration carries forward only
confirmed requirements and links; it must not change product goals, lower evaluation standards, or state goals or gaps as current facts without authorization.

<a id="6-定期治理权限边界与验收"></a>
## 6. Periodic Governance, Permission Boundaries, and Acceptance

Periodic governance is triggered only by an explicitly authorized task or schedule; no interval or default whole-repository scan is established. Governance is constrained by the current task's workspace, scope, read/write mode, and permissions for external actions; past commands and authorizations do not carry over. This section defines decision, permission, and acceptance principles. The execution order is maintained only in the [governance engineering standard](knowledge.md).

The selected scope may cover outdated facts, duplicate sources of truth, broken links and source anchors, entry points and Skill routing, tool contracts, missing decisions, and current risks. Disclose unread scope and evidence gaps; do not claim repository-wide completion based on sampling.

Select acceptance and independent review in proportion to risk. Small changes of the same type and Owner may be combined into one bounded task and one specification and safety-quality review, avoiding line-by-line orchestration; check the impacts of deletions, security-boundary changes, and tool-contract changes separately. Combined review does not lower mandatory constraints, Owner responsibilities, evidence completeness, or real-host/product acceptance requirements, and workflow simplification does not expand permissions.

Before comparing effectiveness, check host, environment, tools, and input prerequisites, then freeze independent criteria; record environment, knowledge, tool, and evidence status separately. Compare benefits only for inputs that can legitimately be compared; do not fabricate a control when no baseline exists. Preserve original tasks, standards, freezes, and raw failures by version; verify a new protocol as a separate version rather than overwriting old evidence or retroactively declaring a pass. Correctness is a hard gate before efficiency. State the limits of conclusions when samples are small; do not let averages obscure serious errors.

Efficiency comparisons distinguish the costs of preparation, knowledge construction/updates, and task execution, and state cold-start costs, reuse counts, and statistical
denominators; moving work earlier into authoring or preprocessing does not make its cost disappear. Per-query tokens, retrieval
latency, or external QA scores alone cannot prove lifecycle-wide efficiency gains or correct real actions. A summary that preserves task intent is not the same as
lossless archiving; maintain necessary raw evidence and failure semantics according to their Owners and retention rules.

| Category | Decision | Handling |
| --- | --- | --- |
| Retain | Current purpose, basis, and source of truth are clear | Maintain near the source; add necessary routing and update triggers |
| Extract | The original is outdated or verbose but contains valid rationale or invariants | First carry them into the current Owner's docs, then clean up the original as authorized |
| Rewrite | A necessary entry point contains incorrect facts, obsolete commands, or duplicate workflows | Correct the content based on current evidence, not just the path |
| Deletion candidate | No unique development value, or valid information has already been carried forward | Check consumption relationships, then delete as authorized; do not add an archive by default |
| Needs verification | Purpose, consumers, or implementation relationship is unclear | Mark the gap; do not treat candidates as an approved deletion list |

Historical proposals, research snapshots, daily reports, and completed prompt/plan/result files are not kept permanently just because they were “once useful.” After necessary information has been carried forward, they may be retired as authorized; use Git to trace historical versions. Being referenced indicates migration impact, not retention value; having no links does not prove that nothing consumes the item.

Historical research unrelated to current code and development decisions may be deleted in full as authorized after confirming its current purpose, consumers, and necessary constraints;
there is no need to redo external research item by item or migrate entire reports just to clean them up. Historical cross-links are not
a reason to retain an entire set permanently, and the absence of source references does not prove irrelevance. When relationships are unclear, retain an item as needing verification. Extract only the necessary parts of decision rationale that remain valid into the actual Owner's docs; do not create historical archives or a memory service.

When a document's verification basis is invalid, an update condition has been triggered, or its maintenance Owner cannot confirm its contents, it must not remain
`active`: update and verify it within the authorized scope, or downgrade it to `draft`, mark it `superseded` and link to replacement body text,
or retire it under the deletion rules. Without write permission, report the invalid status and required handling; do not treat the page as a verified current standard.

Not all Markdown files are ordinary knowledge pages: product Skills, Prompts, and reference modules may be runtime inputs or packaged payloads; maintain policies, protocols, licenses, third-party notices, test fixtures, and operational contracts according to their actual purposes. For generated inventories, retain the generation source and checking mechanism; derived indexes do not become the authority for body text. Before cleanup, check body-text value, runtime consumption, links, IDs, navigation, scripts, and gates, and follow resource, compliance, and data-retention requirements.

Governance acceptance checks both correctness and discoverability:

- Navigation depth, document line counts, directory counts, and total historical warnings are not standalone success criteria. Do not add templates/indexes, conceal necessary constraints, or lower gates just to meet a fixed
  “three hops” or numeric threshold. First verify the correct Owner, knowledge, and verification prerequisites for representative tasks;
  then judge efficiency from comparable evidence from the real host.

- Relative links, source anchors, ID associations, and navigation are valid, and each body has only one source of truth; checking tools must cover actual knowledge directories and state any uncovered scope.
- For representative affected tasks, check the lookup path “entry point → applicable Skill (if any) → necessary docs → source and tools → verification” to avoid circular routing, unbounded scanning, and unnecessary repeated reads.
- Run the corresponding documentation checks for document changes. Skill, tool, or product-behavior changes also require actual host invocations or product acceptance; link checks are not a substitute.
- Actual acceptance for Skills and tools must verify success, denial, and failure paths against the contracts affected by the change. Use transcripts, tool events, and actual artifacts to confirm permitted read/write scope, exit or error results, and the resulting state and gaps after partial execution. Failures, timeouts, missing evidence, or partial writes must not be reported as success. Paths not verified in a real environment remain unaccepted; unit fixtures or a generic statement that “output looks normal” cannot fill the gap.
- For migration and deletion, check before/after inventories and consumers. Compare red gates against a baseline using the same command to distinguish pre-existing issues from new regressions.
- Evaluate efficiency from evidence of real reads and invocations; without a before/after comparison, do not claim time savings or a percentage improvement. Directory migration, shorter documents, and reduced counts do not by themselves prove efficiency gains.

Perform remediation only within the authorized scope, and report completed items, evidence, outstanding items, and blockers. Finding a problem does not automatically authorize bulk deletion, product changes, tool installation, user-configuration changes, commits, pushes, merges, or releases.

<a id="当前检查范围"></a>
### Current Check Scope

The source of truth for the metadata schema is [frontmatter](../../scripts/ci/docs/frontmatter.py); the controlled vocabulary is [keywords](../../scripts/ci/docs/keywords.yaml); and alias and keyword validation is owned by [vocabulary](../../scripts/ci/docs/vocabulary.py). Knowledge pages must not duplicate fields, status enums, or vocabularies.
Assign new or revised knowledge according to actual Owner and purpose; do not carry forward the old Wiki static site, a fixed architecture skeleton, or the historical convention of “syncing only architecture.” Check updates against requirements, mechanisms, risks, and consumers that remain valid.

The root `pnpm ops ci check docs workspace` command uses [`scripts/ci/docs/check.py`](../../scripts/ci/docs/check.py).
It discovers root/local docs, READMEs, AGENTS files, and development-boundary pages in the current worktree according to actual app/package Owners, named required entry points, and purpose-based exclusions, then outputs an exact inventory. It checks more than just body text with metadata and does not substitute HEAD
for uncommitted content. A missing required entry point, empty inventory, read failure, or out-of-scope item exits nonzero.
For body text declaring frontmatter, it checks the full schema, controlled keywords, source-of-truth IDs/related links across the full inventory, and resolved source references; it reuses the existing structure tool to check relative-link context for each logical entry point.
Checks and generation commands for the old Wiki site have been removed, and it no longer generates an index. The current knowledge gate is uniformly `pnpm ops ci check docs workspace`.
This gate does not scan the old root Wiki, work records, local plan cache, product Prompts/Skills, licenses, fixtures,
or third-party assets; these are validated separately by their actual Owners. Desktop's local `docs:check/docs:write`
continues to own independent contracts such as generated inventories. The root gate does not replace those checks, nor does it prove that body text is semantically correct or that a real host passed.
Links and host invocations for development Skills are verified separately in the internal source repository. Public source gates do not check out these internal assets,
and the absence of an internal host is not a reason to skip product, architecture, or engineering checks.

To verify this proposal's records, use `pnpm ops ci check docs workspace --record <work-records内的明确md路径>`;
repeat the named option for multiple records. The command checks the complete current knowledge set and those records together; it does not recursively scan history. Each specified record
must have valid frontmatter, be an ordinary Markdown file at a canonical repository-relative path, and have no links or
reparse points in its leaf or ancestors. The combined inventory shares metadata, keyword, ID/related, source-reference, and structure checks. Explicit paths and
errors are reflected in the output receipt; the check does not write files or promote drafts to current knowledge.

For bounded remediation, the minimal structure check on an explicit file list still uses the
[Engineering guide](../../scripts/ci/docs/structure-check.mjs):
`node scripts/ci/docs/structure-check.mjs <明确文件清单>`.
It reads only the explicit inventory and checks duplicate IDs within it, ordinary inline relative links, Markdown heading anchors,
nonempty quoted `id/name` anchors on body HTML `a` elements, and list-valued repository-relative `code_refs` in
frontmatter. It does not recursively check all linked body text, external URLs,
reference-style links, other custom HTML anchors, the full YAML schema, repository-wide IDs/related links, requirements coverage, or semantics.
HTML anchor values must match exactly; tag and attribute names are case-insensitive. Frontmatter, code examples, comments, and
script/style text are not treated as HTML navigation targets. Do not describe the minimal extractor as a full HTML rendering parser.
Save the inventory and execution result with this task's record. Missing files or check errors exit nonzero; a whole-repository scan is not the default.
This page's `arch-knowledge-principles` is the sole governance body text. The old `arch-knowledge` ID is historical navigation,
not a current discovery entry point. If a tool is found to still consume that ID, verify its actual contract and migrate the consumer; do not permanently retain the old Wiki stub for
compatibility with historical indexes. The root `docs:check` scan does not include that old navigation.
Actual source code, authorization, and task reading paths still require human verification. Skill changes require real host invocation, and product changes require a real product flow.
