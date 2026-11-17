# ScholarSeed Bridge

**English** · [简体中文](README.zh.md)

Read before a Bridge call, not for local execution or the native plan tool.
Use the model tool `scholarseed_bridge`, not a shell executable or direct HTTP.
Call it with `{"capability":"…","operation":"…","request":{…}}`. For a large or
multiline request, use the session-relative `request_file` instead of `request`.
The outer operation selects the endpoint; an inner `request.operation`, when
present, selects the mutation.

Read from [contracts/](contracts/) only the complete JSON record whose top-level
`capability` and `operation` match the intended call. Each `<capability>.jsonl`
line is one operation. Do not read the whole capability file or match a nested
mutation's operation instead. Use a JSON-aware selector when available, or locate
the matching record and read that entire line in bounded chunks if necessary;
do not truncate its schema, guidance or prerequisites. Do not install a tool just
to select a contract. Selection is a local read, not a Bridge invocation.

Use the record's request/response schemas, guidance and prerequisites. A reference
bundled with the running release is sufficient; do not make a preliminary help call.
Only if the operation is absent, the releases may differ, or the host reports a
stale contract, use `contract/describe` for that operation:

```json
{"capability":"contract","operation":"describe","request":{"target_capability":"artifact","target_operation":"publish"}}
```

Use actual identifiers and inspect results. A schema or discovery result grants
no permission, bypasses no confirmation and is not a receipt. Never read credentials,
private state, settings files or databases to replace product operations. Report
unavailable tools, failed operations or incomplete contract reads; do not guess,
bypass the failure or claim success.
