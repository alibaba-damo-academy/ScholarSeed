---
name: ScholarSeed Plugin Card
description: Conversation cards and workbench views with clear state and official ScholarSeed controls.
---

# Design System: ScholarSeed Plugin Card

## Overview

Use a compact conversation card for a short result or a decision that blocks the next step. Use a workbench view for graph exploration, long comparisons, and source review. Reuse an official public component when it meets the task. Otherwise start from the closest template and preserve its host integration. See the [interaction guide](interaction.md) and [testing guide](testing.md).

## Colors

| Role | Use in the official UI sandbox |
| --- | --- |
| Canvas behind the card | Transparent; inherit the surrounding conversation surface. |
| Main and supporting text | `--vds-text-primary` for labels and decisions; `--vds-text-secondary` for short explanations. |
| Grouping and boundary | `--vds-bg-component` or `--vds-border-default` only if grouping needs them. |
| Brand and feedback | Use the official primary `Button` and control selection states; show errors with text, using `Alert` for group-level failure. |

The exported UI maps these roles to both host themes. Use the host tokens for fills, borders, text, and chart marks. Check secondary text, legends, and focus indicators against their actual background. Pair selection and status colors with a visible label, marker, or control state.

## Typography

Use the host's sans font and body scale. Use `--vds-font-subhead` with `--vds-lh-subhead` for a compact in-card heading when the host has not already supplied one; option labels use the body role, and descriptions use `--vds-font-body-lv1` with `--vds-lh-body-lv1`. Do not use letter-spaced labels, display titles, or a second typeface. Never shorten labels by clipping task-critical text.

## Layout

**Default layout:** result or decision → comparable values or editable group → immediate action and feedback. Put supporting source notes and methods in the associated details. Use `--vds-space-3` between groups and `--vds-space-2` inside groups; use one level of indentation for a related note or disclosure. Start with a single reading column and a shared alignment edge. Use SDK component props and verified CSS; the sandbox may omit Tailwind classes that were absent at build time.

**Workbench:** Lead with the result and put filters close to the plot or table. Place evidence and source details in an expandable area or a detail pane that opens from the selected item. Use the same component instance in the conversation preview and workbench. Put the result summary first in the preview, so it remains meaningful at a compact height. Let the workbench frame own vertical scrolling and let the component body and the evidence area grow with content. A fixed maximum height and vertical overflow on the evidence area create a second scrollbar. Keep controls and source links reachable at the smallest supported window width.

### First-view priority

Before generating a component, name the result, the values a reader compares, and the immediate action in the requirements. Let that answer choose the primary layout. Give the result or decision the first position and strongest weight. Keep the action beside its inputs or in one visible action area; use disclosure for material a reader needs to inspect only on demand.

| Reader's job | Primary layout | Initial view |
| --- | --- | --- |
| Scan independent results | List | Active items first, with their key values and status. |
| Compare two values or versions | Paired rows or a compact table | Item, earlier value, revised value, and the condition that affects the comparison. |
| Compare a trend, distribution, or interval | Chart with a readable value list when needed | The estimate or trend and its unit or uncertainty. Keep the reference line and comparable rows together. |
| Supply or confirm values | Form | Decision, current values, and the first editable group. Use one primary action with a concrete label. |

For tables, let the text column use the remaining width and wrap. Align comparable numbers and units consistently, reserving space for complete values. Keep row actions together at the trailing edge. Use the same control size for peer buttons, with a common minimum height and room to grow for wrapped labels. In a narrow host, wrap labels and controls at their own boundaries, then stack paired values within their item if needed. Move secondary columns to details before clipping a result, unit, or action. For dense charts, retain the shared scale and show a compact aligned value list if labels or marks cannot fit.

Review every line above the fold. Merge repeated headings, shared source labels, and equivalent status labels. Remove instructions that the control already conveys. Keep a condition, unit, or risk beside the value it qualifies. Put original passages, derivations, and exceptions in the related item’s details. Cite a common source once for the group and keep row-specific locators where they help readers check a claim.

### Component combinations

Use these combinations as starting points. Choose components from the installed SDK contract and the closest template.

| Task | Starting combination |
| --- | --- |
| Show a short result | Result summary → chart or read-only table if needed → labeled source detail. Keep display-only filters and selection local. |
| Ask for one decision | Decision cue → `RadioGroup` with the relevant trade-offs → optional labeled `Input` → inline feedback → one primary `Button`. |
| Explore a longer result | Compact summary in the conversation → main chart or table with nearby filters in the workbench → details opened from the selected mark or row. In a narrow column, wrap labels and controls and open details below the result. |

