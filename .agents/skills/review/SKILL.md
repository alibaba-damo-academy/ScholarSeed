---
name: review
description: Review a ScholarSeed design or diff for correctness, compatibility, ownership, and missing acceptance evidence.
---

# Review

Read the applicable [repository rules](../../../AGENTS.md), [ownership map](../../../docs/architecture/ownership.md), and current code around affected entry points.

1. For a design, check requirements, scope, the chosen owner, callers, failure behavior, and observable acceptance.
2. For code, inspect the full diff and relevant callers. Prioritize reproducible correctness, security, compatibility, and missing regression evidence.
3. Report each finding with severity, file location, concrete impact, and a way to verify it. State which relevant checks or behavior remain unverified.

Keep the review read-only. Route authorized changes to [implementation](../implementation/SKILL.md), and execution evidence to [verification](../verification/SKILL.md).
