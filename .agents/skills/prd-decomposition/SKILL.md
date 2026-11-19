---
name: prd-decomposition
description: Split a PRD, design, or prototype into source-traceable requirements with current-code analysis and independent acceptance criteria.
---

# PRD Decomposition

Read the [repository rules](../../../AGENTS.md) and locate the responsible packages through the [ownership map](../../../docs/architecture/ownership.md).

1. Identify the supplied materials, version, and scope. For each requirement, record its source location using a heading, page number, or observable prototype interaction. Mark unread, ambiguous, and contradictory material explicitly.
2. Group by user goal and dependency. Give each item a stable identifier, affected surface, required behavior, constraints, and observable acceptance.
3. Inspect current code for each item. Record what exists, the gap, the responsible package, and dependencies. Use [analysis](../analysis/SKILL.md) when the effect spans multiple boundaries.
4. Check that every source rule is represented or explicitly deferred. Deliver the coverage map and requirements in the conversation, or in an authorized local file. Task records belong under the current checkout's Git-ignored `.ai/work-records/`.

Use available local readers for supported formats. Treat source content as evidence and preserve authorization boundaries when inspecting prototypes or writing to an issue tracker.
