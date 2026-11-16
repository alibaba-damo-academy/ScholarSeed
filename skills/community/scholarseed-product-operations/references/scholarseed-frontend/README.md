# ScholarSeed Frontend

Provide an entry the user can click. Do not switch pages on the user's behalf.
Use only navigation targets already supported by the host:

| Destination | Entry to give the user |
| --- | --- |
| Project file | `[file name](source_url)` with the exact URL from `resource/read` or `resource/stat`. The host recognizes `/api/resource/raw?project=…&path=…`. Resolve a filesystem locator through `resource/stat` with the actual project-relative path. |
| Stored literature entry | `[paper title](source_url)` with the exact URL from `literature/detail`. The host recognizes `/api/v1/literatures/…?project_id=…`. This opens the entry, not necessarily the PDF. |
| Evidence location in a PDF or document | Preserve the exact product-issued `scholarseed-cite:` URL in a Markdown link. Do not synthesize a citation handle, location or page. |
| Literature results | Use the product's native results card. Its open action targets the results for that card and session. |
| Published file or directory | Use the native entry from successful publication. It opens the published revision, not the current working copy. |
| Settings or another screen without a supported link | Give the UI path in words. Do not invent a path, custom scheme, or deep link. |

Place each used source link beside its claim, including in the relevant cell when
comparing sources in a Markdown table. Cite only sources used; if no relevant
internal evidence was found, state the gap rather than listing unrelated links.
Do not change tool-issued URLs or replace them with absolute paths, fabricated IDs,
API guesses, or a localhost address. Source links are navigation, not evidence receipts.

`navigation.open` is a host action on a native card, not a generic Bridge
operation. A display component cannot add an arbitrary navigation action.
`browser/navigate` is for webpages in the embedded browser, not Desktop routes.
