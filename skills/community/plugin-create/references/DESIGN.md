# Design the plugin's first view

Start with what the user needs to see, compare and do. Show the result or decision first, with its units and conditions; put supporting evidence near the related item. Use realistic long labels and values before choosing a layout.

| Job | First view |
| --- | --- |
| Scan a result | Short conclusion, key values and evidence locator. Use registered OpenUI text and list primitives when they fit. |
| Compare values | Align the item, earlier value, revised value and source. Keep unknown values explicit and wrap long cells without separating a number from its unit. |
| Compare trends | Use a supported chart with a shared scale and clear units. Retain a readable value or evidence path for the decisive result. |
| Make a decision | Show the choice and trade-offs at the point the workflow needs an answer. Use the native decision surface rather than styling a display as a form. |
| Explore dense results | Keep the conversation summary useful on its own. In a supported workbench, place controls beside the affected data and let the host own scrolling and opening the view. |

Use the host's theme and typography. Keep the first view readable at narrow widths; do not add another shell, vertical scrollbar or a redundant heading. For actual interactions, keep focus and edits on failure, distinguish saving from submitting, and show artifacts only after successful creation. Keep the submitted result and evidence readable after confirmation.

Use the same checked records for conversation, workbench, copy and exported results. Preserve stable IDs and source locators. See [testing](testing.md) for observable checks.