Keep the first view focused on the result or decision and its immediate controls. Put methodology, full source text, and detailed field explanations behind the related item. Choose a read-only table for inspection and expose editing controls when the task calls for editing.

Use a shared scale and an aligned reference marker for comparable charts. Show the unit and denominator next to each metric. Give chart edges, table rows, and evidence records stable IDs so selection and the evidence panel always point to the same item.

## Elevation & Depth

Let the host supply the outer surface. Group related content with headings, spacing, and separators. Add a boundary for a distinct interactive region that needs one. Keep simple metrics in a compact summary row that can wrap, and use standard radio rows for ordinary single-choice options.

## Components

| Use | Prefer |
| --- | --- |
| Exactly one choice | Declare official `RadioGroup` and `RadioGroupItem`; use `Checkbox` only for independent or multiple choices. |
| Reason or note | Use labeled `Input` or `Textarea`; keep current input on save failure. |
| Confirm, save, cancel | Use one explicit `Button` with `variant="primary"` and a verb that describes the result. For other actions use `secondary` or `ghost` explicitly; the default button is primary. |
| Plot and table | Reuse SDK plot and table components when their interaction and data contracts fit. |
| Pending, saved, failed | Show relevant feedback only. Distinguish local edits, a draft receipt and actual submission; make focus and selection visible without relying solely on color. |

When adapting a scaffold, check the actual component for these rules: changing data alone does not fix a checkbox used for a single choice or two default-primary actions.

## Copy and exported results

Start a host-supported dialog or notice with the current state or decision. Keep only information that affects the choice. Label buttons with the action and, where useful, its object: “Submit selected findings”, “Keep editing”, or “Retry export”.

| Event | Visible feedback and recovery |
| --- | --- |
| Select or edit | Show the new value immediately. Keep keyboard focus and the visible selection when switching surfaces. |
| Save a draft | Mark it saved after the save receipt. On failure, keep the edit and make the existing save action available again. |
| Submit | Keep the card in place and show the host's pending or confirmed state. After confirmation, preserve the submitted values and keep evidence readable. An unknown outcome calls for checking the existing request. |
| Create an artifact | Report progress or failure for this step separately. Show the artifact entry after creation succeeds; retry the artifact step using the confirmed values when possible. |
| Load the workbench or register copy content | Keep confirmation visible when either operation fails. State which operation failed and expose its recovery through the owning control. |

Use the [interaction guide](interaction.md#registering-content-for-copying) for copy registration.

Start an exported report with the conclusion or next step. Keep each claim beside its evidence locator, and put long quotations and derivations in linked details or an appendix. Remove repeated explanations and accounts of the generation process. In a structured export, put the fields a reader uses to act first and keep the locator in the same record. Use the [evidence guide](evidence.md#use-the-latest-decision-to-produce-one-result) for data consistency across views.

## Visual and interaction checks

Judge what attracts attention first, whether the decisive result and action are visible, and which elements compete with them. At narrow widths, preserve readable values, units and peer controls; long labels must wrap without detaching from their values. Keep focus visible and feedback next to the action it describes. Use the [testing guide](testing.md#packaged-preview-inspect-the-first-view-and-operate-the-component) for the host checks and evidence to collect.

### Narrow workbench examples

Use these examples to decide what belongs in the first view and what belongs in details.

| Task | First screen | On demand |
| --- | --- | --- |
| Review an argument | Show each reasoning chain in order, with its conclusion and the editable assumption in context. | Expand the selected source and show where its wording supports the chain. |
| Explore relationships | Give the selected person or item a clear focus. Wrap or move labels that would collide. Provide a compact relationship list when the diagram gets dense. | Show the selected relationship's evidence and original wording together. |
| Compare revisions | Name the changed provision and align the earlier and revised values. Mark an unverified baseline in the earlier-value position. | Open the exact passages from that row. |
| Act on an obligation | Lead with the current task, payee and effective deadline. Put missing dates or a condition that suspends the deadline beside the task. | Expand the source clause, calculation or inactive branch from the relevant entry. |
| Inspect point and interval estimates | Put the overall estimate beside the subgroup rows so readers can compare them on the same scale. Align the reference marker and ticks, keep uncertainty visible and cite the shared trial once. | Show the selected row’s precise source locator, population and interpretation. |

Keep the interaction available while evidence is expanded. Place a field beside the item it edits, with a visible label and save feedback near the relevant action. Leave historical evidence expandable while disabling writes. Confirm the layout with the packaged component in the host rather than relying on the width of an external mockup.
