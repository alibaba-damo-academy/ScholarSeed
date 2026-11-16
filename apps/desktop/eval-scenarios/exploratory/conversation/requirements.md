<a id="真实对话与任务结果候选需求"></a>
# Candidate Requirements for Real Conversations and Task Results

<a id="用途与入口"></a>
## Purpose and Entry Point

Users send requests from the new-task or existing-task input area in a project workspace and observe the same task's execution state, answer, and available results. The real entry point, requirement applicability, and adoption status for the target version still need verification. This page is a candidate compiled from historical requirement assets, not this round's frozen criteria or a product pass result.

Real single-turn completion in an isolated project

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; one synthetic request and its real completed reply in an isolated project. The input field text is a placeholder. The screenshot does not prove readback after reopening, file artifacts, or a formal evaluation pass; see [Build Basis](./build.md) for the source.

Display after reopening a task in the same process

Reference: isolated project on the same version, 2026-11-13; shows the messages and completed state after reselecting a task. The screenshot itself does not prove the selection process or recovery across a restart.

Real task title-bar action menu

Reference: isolated project on the same version, 2026-11-13; the real task title-bar action menu with the workbench open. It does not prove any menu action or the state with the workbench closed.

**Reference screenshot gaps:** Full-window screenshots for file artifacts, sent image-group previews, and other conversation states on the target version are still missing. See the blank input composer reference in [Composer Candidates](./../task-composer/requirements.md); it shows only the pre-send state. Component fixtures, historical real user conversations, and synthetic results must not be used as substitutes.

<a id="候选正常流程"></a>
## Candidate Normal Flows

<a id="已发送图片组预览与原文件操作chat-image-group-cand-001产品需求版本待确认"></a>
### Sent Image-Group Preview and Original-File Actions (`CHAT-IMAGE-GROUP-CAND-001`; product requirement version pending confirmation)

Historical user confirmation says sent images can be viewed as a group. Use two distinguishable images actually sent in the same authorized isolated conversation, with their identities independently recorded before sending, to check thumbnails, opening the preview, switching within the group, zooming, dragging, and closing; the filename shown in the preview should correspond to the current image. A successful image preview does not prove that the model read the image. Draft thumbnails and their removal are pre-send states and do not substitute for a sent message; display order for mixed context is covered separately by `CHAT-MIXED-CONTEXT-CAND-001`.

Check the actual target of each original-file action separately: opening in the workbench should correspond to the current image and must not import it automatically; Open With and Show in Folder should target the same original file, and a host acknowledgment does not replace checking the target; Copy requires checking the authorized clipboard result. For library import, independently compare the directory, file identity, and bytes or digest before and after import. When a name collides, prompt for a new name without overwriting the original or assigning a number automatically. Check an action only when it has its own authorization and reference; a visible menu or success notice does not substitute for the final state. The latest historical menu requirement replaces Save As and the system default opener with four actions, while the current source still has Save As. The target package's applicability and this conflict require Owner confirmation; do not decide the Save As menu question here. Failure handling, full menu details, and cross-platform behavior are separate topics.

Target-package applicability, requirement version, adoption, and a real full-window screenshot of a sent-image preview remain to be checked; historical development instances and component images are not target references. In the current source, opening the More menu itself may read and revalidate session files, update the host authorization root, and enumerate applications; first verify the actual target and authorization. The menu need not be opened merely to inspect a preview. Separately verify authorization to prepare isolated synthetic images, read files, write drafts, send and incur model costs, use the clipboard, open or reveal files in the host, and write to the library. Do not read real user data or prepopulate sent messages. Sources and differences are in [Build Basis](./build.md).

<a id="新任务与真实单轮历史-chat-new-013chat-turn-011产品需求版本待确认"></a>
### New Task and Real Single Turn (historical `CHAT-NEW-01@3`, `CHAT-TURN-01@1`; product requirement version pending confirmation)

In an isolated project, send a synthetic request from the verified new-task entry point. The first send creates a distinguishable new conversation, and messages from existing conversations do not appear in it. The user can see the original request, execution changes, and complete final answer from the same real turn; the answer should address the request and have a verifiable completed final state. An empty answer, merely returning to idle, or the model's own claim does not independently prove success. Historical IDs and asset revisions are not product requirement versions; adoption and applicability to the target version remain to be confirmed.

