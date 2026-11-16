<a id="文件策略基线构建依据"></a>
# File-Policy Baseline Build Basis

Current asset revision: `file-policy/7`. This run clarifies that the target package's read contract must be verified in practice. The [Current Artifact Recheck](#当前制品复核) below retains historical package evidence; business criteria and requirement version are unchanged.

<a id="202611121823-目标版本参考图"></a>
## Target-Version Reference Image: 202611121823

`window-20261112-1823.png` is a byte-for-byte copy of the original complete-window image from the target version. Source: `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/file-policy.png`, 2026-11-12 20:31:57 +0800, SHA-256 `7b09a052a1345a572ff9a9909696d0c55c6ab759114c4816beffeecf43d2cef6`. Target: macOS arm64 `0.3.2 / 202611121823 / preview`, `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The original run record is in a local ignored directory. The image shows natural preferences and version limits; displayed values are dynamic and do not prove policy was saved or took effect. It does not replace execution or evaluation in this run. This change adds the image only and does not alter requirement version, criteria, or historical result.

<a id="202611121823-正常展示沿用"></a>
## Reuse of Normal Display at 202611121823

Based on the user's unified adoption rule for verified normal behavior and the quick-review layer already adopted on this page, the save-preference, version-retention count, and size display subcriteria under FILE-OBS-001–003 are reused within scope for macOS arm64 `0.3.2 / 202611121823 / preview`. Existing adoption and subsequent records on this page were checked; no record was found confirming that this sub-scope was retired or changed. This bounded check does not establish the complete change history, common source/artifact origin, target-package reachability, or a product pass. Original IDs, requirement version, criteria, and historical rulings are unchanged.

Before execution, verify the minimum fields for save preferences and file-version settings, read timing, and KB/1024 conversion against the target package's actual contract. Retain a gap if the startup snapshot is stale, settings cannot be read, or fields are missing; do not self-certify from the screen or an unverified default. Do not focus numeric inputs or trigger blur-save, toggle switches, or accept migration. Policy effects, writes, and migration remain focused scenarios. The old-package read contract below is a historical clue only.

Historical asset-creation note: revision file-policy/3 (reference image added only; revision 1 criteria unchanged). The user selected existing functionality in the specified package; three items were auto-displayed in the quick review and first included at v`0.3`.

Source: macOS arm64 0.3.0 / 202610281438 / preview; `app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. In the installed renderer, `FileVersionPage` at line 78347, `loadFileVersionSettings` at line 4346, and `advanced` constant at line 77665 in `assets/index-C4-PYlXk.js` were compared within scope against [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx) and the [file settings Owner](../../../src/renderer/src/features/resources/settings.ts). This does not prove repository-wide mapping.

| Criterion | Fixed / dynamic / conditional behavior and source |
| --- | --- |
| 001 | `autoSave`/`formatOnSave` come from profile preferences; absent values default to true/false. Do not turn defaults into permanent fixed requirements. |
| 002 | GET `/api/serve/settings/file-versions`; retain original `max_versions_per_file`; divide `max_file_size_kb` by 1024 and display to two decimals with trailing zeros removed; disable fields until settings load. |
| 003 | Show a migration notice only when `migration_required`; show a toast on read failure; advanced configuration is false in this package, so mode, allow/deny lists, or scan areas are not required. |

Independent references use only the read-only settings fields above and the preference allowlist. Focusing numeric inputs may trigger save on blur; do not focus/fill/press Enter. Switches immediately write preferences; do not operate them. Policy effects, migration, scanning, and save conflicts are separate focused scenarios; do not infer success from a display match.

`reference.png` is an unchanged copy of the checked original `library-files.png`; version/date and dynamic-value boundaries are in the main text. SHA-256 `d866a45e252348f0b9b3e84ffa8c5893e689650e379a41703f33df666b34e01c`. Do not overwrite historical revision 1.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision was file-policy/3. In line with the user's pre-release quick-review goal and unified adoption rule, quick-review and focused-scenario layers were added to the same requirements document, reusing the source binding, exact artifact, and existing Review. Historical business version v`0.3` and full criteria remain unchanged. Selected sources are explicit subcriteria under FILE-OBS-001–003; the necessary reference is the minimum current file-setting fields, using the original build's KB→MB relation for size. Not selected: preference edits, migration confirmation, retention/cleanup, and the real save lifecycle. Any part lacking evidence remains pending confirmation.

This only completes pre-execution layering. It produces no product pass result and does not supersede historical full runs. Later runs consume subcriteria frozen by a separate Review; a quick-review result must not be described as covering the full original IDs. This build added no product operations or data-write permissions.


<a id="当前制品复核"></a>
## Current Artifact Recheck

Current asset revision: `file-policy/4` (2026-10-30). This incrementally updated artifact location and independent references only; it did not change stable IDs, v`0.3`, full criteria, or quick-review/focused-scenario boundaries. Package numbers, old source line numbers, layering revisions, and results above are historical records, not package binding or pass results for this run. The reference image retains its original source date/build.

This run's source is the inspected installed build `0.3.0 / 202610301343 / preview / macOS arm64`; app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Direct evidence is the actual unpacked release file `renderer/assets/index-CddcCmKt.js`, SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`; compiled functions/line numbers below refer to that file unless another file is named. Referenced `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`; `out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`; preference constants are in `renderer/assets/AccountMenuPanel-CHQ1thBC.js`, SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`. No source commit is bound; repository Owner links above are auxiliary clues only. Do not equate checkout/remote HEAD with this package.

- Fixed/dynamic/conditional: `FileVersionPage:80065` still reads `autoSave`/`formatOnSave` from renderer preferences. `FILE_VERSION_ADVANCED_CONFIGURATION_ENABLED:79386` in the target chunk is false; do not require the advanced area merely because code for another implementation exists. Show migration notice only when read result is `migration_required`.
- Independent settings read: `loadFileVersionSettings:4640` uses GET `fetch(window.scholarseed.getApiBase() + '/api/serve/settings/file-versions', {credentials:'include'})`; on success, retain only top-level JSON fields `max_versions_per_file`, `max_file_size_kb`, and `migration_required`. Do not guess a `settings`/`body` container or output `include_patterns`/`ignore_patterns` or other project data. A non-success response, parse error, or unready state cannot be substituted with temporary default numbers.
- `fileVersionSizeMbText:4630` still divides KB by 1024, applies `toFixed(2)`, then converts through Number to remove unnecessary zeros. Read the startup allowlist for `autoSave`/`formatOnSave` from preload `preferences`; defaults true/false are in `AccountMenuPanel-CHQ1thBC.js:357`. Confirm preferences have not changed afterward. If the snapshot is stale, the reference is missing; do not call `savePreferences` or `reconcilePreferences` to manufacture one.
- Numeric input blur can save, and switches immediately change preferences; continue to avoid focus/fill/Enter/toggling. This review updates evidence locations only and does not change expectations for saving, migration, or retention policy.

This run inspected only the extracted artifact and asset. It did not start/connect to the product, read user state, or make a request; it produced no new runtime screenshot or product acceptance result. A later run still needs an independent reference from the same authorized instance and time window. Missing, stale, or failed references cannot be self-certified from the page under review.
