---
name: implementation
description: Implement a ScholarSeed feature or fix through its normal entry points, verify the change, and deliver within the task's scope.
---

# Implementation

Read the applicable [repository rules](../../../AGENTS.md), [ownership map](../../../docs/architecture/ownership.md), and [development guide](../../../docs/runbooks/development.md). Preserve unrelated changes.

1. Identify the behavior to change, its owner, affected callers, and acceptance evidence. For an unresolved architecture choice, use [design-solution](../design-solution/SKILL.md).
2. Reuse existing mechanisms. Keep the normal entry point, supported inputs, and failure paths working. Reproduce the issue with a focused regression check when suitable.
3. Run the checks for the changed surface, inspect the full diff and affected callers with [review](../review/SKILL.md), and complete the required [verification](../verification/SKILL.md).
4. Report the resulting behavior, checks, evidence, and any blockers. Follow the repository's delivery rules and the current task's authorization for Git and external actions.
