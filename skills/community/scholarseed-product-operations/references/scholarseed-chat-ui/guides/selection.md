# Select Rows and Continue

**English** · [简体中文](selection.zh.md)

Use `table.view` with `component/request` when the user wants to pick displayed
rows and continue, even without asking for a card. Do not substitute a read-only table
or ask for the choice again in text. Ordinary read-only tables use
[declarative display](conversation.md), not this workflow.

Read [interaction rules](interaction.md), then the bundled [table schema](table/schema.json)
and [request example](table/compose.json). Examples are synthetic; send real data.
The slot's data is `{dataset}`. A dataset has `columns: [{key,label,unit?}]` and
`rows: [{id,values:[...]}]`; preserve stable row IDs and missing values as null,
not zero. Schema applies to data, not the operation envelope.

State the decision needed, wait for the real result.answers, and use
`{action,values:{selected:[stable row IDs]}}` to continue from the selected records.
Local selection/drafts do not resume the agent; cancellation, failure, expiry or
unknown outcomes are not confirmation. Changed arguments need a new request ID;
only identical transport retries reuse one. Do not infer selection from display
success or replace native authorization, clarification or confirmation flows.
