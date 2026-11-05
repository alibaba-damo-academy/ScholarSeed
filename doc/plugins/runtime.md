---
id: reference-plugin-runtime
title: How Plugins Run
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Understand how the AI, plugin components, and ScholarSeed exchange data, state, answers, and versions.
---

# How Plugins Run

**English** · [简体中文](runtime.zh.md) · [Read offline](../plugins.html#runtime)

[Plugin Overview](../plugins.md)

The AI follows the Skill to issue a request. After backend validation, ScholarSeed displays a conversation card. The user's answer returns to the AI so it can continue the task.

For the [paper-reading-notes example](create.md): request `reading.focus` → validate the request → load `focus.js` → choose **Understand the method** → return `{focus: "method"}` → generate method notes.

## From Loading to Rendering

1. The package passes installation checks and the user confirms installation and enables it. The AI discovers and uses the Skill during a real task.
2. The AI queries the component catalog and requests an available slot. Public business cards are driven by domain tools.
3. ScholarSeed pins the plugin and UI resource versions for the interaction. Custom components load their package entry in an isolated iframe; public cards use ScholarSeed's implementation and have no package entry.
4. Custom components use `mount(render)` to receive snapshots and render into `#root`, including language and theme changes. Do not create a second React root or duplicate render subscriptions.

`component/request` waits for an answer; `component/display` only displays content. A published record does not prove the business operation completed.

## Drafts and Answers

| Data | Purpose | Validation |
| --- | --- | --- |
| `data` | Business input provided by ScholarSeed | Component `input_schema` |
| `draft` | Saved UI draft | Draft-saving flow; not approval or an execution result |
| `values` | Submitted values | Action `input_schema`; `interaction.answer` also validates component `output_schema` |
| `{action, values}` | Answer envelope returned to the AI | Wrapped by the backend; do not include this outer envelope in the `values` schema |

Use `onState` for the current snapshot and subsequent `data`, `draft`, `status`, `language`, `slot`, and `theme` updates. `mount` already connects the render subscription.

- `save(values)` saves a draft without continuing the AI task. Preserve input on failure.
- `submit(actionId, values)` answers the current interaction. Submit only while pending; determine completion from subsequent state.
- Theme, language, and state updates must not clear unsaved input. An old save response must not overwrite newer edits.
- Do not advance dependent steps after cancellation, failure, expiration, or an unknown result.

See the [frontend SDK](api.md#frontend-sdk) for signatures and return values.

## Updates and Historical Cards

Increment the Skill and descriptor versions, rebuild the ZIP and digest, and confirm the update through a new installation card or the Skills center. Preserve the old version on a slot conflict or update failure; do not silently take over another plugin.

Historical interactions retain their original plugin version, UI resources, data, draft, and action semantics. New versions must not reinterpret old answers. Disabling prevents new bindings, but old cards still require current permission and state checks; their authorization is not permanent.

## Permission Boundaries

Components can use only supplied data and actions that are both declared and actually connected. Their iframe has no Node, Electron, preload, or parent-document privileges. It is not an arbitrary file, HTTP, or command proxy.

Skill backend calls and frontend SDK calls are separate interfaces. Declaring a capability neither connects a handler nor grants business permissions. This protocol has no global event interception, tool rewriting, or automatic approval API.

Next: [Available APIs](api.md) · [Testing and Updates](testing.md).
