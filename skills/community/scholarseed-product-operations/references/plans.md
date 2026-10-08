## Main plans and subplans

For a multi-stage task, use the existing conversation plan through the `scholarseed_bridge` model tool with `capability=plan`, with explicit stable item IDs and `parent_id` links. This is the host presentation of the task's plan, not a replacement research workflow. Derive the main stages from the actual task or skill; do not hardcode a stage count or promote every tool call and section writer into a main stage.

First call the model tool with `capability=plan`, `operation=get`, `request={}`. It returns the current `turn_id`, `items` and optional `plan` metadata. The tool schema describes the `plan/write` request. A write supplies `operation`, `plan_id`, `expected_revision` (0 when there is no structured plan), a fresh `request_id`, the returned `turn_id`, and the full `items` list. Each item has `id`, `content`, `status`, and optional `parent_id`; no parent means a main stage. Use `create` with a new plan_id for a new task. Use `update` to retain the main stages while changing real statuses or adding/removing detailed child steps. Only an actual change in task scope justifies `revise`, which requires a reason and may change main stages. Retry an uncertain identical write with the same request_id; on revision conflict, reread and merge the actual current state before a new write.

Keep root IDs, titles, and order stable; put execution details under them as children.
Update from observed evidence, preserve failures, and never infer progress from elapsed time.
A completed parent has no unfinished children; after interruption, reread the tree before updating it.

Before ending any turn while a structured plan exists, reconcile the tree against observed evidence: every root stage whose work has completion evidence must be written as `completed`, or as `partial` / `blocked` / `failed` with the observed reason. Never end a turn that delivers the final deliverable or declares the task complete while any root is still `pending` or `in_progress` — write the closing `update` first. A root may remain `pending` or `in_progress` at turn end only when the turn genuinely stops mid-work, and the closing message must name the stage that remains open. If a later turn continues, finishes, or verifies work owned by an earlier turn's plan, call `plan get` and write an update carrying the new `turn_id` before doing that work; the closing update belongs to the turn that obtains the completion evidence, not to the turn that created the plan.

Once a structured plan exists, update it only through this bridge; release it explicitly
before switching to a native flat plan. Plan records are separate from research artifacts.
