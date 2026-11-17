# Third-party notices for paper-fulltext-dl

## PDF inspection

The adjacent `paper_fulltext_dl-0.1.3-py3-none-any.whl` uses `pypdfium2` as an
external dependency for PDF page counting, text extraction and rendering.
`pypdfium2` is available under Apache-2.0 or BSD-3-Clause; its PDFium runtime and
bundled dependencies retain their own license terms. Product packaging must keep
the license files from the actual `pypdfium2` wheel selected for each platform.

## Optional Zotero translators

The paper-fulltext-dl wheel does not distribute Zotero translator source files or
generated adapters. It includes only the converter and browser runtime. Users may
separately obtain trusted translator files, convert them locally and explicitly
configure their adapter directory. Those files retain their upstream copyright
and license terms; local conversion does not relicense them.

The AGPL-3.0 text is retained as a reference alongside the wheel at
[AGPL-3.0.txt](AGPL-3.0.txt) and inside it at
`paper_dl/translators/LICENSES/AGPL-3.0.txt`. Not every optional translator uses
that license, so the individual upstream file remains authoritative.

This notice does not assign a license to paper-fulltext-dl, the skill or the
integrating platform. The package-wide license and public source URL have not yet
been supplied and remain null in [provenance.json](provenance.json).
