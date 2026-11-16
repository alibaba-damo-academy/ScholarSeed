# ScholarSeed Bridge

Use the model tool `scholarseed_bridge`, not a shell executable or direct HTTP.
Call it with `{"capability":"…","operation":"…","request":{…}}`. For a large or
multiline request, use the session-relative `request_file` instead of `request`.
The outer operation selects the endpoint; an inner `request.operation`, when
present, selects the mutation.

Open just the required operation in [contracts/](contracts/): files are named
`<capability>.jsonl`, with one complete contract per line. Use its request schema,
guidance and prerequisites. A reference bundled with the running release is
sufficient; do not make a preliminary help call. If the operation is absent,
the installed skill and product may be from different releases, or the host
reports a stale contract, use `contract/describe` for that operation only:

```json
{"capability":"contract","operation":"describe","request":{"target_capability":"artifact","target_operation":"publish"}}
```

Use actual identifiers and inspect the returned result. A schema or discovery
result grants no permission, bypasses no user confirmation, and is not a receipt.
Do not read credentials, private state, local settings files or databases to
replace product operations. If the tool is unavailable or the operation fails,
report the concrete gap instead of claiming it worked.

| Task | Read only this workflow |
| --- | --- |
| Project resources and stored papers | [Project resources](guides/resources.md) |
| PDF evidence or external retrieval | [Evidence and retrieval](guides/retrieval.md) |
| Earlier or attached conversations | [Conversation history](guides/history.md) |
| File delivery or explicit library import | [File artifacts](guides/artifacts.md) |
| Multi-stage plans or an existing product plan | [Conversation plans](guides/plans.md) |
| Inspect or change MCP servers | [MCP configuration](guides/mcp.md) |

For material-dependent answers, start with the materials the user named, then
relevant session files and the current project's authorized resources or literature.
Read only material relevant to the question. If internal evidence is insufficient,
explain the gap before using permitted external retrieval. Metadata or abstracts
are not full-text evidence. For links to sources actually used, follow
[ScholarSeed Frontend](../scholarseed-frontend/README.md).
