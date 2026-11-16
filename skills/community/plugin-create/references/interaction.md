# Host surfaces and workflow state

Discover the active contract with `scholarseed_bridge` → `component/catalog`. Pass a specific `slot` for its full contract. Catalog entries describe a surface; they do not create authorization or establish that a business handler is available.

| Requirement | Current host route |
| --- | --- |
| Reusable conversation result | An installed private slot with a fixed `openui` layout; publish with `component/display`. Discover primitives with `{include_ui: true, ui_mode: "declarative"}`. The public `conversation.ui` accepts a document, not the private slot's business JSON; do not substitute it for a packaged layout. |
| Choice or authorization | Use native user input or the operation owned by the domain. For example, literature authorization uses its own host operation and returned grants, not a generic card answer. Continue dependent work only on the actual successful decision. |
| Task Canvas | Discover with `{slot: "canvas.ui", include_ui: true, ui_mode: "canvas"}`. Canvas has its own document contract: use display without interaction, or request with a supported interaction and output schema. It is not a fixed conversation slot or a generic graph editor. Use only verified Canvas components and actions. |
| Independent custom workbench | A packaged sandbox component can declare `workbench: true` when the host supports that route. This is a separate executable surface with a package-local entry and the host `window.plugin` bridge, not an OpenUI layout. Use only if it meets the requirements without the shared plugin UI SDK and is within the agreed design; never use it as an automatic fallback. The host moves the same instance; do not add a navigation button or open another window. |

## Fixed OpenUI layout

Require descriptor support for `openui`. Declare the component ID, private slot, `input_schema`, fixed tree and JSON preview in schema 2. Omit `entry`, `ui`, `workbench` and actions for this path.

```json
{"component":"Conversation","args":[[{"component":"TextContent","args":[{"field":"summary"}]}]]}
```

Use registered names and positional arguments from the active declarative catalog, not the developer gallery or sandbox catalog. Arguments are literals, arrays, nested nodes or `{"field":"name"}`. Bind required top-level fields with scalar or array-of-literals schemas. Field values cannot provide component names, markup, actions or code.

Preview with `{"data": {...}, "responses": {}}`. The generated Skill checks its installed slot and calls `component/display` with `{request_id, slot, title, data}` (optional `prompt` is not a title). Send only real business JSON in `data`; Desktop binds the values and renders the fixed tree. Do not send source or call `component/request` for this slot. Use summaries, stable IDs and source pointers within `bridge_request_max_bytes`, measured in UTF-8.

## Decisions, drafts and receipts

Treat the request, editable state, saved draft, final answer and artifact as separate records. A successful answer advances dependent work; cancellation, expiration or unknown outcomes do not. Reuse confirmed values for unaffected steps. Use a new request ID for a new result, stage or revision; check the original outcome before an identical transport retry. Do not repeat a business effect to recover an unknown response.

For an agreed sandbox workbench, use the host's `window.plugin` contract from `prepare`, without `window.scholarseedUI`, network, host DOM, popups or standalone HTML. A display card has no pending answer; use `component/request` only when an actual declared answer is needed. Validate submitted values against the action's input schema and component's output schema, not against the outer `{action, values}` envelope.

Keep local edits separate from host data and draft; restore explicit empty values and preserve unsaved changes on state, theme or locale updates. Read the latest edits when saving or submitting. Mark a draft saved only after its receipt and do not overwrite later edits with an older receipt. Wait for the host state after submission; retain the final values for read-only review. If copy is required, register current content through the host contract after the saved revision updates.

A custom submission cannot grant source access, navigate or perform native business actions. Use the owning handler and verify its actual result; declaring an action does not create a handler. If a required action or state transition is missing, expose the gap before packaging.
