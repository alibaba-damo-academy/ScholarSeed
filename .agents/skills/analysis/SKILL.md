---
name: analysis
description: Analyze requirements, source code, or runtime evidence to explain current behavior, impact, constraints, or a defect's cause.
---

# Analysis

Read the applicable [repository rules](../../../AGENTS.md) and find the [responsible package](../../../docs/architecture/ownership.md). Establish the task, evidence revision, and scope before following the relevant entry points.

1. For a requirement, identify existing behavior, gaps, constraints, affected consumers, and open decisions. For a defect, identify the trigger, expected behavior, and competing explanations.
2. Follow the relevant entry point through validation, dependencies, and persistence. Read only the issue materials, session evidence, traces, or UI observations needed to test the explanation.
3. Separate observations, inferences, contradictory evidence, and unknowns. State what would distinguish remaining explanations. Cite file locations or runtime evidence.

Keep analysis read-only. Route design decisions to [design-solution](../design-solution/SKILL.md) or an authorized local fix to [implementation](../implementation/SKILL.md).
