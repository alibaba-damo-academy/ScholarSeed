# Directory Snapshots

**English** · [简体中文](directories.zh.md)

Read with the [artifact guide](artifacts.md) only when publishing a directory.
Its authorization, output-location, deliverable-role and receipt rules still apply.

The same publish operation accepts a directory path and freezes its complete
member tree, including empty directories, into an immutable directory revision.
Finish all members before publishing; do not use symlinks or junctions. Inspect
the actual receipt rather than representing a directory as an ordinary file or
ZIP. The directory card opens the published read-only member snapshot, not the
current source directory. Subsequent source edits or deletion do not change an
existing snapshot; publish again to deliver a new revision. Directory snapshots
currently do not support the file-only save-copy or library-import operations.
