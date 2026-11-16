<a id="通知"></a>
# Notifications

Reference for notification settings in the target version.

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. This shows notification settings and the sound preference at that time; it does not prove notification delivery or actual sound playback. See [build evidence](./build.md#202611121823-目标版本参考图) for the source and summary.

Inspect the system notification entry point, unread-message actions, and sound preference. Navigate from the main screen: avatar menu → Settings → Notifications.

![Notification page reference](./reference.png)

Reference image source: macOS arm64, 0.3.0 / 202610281438, 2026-10-28. The sound switch reflects the preference at that time and is not a fixed expectation for later versions; the image only helps identify the page.

<a id="查看通知选项"></a>
## Inspect Notification Options

<a id="通知与未读入口notify-obs-001--v03"></a>
### Notification and Unread Entry Points (NOTIFY-OBS-001 · v`0.3`)
Fixed: the page title and description, and the Desktop Notifications, Unread Messages, and Sound Alerts sections are clear. The first two sections show the system notification settings and mark-all-as-read entry points, respectively, with an explanation of their purpose.

<a id="声音偏好notify-obs-002--v03"></a>
### Sound Preference (NOTIFY-OBS-002 · v`0.3`)
Dynamic: the sound-alert switch matches the preference currently saved by the client, or the version's default if no preference has been saved. Check the displayed state only; do not judge by whether sound actually plays.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Use the normal v`0.3` subpoints NOTIFY-OBS-001 and 002. This covers only the scope below and does not establish that every criterion under these IDs passed.

Notification settings should show the desktop notification, unread, and sound sections and explain their main entry points. The sound switch should match the successfully read preference or the declared default.

Required reference: this instance's `soundAlerts` startup preference whitelist. The [historical artifact reading reference](build.md#当前制品复核) applies only to the old package; verify the target package's read contract and default before execution. Use the default only when the preference is known to be absent and the target package default has been confirmed. If it changes after startup, use an independent current reference.

<a id="专项层"></a>
## Specialist Layer

This layer does not select system settings navigation, mark-all-as-read, switch changes, or actual sound/notification delivery. The original complete criteria, stable IDs, versions, and historical results are retained; layering does not approve unconfirmed branches.
