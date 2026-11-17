# Custom-Slot Display and Interaction

**English** · [简体中文](interaction.zh.md)

Read for domain extensions or Canvas, not ordinary conversation.ui display.
Use the [Bridge protocol](../../scholarseed-bridge/README.md) and only the selected
component operation contract and slot schema. Prefer bundled same-release schemas;
use [catalog recovery](catalog.md) only when missing or mismatched.

These isolated compositions are for cases that need a domain extension. Use `conversation.ui` for ordinary charts and tables.

| Data and Goal | Slot | Guide |
| --- | --- | --- |
| Task canvas or interactive page | `canvas.ui` | [Canvas](canvas.md) |
| Statistical plots or selection from original rows | `plot.view` / `table.view` | [Charts and Formulas](content.md) |
| Formulas, native Markdown, code fences, or diagram fences | `formula.view` / `markdown.view` | [Charts and Formulas](content.md) |

Use `component/display` for display-only compositions. Use `component/request` only when further work depends on a user decision, and state what the user needs to decide. Read the bundled operation contracts and map real data using the guide and the actual slot schema. Do not present synthetic examples as results. The envelope must contain `request_id`, `title`, `slot`, and `data`. The slot schema applies only to `data`, not the envelope. Changed arguments require a new request ID, including revisions; reuse an ID only for a transport retry with identical arguments. Do not apply the in-place update rules of `conversation.ui`. Stay within the current Bridge byte limit rather than sending entire documents or many unrelated cards.

Introduce the result in plain language, show the relevant card, then explain the finding. Keep each card focused on the current question and explain the data scope, sources, and conclusion. Send multiple cards at the relevant workflow steps rather than building one long page. Keep slot names, versions, state machines, and debug logs out of ordinary answers unless the user is designing or debugging. Do not restate card contents as a long checklist; summarize the outcome briefly and omit recovered internal retries that did not affect it.

A successful request returns its answer in `result.answers`. Data selection uses `{action, values: {selected: [stable row IDs]}}`; Canvas returns the current JSON described by its `output_schema`. Continue from that result without asking for confirmation in text. Cancellation, failure, expiry, and unknown outcomes are not confirmation. Local actions and draft saves do not resume the agent. Successful display does not prove file publication, citation verification, tool execution, full-text authorization, or skill installation.

See [Card Authoring](authoring.md) for creating or customizing cards with the official UI. Discovery, declarations, and preview examples grant no network, filesystem, clipboard, host DOM, or arbitrary external-link access.

For computed datasets, serialize the complete operation request to a session-local
UTF-8 JSON file; pass request_file instead of request, never both. Omit the outer
capability/operation wrapper, not the request fields. Print only the path and a
summary; do not transcribe computed points through the model or give scripts Bridge
credentials. Published cards retain a data snapshot. Local code execution follows
the [execution guide](../../execution.md). Never use host source, private state or
fabricated events to bypass discovery or prove success.
