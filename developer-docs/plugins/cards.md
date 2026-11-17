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
| Compose charts, tables, evidence, or artifact previews | Use the unified Skill and composition slots below first |
| Collect choices for your own workflow | A custom slot, data/action schemas, and component code |

## Public Business Slots

| Slot | Displays | How it is used | Implementation |
| --- | --- | --- | --- |
| `interaction.question` | Choices and confirmation | ScholarSeed's native question flow displays it and collects answers. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
| `display.literature-search` | Search summary and a button for full results | Shown in the literature-result flow with the current result set. | [Summary](../../apps/desktop/src/renderer/src/features/literature/Summary.tsx) |
| `preview.literature-results` | Full results, filters, pagination, and sources | Open from the summary to select papers, inspect sources, or add to the library. | [Details](../../apps/desktop/src/renderer/src/features/literature/Details.tsx) |
| `literature.selection` | A paper subset | Compatibility with existing literature flows; returns selected paper IDs. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
| `literature.authorization` | Papers within a full-text authorization request | The literature authorization flow waits for confirmation before acquiring full text. | [Choices](../../apps/desktop/src/renderer/src/features/literature/Choices.tsx) |
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
- **Full-text authorization:** `literature.authorization` shows the requested papers. Managed acquisition supports authorized reading; it does not write to the library or save files for the user.
- **Research results:** the results view keeps explicit library actions and BibTeX export. References continue to link to their sources.

## Unified Skill and Composition Slots

The Agent loads the conversation-card guide through `scholarseed-product-operations`, discovers current official UI, and reads its three references. The entry is `skills/community/scholarseed-product-operations/references/scholarseed-chat-ui/guides/conversation.md`. The three formerly separate conversation skills are consolidated here and are not installed separately.

| Composition slot | Purpose | Contract and examples |
| --- | --- | --- |
| `rich-content.compose` | Charts, tables, formulas, diagrams, code, and prose | `references/scholarseed-chat-ui/guides/content.md` |
| `research-evidence.select` | Complete evidence, locations, and selections | `references/scholarseed-chat-ui/guides/evidence.md` |
| `artifacts-workbench.preview` | File paths, versions, and supplied previews | `references/scholarseed-chat-ui/guides/workbench.md` |

Use schema-compliant JSON when a composition meets the need; do not generate another plugin. New interactions outside these compositions use `plugin-create` for creation, checks, and publication, followed by user installation confirmation. Domain slots remain driven by domain tools; an arbitrary Conversation export is not an invocable slot. Organize answers as explanation, component card, and interpretation rather than packing many unrelated components into one plugin page. Technical names and logs are debugging details.

## Conversation Components

Read components from `window.scholarseedUI.Conversation` and declare `Conversation` in `ui.exports`.

| Category | Current exports | Your responsibility |
| --- | --- | --- |
| Prose and rich content | `Markdown`, `Code`, `Formula`, `Tabulation`, `Diagram`, `Canvas`, `Content` | Original content and controlled copy/open callbacks; display is not execution. Shared image implementations remain native; Markdown multi-image integration is separately planned. |
| Charts and tables | `Plot`, `BarChart`, `GroupedBarChart`, `StackedBarChart`, `LineChart`, `ScatterChart`, `PieChart`, `DonutChart`, `Histogram`, `BoxPlot`, `Heatmap`, `DataTable` | Explicit columns, units, missing values, and sources; use official ECharts/TanStack components, not executable configuration. |
| Research results | `Results`, `Details`, `References`, `Downloads`, `Delivery`, `Review` | Real domain data and operation ports, normally supplied as `content` and `ports`. |
| Citations and evidence | `CitationLink`, `CitationSources` | Complete excerpts, locations, historical snapshots, and navigation; labels are not read permission. |
| Artifacts and workbench | `FileFormatIcon`, `Artifact`, `ArtifactGroup`, `ArtifactMenuItems`, `FileMenuItems`, `ArtifactDestination` | Immutable file/version identities and save/import/open outcomes; icons, groups, and menus are not independent business cards. |

User input and context, execution and plans, confirmation and clarification, next steps, failures, and empty answers use native ScholarSeed UI, with no corresponding official package export or iframe entry. `interaction.question` and `literature.authorization` remain native contributions. Shared content images, menus, and component-local error handling remain available.

Inspect `catalog.composition.Conversation` for input guidance and [source and types](api.md#source-and-types) for exact signatures. Exported components do not imply that all internal callbacks are available to ordinary plugins.

### Live Official Component Preview

After installing this checkout's Desktop frontend dependencies, run:

```sh
pnpm ops dev browser
```

Open the [Desktop component gallery](http://localhost:5173/?dev=components) on the renderer's loopback address.

Schema-backed seeded random data and JSON editing are preview tools, not real papers, saved results, or permission evidence. New components still need editable data contracts and safe interaction bindings. Preview does not call real business services or replace installation, copy, or Agent acceptance; documentation screenshots are not a live preview.

### Copy Content, Not Interface Controls

Whole-message copying merges prose and registered card text in turn order, with no separate card copy button. Charts and tables retain complete data and units, code retains collapsed lines, evidence retains excerpts and saved selections, and artifact previews retain supplied content and versions without reading linked files.

Layout, icons, and menus have no copyable business text. Register custom content through the [copy SDK](api.md#register-copyable-card-content). Automatic registration uses `mount()` context; do not overwrite sibling components with `setCopyContent()`.

## UI Controls

- **Input:** Button, IconButton, Checkbox, Input, Textarea, RadioGroup, Select.
- **Layout:** Card and its Header, Title, Description, Content, Footer.
- **Overlays:** Dialog, DropdownMenu, and their declared children.
- **Tables and feedback:** Table, Alert, Badge, Progress.

Inspect `catalog.exports` for exact exports and declare the top-level names you use in `ui.exports`. Use the official React runtime; do not bundle another React or import Desktop internals. Supply your own custom styles rather than assuming ScholarSeed generates arbitrary Tailwind classes.

Next: [Drafts and Answers](runtime.md#drafts-and-answers).
