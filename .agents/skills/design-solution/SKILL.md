---
name: design-solution
description: Design a ScholarSeed change using current code and ownership boundaries, with observable acceptance criteria.
---

# Design Solution

Read the applicable [repository rules](../../../AGENTS.md), [ownership map](../../../docs/architecture/ownership.md), and [development guide](../../../docs/runbooks/development.md#choose-commands-and-evidence-by-change). Inspect the current entry point and callers.

1. State the user-visible result, present behavior, constraints, affected callers, and scope.
2. Identify the existing owner and mechanism. Describe required state, failure behavior, and compatibility. Compare viable approaches only when there is a meaningful unresolved choice.
3. Specify implementation steps and observable acceptance. Separate deterministic checks from host or product behavior that requires real execution.

Provide the plan in the conversation by default. When authorized to save a draft, use the current checkout's Git-ignored `.ai/work-records/proposals/<date>/<topic>/plan.md`. Check that the target is ignored and untracked. Keep existing files intact and keep drafts out of Git.

Use [implementation](../implementation/SKILL.md) for authorized changes and [review](../review/SKILL.md) for design review.
