# Task Canvas

When generating or revising a Canvas, use the [design guide](../DESIGN.md) to choose its layout and controls. Before publishing, check the first visible area, narrow layout, and host-owned actions against the actual source.

A Canvas is a task page, not a wrapper for an ordinary answer, Markdown, or a plot. Read the bundled [Canvas signatures](../canvas.md). If unavailable or mismatched, request `{slot:"canvas.ui",include_ui:true,ui_mode:"canvas"}` through component/catalog, adding ui_detail:"schema" only when needed. Prefer OpenUI; use HTML/CSS/JavaScript for custom behavior it cannot express.

Use the request envelope `{request_id, title, slot: "canvas.ui", data}`. The `data` fields are `format` (`"openui-lang"` or `"html"`), `version: 1`, `source`, optional `initial_state`, and optional `interaction`. The `interaction` object contains `actions` (`"rollback"`, `"cancel"`, or `"submit"`) and `output_schema`. Omit interaction and use component/display for non-blocking display. Declare interaction and use component/request to wait for a decision. Actions must include submit or cancel. The host owns these buttons. Changed content needs a new request ID; request_file works as with other components.

For multiline source, prefer writing the complete request as JSON from a script and passing request_file to avoid nested escaping. Scope HTML scripts in a module or an immediately invoked function; do not shadow browser globals such as history or location.

OpenUI uses root = Stack([...]) and named fields. Bindings and derived values stay local; do not use `Query`, `Mutation`, `@Run`, `@ToAssistant`, `@OpenUrl`, or host tools. Submission unwraps {componentType,value}, maps bindings to field names rather than $ local variable names, and preserves nesting, empty values, false and zero. Match output_schema to this JSON. Rollback restores previous local state without messaging the Agent.

HTML runs in an opaque sandbox without network, filesystem, native APIs or parent DOM access. Register `window.canvas.register({onRestore(state), onRollback(), onCancel(), onSubmit()})`. onRestore receives initial/saved state; canvas.save(json) saves JSON drafts. onRollback changes the page and returns restored state locally. onSubmit returns current JSON or a Promise. onCancel performs local cleanup, without submitting values. Handler failures preserve input for retry. Never impersonate host messages.

Conversation and workbench share one live instance, without rerunning scripts on moves. Reopening restores saved JSON, not JavaScript closures. Only schema-valid, backend-confirmed submission resumes the Agent. Cancellation returns cancelled without unsaved values. Failure, expiry and unknown outcomes are not confirmation; recover the existing interaction instead of creating another.
