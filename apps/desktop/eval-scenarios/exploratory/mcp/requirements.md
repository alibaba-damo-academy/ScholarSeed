<a id="mcp-历史要求与当前入口映射"></a>
# Historical MCP Requirements and Current Entry Mapping

Current entry point: Main interface **“扩展” → “连接器”** (“Extensions” → “Connectors”), explicitly confirmed by the user on 2026-10-31. The current quick review is merged into the [Connectors baseline](../connectors/requirements.md#发布快评层) and is not counted as a separate page. MCP-OBS-001–003 and v`0.3` are retained for requirements traceability; disappearance of the old Settings entry does not establish that MCP capabilities are missing.

The business criteria below retain their old IDs and do not require restoring the removed standalone Settings page. See the Connectors document for the currently selected status, directory, and add-form subcriteria, as well as old fields without a mapping. This does not claim that all details under the old IDs have been completed after migration.

See the [Connectors document](../connectors/requirements.md) for current-version reference images of the connector and its unsubmitted form.

Current connector form, not submitted

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; this shows only an unfilled, unsubmitted form and does not prove connection or authorization.

Connector counts, connection state, and pending-apply state vary with the environment; the values shown in the reference image are not fixed.

<a id="查看现状"></a>
## Inspect Current State

<a id="状态摘要mcp-obs-001--v03"></a>
### Status Summary (MCP-OBS-001 · v`0.3`)

Fixed: The title, purpose statement, and refresh entry point are clear. Dynamic: The server totals in the summary and the ready, failed, waiting, pending-authorization, and disabled counts match the current read-only MCP state in this instance. Unread, failed, or unsupported states have corresponding messages and are not presented as successful connections.

<a id="服务器列表mcp-obs-002--v03"></a>
### Server List (MCP-OBS-002 · v`0.3`)

Conditional: When the current configuration is empty, show an unconfigured-state message. When configuration exists, server names, transport types, enabled states, and connection/tool states correspond to the read-only state from the same instance. If the tool count is not returned, do not infer readiness.

<a id="查看添加入口"></a>
## Inspect the Add Entry Point

<a id="添加表单mcp-obs-003--v03"></a>
### Add Form (MCP-OBS-003 · v`0.3`)

Fixed/conditional: The form has an Add Server group, transport selector, name, identifier, and add entry point. For HTTP, show a URL; for stdio, show a command and arguments. Disable adding while reading/saving or when the current capability is unsupported. Check only the transport selected naturally; do not infer submit validation from whether the empty-form button is disabled.

<a id="发布快评层"></a>
## Release Quick-Review Layer

For the feature identities MCP-OBS-001–003 at v`0.3`, review the naturally observed current state, My List/empty state, and unsubmitted add form in the [Connectors quick-review layer](../connectors/requirements.md#发布快评层). The six summary counts, refresh behavior, and all transport branches from the old page are not automatically required to reappear verbatim in the new layout. The original detailed criteria remain historical full requirements and migration items pending verification; this run claims only the selected sub-scope.

Use the current public connector directory, naturally occurring installation/authorization state, and in-package form defaults/display conditions as necessary references. Do not read configuration contents or secrets. Do not probe a Settings bypass to find the old entry point, use failure from the old status API to block the current public connector directory, or count coverage of the same page twice.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: refresh, adding, transport switching, connection/authorization, and tool invocation. Preserve the original full criteria, stable IDs, versions, and historical results. An unconfirmed branch is not authorized merely because the layer was approved.
