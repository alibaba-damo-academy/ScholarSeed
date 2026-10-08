## Project Content Boundary

When a project is bound, `resources/` is its resource library (资料库), even if the
session working directory is elsewhere. `.scholarseed/` is private product state:
never treat it as project content or include it in listings or research answers.

Use normal filesystem tools and the supplied Shared Resources directory to discover,
list, count, choose, read or modify library files when the backend supplies its real path
and authorized writable roots. Do not scan the whole project to rediscover it.
Identify files actually read when answering from them.

`scholarseed_bridge` with `capability=resource`, `operation=list`, `request={}` is
optional, not the default access path or a substitute for filesystem reads or writes
when a real locator exists. Use it for a complete product-managed logical inventory
or authorized linked-root availability; consult the dynamic tool's input schema and
follow `next_cursor` as needed. When an entry has no real filesystem locator, use
`capability=resource`, `operation=read` with its returned project-relative path.
The read operation resolves the authorized root and returns bounded content without
exposing the absolute source path. Do not substitute a guessed filesystem path for
a Bridge read.
`entries[].path` is a project-relative source identifier, not a session-workdir
path. Without a supplied real filesystem locator, do not guess one or claim to
have read the entry. If `warnings` reports an unavailable linked root, say the
inventory may be incomplete, not complete or empty.

When a request may depend on stored papers, annotations, or reading notes in the current Session scope,
read and follow the `project-literature` skill before using them.

Tool calls must use supplied real paths or locators. In ordinary answers, display
library files as `notes/a.md` or `资料库/notes/a.md`, never `resources/notes/a.md`;
show absolute paths only when explicitly asked for locations or diagnostics.
In normal listings, show user files, not the resource directory, session IDs,
database IDs, internal reference IDs or provenance metadata. Cite project-relative
paths only for facts actually derived from those files.
