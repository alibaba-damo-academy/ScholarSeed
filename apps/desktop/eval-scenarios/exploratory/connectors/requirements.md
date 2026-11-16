<a id="连接器列表与详情"></a>
# Connector List and Details

## Target-Version Connector Market Reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows the naturally occurring market state only; does not prove connector configuration, authorization, or tool invocation.

## Target-Version Connector Form, Not Submitted

Reference: same target build, 2026-11-12. HTTP empty form in a complete window, not filled or submitted; does not prove preview, saving, or connection.

## Target-Version STDIO Empty-Form Reference

Reference: same target build, 2026-11-12. Unsubmitted, empty STDIO form in a complete window; shows only command and argument entry points. Does not prove switching, preview, saving, command execution, or connection.

## Current Connector-Market Reference

## Current Connector Form, Not Submitted

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12. The form was not filled or submitted; does not prove connection, authorization, or tool invocation.

Find connectors and inspect connection guidance, current state, and visible tool information. Entry point: main interface “扩展” (“Extensions”) → “连接器” (“Connectors”); default tab “市场” (“Market”), switchable to “我的” (“My”).

![Connector market reference](./reference.png)

Reference: macOS arm64, 0.3.0 / 202610281438, 2026-10-29. Directory, installation, and authorization state vary with the environment; displayed values are not lasting expectations.

<a id="查找连接器"></a>
## Find Connectors

<a id="入口与市场目录connector-obs-001--v03"></a>
### Entry Point and Market Directory (CONNECTOR-OBS-001 · v`0.3`)

Fixed: Connector navigation, Market/My tabs, search, and Add entry point are clear; the selected tab matches the content. Dynamic: Market shows non-custom connectors from the current public directory. Names, current-language descriptions, and supported-authentication/authorization-state badges match the directory and product copy. Keep installed items visible. Loading, read failure, and genuinely empty state have distinguishable feedback.

<a id="我的目录与卡片状态connector-obs-002--v03"></a>
### My Directory and Card State (CONNECTOR-OBS-002 · v`0.3`)

Dynamic: My shows only currently installed connectors, including built-in and custom items. If none are installed and no search is active, show an empty state and Add entry point. Market's installation indicator matches current installation state. For authorized items, the task switch is selected when authorization is present and enabled. Unauthorized items show the applicable authorization or custom-edit entry point; they cannot be toggled directly to enabled. Showing an entry point does not prove its action succeeded.

<a id="搜索与范围组合connector-obs-003--v03"></a>
### Search and Scope Combination (CONNECTOR-OBS-003 · v`0.3`)

Dynamic: Within the current source, search by name, current-language description, or source address; ignore case and surrounding whitespace. Show a no-match message and restore results when cleared. Switching between Market/My retains the query and filters within the new scope. Do not apply skill-page category or per-tag keyword rules.

<a id="查看连接器"></a>
## Inspect a Connector

<a id="详情说明与元数据connector-obs-004--v03"></a>
### Detail Description and Metadata (CONNECTOR-OBS-004 · v`0.3`)

Dynamic: Details are available even when not installed. Title, description, source domain or identifier match the selected directory item. Transport protocol, supported authentication methods, and service address are clear; if there is no remote address, show a local-process explanation. Fixed: Current details display version identifier 1.0.0; this does not prove the remote service's handshake version is correct. The description area can scroll as needed; closing returns to the list.

<a id="详情安装与授权状态connector-obs-005--v03"></a>
### Detail Installation and Authorization State (CONNECTOR-OBS-005 · v`0.3`)

Conditional: When not installed, do not show the task switch that is only for installed items. When installed, task enablement and authorization information match current state. For an authorized built-in or OAuth connection, non-empty account, scope, and expiry information match public authorization metadata; display expiry seconds in the client's local time zone. Existing errors or revocation notices must not be masked by a normal state. An install, authorization, or task entry point does not prove its action flow passed.

<a id="工具区域与分页connector-obs-006--v03"></a>
### Tool Area and Pagination (CONNECTOR-OBS-006 · v`0.3`)

Conditional: Do not show the tool list when unauthorized. When authorized, distinguish waiting to load, requiring enablement after activation, zero tools, and existing tools; do not treat unknown data as zero. Existing tool count, names, and descriptions match current public tool metadata; if a description is missing, show “暂无说明” (“No description”). If there are more than five tools, show five per page, disable previous/next appropriately on first/last page, and return to page one when switching details. Show an explanation on load failure; do not fabricate a list. Authorization/pagination states not naturally encountered are not considered covered.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: CONNECTOR-OBS-001 and 002. This covers only the scope below, not every detail under these IDs.

Connector-page source tabs Market/My, current directory cards, and naturally occurring installation/authorization state should match the corresponding public directory. Preserve a real empty state when nothing is installed; do not infer connection from a Market card.

The user confirmed the MCP hosting relationship on 2026-10-31. Verify MCP-OBS-001–003 at v`0.3` under the same feature identities, merged with this page:

