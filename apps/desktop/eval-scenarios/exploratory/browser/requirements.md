<a id="内置浏览器使用候选需求"></a>
# Candidate Requirements for the Built-in Browser

<a id="用途与入口"></a>
## Purpose and Entry Point

The built-in browser opens and displays webpages in the project workbench. Current source points to the “浏览器” (“Browser”) entry in a new workbench tab; visibility depends on browser capability. The target installed build's entry point, requirement version, and applicability remain unverified. This page is a candidate based on historical requirements and source clues, not an adopted criterion or runtime result.

**Reference screenshot gap:** No complete-window screenshot has been verified as source-traceable and approved for reuse for real webpage browsing in the target version. A settings page or blank page cannot substitute for webpage browsing and its result. See the [Build Basis](./build.md) for whether historical screenshot paths are available.

<a id="候选主流程"></a>
## Candidate Main Flow

<a id="网页打开与导航browser-cand-001需求版本待确认"></a>
### Open and Navigate to a Webpage (`BROWSER-CAND-001`; requirement version pending confirmation)

In an authorized isolated browser, open a controllable test webpage from the verified entry point and reach a distinguishable target through real address input or page navigation. Use a prepared page identifier and address as independent references; verify the target actually displayed and that the page is readable. If back, forward, or refresh is selected, observe the corresponding page-state change. A toolbar, navigation receipt, or tab with a matching name does not substitute for an actually loaded webpage. Page contents, browser tabs, and history change with natural use.

<a id="页面查找browser-cand-002需求版本待确认"></a>
### Find Text on a Page (`BROWSER-CAND-002`; requirement version pending confirmation)

Find known text on a loaded webpage whose content can be checked independently. Verify that the query, visible matches, and navigation feedback correspond to the target page. Historical real observation showed that a match could be navigated to, but the number of matches and website content are not fixed expectations; showing the find box is not a substitute for a match. Different languages, dynamic pages, focus behavior, and cross-platform behavior are separate focused scenarios.

<a id="候选专项与关联"></a>
## Candidate Focused Scenarios and Associations

<a id="网页缩放browser-zoom-cand-001需求版本待确认"></a>
### Webpage Zoom (`BROWSER-ZOOM-CAND-001`; requirement version pending confirmation)

Historical confirmation says the browser menu includes zoom out, zoom in, percentage, and reset to 100%; the historical plan requires zoom in same-origin tabs to be independent. Use an authorized real webpage, separate tabs of the same origin, and independently observed zoom states as references; verify actual display and reset. Do not substitute PDF or image zoom. Target-version applicability and complete-window image remain unverified.

<a id="网页可视区截图browser-capture-cand-001需求版本待确认"></a>
### Capture the Visible Webpage (`BROWSER-CAPTURE-CAND-001`; requirement version pending confirmation)

Historical confirmation says the menu includes a screenshot of the visible webpage and a save action. Use the actual visible content of the same authorized webpage and disposable output as references. Distinguish triggering, native save, cancellation, and file end state; an evaluation evidence screenshot is not a substitute. Target version and native save behavior remain unverified; separately verify file writes and platform permissions.

<a id="网页开发者工具与设备工具栏browser-devtools-cand-001browser-device-toolbar-cand-001需求版本待确认"></a>
### Web Developer Tools and Device Toolbar (`BROWSER-DEVTOOLS-CAND-001`, `BROWSER-DEVICE-TOOLBAR-CAND-001`; requirement version pending confirmation)

Historical confirmation says the menu includes Developer Tools and a device toolbar. Verify the entry point, real open/close behavior, and host layout separately for each. The device-mode proposal and target-build support remain unconfirmed; one entry point does not substitute for the other, and source alone does not prove implementation. Verify the real webpage, window side effects, platform, and authorization separately.

<a id="打印网页browser-print-cand-001需求版本待确认"></a>
### Print a Webpage (`BROWSER-PRINT-CAND-001`; requirement version pending confirmation)

