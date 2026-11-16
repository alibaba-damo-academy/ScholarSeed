<a id="系统入口与窗口生命周期候选需求"></a>
# Candidate Requirements for System Entry Points and Window Lifecycle

<a id="用途与入口"></a>
## Purpose and Entry Points

Users can notice tasks and return to the product through system notifications, the application window, the macOS menu bar, or the Windows system tray. Update notices let users inspect a candidate version and decide whether to update. Entry points and specific behavior depend on the target platform and installed artifact. This page is a candidate consolidation of historical requirements and current Owner materials, not an adopted criterion or evaluation result.

**Reference screenshot gap:** No complete window image has been verified as both source-traceable and approved for reuse for the target build's native close confirmation, tray, system notification, or update-ready state. A notification settings page or component fixture cannot substitute for a system notification, tray, or real installation. Keep native dialogs in their host context; do not crop them in isolation.

<a id="候选专项"></a>
## Candidate Focused Scenarios

<a id="关闭后台与恢复"></a>
<a id="关闭后台与恢复system-window-cand-001需求版本待确认"></a>
### Close, Background, and Recovery (`SYSTEM-WINDOW-CAND-001`; requirement version pending confirmation)

For an authorized instance that can be exited, use real native window operations to observe closing, the background entry point, and recovery. Separately verify macOS window close and actual exit, and Windows close confirmation, cancellation, backgrounding, and actual exit as observable end states. Check window visibility, process, and task state for the same instance. Seeing a dialog, receiving a click, or hiding the main window does not prove exit, task completion, or successful recovery. Check platform differences against the [Window Lifecycle Owner](../../../docs/architecture/ownership.md#窗口关闭确认与后台菜单). Actual exit, running tasks, and preference writes each require separate authorization. Adoption of the requirement, entry point, and implementation mapping for the current target build remain unconfirmed.

<a id="原生后台菜单"></a>
<a id="原生后台菜单system-tray-cand-001需求版本待确认"></a>
### Native Background Menu (`SYSTEM-TRAY-CAND-001`; requirement version pending confirmation)

Use the target platform's real system menu to inspect available entry points and their correspondence to the current isolated project and task. Opening the menu must not itself raise the main window. After explicitly selecting an available target, check the corresponding window and target. Judge rules for no-task, data failure, and unavailable targets separately against approved evidence; do not substitute old suggestions or a static image. Reading and selecting from the menu may affect window or navigation state. Check authorization and an independent reference separately for exit, real tasks, and system permissions. The macOS menu bar and Windows tray do not validate each other.

<a id="系统通知与任务关联"></a>
<a id="系统通知与任务关联历史-notification-011产品需求版本待确认"></a>
### System Notifications and Task Association (historical `NOTIFICATION-01@1`; product requirement version pending confirmation)

With an authorized isolated task and existing system notification permission, observe how a real task alert relates to task identity, state, and subsequent navigation. Marking an alert as read must not change the task's business result. Record task identity, state, and what the user actually sees separately. A settings-page toggle, simulated event, or ordinary component screenshot does not prove native delivery or navigation. Historical `@1` is an asset revision, not a product requirement version. This item is `pending / exploratory`; historical case `candidate_unapproved` does not automatically place it in the adopted denominator for the target build. Check authorization separately for notification permissions, system settings, real tasks, and marking as read.

<a id="更新提醒与更新全流程"></a>
<a id="更新提醒与更新全流程system-update-cand-001需求版本待确认"></a>
### Update Notice and Full Update Flow (`SYSTEM-UPDATE-CAND-001`; requirement version pending confirmation)

The lightweight update notice confirmed in the historical work item must not take focus from an operation in progress when an update is found or prepared. After the user opens the update entry point, the notice may show information consistent with the candidate build, and the user confirms any restart. Current source or screenshots of an old package cannot substitute for testing the target artifact and the same candidate version. Freeze real end states separately for download, verification, installation, exit/restart, failure recovery, and version-line switching; these require a signed source, recoverable isolated environment, and corresponding authorization. Do not perform them as part of this task without that scope. The About page's display and version information are covered by the [About baseline](./../about/requirements.md) and do not independently establish a complete update pass.

<a id="数据权限与边界"></a>
## Data, Permissions, and Boundaries

Test only with a task-dedicated isolated instance, disposable synthetic tasks, and recoverable platform environments. Independently verify identities for projects, tasks, windows, and candidate builds. Prepopulated databases, simulated bridge events, and static screenshots cannot substitute for real notifications, tasks, installations, or state across restarts. Record macOS and Windows, themes, DPI, and system permissions separately. If a real target platform or permission is unavailable, retain the gap; results from one platform do not represent the other.

The product requirement version, target-package applicability, adoption state, and complete real screenshots remain unverified on this page; see the [Build Basis](./build.md). Browser settings, user-feedback action records, and product update development/release operations remain with their respective Owners. A screenshot or visible entry point does not mean a focused operation succeeded.
