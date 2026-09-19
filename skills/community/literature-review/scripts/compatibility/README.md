# Historical helpers — maintainer reference only

New work uses native chapter text -> complete v1 -> one delta -> editable v2.
Main uses workflow publish for current-source checks, compilation and page images.

Legacy section-writing, quality-audit and v3 modules remain only for explicit
historical callers and reusable parsing/template helpers. They are not recovery
paths for native documents. In particular, manuscript accept/read-cards/recompile,
asset sealing and the publication cache have been retired. Their previous
implementations and old-interface tests are recoverable from Git.

Do not alias historical intermediate v2 to the new final v2 or bulk-rename review
workspaces. Import a known final old source with dependencies into a separate
publication workspace. Normal CLI discovery excludes historical stage chains.
