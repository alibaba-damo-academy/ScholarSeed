## Main plans and subplans

**English** · [简体中文](plans.zh.md)

Use a product plan only when the user explicitly requests a persistent task tree,
an existing product tree needs continuation, or a workflow requires persistent
stage tracking (for example the literature-review execution workflow). Ordinary
research, multiple steps, long tools, retrieval and artifact publication do not
require it. A written proposal or native lightweight plan does not enable it.

When no product plan is enabled, read the bundled `plan/enable` contract and call
`scholarseed_bridge` with capability `plan`, operation `enable`, and request
`{purpose:"user_requested"|"workflow_required", reason:"actual need"}`. This does
not authorize execution, create stages, or start timing. It returns current state.
Use the [Bridge path](plans/fallback.md) for the rest of this turn; do not pass
product arguments to a Codex native `update_plan` accepting `plan`/`explanation`.
The host selects the dedicated product tool at the next turn boundary. Existing
product trees remain enabled without another enable call; `release` opts out
without deleting history. Merely loading this guide does not enable anything.

Keep stable IDs and parent_id links; maintain real stages, not a leaf per tool
call or a retrospective checklist. Plans do not replace the research workflow.

Check the actual declared schema first. For an older tool requiring a request
wrapper, read [legacy plans](plans/legacy.md) instead of applying the flat forms.
If the product tool is absent, read [Bridge fallback](plans/fallback.md). Do not
preload either branch for the current flat tool; never switch an existing tree
into a different native plan system.

The following forms apply when the declared tool schema is flat. Call `operation=get` alone first. The result contains the plan, expected_revision, turn_id and allowed `actions` for each ID. No request wrapper, operation=write, or operation=progress. Every mutation supplies plan_id, expected_revision and request_id. The host binds the authenticated callback turn; omit the optional model turn_id instead of guessing. Reuse the returned identity and expected_revision, with a fresh request_id for changed arguments; an uncertain identical retry keeps its original arguments and request_id.

**Structure:** use create/update/revise/release with a complete flat items snapshot, including unchanged items. Each item has id, content, optional parent_id and kind (group or step). Never send status, title, nested children, or kind=item. Structure edits preserve existing execution states; new items are pending. Create needs a new plan_id and the returned revision (0 only when plan metadata is absent); other operations keep the existing plan_id. Update preserves root IDs, content/order and existing parent links. Revise requires a real scope/structure change and reason; it cannot erase execution history. Release explicitly opts out and preserves the tree, not ordinary completion.

**Execution:** use start/complete/pause/block/fail/partial with step_ids:[id,...], not items or status fields. Choose from the returned actions. Start each executable leaf BEFORE performing its work or opening its checkpoint. Start all affected leaves before a combined command. After verifying actual completion, prefer complete with a nonempty reason citing the observed result. It atomically completes started and unstarted leaves together; unstarted leaves gain no invented start or execution time. Strict finish remains available only for already-started work. Pause while waiting for the user; start again before handling the result. Parallel leaves may run together. Declare containers kind=group before execution if children will be refined later; an already-started leaf cannot become a container or be deleted.

After a rejection, use the returned current state or reread it and correct the cause. A rejected mutation does not advance revision; never guess the next revision. If the work has not happened, start then execute it. If it already completed without a recorded start, verify its actual result and use complete with step_ids and a reason stating the observed completion evidence. Reconcile remains available for only unstarted leaves. Neither operation invents a start or execution time. Include nonempty groups only when all descendants are already completed or complete in the same call; selecting a parent never completes its unselected children. Complete is not independent acceptance of the task result. A file merely existing does not establish that a step's requirements were met. Do not issue a bookkeeping start/finish to fabricate history. Block only for an actual obstacle, not missing timing. A separate verification leaf is appropriate only when actually performing authorized verification. Do not blindly repeat non-idempotent work.

Keep IDs when renaming. A group is a container, not executable work; do not turn it into a step. Refine and start its concrete leaves before working.

**Estimates:** after resolving the execution agreement, include estimate:{lower_seconds,upper_seconds} on create/revise when the agreed plan has a processing-time range. Never infer it from skill selection or a processing budget. It covers the whole plan, including work already performed on revise, and excludes user waits; it becomes visible only after start. Omit on update to preserve it; null clears it. Create/revise without an estimate clears the range. An estimate is not measured execution time.

The host records timestamps. Never supply invented durations or infer progress from elapsed time. Only independently observed in_progress intervals provide measured leaf execution time; missing timing remains blank, not zero or a retrospective estimate. Parent and parallel intervals can overlap; do not sum them to invent total elapsed time. An empty group cannot complete, and a completed parent has only completed children.

Before a turn ends, reconcile completed work using execution actions, or report partial/blocked/failed stages with their observed reason. Do not declare the final task complete while roots remain pending/in_progress. A genuine mid-work stop names the open stage. On continuation use get before continued work; the native tool binds the current callback turn, so do not replay a historical turn_id. The closing action belongs to the turn that obtains completion evidence.
