<a id="mcp基线构建依据"></a>
# MCP Baseline Build Basis

Current asset revision: `mcp/6`. On 2026-10-31, verification ownership was corrected to match the user's explicit MCP entry semantics; use the [current Connectors implementation](../connectors/build.md#mcp承载映射). As requested, the obsolete UI reference image was removed and the current Connectors reference image linked. The original business criteria, stable IDs, and v`0.3` are retained; the old layout does not need to be restored.

Historical asset creation note: revision mcp/3 (reference image added only; revision 1 criteria unchanged). The user selected the existing functionality in the specified build; three items were auto-displayed in the quick review and first included at v`0.3`.

Source: macOS arm64 0.3.0 / 202610281438 / preview; `app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. The bounded comparison was against `McpSettingsPage` at line 75303 in the installed renderer's `assets/index-C4-PYlXk.js` and the corresponding `apps/desktop/src/renderer/src/components/business/McpSettings.tsx` at that time (this file is absent from the current source tree). This does not establish a mapping for the entire repository.

| Criterion | Fixed / dynamic / conditional behavior and source |
| --- | --- |
| 001 | `status` returns `configuration.servers` and server states. The waiting count is `connecting` plus `pending_apply`; other categories are counted by state. `unsupported`, `pending_apply`, and `safe_error` each have a corresponding message. |
| 002 | Empty state depends on the length of `configuration.servers`. If state is missing, enabled items fall back to `pending_apply` and disabled items to `disabled`. An unknown `tool_count` must not be treated as ready. |
| 003 | In `AddServerForm`, the naturally selected HTTP transport shows URL; stdio shows `command`/`args`. Disable Add while loading, saving, or unsupported. Required-field validation runs on submit; the empty-form button is not required to be disabled. |

Use the existing public preload `mcpSettings({operation:'status'})` for an independent reference. Retain only allowlisted fields: `supported/state`, server `id/name/transport/enabled`, and state/`tool_count`, plus the necessary `supported/pending_apply/safe_error` fields. Do not persist full headers, URL queries, command arguments, or other secrets. Capture the form through its bottom; do not refresh, change transport, add, enable/disable, or remove. Actual tool invocation and authorization are separate focused scenarios.

The historical reference image was an unchanged copy of the original `mcp.png`, SHA256 `2f237b8626fb0eaa2cf5dd79d9df737b0af23fda792233dfe14cbbb427b57bf5`. The old UI has been removed, and the local reference copy was deleted at the user's request. Do not write back to the historical frozen revision.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision was `mcp/3`. In response to the user's pre-release quick-review goal and the unified adoption rules, the quick-review and focused-scenario layers were added to the same requirements document. They reuse the source binding and existing Review on this page. The old business version v`0.3` and full criteria remain unchanged. The selected source is the explicitly stated subcriteria under MCP-OBS-001–003; the necessary reference is the minimum public, read-only server state from the same instance, without environment variables or secrets. Not selected: refresh, adding, transport switching, connection/authorization, and tool invocation. Any part lacking evidence remains pending confirmation.

This only completes pre-execution layering. It produces no product pass result and does not supersede historical full runs. Later runs consume the subcriteria frozen by a separate Review; a quick-review result must not be described as covering the full original IDs. This build added no product operations or data-write permissions.


<a id="当前制品复核"></a>
## Current Artifact Recheck

Historical asset revision: `mcp/4` (2026-10-30). At that time, only artifact location and independent-reference details were incrementally updated; stable IDs, v`0.3`, full criteria, quick-review/focused-scenario boundaries, and results were unchanged. Package numbers, old source line numbers, layering revisions, and results are historical records, not package bindings or pass results for this run.

This run's source is the inspected installed build `0.3.0 / 202610301343 / preview / macOS arm64`; app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Direct evidence is the actual unpacked release file `renderer/assets/index-CddcCmKt.js`, SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`; compiled functions/line numbers below refer to this file unless another file is named. The referenced `out/preload/index.js` has SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`; `out/main/index.js` has SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`; the file containing preference constants, `renderer/assets/AccountMenuPanel-CHQ1thBC.js`, has SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`. No source commit is bound. Repository Owner links above are auxiliary references only; checkout or remote HEAD is not equivalent to this package.

- The original entry point and criteria are retained. This run checked `NAV_ITEMS:79428` / `visiblePage:79457` / `SettingsContent:83461`; no old standalone mcp navigation or old `McpSettingsPage` rendering branch was found. A bounded search of extracted renderer chunks also did not locate that old component. This is an accessibility gap in the inspected entry-point chain, not proof that all capabilities are absent. Do not delete MCP-OBS-001–003 or claim the migration was adopted on this basis.
- The public state bridge remains: preload `mcpSettings:293` → main `mcpSettingsRequest:27791`, with operation=status → GET `/api/settings/mcp`, returning `{status,body}`. A 200 response parses top-level `supported/state/configuration/servers` from `body`. Project only `id/name/transport/enabled` from `configuration.servers` and `state/tool_count` from state items, plus necessary `supported/pending_apply/safe_error` fields. Do not persist configuration contents, URLs, headers, environment, commands, or arguments. State and configuration arrays must not be conflated as one list.
- `getMcpConfiguration:3323` is used by Connectors/CustomConnector; this does not prove the old standalone page is reachable. A later run must first verify the real entry point. Do not substitute the connector's custom form for the old page, fabricate a page screenshot from a bridge response, or skip it as inapplicable because it was not reached. Adoption and applicable version for restoring/removing/migrating the entry point remain unconfirmed; retain the original quick-review gap.
- Because the old page is not bound to the current component, historical criteria for count fallbacks, summaries, and `AddServerForm` remain historical requirements only. Do not present old line numbers as implementation locations for this run. Reading the bridge does not prove that the UI or tool invocation passed.

This run inspected only the extracted artifact and the asset. It did not start/connect to the product, read user state, or make a request; it produced no new runtime screenshot or product acceptance result. A later run still needs an independent reference from the same authorized instance and time window. Missing, stale, or failed references cannot be self-certified from the page under review.
