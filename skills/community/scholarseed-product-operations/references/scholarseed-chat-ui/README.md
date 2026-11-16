# ScholarSeed Chat UI

Choose from the task goal and real data, even when the user did not request a
component. Use no component when the answer is clearer as text.

| Goal | Prefer |
| --- | --- |
| See change across ordered times | Line chart; preserve order and units. Explain gaps rather than inventing points or converting missing values to zero. |
| Compare magnitudes across categories | Bar chart; use a table instead if exact lookup or several dimensions matter more. |
| Pick from rows in the conversation and continue with the choice | [`table.view`](guides/content.md) with `component/request`. Phrases like “Put them together so I can pick one, then tell me which one I selected” call for an in-chat selection even without the word “card”. Follow the [request example](guides/table/compose.json), give each row a stable ID, then use the selected IDs in `result.answers`. Do not substitute a read-only table or ask for the choice again in text. |
| Verify claims against sources | Native Markdown citations; put the links with the claims or in the matching table cells. |
| Open results or delivered files | Native literature or artifact entry from the respective workflow, not a generated imitation. |
| Edit structured values before submission | Task Canvas; wait for a submission only if downstream work depends on it. |
| Explain a definition, a single finding, or a next step | Plain text. |

For ordinary display, open the bundled [conversation signatures](conversation.md)
and use only its registered OpenUI Lang components. The `conversation.ui` slot is
read-only. Its OpenUI source must assign the root, for example:

```text
root = Conversation([TextContent("Comparison"), Table([Col("Option", ["A", "B"])])])
```

A bare `Conversation([...])` will not render. A successful Bridge display
response confirms publication only; do not claim the card rendered or an
interaction completed on that basis.

For Canvas, open the bundled
[Canvas signatures](canvas.md) and the [Canvas guide](guides/canvas.md), which
routes to the [Canvas design guide](DESIGN.md) for authoring.
For calls, use the [component contracts](../scholarseed-bridge/contracts/component.jsonl).
There is no need to inspect UI source or query the catalog before using the
same-release signatures. If the host rejects an unknown component or reports a
registry mismatch, check the current `component/catalog` for the relevant mode.
Do not guess signatures or silently replace an unavailable operation.

Use the [display guide](guides/conversation.md) for the display
envelope, updates, and separation of display from interaction. Load
[custom card authoring](guides/authoring.md) only when the task
actually requires an executable custom card, not for ordinary charts or tables.
Use native product flows for input, clarification, progress, authorization and
error recovery. Rendering does not authorize an operation or prove a file,
citation, or business result exists.
