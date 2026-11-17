# Legacy Native Plans

**English** · [简体中文](legacy.zh.md)

Read only when the declared native get/write tool requires a request wrapper.

Existing native threads may retain the older declared get/write tool with a required request field. For that actual declared schema, keep the original wrapper: get has request={}, and write has the complete PlanWrite request with operation and item statuses. Use the returned current state/transitions and request_schema for corrections. Record in_progress before real work and complete afterward; never fabricate missing starts. For reconciliation, discover the current scholarseed_bridge plan/action contract and use its reconcile action rather than adding unsupported arguments to the older tool. Do not mix this older presentation with the new flat actions or invent an alias to change it.

Keep stable IDs, scope and parent links. Rejected writes do not advance revisions;
use returned state and transitions. Finish only after verifying real work, and
report open, blocked or failed stages before ending the turn. The host owns timing;
never infer durations, use empty groups or claim completion from file existence.
If reconciliation needs Bridge, read [fallback](fallback.md) before that call.
