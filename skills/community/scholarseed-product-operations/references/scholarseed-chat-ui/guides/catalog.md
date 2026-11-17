# Component Catalog Recovery

**English** · [简体中文](catalog.zh.md)

Read only when required signatures are missing, mismatched or unavailable, or
an executable custom plugin needs sandbox exports. Do not query the catalog
before using valid same-release bundled signatures.

Use the actual `component/catalog` contract through the
[Bridge protocol](../../scholarseed-bridge/README.md).
For declarative display request `{"include_ui":true}`.
For Canvas request `{"slot":"canvas.ui","include_ui":true,"ui_mode":"canvas"}`.
Do not infer capabilities from examples or inspect host source to replace discovery.

The returned `components` list contains currently bindable slots. By default the response includes only `ui.declarative`: the registry-generated OpenUI Lang schema, groups, and prompt. Use it for declarative composition rather than maintaining a separate fixed component list. Only executable custom plugin authors pass `ui_mode: "sandbox"` to get the separate `ui.catalog`. The two catalogs are not returned together, to stay within the Bridge response budget. A catalog does not grant execution permission. A declarative descriptor has only `format: "openui-lang"`, `version: 1`, and `source`. Do not also generate A2UI, React, or HTML. If discovery fails, state what is unavailable instead of guessing components or fields.

Load details on demand. The default `components` list gives slot summaries; pass the exact `slot` when you need the full input and output schemas for a domain slot. Declarative mode returns the generated prompt and positional signatures by default; request `ui_detail: "schema"` only when you need the full JSON Schema. Do not load both large bodies at once. An unknown slot returns an empty list; do not invent capabilities or bypass discovery by reading host source.

Report missing slots or failed discovery and stop dependent composition. Discovery
is not permission, publication, successful rendering or a user decision.
