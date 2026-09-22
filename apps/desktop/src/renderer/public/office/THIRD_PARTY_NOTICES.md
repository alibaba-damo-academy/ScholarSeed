# ZetaOffice runtime assets

The versioned `zeta-20250513/soffice.*` files are the browser runtime consumed
by the ScholarSeed Office workbench. They were mirrored from
`https://cdn.zetaoffice.net/zetaoffice_latest/` as one immutable set; the
adjacent manifest records their source date, byte sizes, and SHA-256 digests.

Upstream source references for this build are published by the zetajs project:

- LibreOffice: `https://git.libreoffice.org/core/+/refs/heads/distro/allotropia/zeta-24-2`
- Emscripten: `https://github.com/allotropia/emscripten/commits/fixed-3.1.65`
- Qt: `https://github.com/allotropia/qt5/tree/5.15.2%2Bwasm`
- Qt Base: `https://github.com/allotropia/qtbase/tree/5.15.2%2Bwasm`

The zetajs JavaScript wrapper remains supplied by the pinned npm dependency and
is licensed under MIT. The runtime contains LibreOffice and its transitive
components; retain their upstream notices and corresponding-source obligations
when redistributing a packaged application.

## Native Chinese and English resources

`locales.data` and its index `locales.json` add the native Simplified Chinese
catalogs and registry translations. English remains in the original frozen
runtime; these additions do not replace `soffice.js`, `soffice.wasm`, or
`soffice.data`. Both locales are available at startup; the default is `zh-CN`.

Corresponding sources (LibreOffice MPL-2.0 notices apply):

- Core: https://github.com/LibreOffice/core/tree/efaf0670b4d055f838a2849becb10f08aa06a257
- Translations: https://github.com/LibreOffice/translations/tree/5acb9e94995b78727200faa5d89f2d8b72002e2e

To reproduce, configure that core revision with the matching translations in
`translations/source` and `--with-lang="en-US zh-CN"`. Build `Executable_cfgex`,
then the native gbuild targets `workdir/XcdTarget/Langpack-zh-CN.xcd`,
`workdir/XcdTarget/registry_zh-CN.xcd`, and
`workdir/XcdTarget/fcfg_langpack_zh-CN.xcd` (absolute target paths via
`make -f Makefile.gbuild`). Run `node scripts/locales.cjs <core> <translations>
<asset-output>` with GNU gettext installed. This uses the upstream
`AllLangMoTarget_*.mk` catalog inventory and `msguniq | msgfmt` pipeline.

The WebAssembly build loads message catalogs from
`/instdir/program/resource/zh_CN/LC_MESSAGES`, not the native desktop
`share/resource` directory. Registry resources retain their native `share/registry`
paths. `locales-residuals.json` records untranslated/fuzzy upstream catalog entries
that may fall back to English; no Canvas strings are overlaid or translated by React.