<a id="待审阅文件与新任务对话chat-review-decouple-cand-001产品需求版本待确认"></a>
### Pending Review Files and a New-Task Conversation (`CHAT-REVIEW-DECOUPLE-CAND-001`; product requirement version pending confirmation)

The user historically stated explicitly that an unreviewed file must not block continuing the conversation. For a real file awaiting review left by an old task in the same authorized isolated project, a new task should send and complete its corresponding real conversation normally; sending must not automatically accept, reject, or clear the original review. Use independently recorded project, old-task, file, and review identities and before/after states as references. An ordinary new-task single turn or send-success notice does not substitute for the pending-review precondition and complete reply. The review decision still requires explicit handling; actual resource-operation errors and revision conflicts must not be swallowed by decoupling the conversation.

This is a candidate special case. Applicability to the target version and adoption remain to be confirmed, and a real full-window screenshot showing a pending-review file and completed new task on the target package is missing. It requires an authorized isolated project, a real file awaiting review, and an independent state reference. File generation, task creation, sending, model calls, and explicit review each have their own permissions and side effects. This item does not claim coverage of continuing the same conversation, queues, resend after failure, unsaved drafts, successive edits, or cross-platform behavior; verify those separately. Do not read real user conversations or forge review state.

<a id="已有会话读回历史-chat-history-013产品需求版本待确认"></a>
### Readback of an Existing Conversation (historical `CHAT-HISTORY-01@3`; product requirement version pending confirmation)

Open a completed isolated conversation from the task list and read back the original user message, reply, and final state corresponding to the independently recorded conversation identity; do not mix in another conversation. An empty task list or an unsent draft cannot substitute for a completed turn. Recovery after restart and other exceptional states are separate topics.

<a id="历史任务的回复时间与排序chat-history-sort-cand-001产品需求版本待确认"></a>
### Reply Time and Ordering of Historical Tasks (`CHAT-HISTORY-SORT-CAND-001`; product requirement version pending confirmation)

Historical user confirmation says the historical-task popover in projects and the Literature Center shows the Agent's last-reply time and sorts in descending order by that time, not by creation, pinning, or other activity time. Use distinguishable real conversations in the same authorized isolated scope and independently recorded last-reply times to check row identity, time, and order in the popover; merely seeing a list or opening a historical conversation does not prove sorting. How tasks without an Agent reply should appear and sort is still unconfirmed and must not be adopted automatically from the current implementation. Target-version applicability, adoption status, and a non-empty full-window popover screenshot remain to be checked. Cross-page extremes and cross-platform behavior are separate topics; this popover is distinct from the pinned group in the project sidebar.

At least two real isolated conversations with distinguishable last-reply times are required, preferably with creation order different from reply order. Confirm the requirement before preparing a real task for a no-reply state. Preparation or continuation each requires authorization. An existing authorized conversation may be observed, but forged events and a prepopulated database are not substitutes; raw files in `examples` do not provide conversation results.

<a id="创建任务分支chat-fork-cand-001产品需求版本待确认"></a>
### Create a Task Branch (`CHAT-FORK-CAND-001`; product requirement version pending confirmation)

Historical user confirmation says the project task menu offers creation of a branched conversation, and the branch's source row can return to the source task. After creating one from an authorized isolated source task, use an independent directory in the same project to verify that the new branch identity differs from the source task, then verify that its source row points to that task and that the return works. Closing a menu, a notice, or a new card does not replace the directory and source-identity reference. This differs from creating a blank task or reading historical messages; do not infer complete history inheritance or that a new turn was executed. Applicability to the target version, adoption, and a real full-window screenshot remain to be checked. Turn-level branching, detaching from a group, failure recovery, and cross-platform behavior are separate topics.

Branch creation changes conversation state and requires an authorized isolated project, a real source task, and write permission. Record the source identity, project, and directory pre-state first. `examples` can provide synthetic project files but no real source conversation. This action does not require sending a model request and does not automatically authorize sending.

