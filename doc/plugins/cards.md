---
id: reference-plugin-cards
title: Public Conversation Cards
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Choose public business cards, Conversation components, and UI controls for the interaction you need.
---

# Public Conversation Cards

**English** · [简体中文](cards.zh.md) · [Read offline](../plugins.html#cards)

[Plugin Overview](../plugins.md)

First choose what drives the card, then choose its UI. **A public slot is a business entry point; Conversation components are composable UI. They are not interchangeable.**

## Choose a Card

| Goal | Use |
| --- | --- |
| Reuse search, paper selection, authorization, or saving | A public slot driven by its domain tool |
| Compose an existing conversation UI | Conversation components, connected to actual props and callbacks |
| Collect choices for your own workflow | A custom slot, data/action schemas, and component code |

## Public Business Slots

| Slot | Displays | How it is used | Implementation |
| --- | --- | --- | --- |
| `interaction.question` | Choices and confirmation | ScholarSeed's native question flow displays it and collects answers. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
| `display.literature-search` | Search summary and a button for full results | Shown in the literature-result flow with the current result set. | [Summary](../../apps/desktop/src/renderer/src/features/literature/Summary.tsx) |
| `preview.literature-results` | Full results, filters, pagination, and sources | Open from the summary to select papers, inspect sources, or add to the library. | [Details](../../apps/desktop/src/renderer/src/features/literature/Details.tsx) |
| `literature.selection` | A paper subset | Compatibility with existing literature flows; returns selected paper IDs. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
| `literature.authorization` | Papers within a full-text authorization request | The literature authorization flow waits for confirmation before acquiring full text. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
| `display.literature-downloads` | Per-paper acquisition or import outcomes | Shown after acquisition/import; users can open full text or the library. | [Downloads](../../apps/desktop/src/renderer/src/features/literature/Downloads.tsx) |
| `display.literature-delivery` | Save location, file conflicts, and outcomes | Started with `literature delivery`; the user chooses and confirms a destination. | [Delivery](../../apps/desktop/src/renderer/src/features/literature/Delivery.tsx) |
| `display.literature-references` | References and source actions | Shows cited literature, with source opening, import, and collection actions. | [References](../../apps/desktop/src/renderer/src/features/literature/References.tsx) |

To reference a public component, set `public: true`, specify the existing slot and scenario file, and omit `entry`. Follow the actual data and actions returned by the [component catalog](api.md#discover-components-and-slots).

Do not fabricate public cards through generic `component/request` or `component/display`:

- `interaction.question` is bound by the native question flow and has no standalone CLI question operation. For your own choices, use a custom slot from the [creation tutorial](create.md#request-the-card).
- Literature cards obtain real context through domain operations such as `literature/result` and `literature/review`. Inspect those operations' contracts instead of inventing their data.

`literature.outline` and `display.literature-review` are custom slots belonging to existing plugins, not public slots.

### How a Slot Resolves to a Component

The frontend routing lives in [Component.tsx](../../apps/desktop/src/renderer/src/features/literature/Component.tsx). Result cards receive `content` and business-operation `ports`; choice cards receive `data/status/slot/submit`. The `literature.selection` registration is marked `legacyOnly` for existing bindings and is not a general-purpose question entry for new plugins.

Inspect all three boundaries before reuse: the public-slot list in [descriptor.py](../../apps/serve/service/capabilities/service/descriptor.py), action constraints in [ui.py](../../apps/serve/service/capabilities/service/ui.py), and frontend-to-domain mappings in [ports.ts](../../apps/desktop/src/renderer/src/features/literature/ports.ts). A visible button alone does not establish a working operation.

Example public-card reference:

```json
{
  "id": "results",
  "slot": "display.literature-search",
  "public": true,
  "preview": "components/results.json"
}
```

Add it to `components`, with schemas and capability declarations matching the actual data and actions. There is no `entry` because ScholarSeed implements the UI. The declaration creates a reference; the literature domain tool still drives the card.

## Public Card Behavior and Examples

The component previews retained in the [Chinese edition](cards.zh.md#公共卡片视觉示例) illustrate the layout with Chinese sample content; they are not evidence of a complete English product flow. The following descriptions let English readers follow the guide without relying on those screenshots.

- **Questions and paper selection:** `interaction.question` shows choices; `literature.selection` shows a selectable subset. The outer interaction owns the question and whole-turn confirmation, not the option component alone.
- **Search summary and full results:** `display.literature-search` summarizes results; `preview.literature-results` contains the full list, filters, and operations. See `results.json`, `details.json`, and `question.json` in [agentic-search/components](../../skills/community/agentic-search/components).
- **Full-text authorization and acquisition:** `literature.authorization` shows the requested papers; the native flow owns its buttons and authorization result. `display.literature-downloads` shows per-paper outcomes. Examples: [authorization.json](../../skills/community/literature-review/components/authorization.json) and [downloads.json](../../skills/community/precise-literature-search/components/downloads.json); paper-subset examples use `scenario.json` in the corresponding component directory.
- **Delivery and references:** `display.literature-delivery` covers save destinations and conflicts. `display.literature-references` presents cited papers and source operations. Their UI does not independently grant download, filesystem, or library permissions.

## Conversation Components

Read components from `window.scholarseedUI.Conversation` and declare `Conversation` in `ui.exports`.

| Category | Current exports | Your responsibility |
| --- | --- | --- |
| Research cards | `Choices`, `Results`, `Details`, `References`, `Downloads`, `Delivery`, `Review` | Real business data, operation ports, and authorization outcomes. Research cards generally take `content` and `ports`; Choices takes `data/status/slot/submit`. |
| Prose and source content | `Markdown`, `Message`, `Code`, `Formula`, `Tabulation` | Original content, copy/open callbacks, citations, and mathematical meaning. Displaying code does not execute it. |
| Artifacts | `Artifact`, `ArtifactGroup`, `ArtifactMenuItems`, `ArtifactDestination` | Immutable file/version identity and save/import/open operations and outcomes; groups only provide layout. |
| Images | `ImageView`, `Images`, `ImageThumbnail` | Authorized URLs, asset identity, load failures, selection, and actions; components do not read arbitrary local files. |
| Citations and context | `CitationLink`, `WebCitationLink`, `CitationSources`, `ConversationReference`, `ComposerRefChip` | Citation resolution, authorized previews, history snapshots, pagination, and navigation; a label is not read permission. |
| Execution | `ExecutionProcess`, `ExecutionBatch`, `ToolExecution`, `ExecutionIO`, `ExecutionStatus`, `WebSearchRecord` | Actual turns, state, I/O, and time; unknown or interrupted results must not appear successful. |
| Task support | `Plan`, `Failure`, `Suggestions`, `Attachments`, `FileFormatIcon` | Plan projection, recovery eligibility, sending, file identity, and opening; UI does not automatically resume tasks or send messages. |

Inspect `catalog.composition.Conversation` for input guidance and [source and types](api.md#source-and-types) for exact signatures. Exported components do not imply that all internal callbacks are available to ordinary plugins.

## UI Controls

- **Input:** Button, IconButton, Checkbox, Input, Textarea, RadioGroup, Select.
- **Layout:** Card and its Header, Title, Description, Content, Footer.
- **Overlays:** Dialog, DropdownMenu, and their declared children.
- **Tables and feedback:** Table, Alert, Badge, Progress.

Inspect `catalog.exports` for exact exports and declare the top-level names you use in `ui.exports`. Use the official React runtime; do not bundle another React or import Desktop internals. Supply your own custom styles rather than assuming ScholarSeed generates arbitrary Tailwind classes.

Next: [Drafts and Answers](runtime.md#drafts-and-answers).
