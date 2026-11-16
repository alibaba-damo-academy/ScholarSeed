# Declarative Result Display

Use official ScholarSeed conversation components when the task benefits from a visual result. Do not force cards into ordinary text answers. User input, execution progress, confirmation, clarification, and error recovery use the existing native product flows, not generated cards or forms.

## Use the Bundled Signatures

For ordinary display, read the bundled [Conversation signatures](../conversation.md) before calling the catalog. If the host reports a version mismatch or an unavailable component, use the model's `scholarseed_bridge` tool to fetch the current catalog:

```json
{"capability":"component","operation":"catalog","request":{"include_ui":true}}
```

The returned `components` list contains currently bindable slots. By default the response includes only `ui.declarative`: the registry-generated OpenUI Lang schema, groups, and prompt. Use it for declarative composition rather than maintaining a separate fixed component list. Only executable custom plugin authors pass `ui_mode: "sandbox"` to get the separate `ui.catalog`. The two catalogs are not returned together, to stay within the Bridge response budget. A catalog does not grant execution permission. A declarative descriptor has only `format: "openui-lang"`, `version: 1`, and `source`. Do not also generate A2UI, React, or HTML. If discovery fails, state what is unavailable instead of guessing components or fields.

Load details on demand. The default `components` list gives slot summaries; pass the exact `slot` when you need the full input and output schemas for a domain slot. Declarative mode returns the generated prompt and positional signatures by default; request `ui_detail: "schema"` only when you need the full JSON Schema. Do not load both large bodies at once. An unknown slot returns an empty list; do not invent capabilities or bypass discovery by reading host source.

Use `slot: "conversation.ui"` for declarative display. This example is synthetic; replace its data with verified values when making an actual call:

```json
{"request_id":"analysis-summary","revision":0,"title":"Analysis summary","slot":"conversation.ui","data":{"format":"openui-lang","version":1,"source":"root = Conversation([TextContent(\"Explain the data and measurement scope.\"), BarChart([\"A\", \"B\"], [Series(\"Score\", [3, 5])]), Table([Col(\"Method\", [\"A\", \"B\"]), Col(\"Score\", [3, 5], \"number\")]), TextContent(\"Explain the findings and limitations.\")])"}}
```

`conversation.ui` supports only `component/display`; do not use `component/request` to ask for a decision. In the same turn, reuse the same `request_id` to update an existing display in place and increase `revision` by one each time. Reuse the same revision only for an identical transport retry. Use a new ID for another turn or display. Local sorting, filtering, legend controls, expansion, and opening resources neither resume the agent nor confirm a decision.

If catalog discovery, publication, or version verification fails, report the gap. Do not read or copy host source, databases, caches, or internal state to bypass discovery, version, or authorization checks. Do not use internal dispatch or fabricated events as evidence of success.

The registry does not expose forms, input controls, confirmation or cancel buttons, or submission actions. Use the model's native clarification tool when needed. Use the applicable domain tool for authorization and wait for its actual receipt. Cancellation, failure, expiry, and unknown outcomes are not confirmation. Do not generate `Query`, `Mutation`, scripts, regex validation, generic MCP calls, or fabricated execution or failure states.

Citations and artifact navigation are not declarative components. Preserve real citation links and use native file cards produced by successful publication. Do not generate `Citation` or `Artifact` components or fabricate evidence handles or artifact IDs.

Use these five categories as discovery entry points, not as a separate component allowlist:

| Category | Components and Guidance |
| --- | --- |
| Text and rich content | Choose TextContent, Table, and other types from the bundled signatures. Prefer native Markdown for complex code and formulas; see [Rich Content](content.md) for dedicated compositions. |
| Charts | Use actual types and variants in the current registry, such as BarChart, LineChart, and PieChart. See [Rich Content](content.md). |
| Research results | For Results, References, and Review, follow [Research Evidence](evidence.md) and use the existing literature tools and real objects. |
| Citations and evidence | Use native Markdown citations and source links. See [Research Evidence](evidence.md) and inspect sources only as authorized. |
| Artifacts and workbench | Use native file cards after publication, the workbench, or a standalone Canvas. See [Workbench](workbench.md) and [File Delivery](../../scholarseed-bridge/guides/artifacts.md) as needed. |

A component name is not a callable slot. Put OpenUI components in `source` and call `conversation.ui`. Domain cards for literature authorization, downloads, and delivery still come from their domain tools; do not fabricate their state with generic descriptors. Read [Card Authoring](authoring.md) or the dedicated contracts below only when executable custom code or a specialized composition is necessary. These run in an isolated sandbox.

## Choose Display or Interaction

These isolated compositions are for cases that need a domain extension. Use `conversation.ui` for ordinary charts and tables.

| Data and Goal | Slot | Guide |
| --- | --- | --- |
| Task canvas or interactive page | `canvas.ui` | [Canvas](canvas.md) |
| Statistical plots or selection from original rows | `plot.view` / `table.view` | [Charts and Formulas](content.md) |
| Formulas, native Markdown, code fences, or diagram fences | `formula.view` / `markdown.view` | [Charts and Formulas](content.md) |

Use `component/display` for display-only compositions. Use `component/request` only when further work depends on a user decision, and state what the user needs to decide. Read the bundled operation contracts and map real data using the guide and the actual slot schema. Do not present synthetic examples as results. The envelope must contain `request_id`, `title`, `slot`, and `data`. The slot schema applies only to `data`, not the envelope. These custom slots need a new ID for changed arguments or revisions; reuse an ID only for a transport retry with identical arguments. Do not apply the in-place update rules of `conversation.ui`. Stay within the current Bridge byte limit rather than sending entire documents or many unrelated cards.

Introduce the result in plain language, show the relevant card, then explain the finding. Keep each card focused on the current question and explain the data scope, sources, and conclusion. Send multiple cards at the relevant workflow steps rather than building one long page. Keep slot names, versions, state machines, and debug logs out of ordinary answers unless the user is designing or debugging. Do not restate card contents as a long checklist; summarize the outcome briefly and omit recovered internal retries that did not affect it.

A successful request returns its answer in `result.answers`. Data selection uses `{action, values: {selected: [stable row IDs]}}`; Canvas returns the current JSON described by its `output_schema`. Continue from that result without asking for confirmation in text. Cancellation, failure, expiry, and unknown outcomes are not confirmation. Local actions and draft saves do not resume the agent. Successful display does not prove file publication, citation verification, tool execution, full-text authorization, or skill installation.

See [Card Authoring](authoring.md) for creating or customizing cards with the official UI. Discovery, declarations, and preview examples grant no network, filesystem, clipboard, host DOM, or arbitrary external-link access.
