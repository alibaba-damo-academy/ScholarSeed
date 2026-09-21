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

## 中文说明

相邻的 paper-fulltext-dl wheel 不再内置 Zotero translator 源码或生成后的
adapter，只包含本地转换工具与浏览器运行时。用户如需启用，必须自行获取并审查
translator，许可条款以各上游文件为准。PDF 检查依赖外部 `pypdfium2`，打包时需保留
实际平台 wheel 携带的 pypdfium2、PDFium 及其依赖许可证文件。
