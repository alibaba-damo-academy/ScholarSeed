---
name: llm-evaluation-build-baseline
description: Build a source-backed evaluation baseline for ScholarSeed Desktop and hand adopted checks to the evaluation runner.
---

# Build an Evaluation Baseline

Read the [evaluation architecture](../../../apps/desktop/docs/architecture/evaluation.md). Identify the target pages or flows, requirements, source revision, artifact identity, and any supplied scenarios. Keep source inspection, real product observations, and acceptance criteria separate.

For each candidate check, record the real product entry, inputs, observable end state, source requirement, adoption evidence, and applicability. Keep stable IDs and record intentional exclusions and unknown coverage. For a development diff, classify direct changes and dependent regression paths. A source location alone does not establish that a flow is reachable.

Hand the versioned checks and inputs to [llm-evaluation-run](../llm-evaluation-run/SKILL.md). Keep exploratory results separate from adopted expectations. Save authorized task records only under the current checkout's ignored `.ai/work-records/`.
