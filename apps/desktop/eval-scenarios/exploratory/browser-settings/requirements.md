<a id="浏览器设置展示"></a>
# Browser Settings Display

Inspect the built-in browser's password-vault state, download preferences, and access policy. Entry point: main interface Settings → Browser; shown only if the product has enabled browser capability.

Complete-window reference for browser settings: top

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13. Shows the top of Settings and password-vault state. The image contains the local username, download directory, and local port, but not a complete connection key; it does not prove download or authorization operations.

Complete-window reference for browser settings: advanced settings

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13. The complete Settings window is scrolled to advanced settings; areas not visible are not covered by this image. Port, switches, site rules, and vault state vary with the environment; values shown are not fixed expectations.

Complete-window reference for browser settings: rules section

Reference: same target build, 2026-11-13. Complete window showing external automation and Agent website-rule sections. Port, switches, and site rules are dynamic; the image does not contain a complete connection key and does not prove rule editing, Agent authorization, or CDP connection.

Reference of actual state for browser-data-clearing options

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13. Complete real window showing clearing options; no clearing was performed. **The type-checkbox area in the image conflicts with adopted BROWSER-SET-006 and the frozen expectation for this run; this is not a correct expected-result image.** Requirement Owner confirmation of the difference remains pending. The website-data explanation also remains an evidence gap.

<a id="了解当前设置"></a>
## Inspect Current Settings

<a id="页面与分区browser-set-001--v03"></a>
### Page and Sections (BROWSER-SET-001 · v`0.3`)

Fixed: The title “浏览器设置” (“Browser Settings”), purpose statement, and selected navigation are consistent. The Password Vault, External Browser Automation, Downloads, Agent Website Rules, Browsing History, and Clear Browsing Data sections are reachable. In this run, inspect only the Browsing History section title and search entry point; history-item contents belong to the history feature.

<a id="密码库状态browser-set-002--v03"></a>
### Password-Vault State (BROWSER-SET-002 · v`0.3`)

Dynamic: Vault state matches the public state of the local vault. `uninitialized` shows a create entry point; locked shows an unlock entry point; unlocked shows lock and the saved-item count. Conditional: When unavailable or unlocking/locking, do not allow create, unlock, or delete. Invalid format cannot be unlocked. An error that has occurred must have an explanation; never display the master password or credential contents.

**Supplementary user-confirmed rule (requirement version pending confirmation):** When vault state is “unavailable” and the interface returns `revoked`, showing only “unavailable” is sufficient; no additional error explanation is required. Other errors retain the original behavior. The user confirmed this rule for a new run on the current target build; the requirement version and broader applicability across versions remain unconfirmed.

<a id="外部自动化状态browser-set-003--v03"></a>
### External Automation State (BROWSER-SET-003 · v`0.3`)

Dynamic: The CDP switch corresponds to the current browser-automation state. When enabled with a port, show a localhost `127.0.0.1` address and port plus a copy entry point; otherwise show that access is closed and there is no listening address. Fixed: Explain that permission applies only to built-in webpages, does not expose the product's main interface, and includes warnings about trusted applications and key-sharing risks. Do not display a full address containing a key directly on the page.

<a id="下载偏好browser-set-004--v03"></a>
### Download Preferences (BROWSER-SET-004 · v`0.3`)

Dynamic: Download folder, ask-every-time switch, and availability match current download settings. When the default folder is in use, the restore-default entry is disabled; an unavailable directory has a notice. If the platform does not support safe automatic saving, disable the ask switch and explain that saving via another method is still required. Fixed: The choose/restore-folder entry points and explanation that Agent standalone sessions cannot download are clear.

<a id="理解访问与清理边界"></a>
## Understand Access and Clearing Boundaries

<a id="agent访问与网站规则browser-set-005--v03"></a>
### Agent Access and Website Rules (BROWSER-SET-005 · v`0.3`)

Dynamic: The Agent Browser Use switch matches current policy; when off, show a notice that reading is not authorized. Site origin and read/interaction decisions match current website rules; an empty list has an explanation. Conditional: After policy is successfully read, the add section has website, action, decision, and Add entry points; Add is disabled when website is empty. A read failure shows unavailable state and Retry instead of an empty list. Fixed: Explain that these rules are not external CDP permission or submission authorization.

<a id="清理入口与默认范围browser-set-006--v03"></a>
### Clear Entry Point and Default Scope (BROWSER-SET-006 · v`0.3`)

Fixed: On first entry, the clearing scope is “最近一小时历史” (“History from the last hour”); the Clear entry point and scope explanation are visible. Explain that the time range applies only to history, website data is handled by site, and downloaded files are not deleted. The current default scope does not show a site field or type-checkbox area. Showing the entry point does not prove data was cleared.

<a id="发布快评层"></a>
## Release Quick-Review Layer

<a id="高级设置下线默认产品配置"></a>
### Advanced Settings Disabled (Default Product Configuration)

Retain the browser entry point and history management from BROWSER-SET-001, download state from 004, and clear entry point from 006. Advanced settings, password vault, external CDP, and Agent website rules are absent. Older display details for 002, 003, and 005 apply only to a configuration where advanced capability is explicitly enabled. On the independent history page, inspect only the entry point, search, and back navigation; do not extract user history text. Verify the product's search fallback as a separate flow; a settings screenshot is not a substitute.

<a id="历史快评范围高级能力显式开启"></a>
### Historical Quick-Review Scope (Advanced Capability Explicitly Enabled)

Adopted normal v`0.3` subcriteria: BROWSER-SET-001–006. This covers only the scope below, not every detail under these IDs.

Password-vault, external automation, downloads, Agent access/website rules, and clearing sections are distinguishable. Compare natural vault state, CDP switch/loopback port, download location/ask switch, Agent access switch/site rules, and default clearing scope with secure references. Scroll as needed for the long page. Do not add full-control details, such as the old 004 rule that Restore default is disabled, to the quick-review gate; full requirements remain preserved.

Required references: check minimum projections for vault state, automation, downloads, and policy against the target instance's actual contract. The [old-package read record](build.md#当前制品复核) is a clue only; do not obtain passwords, credentials, or history entries.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: vault creation/unlock, history text, preference edits, CDP copying/access, rule editing, and actual data clearing. The default-scope display for clearing remains in the quick-review layer. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.
