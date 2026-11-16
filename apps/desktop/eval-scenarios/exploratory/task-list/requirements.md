<a id="项目任务列表候选需求"></a>
# Candidate Requirements for the Project Task List

<a id="用途与入口"></a>
## Purpose and Entry Point

The task list in a project workspace is used to inspect tasks in the current project and distinguish pinned tasks. The design map is the historical source for the entry point; applicability of the requirements to the target version remains unverified. This page is a candidate specification, not a result from this run or a frozen evaluation standard.

Project task empty state and new-task input

Reference image from the natural empty state of an isolated project in the macOS installed build `0.3.2 / 202611121823 / preview`; the right pane shows a synthetic document. It does not verify a non-empty task list, pinned group, or task actions. See the [Build Basis](./build.md) for source and limitations.

Isolated project with non-empty tasks and session readback state

Reference: isolated project in the same build, 2026-11-13. Shows one real task in the list and its state after reopening; does not prove pinning, ordering, or other task actions.

Isolated project with multiple tasks

Reference: isolated instance of macOS installed build `0.3.2`, 2026-11-13. Shows multiple real synthetic tasks and one reply. The screenshot does not prove the complete catalog or ordering rules. See the [Build Basis](./build.md) for build and identity-association boundaries.

<a id="正常展示候选"></a>
## Candidate Normal Display

**Task scope and list (`TASK-LIST-CAND-001`; requirement version pending confirmation):** In the verified current project, the task area shows visible tasks for that project or an empty state consistent with the real catalog. Task names and selection match the isolated task catalog readable in this run. Verify the target-version entry point and state semantics; do not substitute another project or prepopulated results.

**Pinned group (`TASK-LIST-CAND-002`; requirement version pending confirmation):** Confirmed historical requirements call for the project list to distinguish pinned from unpinned tasks. When pinned tasks exist, show a separate pinned group; row identities and pinned state match the independent catalog. See the [Build Basis](./build.md) for historical requirements and target-version boundaries.

**Archived project tasks and restore (`TASK-LIST-CAND-003`; requirement version pending confirmation):** Historical user confirmation says the Archived section in the current project's sidebar is collapsed by default and its count matches the real archived catalog. When expanded, it shows archived tasks belonging to that project. Opening history is read-only; input and submission are unavailable. For an authorized isolated task restored from the archive, use the same task identity to verify before/after changes in archived and ordinary catalogs and the end of read-only state. A missing list row or success notice alone is not an independent catalog readback. Target-build applicability and a complete real window screenshot remain unverified. This does not cover deletion, stopping an active task, or model sending after restore.

**Delete an archived task (`TASK-LIST-CAND-007`; requirement version pending confirmation):** Historical user confirmation says an archived task in the project sidebar can be deleted directly using the existing confirmation flow. For an authorized disposable isolated archived task, observe cancellation and confirmation separately and compare before/after archived and ordinary task catalogs for the same project and task. Cancellation must not delete; after confirmation verify the actual deletion end state. A missing row or notice alone is insufficient. The original-data impact scope, failure semantics, target-version applicability, and complete real window screenshot remain unverified. Separately authorize irreversible deletion and associated writes; do not substitute deleting or restoring a running task.

**Rename a task (`TASK-LIST-CAND-008`; requirement version pending confirmation):** Historical user screenshots confirm a rename entry point in task actions. An older exploration asset proposed saving a new title and retaining it when reopening the same conversation, but complete persistence semantics have not been approved. Candidate validation requires an authorized real isolated task. First record the project, session ID, old title, and a non-empty synthetic new title; perform the operation through the real entry point, then verify identity and title using an independent catalog readback for the same ID and reopening result. Closing the menu or changing list text alone does not prove persistence. Cancellation, empty value, excessive length, restart, and concurrency are separate scenarios pending confirmation. Write authorization, target-build applicability, and a complete window screenshot remain unverified.

