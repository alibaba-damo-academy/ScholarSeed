## Agent File Artifacts

**English** · [简体中文](artifacts.zh.md)

### File-only execution

An explicit file transfer or processing request is not permission to search or import.
Use the supplied sources and requested destination directly. Do not enumerate unrelated
capabilities or describe unused operations. Do not load evidence/search/library skills
just to transfer bytes or verify file format; load them only if the requested outcome
needs source discovery, content interpretation or library operations. Preserve all
current-turn search, network and write restrictions; a direct link never bypasses them.

Use the typed `publish_artifacts` tool for delivery; no preliminary contract read or
describe call is needed. If this tool is unavailable in an older host, use the bundled
[artifact contract](../contracts/artifact.jsonl) for `artifact/publish` and the
[Bridge fallback](../README.md) only if the contract is missing or stale.
The legacy `scholarseed_bridge` entry uses `capability=artifact`, `operation=publish`,
and `request={"path":"relative/path","role":"final"}` for one file.
Never invoke the Bridge through shell or inspect its credentials. After the requested
operation and necessary verification, publish the deliverables, inspect each successful
publication receipt and finish. A failed stage is not permission to repeat successful
stages or expand the task.

### File delivery

Finish each independent user-facing deliverable in the actual session output
directory, then declare them together with
`publish_artifacts({"files":[{"path":"relative/a.md","role":"final"},{"path":"relative/analysis.py","role":"final"}]})`.
Declare only intended deliverables; never scan and publish the whole output directory.
The response has `completed`, `partial`, or `failed` status and per-item receipts.
Invalid structure rejects the whole request. When required fields are missing, follow
`next_action` and use verified paths in the corrected arguments.
File errors allow partial success. For these errors, correct and submit only `retry_files`.
Repeated submissions in the same turn reuse the existing publication, while changed
bytes produce a new revision. A later turn retains the existing turn-specific publication semantics.
Use `final` for the main result and `supporting` for additional result deliverables.
Use `intermediate` for a stage result explicitly delivered for the user to review
or use independently, such as a proposal draft or a stage analysis report. A file
is not a stage deliverable merely because it was generated during execution.
Declare it in `files` as `{"path":"relative/path","role":"intermediate"}`.
Stage deliverables belong in artifact lists and the task overview, not conversation
file cards. Result deliverables appear in both the lists and conversation cards.
The product tracks other new and changed files as working files; only published
deliverables get conversation file cards. Never publish temporary, cache,
runtime-state, source-input or incidental source-edit files, or automatically
import outputs into a library. A successful command registers an immutable file
revision; never claim publication after a failed command.
Before publishing a directory, also read [directory snapshots](directories.md).
Internal processing scripts, tool JSON parameters/responses, conversion data and
logs remain working files, not deliverables. User-requested code and datasets can
be deliverables regardless of extension. Reading an original input does not make
it a new deliverable; do not publish it just because it was read or copied.

Link a reported, existing session file by its actual working-directory-relative
path, including the output directory prefix, not just the filename (encode spaces in Markdown links).
Never link an unwritten file, use `file://` or an absolute path. The publication
receipt is authoritative for a delivered file; intermediate deliveries
intentionally have no conversation file card.

Only for explicit library import, read [imports](imports.md); publication alone
does not authorize import. Do not preload that guide for ordinary delivery.

## Session output location

SESSION_DIR means the actual output directory already selected for this conversation.
The host-supplied output_dir already exists; use it directly without directory setup or collision checks.
Use the host-supplied location or, for a new project conversation, follow the host's
session-directory instructions once and reuse that exact path. Do not change cwd,
derive a second directory from a title/ID, or assume an output prefix. Honor explicit
destinations within the authorized scope. Resolve bridge paths against the actual cwd.

Place new deliverables in SESSION_DIR, their referenced assets alongside them, and
non-deliverable task files under SESSION_DIR/work/. Create directories only as needed.
Keep meaningful result names. Use work/tmp/ only for disposable task-owned data;
keep atomic sibling staging, cleanup semantics and required private run state intact.
Resume the exact previously bound run or output path, including legacy layouts.
Do not move, duplicate, clean or adopt another session's files; an existing input,
library, fork reference or matching topic name is not a new output destination.
Do not create or require a project-root `literature/` folder for generated files.
