<a id="系统入口与窗口生命周期候选构建依据"></a>
# Candidate Build Basis for System Entry Points and Window Lifecycle

<a id="建设状态"></a>
## Construction Status

Asset revision `system-shell/1`. This page establishes candidate focused-scenario leads for windows, background menus, notifications, and updates only; it is not part of the adopted baseline or smoke denominator. New `SYSTEM-*-CAND-*` values are candidate IDs. The historical `@1` in `NOTIFICATION-01@1` is an asset revision, not a product requirement version. The requirement version, product adoption, and installed-package applicability for target `0.3.2 / 202611121823 / preview` remain unconfirmed. Historical freezes and existing page requirements are unchanged.

<a id="可回查的需求来源"></a>
## Requirements Sources for Reference

- The [Window Close and Background Menu Owner](../../../docs/architecture/ownership.md#窗口关闭确认与后台菜单) records macOS and Windows close, actual-exit, and menu-navigation boundaries, and requires real non-headless Desktop and native acceptance on each platform. In that document, `current` means a source or known implementation fact, while `required` is an acceptance basis; neither allows a claim that the target installed package passed.
- The task-notification and background-entry proposal records the relationship among tasks, notifications, and project navigation. “Product rules requiring confirmation and suggested defaults” are explicitly implementation assumptions and must not be written as approved criteria without confirmation. OS notification permission, real tasks, read state, and menu navigation are separate operations.
- The lightweight update-notice design mapping records work item `87617772` requirements not to steal focus and to let the user open the update entry point. The source lists real update-ready screenshots and cross-platform verification as gaps. Actual installation, signing, and channels must follow the [Build and Release Guide](../../../../../docs/runbooks/build.md); the guide does not grant installation or release authorization.

<a id="历史稳定点"></a>
## Historical Stable Points

Use the `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` recorded in the [historical P2 freeze](../../frozen/p2-20261025-539af0794/freeze.json) to check `apps/desktop/docs/scenarios/catalog.json` and `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json`. Their SHA-256 values are `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f` and `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`, respectively.

The historical goal of `NOTIFICATION-01@1` was for task alerts to match real state and for marking an alert read not to change the task. Its directory marks `reviewState=pending` and `coverageEligibility=exploratory`; corresponding `D6-SET-009` has `expectedStatus=candidate_unapproved`, and the item is in `excludedOutsideDefaultDirections` in the P2 freeze. Do not infer target-build adoption, actual delivery, or evaluation success from `status=active`, historical observations, or the existing [notification settings display](./../notifications/requirements.md). These sources can be checked with `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>`; do not restore or modify frozen files.

<a id="源码定位截图与交接"></a>
## Source Locations, Screenshots, and Handoff

Current source baseline `acce09fa42ddf234d84b02dde34b2ab4be570215` is not established as coming from the target installed package. [tray.ts](../../../src/main/tray.ts) owns tray/close actions, SHA-256 `ffa937ecb90c8124ec589acf319213af41dde6b6f04fab28cb8d2de22f63fb5a`; [window.ts](../../../src/main/window.ts) owns native window lifecycle, SHA-256 `fdee037c2cce16bb064ec9ea5e04be110fec65053303b973074c650dfb8427c3`; [Close.tsx](../../../src/renderer/src/shell/Close.tsx) and [Background.tsx](../../../src/renderer/src/shell/Background.tsx) respectively contain close-confirmation and background-menu interactions, with SHA-256 values `28ca091740ff3d05593353d702e32a82e43aa902562c5b121c68ea44dda7ebc7` and `1eaad9f539aaa58abda917036e2f3968c64ac1f65be545a19d303a48c39c7d73`. These are location and side-effect clues, not substitutes for confirming actual user requirements and observing the real product.

Target artifact clue: macOS arm64 `0.3.2 / 202611121823 / preview`, with a previously recorded ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. Recheck the instance and digest before execution. Existing `notifications/reference.png` and earlier settings-page screenshots cover notification preferences only; they do not prove OS notifications or native menus. There is no traceable, authorized, reusable complete screenshot for the target build's system notification, close confirmation, tray, or update-ready state. Capturing each platform requires the real product and authorization; source code or component fixtures cannot substitute for the image.

First have the requirement Owner confirm the candidate's product requirement version, applicability, and unresolved rules. Then prepare an isolated task, system state, platform, and corresponding authorization. Separately freeze higher-risk update, installation, exit, system-settings, and mark-as-read actions. Do not proceed when the environment cannot be recovered or its source is unknown. Do not manufacture a pass by changing product rules or removing gates.
