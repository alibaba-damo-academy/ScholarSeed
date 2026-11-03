# Office Fontconfig generator

This wasm32 component generates the native `le32d8.cache-8` indexes consumed by
the frozen Office engine. It does not replace LibreOffice or change the font
inventory. `ac_cv_func_link=no` selects Fontconfig's existing mkdir lock because
Emscripten's hard-link stub returns EMLINK, which the original lock rejects.

Run `node apps/desktop/scripts/cd/fontconfig.cjs` from the repository root with the
Emscripten 3.1.65 SDK in `PATH`. The exact SDK release, upstream archives and Zeta
patch hashes are in [sources.json](sources.json). The build uses a fresh directory
under `tmp/repos/fontconfig-builds/`, validates downloads and prints output sizes
and hashes. Copy the two reviewed outputs into
`apps/desktop/src/renderer/public/office/zeta-20250513/` and update its manifest.
Ordinary Desktop builds validate the frozen outputs; they do not need Emscripten.
The generator is platform-neutral WASM. The build recipe was exercised on macOS;
Windows product acceptance was explicitly excluded from this task.

Fontconfig 2.14.2 and FreeType 2.13.0 retain the listed Zeta patches. libxml2 2.12.10
uses UTF-8 configuration without ICU/iconv; those encoding backends are unnecessary
for the frozen configuration. Emscripten's pinned `USE_ZLIB` port supplies zlib
1.2.13. The full Office engine's exact source revision is not known; matching
version names alone does not establish compatibility. The real engine acceptance
must compare the full font descriptors, per-character formatting, page/line counts
and rendered pixels after generation, process restart and document switching.

The iframe shares the existing MEMFS font byte views with this generator, including
the same filtered TTC faces and bundled fonts. It restores nonzero directory
timestamps after complete package/font installation. Main persists only the two
bounded indexes and their timestamps, keyed by source-file metadata, face selection,
installation order and frozen asset manifests. Bump `OFFICE_FONT_CACHE_SCHEMA` when
changing installation naming, TTC selection or cache semantics without an asset
change. A failed index build is diagnosed; Office can still scan the full inventory.

Licenses are shipped in
[FONTCONFIG.md](../../resources/notices/FONTCONFIG.md).