<a id="文件产物交付历史-chat-artifact-012产品需求版本待确认"></a>
### File-Artifact Delivery (historical `CHAT-ARTIFACT-01@2`; product requirement version pending confirmation)

In an authorized real turn that explicitly requests a file artifact, the task result provides a corresponding artifact entry point, and the identity of the opened file matches the file actually published and its contents are readable. Evaluate source fidelity and semantic quality separately against independent materials and review. Ordinary text conversations do not all need to produce files; a card, filename, or model claim of generation cannot substitute for actually opening the result.

<a id="过程文献更多操作chat-process-literature-cand-001产品需求版本待确认"></a>
### More Actions on In-Progress Literature (`CHAT-PROCESS-LITERATURE-CAND-001`; product requirement version pending confirmation)

Historical defect screenshots confirm that an in-progress literature item should expose discoverable More actions and preserve normal PDF reading, without fabricating a working-file path. Use literature and attachment identities from the same authorized real conversation as references to observe the entry point and actual available targets; if PDF reading is selected, verify the real reading end state for that same attachment. Any displayed path must match an independent source. Not every paper is required to have a local file, and PDF download must not be inferred. The complete rules for specific menu items still require confirmation and must not be defined from source alone. Applicability to the target package, real in-progress literature, and a full-window screenshot remain to be checked. Separately verify authorization for copying titles, network access, generation, and file access; a Literature Center attachment entry is not a substitute.

<a id="文献综述卡片与引用导航chat-review-card-cand-001产品需求版本待确认"></a>
### Literature-Review Card and Citation Navigation (`CHAT-REVIEW-CARD-CAND-001`; product requirement version pending confirmation)

Historical user requirements say the review card displays, in order, scope and deliverables, the review outline, literature citation information, and citation checks and unresolved issues. Remove the original card title and user input from the scope area. The outline is a tree, and section summaries use a gray-background, vertical-bar quotation style. Show citation information in a table, with explanations in hover tooltips. The issue-check table includes citation-check status, unresolved issues, and issue priority; use “—” when absent. A library citation should open the corresponding paper in a new side window, and a web citation should open the corresponding page in a new side window. Check against the same authorized real review result and independent references for scope, sections, citations, and target identities; the existence of a card does not prove citation correctness or review quality. The graphic details of the count dashboard still need to be checked against the original image and are not inferred by this candidate. Target-package applicability, requirement version, real results, and a full-window screenshot remain to be checked. Separately verify permissions for model use, network access, and opening targets; do not substitute simulated data or historical development records.

<a id="对话文件历史版本chat-artifact-version-cand-001产品需求版本待确认"></a>
### Historical Versions of Conversation Files (`CHAT-ARTIFACT-VERSION-CAND-001`; product requirement version pending confirmation)

Historical user requirements say that for the same turn and publication path, only one latest-file card is shown, with a version entry point that opens historical content by immutable publication/artifact identity. For an authorized real artifact, at least two distinguishable versions from the same turn and path, with independent identity and content references, are required to check the latest card, version selection, and actual opened content. A normal artifact entry point, filename, or single card does not prove version correspondence. Target-package applicability, requirement version, and a full-window screenshot remain to be checked. Separately check conditions for model calls, artifact writes, recovery after refresh, and cross-platform behavior; do not prepopulate product results.

<a id="对话画布与工作台往返chat-canvas-cand-001产品需求版本待确认"></a>
### Conversation Canvas and Workbench Round Trip (`CHAT-CANVAS-CAND-001`; product requirement version pending confirmation)

Historical confirmation requires each conversation canvas preview to collapse independently. Whether expanded or collapsed, the same canvas can be opened in the workbench. Returning to the conversation with the workbench's own collapse button preserves that canvas's prior preview state and original document, without automatically switching back to the original document. Use a distinguishable canvas identity, content, and pre-entry preview state in the same authorized real conversation as independent references. Observe opening, workbench rendering, and return with both collapsed and expanded previews. Similar appearance does not prove the same canvas, and this does not imply canvas editing or saving passed.

