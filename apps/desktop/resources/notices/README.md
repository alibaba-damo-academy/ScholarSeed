# Third-party notices and corresponding source

**English** · [简体中文](README_zh.md)

This directory accompanies the source distribution and Desktop installers. It
covers certifi, tqdm, lightningcss, Pillow, pypdf and pycparser, as well as the
Office components described below. Third-party components retain their own
licenses; ScholarSeed's Apache-2.0 license does not replace them. The notices
also cover lightningcss even though it is a build dependency. This directory is
not a complete product SBOM and does not establish license clearance for
unlisted components.

Office image compatibility uses emf-converter 4.20.3 (Apache-2.0), UTIF 3.1.0
(MIT) and pako 1.0.11 (MIT / Zlib). The [bundled emf-converter third-party
notices](emf-converter/THIRD_PARTY_NOTICES.txt) are distributed as published.
They include copyright, license and related notices for its inlined image
decoders and dependencies; the main package's Apache-2.0 license does not
replace those terms. [manifest.json](manifest.json) records the pinned source
archives, artifact digests and notice digests.

## Components and source

| Component | License | Use | Notice | Source |
| --- | --- | --- | --- | --- |
| certifi 2026.10.19 | MPL-2.0 | Runtime dependency | [Original notice](certifi.txt) | [Pinned source archive](https://files.pythonhosted.org/packages/a6/bd/1436c50cc46699de0230fbaacc1d1de7bfec413176099949e9d5112e88f2/certifi-2026.10.19.tar.gz) |
| tqdm 4.68.4 | MPL-2.0 AND MIT | Runtime dependency | [Original notice](tqdm.txt) | [Pinned source archive](https://files.pythonhosted.org/packages/ae/5f/57ff8b434839e70dab45601284ea413e947a63799891b7553e5960a793a8/tqdm-4.68.4.tar.gz) |
| pypdf 6.15.0 | BSD-3-Clause | Runtime dependency | [Original notice](pypdf.txt) | [Pinned source archive](https://files.pythonhosted.org/packages/17/17/ee75a92718ec7212de831e71454d702225aa5e474a805cce169806044453/pypdf-6.15.0.tar.gz) |
| pycparser 3.0 | BSD-3-Clause | Runtime dependency | [Original notice](pycparser.txt) | [Pinned source archive](https://files.pythonhosted.org/packages/1b/7d/92392ff7815c21062bea51aa7b87d45576f649f16458d78b7cf94b9ab2e6/pycparser-3.0.tar.gz) |
| pillow 12.3.0 | MIT-CMU | Runtime dependency | [Original notice](pillow-darwin-arm64.txt) | [Pinned source archive](https://files.pythonhosted.org/packages/1c/3d/bb7fca845737cf9d7dbde16ed1843984665ff2e0a518f5db43e77ec540b9/pillow-12.3.0.tar.gz) |
| lightningcss 1.32.0 | MPL-2.0 | Build dependency | [Original notice](lightningcss.txt) | [Pinned source archive](https://codeload.github.com/parcel-bundler/lightningcss/tar.gz/7f8a861bdee476fe90c89a8badeb3fd33a99c51a) |
| docx-preview 0.4.1 | Apache-2.0 | DOCX preview | [Original notice](docx-preview.txt) | [Pinned source archive](https://codeload.github.com/VolodymyrBaydalka/docxjs/tar.gz/c533f383069008d4a1e05c6171ef8777fd078385) |
| ExcelJS 4.4.0 | MIT | XLSX preview | [Original notice](exceljs.txt) | [Pinned source archive](https://codeload.github.com/exceljs/exceljs/tar.gz/ac96f9a61e9799c7776bd940f05c4a51d7200209) |
| @aiden0z/pptx-renderer 1.3.0 | Apache-2.0 | PPTX preview | [Original notice](pptx-renderer.txt) | [Pinned source archive](https://codeload.github.com/aiden0z/pptx-renderer/tar.gz/0cf5c194b4db2cf9f2531b6a7e24a61338caabf1) |

The published PPTX renderer bundle contains **mtx-decompressor 1.4.2** under
MPL-2.0. This bundled version is distinct from the one separately resolved by
npm. We retain the upstream [third-party notices](pptx-renderer/THIRD_PARTY_NOTICES.md),
[full MPL text](pptx-renderer/licenses/mtx-decompressor-MPL-2.0.txt) and
[corresponding source archive](https://github.com/ChristopherVR/mtx-decompressor/archive/refs/tags/v1.4.2.tar.gz).
ScholarSeed has not modified that component's source files. The
[ECMA copyright notice](pptx-renderer/licenses/ECMA-text-copyright-notice.txt)
and source inventory for the mechanically derived geometry definitions are
also retained. Packaging does not change the original licenses of these
Office components.

The Pillow notice in the table is the full macOS arm64 copy. See the
[Pillow review](PILLOW.md) for the other platforms and differences. The
original BSD-3-Clause texts for pypdf and pycparser retain their copyright
notices, redistribution conditions and disclaimers. Installers also keep the
original `.dist-info/licenses/LICENSE` files in the Python environment.

The full MPL-2.0 text is included in [the original lightningcss LICENSE](lightningcss.txt).
It also applies to the MPL-covered portions of certifi and tqdm. tqdm's MIT
notices must be retained as well; the aggregate expression is **MPL-2.0 AND
MIT**, not a choice of either license.

## Obtain the corresponding source

The public HTTPS links point to exact versions or commits and do not require a
company account. The lightningcss npm tarball mainly contains the JavaScript
interface and is not a substitute for the Rust source archive, which includes
Rust code, Cargo configuration and upstream build materials. Its pinned commit
comes from the npm release's `gitHead` metadata. The certifi source distribution
includes the certificate data for that version. The source archives retain their
original licenses; the source is not relicensed under Apache-2.0.

[manifest.json](manifest.json) lists the full SHA-256 of each source archive,
verified artifact URLs and digests, original license member paths and digests,
and the digests of the distributed copies. Extraction normalizes CRLF to LF.
The Office reader notice copies are also normalized to one trailing newline as
recorded in `noticeNormalization`. These changes do not alter the license text;
the original member's bytes remain in the upstream artifact. Verify the
archive's SHA-256 before extracting it. Do not substitute the latest branch
for the pinned version.

These links cover the upstream artifacts identified in the manifest. Distributors
of modified MPL-2.0-covered files must provide the corresponding modified source
and preserve applicable notices. Maintain source availability for recipients;
replace unavailable upstream links with an accessible matching archive or bundled
source. BSD-3-Clause does not require publication of modified source merely for
redistribution, but its notices and disclaimer must be retained as specified.

## Pillow acknowledgements

Pillow and PIL: Copyright © 1997–2011 Secret Labs AB; Copyright © 1995–2011
Fredrik Lundh and contributors; Copyright © 2010 Jeffrey 'Alex' Clark and contributors.

This product uses the FreeType Project (https://freetype.org/). The FreeType
portions included through Pillow are used under the FreeType License (FTL);
all applicable copyright notices and disclaimers are reproduced in the platform
license files. The FreeType authors provide no warranty for this product.

This software is based in part on the work of the Independent JPEG Group.

This software includes code from XZ Utils (https://tukaani.org/xz/).
The liblzma 5.8.3 [0BSD supplement](xz-0bsd.txt) and the upstream notice
discrepancy are explained in [Pillow review](PILLOW.md).

These acknowledgements do not imply endorsement by the third-party authors or
organizations. The full platform notices retain the other components'
copyright notices, licenses, disclaimers and applicable terms; these summaries
do not replace the original texts.

## Location

- macOS: `ScholarSeed.app/Contents/Resources/notices/`
- Windows: `<installation directory>/resources/notices/`
- Source tree: `apps/desktop/resources/notices/`

Keep the original `.dist-info/licenses/` directories in the Python wheels.
This directory supplies convenient additional copies, not a reason to remove
the originals. All three Pillow platform notices ship with the product; see
the manifest for the platform mapping.
