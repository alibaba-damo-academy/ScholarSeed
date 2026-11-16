<a id="关于页基线构建记录"></a>
# About-Page Baseline Build Record

Current asset revision: `about-quick/18`; this change clarifies that the read contract must be verified against the actual target instance. Old-package records are clues only. Stable IDs, requirement version, criteria, and historical rulings are unchanged.

<a id="202611121823-目标版本参考图"></a>
## Target-Version Reference Image: 202611121823

`window-20261112-1823.png` is a byte-for-byte copy of the original real complete-window image from the target version. Source: `tmp/test_snapshot/desktop/baseline-1823-batch3/driver/evidence/about.png`, 2026-11-12 20:06:38 +0800, SHA-256 `e202eefeb7dbb059167f6138158f7663e023404c7f77038ce1a2546f72735884`. Target: macOS arm64 `0.3.2 / 202611121823 / preview`, `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`; original run record is in a local ignored directory. Shows version and the update notice at that time; does not prove download, update, or installation. The image does not replace execution or judgment in this run. This change adds the image only and does not change requirement version, criteria, or historical results.

<a id="202611121823-关于页展示沿用依据about-quick16"></a>
## Reuse Basis for Target-Version About Display: about-quick/16

For macOS arm64 `0.3.2 / 202611121823 / preview`, reuse the adopted quick-review subcriteria ABOUT-OBS-001, 003, 010–014 under about-quick/14 and the user's 2026-10-30 unified adoption rule: display version, build/channel, and main support entry points. Existing adoption and subsequent revisions on this page were checked; no record was found confirming that the sub-scope was retired or changed. This is bounded review, not a complete requirement change history, common source/artifact origin, or proof of real testing. A new run must independently verify the installed-package version/build/channel, client year, and applicable official support-entry source. Old-package read contracts are clues; confirm they still apply to the target package. Do not self-certify from the page or infer defaults from a failed read. Copy, update, preference, and external-link actions are outside this quick review. Original IDs, v`0.3`, criteria, and historical rulings remain unchanged.

<a id="采用与来源"></a>
## Adoption and Sources

- Historical asset revision: `about-quick/15`; requirements are in [requirements.md](requirements.md), with 14 stable IDs, all v`0.3`. The user explicitly adopted existing v0.3 functionality as the initial baseline; adoption is not proof of test success.
- Source: Desktop `0.3.0`, initial analysis commit `4208262be8b32323320fe16da91741b196110226`. The page/update/preference chain below was unchanged at `23d3a79240643442c9830ab45655c1f9fb70970d`; this does not establish complete source binding for any installed package.
- Reference image: [reference.png](reference.png), macOS arm64 installed build `0.3.0` / build `202610271421`, 2026-10-28 11:16 (Asia/Shanghai). SHA-256 `2a68092ad1842fa08e706ec37a460c7c7835af37b8d309614c7946064dc1c36b`; authorized copy of the original, uncropped and unannotated. Shows only main areas; dynamic values and bottom/popups are not criteria based on this image.
- Revision summary: `about-version/6` first included; `about-quick/7` quick-review criteria; `8` natural conditions; `9` deduplicated public rules and added reference image; `10` located dynamic fields; `11` completed phase semantics/action mapping and clarified independent references. These clarify wording/evidence only and do not change product requirement version. Old text is retained in Git history and per-run frozen inputs.

<a id="固定动态与条件分析"></a>
## Fixed, Dynamic, and Conditional Analysis

Revision 13 changed the requirements reference to an explicit same-directory path `./reference.png`; no image or business criteria changed. Old runs retain their original frozen references.

Revision 12 followed the user's explicit verification-ownership decision: automated quick review 001–005 and 007–014; 006 requires a real installed environment that does not support updates and is a manual focused scenario. This changes verification method only, not business criteria or requirement version. Old runs continue using their original frozen scope.

