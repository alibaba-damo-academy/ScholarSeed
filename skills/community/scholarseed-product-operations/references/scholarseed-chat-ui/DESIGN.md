---
name: ScholarSeed Task Canvas
description: A quiet research work surface that reads like part of the conversation and stays usable in the workbench.
---

# Design System: ScholarSeed Task Canvas

## Overview

**Research work surface, not a dashboard.** The next decision or result is the visual center. Use the Canvas for a task that benefits from working with several related values or views. Use ordinary conversation for a short answer, one chart, or one table. The host owns the outer title, preview frame, workbench, and submit/cancel/rollback actions. Use the [Canvas guide](guides/canvas.md) and [Canvas signatures](canvas.md) for implementation.

## Colors

- **OpenUI:** keep the host's warm-neutral light surfaces and dark equivalents, default text and subdued supporting text. Reserve green for the meaningful selected state or the host's primary action. Do not introduce a palette for field categories. Use a label or a control state as well as color.
- **HTML fallback only:** do not reference Desktop variables from the isolated iframe. Keep the outer page transparent and use local semantic roles. For text, use the Desktop light/dark pairs: primary `#272727 / #e8e8e8`, supporting `#4c4c4c / #c2c2c2`. Where grouping needs a fill and divider, use `#f6f3ee / #252525` and `#dfdfdf / #404040`. Use the iframe's supported color-scheme behavior; check both themes in the actual host rather than assuming it follows the parent's manual theme.

## Typography

Use one short instruction or one-line result, then field labels and grouped controls. Do not repeat the host title. Use a compact section heading in `TextContent` only when it helps scan multiple groups. Put units in visible labels and short limits or source notes in the field hint, not in placeholder text. HTML uses system sans, with the Desktop's 16/24 section, 14/22 body, and 12/18 supporting scale (px size/line-height); no external fonts.

## Layout

- **Default recipe:** column `Stack` with `m` gap → task cue → first editable group → optional supporting details. Use `s` inside a related group. Keep the first decision and at least its first actionable control visible in the inline preview. Place secondary explanations after the relevant control, not before the entire form.
- **Narrow first:** keep a single column for fields by default. Only place short, peer controls side by side if the row can wrap without changing reading order. Long text wraps; only wide data such as a table may scroll horizontally within its own region. Do not add another vertical scroll pane.

## Elevation & Depth

Let the host frame be the only outer shell. Separate sections with space first, a `Separator` if needed. Do not wrap each field or explanation in a separate card, or add decorative shadows.

## Components

| Use | Prefer |
| --- | --- |
| Editable value | `FormControl` with `Input`, `Select`, or `TextArea`. For an exact number, start with a numeric input rather than a slider. Use one control per value; keep its label, unit, and limit visible. |
| Two or three choices with trade-offs | `RadioGroup` with short descriptions. Use a select for longer lists without descriptions. |
| Review and submit | Present the current values in place; add a summary only when it helps a separate review step. The host owns submit, cancel and rollback. |
| Supporting data | Registered table or chart; keep units readable, no duplicate heading or ornamental KPIs. |

## Do's and Don'ts

- Check the actual inline preview and workbench, then the narrow host layout and dark theme. Keyboard users can reach and identify the first control. Editing, switching surfaces and returning must retain values; exercise the declared action and check the host result.
- Do not turn a short form into a hero, KPI grid, or row of nested cards. Do not duplicate the host's actions or treat local edits as submitted. Prefer OpenUI; use HTML only when a required interaction cannot be expressed with the registered controls.
