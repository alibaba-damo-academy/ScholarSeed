<a id="数据存储基线构建依据"></a>
# Data Storage Baseline: Build Evidence

Current asset revision: `storage/7`. This revision clarifies that the target read contract must be verified in practice. [Current artifact review](#当前制品复核) below retains the historical package evidence; business criteria and requirements version are unchanged.

<a id="202611121823-目标版本参考图"></a>
## 202611121823 target-version reference image

`window-20261112-1823.png` is a byte-identical copy of the target version's actual full-window capture. Source: `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/storage.png`, 2026-11-12 20:32:06 +0800, SHA-256 `0198e9f113df2810b13409af0613540ed88d1ff6c79c2d88f53bf2a6ce0b777a`. Target: macOS arm64 `0.3.2 / 202611121823 / preview`; `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The original run record is in a locally ignored directory. The image shows the isolated instance's data root and project root, including the local username and isolated path. Paths are dynamic values; the image does not prove migration or modification. It does not replace execution or evaluation in this run; this revision only adds the image and does not change requirements version, criteria, or historical results.

<a id="202611121823-正常展示沿用"></a>
## 202611121823 carry-forward basis for normal display

Under the user's unified adoption rule, based on records of verified normal behavior and the adopted quick-review layer on this page, carry forward a bounded subset of STORAGE-OBS-001–003 for macOS arm64 `0.3.2 / 202611121823 / preview`: normal display of the current data root, default project location, and effective boundary. Review of the page's existing adoption and subsequent records found no confirmation that this sub-scope was retired or changed. This does not establish the complete change history, source-to-artifact identity, reachability of the target package's entry point, or product acceptance. Original IDs, requirements version, criteria, and historical decisions remain unchanged.

Before execution, verify against the target package's actual contract the minimal `root` / `configured` projection and timing for the independently established startup data root, same-instance storage configuration, and default project root. A default project root different from the current project's actual path cannot substitute for it. Missing data or a read failure remains a gap; the page's displayed path cannot prove itself. Do not open a directory picker, change locations, or restart. Migration and effective application remain specialized scenarios. The old-package read contract below is historical evidence only.

Historical baseline note: revision `storage/3` only added a reference image; criteria from revision 1 were unchanged. The user adopted the existing functionality of the specified package for this run; the three display-only items were added to automatic quick review for the first time in v`0.3`.

Source: macOS arm64 0.3.0 / 202610281438 / preview; `app.asar` SHA-256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. The installed renderer's `assets/index-C4-PYlXk.js` contains `DataStoragePage` at line 77884 and `loadWorkspaceRoot` at line 5542. Bounded comparison with [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx), the [storage owner](../../../src/main/storage.ts), and the [persistence contract](../../../../../docs/architecture/persistence.md) does not establish a mapping for the whole repository.

| Item | Fixed / dynamic / conditional behavior and source |
| --- | --- |
| 001 | `storageConfig().home` is the actual data home for this run, bound to the instance by an independent startup record; there is no runtime button to change `home`. |
| 002 | `GET /api/serve/workspace-root`; display `configured` or `root`, and restrict the change entry according to `ready`/`busy`. `configured` and `root` can differ; preserve both complete original values. |
| 003 | `platform` and `canChangeDataHome` determine the installation/first-launch footnote. The current implementation shows restart/failed notices during the change flow; since this run makes no change, it need not manufacture that notice. |

The independent reference consists only of `home`/`canChangeDataHome` and `root`/`configured`/`restartRequired`, bound to the independent startup record. If a path is truncated, capture the full actual page text. Do not open the picker or change the project location; migration and restart application are separate specialty scenarios.

`reference.png` is an unmodified copy of the inspected original `storage.png`; version/date and dynamic-value limits are described above. SHA-256 `4e86160817855083ada8ae0828abe097f03d1e1c664d748d938e76636cbde927`. It is not included in historical freeze revision 1.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset is revision `storage/3`. Under the user's pre-release quick-review objective and unified adoption rule, this revision added quick-review and specialty layers to the same requirements file, reusing the source, exact artifact binding, and existing review on this page. The old v`0.3` business version and full criteria are unchanged. Selected sources are the explicit subpoints in STORAGE-OBS-001–003. Required references: the isolated task's startup data root and the public default project-root configuration; do not read other directory contents. Not selected: directory selection/open/copy, migration, changes, and restart. Any parts without supporting evidence remain unconfirmed.

This revision only layers the criteria before execution; it does not establish product acceptance or replace historical full runs. Later runs consume subpoints frozen after independent review; a quick-review result must not be presented as coverage of every criterion under the original IDs. This build adds no product-operation or data-write permission.


<a id="当前制品复核"></a>
## Current Artifact Review

Current asset revision: `storage/4` (2026-10-30). This revision only incrementally updates artifact location and independent references; it does not change stable IDs, v`0.3`, full criteria, or the quick-review/specialty boundary. Earlier package IDs, source line numbers, layering revisions, and results are historical and do not establish this run's package binding or outcome. The reference image retains its original source date/build.

This run's source is the verified installation package `0.3.0 / 202610301343 / preview / macOS arm64`; `app.asar` SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Direct evidence is the actual loose release directory `renderer/assets/index-CddcCmKt.js`, SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`; compiled function names/line numbers below refer to this file unless another file is named. Referenced files: `out/preload/index.js`, SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`; `out/main/index.js`, SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`; and `renderer/assets/AccountMenuPanel-CHQ1thBC.js`, containing the preference constant, SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`. The source commit is not bound. Repository owner links above are supporting clues only; the current checkout/remote HEAD is not treated as this package.

- Fixed/dynamic/conditional: `DataStoragePage:79602` separately reads the data root and default project root, with independent loading/error/ready states. The configured path takes precedence (`configured || root`); an unapplied configuration must not be treated as the currently used root. The change entry is restricted by workspace readiness and busy state; a restart notice still comes only from this page's change flow.
- The public data-root bridge `window.scholarseed.storageConfig()` (preload :543; main IPC :40215) returns an object directly, without an `ok`/`body` wrapper. Read only `home`/`configured`/`canChangeDataHome`, and `firstLaunchEligible` only if necessary. Do not collect `runtimeStore`, which is unrelated to the paths displayed on this page. `home` comes from `desktopHome()` and must be compared with the independent startup data root for this run; the installation directory, `userData`, and default project root cannot substitute for it.
- Project-root reading follows `loadWorkspaceRoot:5843` → `readJson:5780`. It issues a GET request to `window.scholarseed.getApiBase() + '/api/serve/workspace-root'` with `credentials:'include'`; the successful top-level JSON contains `root`/`configured`/`restartRequired`. Preserve the current `root` and `configured` values separately; use `root` only when `configured` is empty. Do not guess a `workspace`/`body` wrapper, list directories, or read project contents.
- The platform comes from `preload.platform`; this installation package binds only darwin/arm64 for this run. `main` has `canChangeDataHome=true` in this run; do not generalize to Windows implementation or acceptance. If the startup record is absent or reading fails, record the missing reference; the page's own path cannot prove itself. Do not call `pickDir`, `commitDataHome`, `saveWorkspaceRoot`, `openPath`, or restart.

This revision only inspected the extracted artifact and assets; it did not start/connect to the product, read user state, or make a request. No new run screenshot or product-acceptance conclusion was produced. Later runs still need an independent reference from the same time in an authorized instance; a missing, stale, or failed reference cannot be self-verified from the page under evaluation.
