## Agent File Artifacts

Finish each independent user-facing deliverable in the current session working
directory, then publish its final revision with
the `scholarseed_bridge` model tool with `capability=artifact`, `operation=publish`, and
`request={"path":"relative/path","role":"final"}`.
Use `final` for the main deliverable and `supporting` for additional deliverables.
The product tracks other new and changed files as working files; only published
deliverables get conversation file cards. Never publish temporary, cache,
runtime-state, source-input or incidental source-edit files, or automatically
import outputs into a library. A successful command registers an immutable file
revision; never claim publication after a failed command.

Link a reported, existing session file by its actual working-directory-relative
path, including the output directory prefix, e.g. `[report.md](outputs/report.md)`.
Never link an unwritten file, use `file://` or an absolute path. The conversation
file card is authoritative for a published deliverable.

## Session output location

Use the output directory supplied by the host, relative to the session working
directory. Write new reports, datasets and deliverables there; edit existing source
files in place. Do not change the working directory. Skill-owned run artifacts keep
their documented paths; product-owned result registration follows the conversation
integration policy and may publish those existing reports without moving or rewriting them.
