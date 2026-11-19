---
name: ui-component-reuse
description: Find and reuse ScholarSeed Desktop UI components by intent before implementing a page, panel, dialog, or control.
---

# Desktop UI Component Reuse

Read the [Desktop rules](../../../apps/desktop/AGENTS.md), [design](../../../apps/desktop/DESIGN.md), and [component ownership and reuse rules](../../../apps/desktop/docs/design/components.md).

Run `node --experimental-transform-types apps/desktop/scripts/ci/find.mjs --list` from the repository root to discover the available categories. Search by user intent with the current finder help and inspect existing instances in the target feature. Compare props, keyboard interaction, and theme behavior with the requested design.

Reuse the shared control when it fits. If a required behavior is missing, identify the owning component and follow its extension and registration rules. Check the affected page in the real Desktop and run the applicable reuse and design checks.
