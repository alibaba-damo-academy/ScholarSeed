---
name: verification
description: Verify a ScholarSeed change against its acceptance criteria using the relevant checks and real host or product evidence.
---

# Verification

Use the applicable [repository rules](../../../AGENTS.md) and [verification guidance](../../../docs/runbooks/development.md#choose-commands-and-evidence-by-change).

1. Record the source revision or artifact, environment, and expected outcomes.
2. Run checks that cover the changed object. Verify a development Skill in its actual coding host and inspect its load path and invocation. Verify product changes through the required real product path.
3. Record the command or observed state for each criterion and classify it as passed, failed, blocked, or unverified. Keep prior evidence identified by its revision.

Leave the implementation and acceptance criteria intact during verification. Route an implementation defect to [implementation](../implementation/SKILL.md). An unmet required check remains open.