- **Status (MCP-OBS-001 sub-scope):** Current card and selected detail installation/enabled/authorization states match the public directory. Unauthorized does not appear ready or as if tools exist; unknown tool count is not treated as zero.
- **List (MCP-OBS-002 sub-scope):** My contains installed built-in/custom connectors or shows a genuine empty state consistent with the directory. Reuse evidence from CONNECTOR-OBS-002; do not count the same page twice.
- **Add form (MCP-OBS-003 sub-scope):** “添加连接器” (“Add Connector”) opens an unsubmitted form; name and HTTP/SSE/stdio protocol entry points are distinguishable. Natural HTTP shows URL; if naturally set to stdio, show command/arguments. A new form does not need the old standalone identifier field. An empty form cannot be previewed/submitted directly; Cancel returns to the list. Do not enter addresses/credentials or execute preview, save, import, or connect.

The old standalone page's six summary counts, all transport switching, refresh/writes, and error-state matrix remain in [Historical MCP Requirements](../mcp/requirements.md); this layer does not claim full coverage. Current criteria do not require restoring the old Settings-page layout.

Required reference: same-source public directory and minimum installation/enabled/authorization fields in the target instance. [Target-version reuse boundaries](build.md#202611121823-正常展示沿用) require verifying the target package's actual read contract first; [old-artifact review](build.md#当前制品复核) is only a clue. Do not read credentials or configuration contents.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: search combinations, all detail metadata, authorized tools and pagination, installation/authorization/invocation. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.

<a id="连接器配置与工具使用候选专项"></a>
## Candidate Focused Scenarios for Connector Configuration and Tool Use

These are historical exploration requirements and user-confirmed connector-entry semantics. Applicability to the target version, product requirement version, and formal adoption remain unconfirmed; they are outside the adopted quick-review denominator above. Numbers after historical `@` markers are business-point asset revisions, not product requirement versions; see the [Build Basis](./build.md). Existing unsubmitted empty-form screenshots do not prove preview, saving, authorization, connection, or tool invocation.

<a id="无效配置与纠正历史-connector-validate-012"></a>
### Invalid Configuration and Correction (historical `CONNECTOR-VALIDATE-01@2`)

In an authorized isolated instance, enter an invalid URL in an unsaved synthetic draft. Preview should give discernible validation feedback and allow correction; a valid-format draft may proceed to preview or clearly state that it is unavailable. Cancel must not create a configuration. Validation feedback does not prove remote connectivity. Do not execute a STDIO command or use real credentials for verification. Prepare distinguishable synthetic inputs and independent before/after catalog references first; preview may read configuration, so check the target package's actual side effects and authorization.

<a id="批量预览与取消历史-connector-preview-011"></a>
### Batch Preview and Cancel (historical `CONNECTOR-PREVIEW-01@1`)

For two distinguishable synthetic HTTP/SSE configurations, preview names, addresses, and transports match independent inputs. After canceling, reread the authorized isolated catalog and confirm no connector was added. Example addresses are format inputs only, not available services. Closing a dialog or a Save-button receipt alone cannot prove that no configuration was written. Form/JSON round-tripping, duplicates, and failure recovery are separate focused scenarios.

<a id="配置认证与真实工具消费历史-connector-auth-011"></a>
### Configuration, Authentication, and Real Tool Use (historical `CONNECTOR-AUTH-01@1`)

Historical user requirements say that when the authorization page supports both methods, API Key is on the left and OAuth on the right; when a service supports only one, do not fabricate the other. Verify the display against an independent capability reference for the same controllable service; an empty form or source code does not prove authentication succeeded. Target-build applicability and specific service state remain unverified.

In a separately authorized isolated environment, use a dedicated test service and test authentication authorized by the user. Configure or install through the connector entry point, and separately observe authentication, connection, visible tools, and actual tool use in an authorized task. Tool identity matches an independent service directory; consumption results match evidence for the same turn and service. A successful save, authorization entry point, or tool list alone does not mean a real call succeeded. API Key, OAuth, and STDIO are distinct conditions. Separately authorize external login, process execution, configuration writes, network access, and model invocation. Do not read or copy real credentials; revocation/deletion and error recovery are separate focused scenarios.

<a id="数据与截图缺口"></a>
### Data and Screenshot Gaps

The [synthetic connector configuration](../../../../../examples/projects/connector-preview/files/connector-preview.json) may be used as a user-confirmed manual-preview input; identity and digest are in the [Build Basis](./build.md). It is only for manual copying into a JSON draft, uses the reserved `.invalid` domain, and does not provide a real service, authentication, or connectivity. Before preview, verify the isolated instance and configuration-read side effects; do not save or connect automatically. A controllable MCP test service is still missing. Current real complete-window references cover only the Market and unsubmitted empty form; reusable complete-window screenshots are missing for preview, connection, authorization, and real tool-use states. Before execution, confirm requirements and target version, independent references, cost, and side effects. If any necessary prerequisite is missing, retain the gap; do not substitute historical partial observations or simulated source events for the real path.