| ID | Fixed content / dynamic source and boundary | Code location |
| --- | --- | --- |
| 014 | Title, description, and navigation semantics come from copy resources; layout/translation are not fixed pixels or a Chinese snapshot. Copyright year is generated from current date. | [AboutPage](../../../src/renderer/src/components/business/AccountPanel.tsx#L791), [page title](../../../src/renderer/src/components/business/AccountPanel.tsx#L994) |
| 001 | Current version prefers `update.currentVersion`, falling back to preload version if unavailable; displayed value also appends buildNumber. Independently compare with target-package metadata; the page's own claim is not its own reference. | [version source](../../../src/renderer/src/components/business/AccountPanel.tsx#L779), [boot metadata](../../../src/main/index.ts#L2935) |
| 002 | Copies current-version label + systemVersion; latter formats actual OS type/version/architecture. Disable if system value is unavailable. Feedback is transient; read clipboard to verify. | [copy value/disabled state](../../../src/renderer/src/components/business/AccountPanel.tsx#L1021), [system format](../../../src/main/system.ts#L6), [copy feedback](../../../src/renderer/src/components/ui/CopyButton.tsx#L65) |
| 003 | buildNumber/channel come from boot/preload; append only when build number exists; Preview condition controls badge. Do not fix this run's build number. | [badge](../../../src/renderer/src/components/business/AccountPanel.tsx#L1016), [preload](../../../src/preload/index.ts#L358) |
| 004 | `getUpdateState` + `onUpdateState` provide phase, candidate, size, description, and errors; opening the page silently refreshes. MB is decimal; description may be absent. None is a fixed version, size, or date. | [state subscription](../../../src/renderer/src/features/updates/state.ts#L37), [candidate display](../../../src/renderer/src/components/business/AccountPanel.tsx#L831), [size format](../../../src/renderer/src/features/updates/state.ts#L176), [refresh](../../../src/renderer/src/components/business/AccountPanel.tsx#L741) |
| 005 | Action depends on phase/recovery restrictions: idle/up-to-date etc. means Check; candidate available/failed means Download; ready means Install; busy/recovery restricted has no executable action. Showing an entry does not prove it completed. | [action selection](../../../src/renderer/src/features/updates/state.ts#L80), [button/progress](../../../src/renderer/src/components/business/AccountPanel.tsx#L919) |
| 006 | Diagnostics entry appears only in unsupported state; diagnostic result exists only after an actual click. Quick review does not manufacture state or click diagnostics. | [diagnostics](../../../src/renderer/src/components/business/AccountPanel.tsx#L919), [result area](../../../src/renderer/src/components/business/AccountPanel.tsx#L1050) |
| 007 | Copy semantics are fixed; switch reads renderer preference, not a fixed false value; default is true. Enabling may trigger automatic preparation, so quick review checks only a known current value. | [switch binding](../../../src/renderer/src/components/business/AccountPanel.tsx#L1037), [default preference](../../../src/preferences.ts#L184), [main-process handling](../../../src/main/index.ts#L3097) |
| 008 | Preview channel only; main process reads policy. Not loaded/submitting/specified target/blocked states restrict changes; read failure has its own recovery entry. Two scope labels are fixed but policy value is dynamic. | [channel entry](../../../src/renderer/src/features/updates/Preview.tsx#L24), [policy read](../../../src/renderer/src/features/updates/Preview.tsx#L57), [scope/restrictions](../../../src/renderer/src/features/updates/Preview.tsx#L124) |
| 009 | `listPreviewUpdateLines` returns actual list; empty/error/loading/specified target determine display. With a target set, show the target and Cancel entry instead of Switch. Do not expect a fixed non-empty list; confirmation may trigger an update, so this is outside quick actions. | [list read](../../../src/renderer/src/features/updates/Preview.tsx#L104), [target replacement entry](../../../src/renderer/src/features/updates/Preview.tsx#L151), [list branch](../../../src/renderer/src/features/updates/Preview.tsx#L238) |
| 010 | Official website semantics are fixed. `siteBase` initially comes from accountBase or a fixed fallback domain; later `getAuthStatus.account_base_url` may update it. A single screenshot domain is not permanently fixed. | [address source/fallback](../../../src/renderer/src/components/business/AccountPanel.tsx#L726), [display/external link](../../../src/renderer/src/components/business/AccountPanel.tsx#L1059) |
| 011 | `CONTACT_MAIL` is a fixed constant in this build; display and copy both use it, with transient success feedback replacing the email text. Expected address is explicit in requirements; do not guess during a run. | [constant](../../../src/renderer/src/components/business/AccountPanel.tsx#L223), [copy](../../../src/renderer/src/components/business/AccountPanel.tsx#L757), [display/feedback](../../../src/renderer/src/components/business/AccountPanel.tsx#L1091) |
| 012 | Community semantics are fixed; real external link shares dynamic `siteBase` with website. Quick scope checks entry semantics only; do not infer it opened or user joined. | [community](../../../src/renderer/src/components/business/AccountPanel.tsx#L1102) |
| 013 | Manual semantics are fixed; full URL is dynamic `siteBase` + fixed `/docs.html`. Quick scope checks entry and explanation only; the control's presence does not prove external content is available. | [path constant](../../../src/renderer/src/components/business/AccountPanel.tsx#L227), [address composition](../../../src/renderer/src/components/business/AccountPanel.tsx#L777), [entry](../../../src/renderer/src/components/business/AccountPanel.tsx#L1123) |

Known state branches from source analysis are not proof of test success; an independent getting-started button remains commented out and is not an existing entry point. Check fixed copy semantically in the current language; do not bind it to coordinates or exact translated words. If dynamic sources are unavailable, record the evidence gap; do not compare the page to itself.

Static gap: domain action selection includes `preparing`, but AboutPage's notice switch does not explicitly handle it. Do not write the domain enum directly as a proven stable page notice. If naturally encountered in a future run, judge the visible result then; do not manufacture state or claim the product defect was reproduced.

Preference chain checked separately: renderer [setAutoDownloadUpdates](../../../src/renderer/src/store.tsx#L2416) changes state, then [PreferenceWriter](../../../src/renderer/src/store.tsx#L1664) saves it to main process. Quick review consumes only a known preference; an untouched switch does not prove the whole persistence flow.


<a id="执行所需独立参照"></a>
## Independent References Required for Execution

These are read-only data-source clues, not substitutes for page evidence, and do not invoke internal writes:

- Package version: macOS target package `Contents/Info.plist` `CFBundleShortVersionString`; build/channel: `Contents/Resources/product.json` `build_number` / `update_channel`. Compare with original values; a digest or manually typed expected value is not a substitute. For other platforms, use actual package metadata contract. OS version/architecture and local year come from the client's system.
- 004–006: existing public read-only bridge `getUpdateState()`, retaining phase, candidate version/size/description, percent, installStage, recovery/failure flags. Compare to page at same time; if state changes, record separate phases. Do not infer state from page notice.
- 007: known `autoDownloadUpdates` preference for the isolated state. 008–009: read-only results from `getPreviewUpdatePolicy()` and `listPreviewUpdateLines()`. Judge only for current channel/known policy and results loaded in this run; non-empty is not an expectation.
- 010: historical `getAuthStatus()` is an internal renderer function name, not a public `window.scholarseed` method. Actual public read path, container, and minimum fields are in [Current Artifact Recheck](#当前制品复核); do not record credentials or full auth response.
- 011: adopted constant `the configured support email`; actual copy and feedback still require testing.

<a id="未知与边界"></a>
## Unknowns and Boundaries

`preparing` exists in the domain but has no explicit About notice-switch branch. If naturally observed, retain the criteria gap; do not invent an implemented notice from the enum. The independent getting-started button is commented out and is not an entry point in this version. Complete interactions/default quick-action rules belong to the execution Skill and are not duplicated here. Call traces, runtime paths, and original-image index belong in ignored run records.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision was about-quick/14. In line with the user's pre-release quick-review goal and unified adoption rule, quick-review and focused-scenario layers were added to the same requirements document, reusing source binding, exact artifact, and existing Review. Historical business version v`0.3` and full criteria remain unchanged. Selected sources are explicit subcriteria under ABOUT-OBS-001, 003, 010–014; required reference is the inspected installed 0.3.0 / 202610281438 / preview and original build source for support entries. Not selected: copy version, update check/download/install, automatic download, and switching version line. Any portion lacking evidence remains pending confirmation.

This only completes pre-execution layering. It produces no product pass result and does not supersede historical full runs. Later runs consume subcriteria frozen by a separate Review; a quick-review result must not be described as covering the full original IDs. This build added no product operations or data-write permissions.


<a id="当前制品复核"></a>
## Current Artifact Recheck

Historical asset revision: `about-quick/15` (2026-10-30). This incrementally updated artifact location and independent references only; it did not change stable IDs, v`0.3`, full criteria, or quick-review/focused-scenario boundaries. Package numbers, old source line numbers, layering revisions, and results above are historical records, not package binding or pass results for this run. The reference image retains its original source date/build.

This run's source is the inspected installed build `0.3.0 / 202610301343 / preview / macOS arm64`; app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Direct evidence is the actual unpacked release file `renderer/assets/index-CddcCmKt.js`, SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`; compiled functions/line numbers below refer to this file unless another file is named. Referenced `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`; `out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`; preference constants in `renderer/assets/AccountMenuPanel-CHQ1thBC.js`, SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`. No source commit is bound; repository Owner links above are auxiliary clues only. Do not equate checkout/remote HEAD with this package.

- Fixed/dynamic/conditional: entry registration is in `NAV_ITEMS`/`SettingsContent` in this chunk. `AboutPage:79757` still reads `currentVersion` from update state, falls back to preload version, and appends preload buildNumber. Preview badge, email constant, client-local year, website/community/manual relationships are unchanged. Update state and restrictions still use `useUpdateState:77401` / `updateActionOf:77404`; entering the page calls refreshUpdate, so do not claim zero background activity. Do not actively check, download, run diagnostics, or change policy.
- Corrected read contract for 010: `getAuthStatus:1613` is internal to renderer, not a `window.scholarseed` method. It uses `getJson` → `apiFetch:1438` to GET `window.scholarseed.getApiBase() + '/api/auth/status'` in the same instance with `credentials:'include'`; successful JSON projects only top-level `account_base_url`. For non-success/parse failure, record missing reference. Do not guess `body`/`data` wrapper or output full auth response.
- `AboutPage:79764` first uses in-memory accountBase or `https://scholarseed.damo.alibaba.com`; a successful non-empty `account_base_url` updates it after trimming trailing slash. Manual appends `/docs.html`; displayed domain is built by `siteHostLabel`. Public `accountBaseUrl` in installed `product.json` is the same fallback domain and proves static configuration only, not startup override or current state. If actual config/response is unavailable, 010 dynamic comparison remains a gap; do not infer reference from page domain.
- Preference allowlist is only `autoDownloadUpdates`; preload `preferences:316` is a startup snapshot, not live query. Focused 007 should bind a known isolated preference or independent current projection. This run did not change preferences, so startup value can be used if current; if modification/reload is unclear, record a gap. 004–009 continue to use `getUpdateState()` / `getPreviewUpdatePolicy()` / `listPreviewUpdateLines()`, reading minimum fields only when their original conditions apply.
- Retained gap: `preparing` action is restricted but About notice switch still has no explicit branch. Do not add an expected notice or claim it was reproduced/fixed.

This run inspected only the extracted artifact and asset. It did not start/connect to the product, read user state, or make a request; it produced no new runtime screenshot or product acceptance result. A later run still needs an independent reference from the same authorized instance and time window. Missing, stale, or failed references cannot be self-certified from the page under review.
