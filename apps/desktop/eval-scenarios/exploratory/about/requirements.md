<a id="关于书深快速评审基线"></a>
# About ScholarSeed: Quick-Review Baseline

## Target-Version About-Page Reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows version and the update notice at that time; does not prove download, update, or installation. See the [Build Basis](./build.md#202611121823-目标版本参考图) for source and digest.

Identify the current client, inspect update and preference information, and locate official support.

**Entry point:** Main interface → Account menu (avatar) → Settings → About ScholarSeed (`关于书深`).

**Verification ownership:** Automated quick review 001–005, 007–014; manual focused scenario 006, requiring a real installation that does not support updates.

<a id="页面参考"></a>
## Page Reference

![Main About-page areas](./reference.png)

Source: macOS arm64 installed build `0.3.0`, build `202610271421`, screenshot date `2026-10-28`. This helps identify the page and requirements only. Version, update notice, preferences, and year shown are values from that time; follow the dynamic relationships described in the text. They are not evidence for this run or pixel-level standards.

<a id="页面与版本信息"></a>
## Page and Version Information

<a id="页面与导航about-obs-014--v03"></a>
### Page and Navigation (ABOUT-OBS-014 · v`0.3`)

Fixed: About-page title, description, and selected navigation are clear; content can scroll to the bottom; closing Settings returns to the original work surface. Dynamic: The footer copyright reads “© year 书深” (“© year ScholarSeed”), with year matching the client's local current year at evaluation time.

<a id="当前版本about-obs-001--v03"></a>
### Current Version (ABOUT-OBS-001 · v`0.3`)

Dynamic: The version body in the “当前版本” (“Current Version”) row is clearly visible and matches version metadata of the target installed package for this run. Do not substitute the separate “new version” notice.

<a id="复制版本about-obs-002--v03"></a>
### Copy Version (ABOUT-OBS-002 · v`0.3`)

Dynamic: The copy entry beside the current version returns the same version text and the client's OS name/version/architecture, matching the page version and real system metadata for this run, and provides success feedback. Disable the entry if system information is unavailable.

<a id="构建与渠道about-obs-003--v03"></a>
### Build and Channel (ABOUT-OBS-003 · v`0.3`)

Dynamic/conditional: Build number in the current-version row matches the target package's build metadata; if there is no build number, it need not be displayed. For Preview channel, show “预览版” (“Preview”); do not mislabel other channels.

<a id="更新与偏好"></a>
## Updates and Preferences

<a id="更新信息与状态about-obs-004--v03"></a>
### Update Information and State (ABOUT-OBS-004 · v`0.3`)

Dynamic: Below the version row and on its right, show update state corresponding to the same time: not checked, checking, no update needed, downloading/progress, verifying, download complete/awaiting installation, installing, restarting, or manual action required. Semantics must match the phase. Failure, rollback, or installation failure must show the problem rather than false success. When an update is found, “new version,” package size, and availability description match candidate release metadata; require only fields applicable to each phase. See the [Build Record](build.md#执行所需独立参照) for reference sources.

<a id="更新动作about-obs-005--v03"></a>
### Update Actions (ABOUT-OBS-005 · v`0.3`)

Conditional: On the right of the current-version row, show Check for not checked/no update/rolled back; Download or Retry Download when an update is found or download fails and a candidate exists; Check when no candidate exists; Restart to Install when download completes. Disable during checking, show progress while downloading, and show only a busy notice during verify/install/restart. When manual action or recovery is required, no executable update entry point is shown. Judge unsupported-update environments separately under 006.

<a id="不支持更新与诊断about-obs-006--v03"></a>
### Unsupported Updates and Diagnostics (ABOUT-OBS-006 · v`0.3`)

Manual focused scenario: In a real installed environment that does not support updates, the version area shows an unavailable explanation and diagnostic entry point for human confirmation. It is not required in a normal update-capable installation.

<a id="自动下载about-obs-007--v03"></a>
### Automatic Download (ABOUT-OBS-007 · v`0.3`)

Dynamic: Below version information, the “自动下载更新” (“Automatically download updates”) switch and explanation are visible; switch value matches the known user preference for this run. Explanation conveys background preparation and that the user decides whether to restart.

<a id="preview-更新范围about-obs-008--v03"></a>
### Preview Update Scope (ABOUT-OBS-008 · v`0.3`)

Conditional/dynamic: If target channel is Preview, show “Preview 更新范围” (“Preview update scope”) area with two scope explanations; selected value in dropdown matches the known update strategy for this run. Show corresponding restriction if a specific target is already set or state is restricted. Do not show the area for other channels.

<a id="切换版本线about-obs-009--v03"></a>
### Switch Version Line (ABOUT-OBS-009 · v`0.3`)

Conditional/dynamic: In Preview scope area, show “切换版本线” (“Switch version line”) or the specified version/build according to the update strategy for this run. If no target is set and entry is available, target list, empty state, or failure message matches load result. An effective target must be selected before confirmation. Disable entry when not ready, busy, or update-restricted.

<a id="官方支持入口"></a>
## Official Support Entry Points

<a id="官方网站about-obs-010--v03"></a>
### Official Website (ABOUT-OBS-010 · v`0.3`)

Fixed/dynamic: The “官方网站” (“Official Website”) row in the official support section is clear, and its domain identifier matches the domain in the effective site configuration for this run.

<a id="联系邮箱about-obs-011--v03"></a>
### Contact Email (ABOUT-OBS-011 · v`0.3`)

Fixed: Display `the configured support email`. Clicking copies the same address and shows “已复制” (“Copied”) feedback; it does not send email.

<a id="官方社群about-obs-012--v03"></a>
### Official Community (ABOUT-OBS-012 · v`0.3`)

Fixed: Show “官方社群” (“Official Community”) and an entry point meaning “官网导航·社群” (“Official site navigation · community”), without implying the user has joined.

<a id="用户手册about-obs-013--v03"></a>
### User Manual (ABOUT-OBS-013 · v`0.3`)

Fixed: User Manual entry point and explanation meaning “官网·快速开始” (“Official site · quick start”) are clear.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: ABOUT-OBS-001, 003, 010–014. This covers only the scope below, not every detail under these IDs.

About page should show version/build/channel and main support entries such as website, email, community, and manual. Use installed-package metadata for version information; verify entry labels/targets against their original source and observe without opening external pages.

Required reference: target package version/build/channel metadata for this run, client year, and read contract verified for the target instance. The [old-package read record](build.md#当前制品复核) is a clue only; do not use historical installed version or reference-image values as current expectations.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: copy version, update check/download/install, automatic download, and switching version lines. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.
