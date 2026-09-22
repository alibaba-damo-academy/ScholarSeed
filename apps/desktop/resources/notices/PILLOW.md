# Pillow 12.3.0 platform license review

Review date: 2026-09-20. Scope: the three CPython 3.12 wheels below, not every
Pillow build, a source build, or the entire ScholarSeed distribution.

## Evidence and platform matrix

All three wheels were downloaded from PyPI. Their SHA-256 values match both
PyPI release metadata and the repository's `uv.lock`. The full embedded
`pillow-12.3.0.dist-info/licenses/LICENSE` was inspected, not just the top-level
MIT-CMU metadata. Artifact URLs, hashes and native member names are in
[manifest.json](manifest.json). Only CRLF-to-LF conversion is applied to the
readable copies; original member hashes are recorded separately.

| Platform | Exact wheel | Full notices | Verification boundary |
| --- | --- | --- | --- |
| macOS arm64 | `pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl` | [arm64](pillow-darwin-arm64.txt) | Archive/hash/license inspection; local Pillow and liblzma diagnostics also run |
| macOS x86_64 | `pillow-12.3.0-cp312-cp312-macosx_10_13_x86_64.whl` | [x86_64](pillow-darwin-x86_64.txt) | Archive/hash/license inspection; native execution not performed |
| Windows x86_64 | `pillow-12.3.0-cp312-cp312-win_amd64.whl` | [Windows](pillow-win32-x86_64.txt) | Archive/hash/license inspection; native execution not performed |

The two macOS LICENSE members are byte-identical (SHA-256
`dda12a98c1979cf3d94df1cff45d27a4cb3f04a60c76f76902ac54cac03ec0ce`).
Windows has different contents and mixed line endings (original SHA-256
`4f7866a74802c6326f81faff59a56546b6aec2b10b91973e0e9308de95e79857`).
Do not replace the Windows notices with the macOS text or a bare MIT license.

## Findings / 核验结论

- Pillow/PIL itself uses MIT-CMU. Retain its attribution, permission notice and
  disclaimer; do not imply endorsement by the authors.
- macOS notices contain sections for AOM, Brotli, bzip2, dav1d, FreeType,
  HarfBuzz, Little CMS, libavif, libjpeg, liblzma, libpng, libtiff, libwebp,
  libyuv, OpenJPEG, Raqm, Tcl/Tk, Xau, XCB, XDMCP, zlib and zstd.
  This is a notice inventory, not proof that every named library is enabled:
  the local arm64 `python -m PIL` diagnostic reports Raqm unavailable.
- Windows notices identify Brotli 1.2.0, FreeType 2.14.3, HarfBuzz 14.2.1,
  Little CMS 2.19.1, libavif 1.4.2, libjpeg-turbo 3.1.4.1, libpng 1.6.58,
  libwebp 1.6.0, OpenJPEG 2.5.4, TIFF 4.7.1, XZ 5.8.3 and zlib-ng 2.3.3.
  The `.pyd` extensions can contain linked code even though the wheel has no
  standalone `.dll` members; absence of DLL files is not absence of obligations.
- FreeType offers an FTL/GPL alternative. This distribution selects FTL for
  the FreeType portions and includes attribution in [README.md](README.md).
  GPL text in the upstream combined notice does not by itself mean that the
  entire Pillow wheel, or ScholarSeed, is GPL-licensed.
- The IJG/libjpeg notice requires acknowledgement in binary-distribution
  documentation. The required acknowledgement is in README.md; the full IJG,
  BSD-style and other notices are retained, not replaced by the summary here.
- MIT/BSD-style, PNG, TIFF, zlib and the other bundled notices retain their
  individual conditions. libavif's combined notices also reproduce third-party
  Apache-2.0 terms. Do not label the whole native dependency set as MIT-CMU.

## liblzma notice discrepancy / 附带声明差异

macOS's combined notice still describes liblzma as public domain. The local
arm64 Pillow diagnostic loaded liblzma 5.8.3; the installed combined license
hash matches the reviewed arm64 wheel's LICENSE. Windows's notice explicitly
identifies XZ 5.8.3 and correctly describes liblzma as 0BSD. Upstream
[XZ 5.8.3 COPYING](https://github.com/tukaani-project/xz/blob/v5.8.3/COPYING)
confirms 0BSD for liblzma. The original macOS notice is preserved as evidence,
and the [0BSD text](xz-0bsd.txt) is supplied as a supplement rather than silently
editing upstream statements. This software includes code from XZ Utils
(https://tukaani.org/xz/).

The same upstream COPYING distinguishes GPL-covered shell utilities/build
files from liblzma. A GPL mention in that overview is not evidence that
liblzma itself is GPL. If redistributing the XZ source/tooling as well, retain
the respective licenses of those files; 0BSD is not a blanket license for XZ.

## Remaining release checks / 发布边界

These findings cover upstream wheel contents and notice obligations, not a
complete binary provenance or patent audit. Some macOS notice sections are
generic and do not identify exact component versions. The local arm64 runtime
probe does not establish the versions inside the Intel or Windows binaries.
The retained full notices and the liblzma supplement must accompany the
product; further upstream corrections should be preserved separately.

Run each native platform build and inspect its final installed resources and
Python dependency inventory. The build freezes and verifies the notices
directory, but static wheel inspection and fixture tests do not prove a final
DMG or NSIS installer includes it. Re-review on any Pillow, Python ABI, platform,
wheel hash or build-mode change. Source-built Pillow is outside this review.
