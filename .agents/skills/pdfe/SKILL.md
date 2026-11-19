---
name: pdfe
description: Locate, implement, or verify a ScholarSeed PDFE prototype scene and determine its mock initialization.
---

# PDFE Prototype Workflow

Read the [PDFE engineering guide](../../../apps/desktop/docs/work/pdfe.md) and [Desktop rules](../../../apps/desktop/AGENTS.md).

1. For a `PDFE-SCENE/1` reference, parse the JSON that follows it and match the exact `pageId` and `sceneId` in the [scene catalog](../../../apps/desktop/preview/catalog.ts). Treat labels and summaries as display text. Report missing or ambiguous IDs.
2. Follow the scene's configuration to its actual mock initialization in the [preview service](../../../apps/desktop/preview/service.ts) and any referenced seed. Separate initial data from interactions observed after launch.
3. For task routing, pass a JSON object with `intent` and `task` on standard input to `node --experimental-transform-types .agents/skills/pdfe/scripts/context.mjs` from the repository root. Add the known role, scope, page and scene IDs when available. Inspect the returned ownership and review requirements before any authorized write.
4. For authorized prototype work, reuse existing renderer and preview entry points and verify the requested scene and interactions. Record the precise scene reference and observed mock result.

Use [review](../review/SKILL.md) for read-only review and [implementation](../implementation/SKILL.md) for a change to real product behavior.
