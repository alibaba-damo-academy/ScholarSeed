<a id="症状级知识路由"></a>
# Symptom-Based Knowledge Routing

Use this page to search by keyword when the symptom or failure is already clear. It routes issues only to the actual Owner documents; the linked documents remain authoritative for their content and evidence. For general development, use the task to navigate from the root [knowledge index](../index.md) rather than reading this page in advance. This page does not authorize starting the product, reading user content, migrating data, or changing permissions.

<a id="身份会话与授权"></a>
## Identity, Sessions, and Authorization

- Skill credentials after sign-in/sign-out, revocation of queued messages, or inherited-environment issues: read [Actual admission of managed-execution credentials](../architecture/serve.md#受管执行凭据的实际准入). Real account identity, session ownership, and model keys are separate; failures do not fall back to old authorization, and records contain no secret values.
- After sign-out, literature-review or precision-search tasks resume with `task_context_missing`, `login_required`, or the wrong workspace: read [Product-task recovery after sign-in](../architecture/serve.md#登录后产品任务恢复). A saved binding is not authorization across turns, and signing in again does not automatically make an old lease valid.
- Sessions, history search, or automatic references to the current object are mixed up after switching projects: read [Session isolation and context](../features/conversations.md). Scope authorization takes precedence over history matching; automatic references and explicit references are separate; foreground navigation does not mean a background task has terminated.
- An input draft is lost after clicking a tab or closing the first-run guide: read [Draft and navigation boundaries](../features/conversations.md#页签导航不得回写过期输入草稿); navigation commits only the fields it owns.
- The Send button remains disabled after the first turn completes, or `recovery_pending` does not clear: read [Post-completion recovery wait and consecutive sends](../features/conversations.md#完成后的恢复等待与连续发送). Do not clear recovery protection directly.
- A queued send is denied by project-file permissions or baseline reading fails: read [Resource-baseline read permission failures](../features/conversations.md#资源基线读取权限失败); first check source authorization, and do not treat a failed card as a model-turn result.
- A PDF selection is appended during a reply, `assistant_claimed_refs_immutable` is reported incorrectly, or references leak into the next turn: read [Appending a PDF selection during a reply](../features/selections.md#回复期间追加-pdf-选区), preserving the immutable boundary of references claimed for the current turn.
- An authorization card expires across turns, the UI falsely shows running after a reply, or a full-text task resumes: read [Authorization waits and continuation across turns](streams.md#授权等待与跨轮次续跑).
- The selected approval mode does not match the effective policy, or a hot switch is unconfirmed: read [Permission-selection intent and confirmation of native application](streams.md#权限选择意图与原生生效确认).
- A subagent is waiting, progress ownership is unclear, or summary-content boundaries are in question: read [Subagent progress](streams.md#子代理进度的可信性与未解决内容边界).
- Native-thread recovery and audit history after a content rejection: read [Visible audit history and model recovery history](streams.md#可见审计历史与模型恢复历史).
- Model labels drift in an answer, citation numbers or positions are wrong, or source trust is in question: read [Answer metadata and citation evidence](streams.md#回答元数据与引用证据).
- A tool is still running, or cancellation acknowledgments do not match native-process cleanup: read [Native terminal cleanup after interruption](streams.md#中断后的原生终端回收).

<a id="文献资源与检索"></a>
## Literature, Resources, and Search

- Literature category trees, project navigation, duplicate names among siblings, or category/tag deletion: read [Literature categories and project scope](../features/catalogue.md). Project identity belongs to Content; deleting a category does not delete literature. Old development-time requests to clear a database do not authorize deleting current data.
- Dragging a PDF into a literature list, project drop targets, or isolation of mixed-file failures: read [Dragging and dropping literature PDF files](../features/catalogue.md#文献-pdf-文件拖放); do not route this into a Resources-directory job.
- Bulk synchronization of literature metadata, retries after rate limiting, or writes still in flight after cancellation: read [Bulk synchronization of bibliographic metadata](../features/catalogue.md#题录元数据批量同步). Bulk operations do not automatically confirm ambiguous title matches; the progress panel and application-process lifecycle are different.
- First load, pagination, refresh, version capabilities, or slow list requests in the resource tree: read [Resource knowledge-task navigation](../features/resources.md#按任务读取), then choose the section on loading, versions, review, or formats. Observing a targeted capability does not mean the overall request has no activation/traversal cost; old performance reports do not prove current latency or success on a real device.
- An Office document remains at “分配编辑器” (the UI text “Assign editor”), WASM warm-up fails, or the document remains invisible after retry: read [Office lifecycle and rendering-readiness gates](../features/resources.md#office-生命周期与格式处理器是两个维度). Distinguish runtime readiness, document-load events, and rendering ACKs.
- Markdown page width, source-search occlusion, external links, in-document anchors, or saved-reference navigation: read [Markdown reading and links](../features/resources.md#markdown-阅读与链接); do not reuse screenshots of the retired three-width layout.
- File tabs point to the wrong project, blur triggers auto-save, or review submissions are duplicated: read the project workspace and batch-terminal-state sections in [Resource knowledge-task navigation](../features/resources.md#按任务读取). File review does not use the literature-review flow, and UI state cannot replace persisted-state or business-terminal-state evidence.
- Adding selected text to a conversation, sending a selection, or source evidence: read [Selection snapshot boundaries](../features/selections.md). The send snapshot and source validation for explanation/editing are different operations.
- A partial PPT/PPTX drag selection becomes a whole-box selection, legacy PPT explanation fails, or PPTX incorrectly uses a snapshot: read [Impress selection and format dispatch](../features/selections.md#impress-选区ppt-与-pptx-不共用降级), distinguishing the restricted read-only fallback for legacy PPT from authoritative-source revalidation for PPTX.
- Adding a literature attachment to a conversation, previewing without a session, or abnormal tab navigation: read the attachment section of [Selection knowledge](../features/selections.md). Check file-message input, Renderer preview identity, and server-side local-file authorization separately; do not route into copy/import or literature-review flows.
- Shared editing of literature notes, save races, or Markdown export: read [Note-saving boundaries](../features/selections.md#文献-markdown-笔记共享编辑与保存边界). Distinguish item notes from PDF reading records; do not infer that a draft was saved from an error response or arbitrary exit.
- First open of AI interpretation for literature, explicit generation, or model JSON results: read [Interpretation-result boundaries](../features/selections.md#文献-ai-解读显式生成与结果可信度). Syntax repair, valid fields, citation location, and temporary preview are different forms of evidence.
- A selection translation reads the wrong attachment, a file is missing, or an error is not JSON: read [Source identity and error feedback](../features/selections.md#选区动作的来源身份与错误反馈); for physical deletion, also read [Exclusive attachment copies](../features/selections.md#托管附件删除与翻译输入故障). For selection-box coverage, cancellation, or late results, read [Temporary chart results](../features/selections.md#图表框选与临时结果). For full-text task scheduling, facing-page layout, and pre-publication source validation, read [Page-by-page translation](../features/selections.md#文献逐页翻译与页内分段).
- A resource review succeeds but navigates to the wrong place: read [Review completion and navigation](../features/resources.md#审阅成员终态与批次投影); verify business completion, in-memory synchronization, and tab navigation separately.
- Ingesting research results and Agent authorization to read full text: [Literature results and full-text boundaries](../features/downloads.md).
- Duplicate execution of web-wide search, degraded stages, or search evidence: read [Single execution and stage evidence](../features/resources.md#全网搜索的单次执行与阶段证据).
- Search-bar disconnection, recovery, or task deletion: read [Search-bar task lifecycle](../features/downloads.md#搜索栏任务与对话结果是不同生命周期).
- Confusion about displaying, tracking, or ingesting conversation search results: read [Display results versus ingestion boundaries](../features/downloads.md#检索结果展示不等于下载或入库).
- Reusing full-text consent across turns of the same task, or mistakenly reusing it for another task: read [Full-text consent and valid scope](../features/downloads.md#全文同意与有效授权范围).
- PaperCard original wording, independent local evidence, or precise PDF location: read [Original wording and location boundaries](../features/selections.md#papercard-原句独立本地证据与严格定位).
- Activating a literature review, using a historical workspace, or reading its artifacts: read [Literature-review safety boundaries](../features/review.md) and its product Skill/Serve Owner. A business issue does not require loading all general Skill-discovery knowledge.

<a id="desktop-与平台"></a>
## Desktop and Platforms

- Feedback recording misses the final step, pause/stop behavior, or probe recovery: read [Probe ownership and stop snapshots](../../apps/desktop/docs/architecture/ownership.md#反馈录制的探针所有权与停止快照). Verify input filtering, network payloads, screenshots, and diagnostic logs separately; a successful historical submission does not prove current safety or success on a real device.
- Feedback submission, diagnostic bundles, session ownership, or upstream errors: read [Serve feedback-submission boundaries](../architecture/serve.md#反馈上报与诊断包边界). Local contract tests do not prove the current upstream deployment or a real submission.
- Workbench caching, tab reclamation, or resource release: read [Residency and release boundaries](../../apps/desktop/docs/architecture/ownership.md#工作台驻留与资源释放); do not treat historical state machines or cache budgets as the current implementation.
- A page, settings subpage, active document, or docked session is not restored after quitting and reopening: read [Renderer last location and directory validation](../../apps/desktop/docs/architecture/renderer.md#current--required--gap--advisory). Saving a navigation pointer does not persist unsaved content.
- Built-in browser, native overlays, CDP, or browser product switches: read [Desktop browser constraints](../../apps/desktop/docs/browser.md), distinguishing source state from real acceptance.
- Background update preparation, activation, recovery, or candidate Provider startup: read [Desktop update-compatibility boundaries](../../apps/desktop/updater/README.md#windows-velopack). Preparation completion, restart authorization, draining, and health commitment are different evidence.
- Cross-platform paths, permissions, processes, cache/Temp/workspace, or archive issues: first read [Cross-platform development and acceptance](development.md#跨平台开发与验收), then locate the actual code Owner. Do not relax security checks.

<a id="serveruntime-与出网"></a>
## Serve, Runtime, and Egress

- Saving or starting/stopping a model connection fails: read [Connection admission](../architecture/serve.md#模型连接保存与启停准入). For personal-model capabilities and proxy differences, read [Personal connection declarations](../architecture/serve.md#个人连接的能力声明); for gateway-origin rejection, read [Outbound origins](../architecture/serve.md#出站来源与目的地). Do not skip action-mode, low-latency-policy, or origin checks just because ordinary chat works.
- Model-list refresh, connection snapshots, or Codex Host reuse: read [Connection-scoped models and Host boundaries](../architecture/serve.md#连接域模型快照与-codex-host-共享).
- Transient failure after HTTP 200 and whether it can be retried: read [In-stream transient-failure retry window](streams.md#流内瞬时失败的重试窗口).
- Observation reads slowed by persistence, backlog, or terminal-event ordering: read [Observation receipt and temporary staging](streams.md#原生观察接收投影与临时暂存).
- Confusion between EOF and terminal state, delta aggregation, or tool-prefix conversion: read [Observation surface and terminal state](streams.md#观察面与终态) and [Aggregation boundaries](streams.md#聚合不是协议降级). Procedures for retrieving session, permission, and stream evidence are maintained only in the [Engineering guide](../../packages/damoatrace/README.md); this table does not authorize starting the product, reading user content, or changing permissions.
- Connection-address, retrieval-transport, or distribution-origin changes: read [Egress and credential boundaries](../architecture/network.md), distinguishing configurable destinations from recipient authorization. An old egress inventory does not prove zero leakage today.
- Fixed Codex artifacts, complete vendor payloads, or DMG tool network fallback: read [Build Owner's bundled artifacts](build.md#内置制品) and the build prerequisites.
- A brand or package-name switch involving old user directories: read [Path source of truth and startup projection](../architecture/persistence.md#1-路径真源与启动投影); do not automatically perform migrations from historical plans.
- Missing evidence or classification of research conclusions as fact/synthesis/inference: read [Research evidence rules](../../skills/community/academic-research-guidance/references/evidence.md); ownership of loading and persistent instructions is described in [Product instructions](../../apps/serve/service/chat/prompts/baseInstructions.md). The existence of a rule or traceable citation does not prove a conclusion is correct.

<a id="开发与验证"></a>
## Development and Verification

- CI is green but includes skips, isolation, or an unclear verification scope: read [CI modes and quality conclusions](development.md#ci-模式临时隔离与质量结论), first checking the original report and actual mode.
- Choosing verification levels, affected edit cycles, commit/release gates, or CI speedups: read [Verification layers and the CI orchestrator](development.md#验证分层与-ci-编排器). Discrete GitLab jobs and the `ci:test` orchestrator have different responsibilities.
- Desktop packaging has duplicate `node_modules`, an asar-closure failure, or declares `ws` as a runtime dependency: read [Electron entry closure](build.md#electron-入口闭包与浏览器驱动-node); a passing `build` does not replace `package:check`.

After locating the Owner document, continue using current source, applicable contracts, and real-verification requirements. This table's routing and reminders do not replace product acceptance and do not prove that linked documents have been checked for current accuracy.