**Pin and unpin (`TASK-LIST-CAND-004`; requirement version pending confirmation):** Pin and unpin a real task in an authorized isolated project. Use before/after independent catalog state for the same project/task identity to check the pinned flag, confirm the task enters the pinned group, and confirm it returns to the ordinary group after unpinning. Menu feedback or group appearance alone does not prove a write. Ordering within the ordinary group should match an actual activity-order reference for the same scope. Target-build applicability and complete non-empty/pinned-state window screenshots remain unverified; persistence across restart, state combinations, failures, and cross-platform behavior are separate scenarios.

**Confirm archive of a running task (`TASK-LIST-CAND-005`; requirement version pending confirmation):** Historical user requirements say confirming archive of a running task automatically stops it; a separate interrupt should not be required first. For a real running task in an authorized isolated project, after confirming archive, verify with independent running state and archived catalog for the same task identity that it has stopped and been archived. Closing the confirmation dialog, disappearance from the ordinary list, or a success notice alone does not prove it stopped. Target-build applicability and a complete real window screenshot remain unverified. Deletion, failure recovery, queue details, and cross-platform behavior are separate scenarios and are not implied by this candidate.

**Confirm deletion of a running task (`TASK-LIST-CAND-006`; requirement version pending confirmation):** Historical user requirements say the irreversible confirmation before deleting a running task must explain retention of original materials, and confirmation automatically stops the task; a separate interrupt should not be required. For an explicitly authorized disposable isolated task, check task state after cancellation separately from the independent stopped state and catalog deletion result for the same task after confirmation. A missing list row, closed confirmation dialog, or receipt alone does not prove stop or deletion. The specific scope covered by the original-materials explanation remains to be confirmed. For predesignated isolated synthetic materials, before/after identities and digests may be recorded separately; do not generalize this to retention rules for all objects. Target-build applicability and complete real window screenshot remain unverified; failure protection, queue details, and cross-platform behavior are separate scenarios.

These candidates can be frozen only after confirming the target requirement version and target-build applicability. Source code or a single observation does not itself approve failure cases or ambiguity. Normal display does not require pre-executing pin, creation, or search actions; pinning, archive, and restore require separate authorization for writes.

Historical `CHAT-HISTORY-01` covers reopening a completed conversation and reading its messages and terminal state; the task list may be a candidate entry point, but list display does not equal history readback. The new conversation identity established by `CHAT-NEW-01` is also not equivalent to an empty list or pinned group. See the [Build Basis](./build.md) for historical stable-ID and scope mapping; candidate IDs do not replace historical IDs.

<a id="数据与参照"></a>
## Data and References

Use an authorized isolated project and real task catalog. Checking non-empty and pinned groups requires distinguishable real tasks and pinned state, plus authorization to prepare and read them. Keep preparation evidence separate from the tested action; do not substitute a prepopulated database or fabricated conversation result for a real task. If there are no tasks, observe only the current empty state; do not claim that the non-empty list or pinned group passed.

Catalog identity, project scope, selected task, and pinned state need an independent reference from the same instance at an appropriate time. The candidate display end state is the current project list matching its catalog; empty state applies only when the catalog has no visible tasks. Retain a gap if the independent reference or version basis is missing. Reading the catalog may synchronize authorized roots; first check the isolated scope and side effects.

<a id="专项与待确认"></a>
## Focused Scenarios and Pending Confirmation

Pin/unpin, drag reordering, rename, archive/restore writes, deletion, pagination cursors, switching projects, failure recovery, and persistence after restart each require separate requirement, data, and operation authorization; a display match does not imply they passed. Pinning requires at least two distinguishable real isolated tasks and before/after references to the same project catalog. `examples` may provide original project materials but does not prepopulate tasks. Archive candidates require distinguishable real isolated tasks and authorized before/after archive state. Archiving a running task also needs independently verifiable real running and stopped states; separately authorize model/tools, stopping, and archive writes. Deletion is irreversible: first verify a disposable isolated task, exact impact scope, and deletion authorization. If a running task is involved, separately authorize real execution and stopping; cancellation does not authorize confirmed deletion. Use independent catalog state for the same project/task identity and historical original messages as references. Do not write directly to a database or fabricate a conversation. The task-search entry point/results, collapsed subtasks, current-package entry point, and semantics for different task states still require confirmation; this page does not assume a complete feature matrix.