The target-version entry point, applicability, requirement version, and real full-window screenshot remain to be checked. If no authorized real canvas is available, generating one involves a model, tools, cost, and writes, which each require separate authorization. Record side effects because canvas/workbench switching may change the isolated layout. Full layout details for preview height and scrolling, workbench-body continuity, and avoiding a duplicate return row, as well as canvas editing, exceptions, and cross-platform behavior, are separate topics; do not substitute component examples or forged events.

<a id="任务概览产物展开chat-overview-cand-001产品需求版本待确认"></a>
### Expand Task-Overview Artifacts (`CHAT-OVERVIEW-CAND-001`; product requirement version pending confirmation)

Historical user confirmation says output artifacts and in-progress artifacts in the task overview each show at most five items by default. If a group has more than five, show the remaining count in that group; expansion displays all items in place and can be collapsed again. Use an independent artifact inventory for the same authorized isolated conversation to check the identities and counts in each group, the remaining count, and states before and after expansion. Check the groups separately; do not extrapolate one group's result to the other or treat listing artifacts as proof that a file opened or its content is correct. Target-version applicability, adoption status, and a real full-window screenshot remain to be checked. The historical old rule for three-item previews and hover details is not a requirement of this candidate.

Each overflow group under review requires at least six distinguishable real artifacts from the same conversation and an independent inventory. An existing authorized conversation may be observed; creating a conversation, generating artifacts, and their model calls, costs, and writes each require separate authorization. Shared `examples` provide only source materials, not prepopulated real task artifacts. Do not use component fixtures or prefilled artifacts as product final states.

<a id="回答的混合引用来源列表chat-citations-cand-001需求版本待确认"></a>
### Mixed Citation-Source List in an Answer (`CHAT-CITATIONS-CAND-001`; requirement version pending confirmation)

Historical design records a later product confirmation: the answer retains a source-count entry point; files and web pages are mixed in one scrollable list in the order of their sources in the answer, without category tabs; the count deduplicates identical source objects. Use the same authorized real conversation and turn, with independently recorded source identities and order, to check the count and list correspondence. An entry point or icon does not prove source identity, content, or openability. This candidate does not require clicking a source or infer that file-version validation, web access, or source-content authenticity passed.

Real distinguishable file and web sources, an answer from the same turn, and independent source references are required. To verify deduplication, that turn must also contain at least one independently identifiable repeated citation to the same source, and its original order must be recorded; otherwise leave deduplication uncovered. Separately verify permissions for model use, network access, file reading, and later opening. Do not substitute component examples, fabricated sources, or prefilled answers. Target-package applicability, requirement version, adoption status, and a real full-window screenshot remain to be checked. Different source conditions, exceptions, and cross-platform behavior are separate topics.

<a id="引用摘录展开chat-citation-excerpt-cand-001需求版本待确认"></a>
### Expand Citation Excerpts (`CHAT-CITATION-EXCERPT-CAND-001`; requirement version pending confirmation)

Historical requirements record that single-file and grouped citation previews count Unicode code points: show excerpts of 240 characters or fewer in full; excerpts longer than 240 characters can be expanded and collapsed; grouped citations have independent expansion states; and original-text navigation is unaffected. Use an authorized real conversation and independent references for excerpt text, source, and length to check the boundary, complete content, expansion state, and original target separately. A source list is not a substitute for an excerpt preview. Historical evidence about the number of collapsed lines conflicts and requires Owner confirmation; it is not currently a criterion. Real native citations, target-package applicability, adoption status, and a full-window screenshot all remain to be checked. Model use, file reading, and navigation follow their actual permissions; this is not part of the adopted smoke-test denominator.

<a id="长用户消息展示与复制chat-message-cand-001产品需求版本待确认"></a>
### Display and Copy of Long User Messages (`CHAT-MESSAGE-CAND-001`; product requirement version pending confirmation)

Historical user confirmation: after sending, user text longer than six visual lines is collapsed, with expand and collapse controls; collapsing does not truncate the original text or copied value. Use a previously recorded synthetic request as the independent reference to check the expanded content of the same message. If operating the system clipboard is authorized, check copy results separately in collapsed and expanded states. Determine visual-line count for short messages and different window widths from the actual layout, not character count. This does not cover copying assistant answers, opening links, or message timestamps; applicability and adoption for the target version remain to be confirmed.

