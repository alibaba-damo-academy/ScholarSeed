<a id="通知基线构建依据"></a>
# Notification Baseline: Build Evidence

Current asset revision: `notifications/7`. Clarification on the freshness of the read contract in the requirements: “Current Artifact Review” below is a historical record for `0.3.0 / 202610301343`, only a clue, not the target package's read contract or default. Verify the target package's read capability, preference timing, and default separately. The original title and anchor are retained for historical references. This revision does not change original IDs, requirements version, criteria, or historical results.

<a id="202611121823-目标版本参考图"></a>
## 202611121823 target-version reference image

`window-20261112-1823.png` is a byte-identical copy of the actual complete-window capture from the target version. Source: `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/notification-settings.png`, 2026-11-12 20:31:19 +0800, SHA-256 `482f06a1183ffe54bd76bef0e89b09c43c6ac42d172fc332980c4cd333b6c072`. Target: macOS arm64 `0.3.2 / 202611121823 / preview`; `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The original run record is in a local ignored directory. The image shows notification settings and the sound preference at that time; it does not prove notification delivery or actual sound playback. It does not replace execution or evaluation in this run; this revision only adds the image and does not change the requirements version, criteria, or historical results.

<a id="202611121823-通知展示沿用依据notifications5"></a>
## 202611121823 basis for carrying forward notification display: notifications/5

For macOS arm64 `0.3.2 / 202611121823 / preview`, carry forward the adopted quick-review subpoints NOTIFY-OBS-001 and 002 from notifications/3 under the user's unified adoption rule of 2026-10-30: display of the notification, unread, and sound sections and their main entries; the sound switch matches the current preference. Review of the existing adoption and subsequent revisions on this page found no record confirming that this sub-scope was retired or changed. This is a bounded review; it does not establish the complete requirements change history, source-to-artifact identity, or successful execution. Verify the minimal allowlist for this instance's startup preference `soundAlerts`. The old-package read contract below must be confirmed for the target package; record a gap if reading fails or the timing does not match. Do not use the page itself or an unconfirmed default as its own proof. System-notification navigation, mark all as read, switch changes, and actual sound playback remain specialized scenarios. Original IDs, v`0.3`, criteria, and historical decisions remain unchanged.

Historical asset revision: `notifications/4`; the increment at that time is in [Current Artifact Review](#当前制品复核). Business criteria and requirements version are unchanged.

Historical baseline note: revision `notifications/3` left the two criteria from revision 1 unchanged and only added the reference image and source. The user adopted the existing functionality of the specified installed package for that run; the two items were first included in automatic quick review under v`0.3`. Complete behavior is outside these two display criteria.

Source: macOS arm64 0.3.0 / 202610281438 / preview; installed package `app.asar` SHA-256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`; actual renderer entry `NotificationsPage` at line 81089 of `assets/index-C4-PYlXk.js`. This is a bounded check of the relevant implementation and does not claim the whole repository matches the artifact.

Source: [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx), `NotificationsPage`; preference owner: [preferences.ts](../../../src/preferences.ts).

| Item | Fixed / dynamic / conditional behavior and source |
| --- | --- |
| 001 | Three fixed rows and two action entries. There is no desktop notification switch; live system-permission state is not required. |
| 002 | `soundAlerts` comes from this instance's profile preference; if absent, the target-package default `true` is used. Read only the independent preference allowlist; do not operate the switch. |

Original fields, tool calls, actual instance, and evaluation results remain only in run records. System settings, mark all as read, and sound behavior require separate specialty scenarios and are not automatic display items in this run.

`reference.png` is an unchanged copy of the notification page's original `notifications.png` from macOS arm64 `0.3.0 / 202610281438`, 2026-10-29. SHA-256 `9d353835b625aa4e4823244eef70c10a9116be0db9902199b32053e52e341d5a`. The original historical evidence directory is currently unavailable locally; we do not claim to have rechecked the original. Revision 1 and its text remain in the original run's frozen input. Adding the image does not revise the original decision or treat it as evidence from a new run.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset is revision `notifications/3`. Under the user's pre-release quick-review objective and unified adoption rule, this revision added quick-review and specialty layers to the same requirements file, reusing the source, exact artifact binding, and existing review on this page; the old v`0.3` business version and full criteria are unchanged. Selected sources are the explicit subpoints in NOTIFY-OBS-001 and 002. Required reference: this task instance's current sound preference or the default declared in the original build. Not selected: system-settings navigation, mark all as read, switch changes, and actual sound/notification delivery. Parts without supporting evidence remain unconfirmed.

This revision only layers the criteria before execution; it does not establish product acceptance or replace historical full runs. Later runs consume subpoints frozen after independent review; a quick-review result must not be presented as coverage of every criterion under the original IDs. This build adds no product-operation or data-write permission.


<a id="当前制品复核"></a>
## Current Artifact Review

Historical asset revision: `notifications/4` (2026-10-30). This revision only incrementally updates artifact location and independent reference; it does not change stable IDs, v`0.3`, full criteria, or the quick-review/specialty boundary. Earlier package IDs, source line numbers, layering revisions, and results are historical and do not establish this run's package binding or outcome. The reference image retains its original source date/build.

This run's source is the verified installed package `0.3.0 / 202610301343 / preview / macOS arm64`; `app.asar` SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Direct evidence is the actual loose release directory `renderer/assets/index-CddcCmKt.js`, SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`; compiled function names/line numbers below refer to this file unless another file is named. Referenced files: `out/preload/index.js`, SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`; `out/main/index.js`, SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`; and `renderer/assets/AccountMenuPanel-CHQ1thBC.js`, containing the preference constant, SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`. The source commit is not bound. Repository owner links above are supporting clues only; the current checkout/remote HEAD is not treated as this package.

- Fixed/dynamic/conditional: `NotificationsPage:82807` still has three rows for desktop notifications, unread messages, and sound alerts. System settings and mark all as read are action entries; a desktop notification switch or live system-permission display is not required. The sound switch is bound to `state.soundAlerts`; actual playback is not a criterion.
- The independent preference reads only `soundAlerts` from preload `preferences:316`. This is a startup snapshot; `INITIAL_PREFERENCES:9198` is the same consumer, not a second independent reference. The default `true` is at `AccountMenuPanel-CHQ1thBC.js:355` and applies only when the isolated preference is known to be absent; do not interpret an unknown read failure as the default.
- If the preference changed after startup or the snapshot cannot be bound to the instance, 002 remains unsupported by evidence. Do not output all of `preferences` (which may contain recent projects/files/sessions), and do not call `savePreferences`, `reconcilePreferences`, `openSystemPermission`, or mark all as read to supply a display reference. Actual delivery/sound, system navigation, and read-state writes remain specialized scenarios.

This revision only inspected the extracted artifact and assets; it did not start/connect to the product, read user state, or make a request. No new run screenshot or product-acceptance conclusion was produced. Later runs still need an independent reference from the same time in an authorized instance; a missing, stale, or failed reference cannot be self-verified from the page under evaluation.
