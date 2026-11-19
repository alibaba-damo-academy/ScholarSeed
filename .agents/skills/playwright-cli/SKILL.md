---
name: playwright-cli
description: Inspect and interact with a selected page using Playwright CLI for local browser or Desktop development.
---

# Playwright CLI

Confirm the installed command with `playwright-cli --help`. Use a dedicated session for the task and read the help for target selection and supported operations.

Open the authorized page and run `playwright-cli snapshot`. Use element references from the latest snapshot and refresh after navigation or page rerender. Capture a screenshot when visual evidence is required. Keep snapshots and screenshots in an authorized ignored location.

For ScholarSeed Desktop, follow [desktop-control](../desktop-control/SKILL.md) to verify the renderer target. For automated test changes, consult the [Desktop testing guide](../../../apps/desktop/docs/quality/testing.md). Preserve logged-in sessions and keep storage state and cookies out of Git.