Expanded long user message

Collapsed long user message

Reference: macOS arm64 installed build `0.3.2`, 2026-11-13, full rendered viewport of an isolated synthetic conversation. The lower part of the expanded message extends beyond the viewport, so the image alone cannot prove that all text is visible or that copying is correct. This observation was in the same process only; limitations on associating the installed build number, channel, and independent conversation identity are in [Build Basis](./build.md).

Top viewport of expanded long message

Middle viewport of expanded long message

End viewport of expanded long message

Reference: consecutive full viewports of a synthetic isolated conversation from the same day, with overlap between images and the final image showing the end of the original text. The images alone cannot prove character-by-character copy, behavior across windows, or recovery after restart.

A real isolated conversation and authorized model call are required. Full applicability to the target version and clipboard results remain to be checked; an input-composer draft, component preview, or another historical conversation is not a substitute. Historical confirmation and source clues are in [Build Basis](./build.md).

The [synthetic Markdown text](../../../../../examples/projects/evaluation/files/sample.md) in shared examples can be reused as the original text to send. Verify its bytes against the manifest and record the actual input before sending. The number of lines in the sample is not the number of visual lines; observe it in the current window layout. The sample contains no conversation result and does not authorize sending or clipboard operations.

<a id="agent-正文裸网址chat-bare-url-cand-001需求版本待确认"></a>
### Bare URLs in Agent Body Text (`CHAT-BARE-URL-CAND-001`; requirement version pending confirmation)

Historical user confirmation says bare URLs in Agent body text are truncated to a single line inside the container; hovering or keyboard focus reveals the full address, while copy and open use the full URL. Ordinary descriptive text links retain their normal line-wrapping semantics. Use the same authorized real answer and an independently recorded full address to check rendering, tooltip, copy, and the authorized open target separately; copying a user message or viewing the source list is not a substitute. Target-package applicability, requirement version, and a real full-window screenshot remain to be checked. Separately verify permissions for model use, external navigation, and system clipboard access.

<a id="已发送混合上下文展示顺序chat-mixed-context-cand-001需求版本待确认"></a>
### Display Order for Sent Mixed Context (`CHAT-MIXED-CONTEXT-CAND-001`; requirement version pending confirmation)

Historical user confirmation says sent content is displayed in this order: text selection/annotation, image, file, and text bubble, with the first three each on their own row. Use the identities, types, and text of the references independently recorded before sending the same real message to check the actual content and display order of each type. This requirement concerns display grouping; it neither requires nor proves reordering of the send payload or persistent references, and visible images or files do not imply that the model read them. Target-package applicability, requirement version, and a real full-window screenshot remain to be checked. Extreme overflow, opening source content, and cross-platform behavior are separate topics.

This requires a real mixed-context message sent in the same authorized isolated conversation, distinguishable synthetic images and files, and real verifiable selections/annotations. A person must confirm preparation of local files. Separately verify authorization for file reading, draft writing, model sending, and costs. `examples` supplies only some original inputs; it does not prepopulate messages or answers. An empty draft, component screenshot, or prefilled message is not a substitute.

<a id="数据与独立参照"></a>
## Data and Independent References

Test projects and inputs must be authorized isolated copies. Select necessary original materials from [examples](../../../../../examples/README.md) and record their version, digest, and copy identity. Record request, project, conversation, and turn identities before execution or when generated; the product must generate real answers and artifacts, with no prepopulated results. The conversation needs an exclusive isolated task, a ready model and runtime environment, and explicit authorization for this model call, its cost, and necessary file writes. Generate artifacts only in the authorized task directory. Compare content with the preselected request and independent original materials; assess quality through independent review, not claims by the driver or model.

Pre-send drafts for new tasks and pending-send queues belong to [Composer Candidates](./../task-composer/requirements.md) and are not redefined here. Task lists and pins belong to [Task List Candidates](./../task-list/requirements.md). Ordinary turns, history recovery, and artifact delivery are distinct units of inspection; results from one screenshot or one turn must not be added up to claim the entire flow passed.