Historical user confirmation says the full browser menu includes Print and canceling print is not a failure. Use the same authorized real webpage and the target platform's native print flow as references. Distinguish opening, cancellation, and actual print end state; a menu item or closed dialog does not prove it was printed. Target-build entry, requirement applicability, complete window image, and cross-platform behavior remain unverified. Separately authorize system printing, output destination, and possible writes; do not substitute a simulated event or another browser.

<a id="浏览历史历史-browser-history-011产品需求版本待确认"></a>
### Browsing History (historical `BROWSER-HISTORY-01@1`; product requirement version pending confirmation)

Auxiliary reference: empty browser-history state

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13. Complete window showing an isolated instance's empty history, search, and clear entry points; auxiliary reference only, not proof of searching non-empty history, webpage browsing, clearing, or candidate adoption.

For history naturally produced by public synthetic pages in this run on an authorized isolated instance, search by time or site and check records against real navigation and the filter scope. Clearing/deleting changes potentially irreversible state; separately verify recoverability and explicit authorization. Historical `@1` is an asset revision, not a product requirement version. This historical item is `pending / exploratory`, and the corresponding historical case is unapproved and outside the frozen scope; it does not automatically count in the target's adopted denominator.

The exact semantics of historical “search by time” remain unconfirmed. Date-grouped display does not automatically equal date filtering. Current source in the build analysis is only a clue for title/address text matching and date grouping; whether the target build behaves this way, requires time filtering, or has specific day-boundary behavior remains unverified. For a historical focused scenario, record actual navigation target and time as independent references; observe search, open, and delete separately. A search result appearing does not mean the target webpage was reopened.

<a id="agent-网页访问确认browser-auth-cand-001需求版本待确认"></a>
### Agent Webpage Access Confirmation (`BROWSER-AUTH-CAND-001`; requirement version pending confirmation)

Historical user confirmation says a pending access request displays its target and authorization scope in a card, and the state after allow, deny, or expiry matches the real result. Allowing access once does not mean subsequent webpage operations succeeded. Real triggering depends on an independent Agent session, available model, and authorization; do not prepopulate bridge events or use a settings-page toggle instead of a real request. Target-build applicability and other authorization states remain unverified.

<a id="下载与浏览数据清理"></a>
### Downloads and Browser-Data Clearing

Download prompt, progress, save location, and actual file creation, as well as the scope, confirmation, and real result of clearing history/site data, remain focused scenarios pending confirmation. The [browser settings display baseline](./../browser-settings/requirements.md) alone does not prove real download, clearing, or Agent authorization; do not create duplicate settings-page criteria. Product navigation may access the network and record history; downloads and clearing also write or delete data. Verify the instance, target, cost, and authorization separately.

<a id="数据参照与缺口"></a>
## Data, References, and Gaps

Use an isolated instance whose capability is enabled and ownership can be verified, an authorized controllable webpage, and independently known expected text. Record the test page's source and access side effects. Do not use real user history, passwords, or credentials. Do not substitute code injection, fabricated navigation, preselected permissions, or fabricated results for the product path. A [synthetic webpage source manifest](../../../../../examples/projects/browser-navigation/project.json) is prepared but has not been confirmed as a usable browser test site. If the service, network, or permission is missing, record the gap; the presence of repository files does not prove a webpage is reachable.

Local sites must also be checked against the product's existing access policy and reachability; do not relax the policy to load an evaluation page. Address suggestions may show history and external web-search items. Select one only with authorization to avoid accidentally sending input or test content to an external search service.

This page's entry point, target-version adoption, successful webpage state, and complete real window screenshots of webpages and non-empty history remain unverified. Freeze authorization, downloads, clearing, and cross-platform behavior separately; do not infer completion from ordinary webpage navigation or settings display. Record requirement version, source revision, asset revision, and tested-package identity separately in the [Build Basis](./build.md).
