---
name: llm-evaluation-run
description: Execute adopted ScholarSeed Desktop smoke, change, full, or targeted evaluation checks with evidence from the identified product.
---

# Execute an Evaluation

Read the [evaluation architecture](../../../apps/desktop/docs/architecture/evaluation.md) and the adopted baseline from [llm-evaluation-build-baseline](../llm-evaluation-build-baseline/SKILL.md). Freeze the target artifact, environment, cases, inputs, and criteria before execution.

Select applicable adopted main flows for smoke evaluation, changed flows and dependent paths for change evaluation, all applicable adopted units for full evaluation, or the user-selected scope for a targeted evaluation. Record missing inputs and unknown coverage.

Use [desktop-control](../desktop-control/SKILL.md) to exercise the real interface when authorized. Capture observations and screenshots per check, with [Trace evidence](../evidence-trace/SKILL.md) when applicable. Classify each unit against its frozen criteria and retain blocked or unverified units. Keep the product and baseline intact. Save authorized task records only under ignored `.ai/work-records/`.