<a id="专项与缺口"></a>
## Special Cases and Gaps

<a id="普通问答历史只读回放chat-answer-replay-cand-001需求版本待确认"></a>
### Read-Only Replay of Historical Answers to Ordinary Questions (`CHAT-ANSWER-REPLAY-CAND-001`; requirement version pending confirmation)

Historical user requirements say that when an answer to an ordinary clarification or built-in question is expanded in history, it retains the prompt, original options, and text box, and accurately displays the selected single or multiple options and supplemental text. Options cannot be changed, text can be selected and copied, and the question cannot be resubmitted. Use the same real request's prompt, option order, pre-submit selections, original supplemental text, and independent receipt as references to check the content after submission and after reopening, read-only behavior, and copy result separately. If an old record cannot reliably identify a choice, preserve the original text and do not guess which options were selected. Skipping and timeout must be distinguished; timeout does not count as user confirmation. Custom plugins, authorization, and waiting for a response are outside this candidate.

Record coverage separately for single choice with supplemental text, multiple choice, skip, fallback for old records, timeout, and reopening; single-choice results do not generalize to multiple choice. This requires an authorized isolated real conversation and its request and decision records. Separately verify authorization for conversation creation, model calls and costs, decision submission, clipboard access, and reopening. Do not substitute simulated events, component fixtures, or someone else's historical conversation. Target-package applicability, requirement version, adoption, and a full-window reference screenshot remain to be checked; check restart and cross-platform conditions separately. This candidate is not equivalent to full coverage of `CHAT-HISTORY-01@3`.

<a id="悬浮会话移动和还原chat-float-dock-cand-001产品需求版本待确认"></a>
### Move and Restore a Floating Conversation (`CHAT-FLOAT-DOCK-CAND-001`; product requirement version pending confirmation)

Empty-task floating composer state

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; new-task floating composer in an isolated project. It does not represent an existing real conversation or the results of dragging, minimizing, or restoring. See [Build Basis](./build.md).

Historical user confirmation says only the six-dot icon can drag the conversation; the title, input area, and other buttons do not initiate a drag. On release, it snaps to the top-left, top-right, bottom-left, bottom-right, or bottom-center, and minimizing and restoring preserves the same dock position. For an authorized isolated conversation, record its identity, workspace bounds, and window size; check the position and identity at all five docking locations and before and after minimize/restore. Separately test safe non-handle areas in the title, input area, and other buttons to ensure dragging neither moves the window nor triggers an unintended action. Panel and entry-point dimensions differ; exact pixel coordinates need not match. Normal button clicks are evaluated separately; do not infer persistence across restarts. The real conversation entry point, requirement version, and target-package applicability remain to be checked. Verify different window sizes and macOS and Windows separately, recording layout or tab changes; screenshots alone do not prove dragging. This is a candidate special case and is not included in the adopted smoke-test denominator.

<a id="悬浮会话左右调宽chat-float-resize-cand-001需求版本待确认"></a>
### Resize Floating Conversation Horizontally (`CHAT-FLOAT-RESIZE-CAND-001`; requirement version pending confirmation)

Historical user recordings and incremental requirements confirm that dragging either horizontal edge of the floating conversation changes only its width, with the opposite edge fixed; it does not add resizing by the bottom edge. Use workspace bounds and panel positions and dimensions before and after the drag in the same isolated conversation as independent references. Observe the left and right edges separately; do not count overall movement or docking as resizing. Target-package applicability, requirement version, and complete panel geometry remain to be checked. Verify window sizes, themes, and platforms separately; do not infer persistence across restarts.

Floating composer initial state

Floating state after dragging the left edge

Floating state after dragging the right edge

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; complete-window states of an isolated real conversation's floating composer before and after two edge drags. The images alone cannot prove full panel height, limits, cross-platform behavior, or a formal evaluation pass.

<a id="文件读取恢复chat-file-read-recovery-cand-001需求版本待确认"></a>
### Recover from File-Read Failure (`CHAT-FILE-READ-RECOVERY-CAND-001`; requirement version pending confirmation)

