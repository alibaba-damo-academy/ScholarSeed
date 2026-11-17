# Declarative Result Display

**English** · [简体中文](conversation.zh.md)

Use official conversation components only when clearer than text. User input,
progress, confirmation, clarification and recovery stay in native product flows.
This guide is for ordinary read-only charts and tables, not user decisions,
Canvas or executable plugins. For those use [selection](selection.md),
[Canvas](canvas.md) or [authoring](authoring.md) only when needed.

Read the bundled [Conversation signatures](../conversation.md), then the complete
`component/display` contract through the [Bridge protocol](../../scholarseed-bridge/README.md).
Use same-release signatures without a preliminary catalog call. Only for missing
or mismatched signatures/components read [catalog discovery](catalog.md).
A component name is not a callable slot: call `conversation.ui` and put its
OpenUI components in `source`.

The descriptor has only `format: "openui-lang"`, `version: 1` and `source`;
do not generate A2UI, React or HTML. The envelope contains `request_id`, `revision`,
`title`, `slot: "conversation.ui"` and `data`. Source must assign its root:
`root = Conversation([...])`; a bare `Conversation([...])` will not render.
Use only actual registered components and verified values, not synthetic examples.

`conversation.ui` supports only `component/display`, never `component/request`.
In the same turn, reuse the request_id for an in-place update and increment
revision once per changed display. Reuse the revision only for an identical
transport retry. Another turn or display needs a new ID. Local sorting, filtering,
legend controls, expansion and opening resources do not resume the agent or
confirm a decision. Stay within the current Bridge byte limit.

Preserve time order, units and missing values; do not invent points or convert
missing values to zero. Use a table for exact lookup or multiple dimensions.
For specialized statistical plots, formulas or native Markdown compositions,
read [rich content](content.md); ordinary charts do not need that guide.

If discovery, publication or version verification fails, report the gap. Never
read/copy host source, private databases, caches or state to bypass discovery,
version or authorization, or fabricate events as evidence. Do not generate forms,
input controls, confirmation/cancel buttons, submission actions, Query, Mutation,
scripts, regex validation, generic MCP calls or invented execution/failure states.
Use the native clarification or domain authorization tool and wait for its receipt;
cancellation, failure, expiry and unknown outcomes are not confirmation.

Preserve real citation links and native file cards from successful publication;
do not generate Citation or Artifact components or fabricate handles or IDs.
Research cards use real domain objects and the [evidence guide](evidence.md).
Introduce the result, show the focused card, then briefly explain its finding,
scope and sources; do not repeat its contents as a long checklist. Keep debug
metadata and recovered retries out of ordinary answers unless requested.
A display receipt does not prove rendering, interaction, publication of a file,
citation verification, tool execution, full-text authorization or installation.