Historical user confirmation says that when a file cannot be read in a real conversation, a confirmation card offers “Retry / Remove this file.” Use the same real failed request and file identity in an authorized isolated conversation, with an independent read-state reference, to inspect available choices and the actual result after the chosen decision separately. A retry acknowledgment does not prove the file was read; if it still fails, do not present it as success. Removing the reference does not mean the source file was deleted. Freeze specific failure-recovery behavior and follow-up handling separately against a real request and confirmed scope.

<a id="文件夹写权限恢复chat-file-write-recovery-cand-001需求版本待确认"></a>
### Recover from Missing Folder Write Permission (`CHAT-FILE-WRITE-RECOVERY-CAND-001`; requirement version pending confirmation)

Historical user confirmation says that when folder write permission is missing, a recovery interaction offers “Authorize / Cancel.” Use the same write request and target directory in an authorized isolated conversation, with independent file states before and after. Opening system settings does not mean permission was granted or a write completed; independently check the actual directory state after cancellation. A recovery decision does not approve expanding file-access scope. Separately verify system authorization, retry, and successful save against the actual final state; a card or decision acknowledgment is not a substitute.

Each of the two candidates above requires disposable isolated files or directories, a corresponding request triggered naturally, and independent file state. Separately verify authorization for runtime preparation, model/tools, permission settings, decisions, and writes. Target-package applicability, product requirement version, adoption, and a full-window screenshot remain to be checked. Do not extrapolate to file-access approval, other permissions, or Windows.

This section covers only the recovery action and final state. The later-confirmed custom-card appearance and its distinction from the old edge-attached notice still need target-version verification; this behavior candidate neither claims to cover nor requires restoration of the old shell.

<a id="普通工具权限请求chat-tool-auth-cand-001需求版本待确认"></a>
### Ordinary Tool-Permission Request (`CHAT-TOOL-AUTH-CAND-001`; requirement version pending confirmation)

Historical user screenshots confirm that a pending tool-permission request during conversation execution reuses the confirmation card. For a real request arising naturally in an authorized isolated conversation, use the same request identity, offered choices, and scope to check the card and available actions. Whether choices such as “Allow once” are offered depends on that request; do not fabricate permissions to fill out a set of choices. If this round separately authorizes a decision, independently verify the decision record for the same request and the subsequent real tool state; a card, click, or acknowledgment alone does not prove tool execution. Freeze rejection, approval, and failure branches separately based on the actual request and permissions.

Model requests, tool execution, network access, writes, and authorization decisions each require separate confirmation; do not trigger an unauthorized tool to gather evidence. Full-text literature authorization and browser-access requests follow their own criteria and are not replaced by a general tool card. Target-package applicability, requirement version, adoption, and a real full-window screenshot remain to be checked; exceptions and cross-platform behavior are separate topics.

<a id="文献全文授权确认及历史回执chat-auth-cand-001需求版本待确认"></a>
### Full-Text Literature Authorization and Historical Receipt (`CHAT-AUTH-CAND-001`; requirement version pending confirmation)

Historical user confirmation says a pending full-text authorization card with checkboxes collapses the literature scope by default; expanding or collapsing it does not change the selected scope, original request, or authorization result. The corresponding historical status row is collapsed by default; when expanded, it shows the full scope and recorded selections from the original confirmation card. Confirmation, rejection, and scope selection are all read-only. Automatic approval or an unknown source must not appear as user-granted authorization. Use the real request identity and scope in the same authorized isolated conversation and an independent decision record as references. The presence or expansion of a card, or clicking confirmation, does not substitute for the authorization result and does not imply successful full-text download, reading, or library import.

Historical records describe different scopes for reauthorization after rejection and timeout. Their applicable objects and subsequent changes remain unconfirmed; this candidate does not prescribe uniform behavior for the two. The real request, target-package applicability, requirement version, adoption status, and full-window screenshot all remain to be checked. Model execution, scope selection, and authorization decisions each require explicit permission. Generic file approval and file recovery are separate topics and are not replaced by this literature authorization card. See [Build Basis](./build.md) for sources and differences.

<a id="文献检索结果的授权范围投影chat-result-cand-001需求版本待确认"></a>
### Authorization-Scope Projection in Literature Search Results (`CHAT-RESULT-CAND-001`; requirement version pending confirmation)

Historical confirmation of the search-result column set: before authorization, or after rejection or an unknown result, show literature and recommendation reasons without an abstract column; after authorization is confirmed, add the abstract column. Partial authorization shows only existing abstracts for selected papers; unselected papers remain in the results without abstracts. Switching column sets does not search again or generate abstracts. Use the same authorized real conversation and search-result snapshot, independent authorization decision, and selected scope to check paper identities and correspondence with existing abstracts. Judge the authorization card, literature-library list, and result columns separately; authorization does not prove that full text was downloaded, read, or imported.

Real results and partial authorization require an isolated conversation, distinguishable papers and result snapshot, and a separate record of the decision from the same run. Separately verify permissions for model use, network access, and authorization actions. An existing authorized real conversation may be observed; simulated cards or prefilled results are not substitutes. Target-version applicability, adoption, requirement version, and a real full-window screenshot remain to be checked. Do not extrapolate to independent search-box results, exception recovery, or cross-platform behavior.

<a id="检索结果已加入行的选择边界chat-join-state-cand-001需求版本待确认"></a>
### Selection Boundaries for Already-Added Search Results (`CHAT-JOIN-STATE-CAND-001`; requirement version pending confirmation)

Historical confirmation requires checkboxes for papers already added from search results to be disabled and excluded from the header select-all and selected count; papers not yet added remain selectable. Use the same authorized real search results and an independent literature-library directory to check identities for added and not-added papers, checkbox availability, the select-all set, and count. Authorization state is not library-import state; do not infer one from the other. This candidate checks display and selection only. Batch import and export are separate write or file-operation topics; visible buttons or selection results do not prove success.

The same isolated results must include at least one distinguishable paper already in the library and one not yet added, with an independent directory for the same scope. Separately verify permissions for real search, import, network access, and writes; a person must confirm import. Synthetic bibliography entries are raw inputs and do not prepopulate search results or library state. Target-package applicability, requirement version, adoption, and a real full-window screenshot remain to be checked; do not substitute simulated data or historical screenshots.

<a id="科研结果加入文献库chat-result-import-cand-001需求版本待确认"></a>
### Add Research Results to the Literature Library (`CHAT-RESULT-IMPORT-CAND-001`; requirement version pending confirmation)

Historical user confirmation says research results offer adding to the literature library, adding metadata only, and exporting Bib. In exact-search cards, batch import offers “metadata and full text” only when a selected paper already has downloaded full text, reusing those downloaded bytes as the primary attachment without downloading again. Do not offer that option unless both conditions hold: the card is an exact-search card and a selected paper has downloaded full text. Use the same-run real results, selected paper identities, and independent library directories, metadata, and attachment identities before and after import as references. To verify reuse, also link the downloaded original and imported primary attachment for the same paper and compare bytes or digests. Check metadata-only and full-text final states separately; a success notice or selection state does not substitute for actual import. Each condition with and without downloaded full text among selected papers needs its own real reference; otherwise leave that subpoint uncovered.

Target-package applicability, requirement version, real results, and a full-window screenshot remain to be checked. Separately verify permissions for real search, network access, human-confirmed import, library writes, and export. An actual Bib export file is a separate final state; check its target and content. Adding a result to the literature library or attaching a file is not delivery into the project materials directory. Failure, duplicate import, and cross-platform behavior are separate topics. Do not substitute synthetic bibliography entries, prefilled results, or simulated events.

Requirement version, target-artifact applicability, adoption status, a real full-window screenshot of completion, and corresponding independent references all remain to be checked. Actual model calls, material reads, artifact writes, and cross-platform conditions require separate authorization. Follow-up questions, stopping, failure recovery, other permission requests, attachment questions, importing artifacts into the library, and restart recovery are not covered by default by the candidates above; freeze them separately for their own objects and real final states. Keep any branch with insufficient or unverified conditions as a gap; do not retroactively claim a pass from simulated events, prefilled results, or empty-state screenshots.
