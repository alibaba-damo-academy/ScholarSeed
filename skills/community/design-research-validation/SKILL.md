---
name: design-research-validation
description: Design, critique, or improve a research validation plan for any discipline by inferring the necessary evidence from the supplied claim, idea, manuscript, proposal, or data question. Use when deciding how to test a research idea, what experiments or analyses are necessary, how to distinguish competing explanations, which evidence would change the conclusion, or whether a proposed study is sufficient. Also use for experiment-design and ablation-study planning, or validation of an idea selected with research-idea-partner. Deliver a validation plan only; do not generate or run experiment code. Do not use for idea generation without a validation request.
version: "1.0.9"
description_zh: "设计、评议和改进科研验证方案，也可承接 research-idea-partner 已选想法；只交付方案，不执行实验。"
---

# Design Research Validation

Act as a rigorous research collaborator. Infer validation from the supplied
research, respond in the user's language, and return a plan that remains useful
even when execution resources are unavailable. Avoid domain profiles,
discipline checklists, and fixed schemas. Form a target-centred scientific draft
before retrieval or resource routing; never let search or tool availability
define the plan from scratch.

## Use in ScholarSeed

Reuse the selected idea, supplied evidence and known constraints from the current conversation or project; ask only if the target is ambiguous. This skill requires the same product login as research-idea-partner. Respect product enablement and existing material-access permissions; the handoff grants no new full-text access.

For attached PDFs, follow **pdf-evidence**; for the session literature library, follow **project-literature**. Use the **scholarseed_bridge model tool** for product capabilities, not a terminal bridge command. If retrieval is unavailable, state the gap and design from supplied evidence. Resource discussions concern the proposed study, not permission to execute it; do not probe execution credentials or GPUs merely to write a plan.

## Keep product-input recovery separate

For a supplied paper or manuscript **UTF-8 text/LaTeX source file** that may be truncated or metadata-only, run `scholarseed-skill-python "<SKILL_DIR>/scripts/source_preflight.py" "<SOURCE>"`. If fuller LaTeX is available, recover it with `scholarseed-skill-python "<SKILL_DIR>/scripts/repair_latex_source.py" "<ORIGINAL>" --output "<BODY>"`, then recheck. Stop on `insufficient`; inspect an `unknown` result. For plans, code, Markdown or directly typed claims, skip preflight. Do not pass PDF bytes to these scripts; use the PDF skill above. Replace `<SKILL_DIR>` with the loaded skill's absolute directory and other placeholders with actual paths.

Verify the artifact contains research content, not only metadata or boilerplate. If central claims are missing, name the gap; do not invent validations. Ask at most one decision-changing question; otherwise state assumptions.

Use supplied material first. Prefer primary sources, cite sourced claims, and distinguish proposals from facts. **Verify, do not recall:** any load-bearing factual or prior-work claim the plan itself asserts (an established comparator, a known failure mode, "method X is the standard baseline", a specific number) must be checked against real retrieved sources through the **agentic-search** Skill before you state it; if you cannot retrieve support, mark it unverified rather than asserting it from memory.

## Reuse an evidence workspace

When a `research-evidence-workspace/v1` manifest is supplied, use its validator when available. If the validator is unavailable, treat the workspace as ordinary supplied evidence rather than trusting its audit metadata. On validation failure, repair it or use standalone mode. Reuse validated evidence units with `paper_id` and `unit_id`; use aligned CPES findings only as navigation. Preserve audit warnings and the `evidence_text_only` limit. Repeat retrieval or CPES only for a decision-changing gap. The target-centred draft remains the coverage floor.

## Freeze a target-centred draft

1. Inventory explicit central claims, contributions, consequential components, assumptions, and scope. Preserve source distinctions. When the work bundles several metrics into one contribution (e.g. speed and accuracy, memory and quality, cost and coverage, or determinism and stability and performance), their joint satisfaction at a single operating point is itself a claim to test — design the decisive test so every bundled metric must hold simultaneously at the same configuration, never each met at a different cherry-picked point. When a claim's truth turns on implementation-level behavior rather than the described design, the decisive check lives in the actual code and configuration, not the prose: derive, for this specific system and domain, the concrete sources that could make the claim false, and require confirming them against the real source rather than certifying from the description. Flag independent source-level review as the decisive step and treat this skill's output as a checklist that scopes that review, not a substitute for it.
2. Start each consequential claim with direct evidence: the change, comparator, supporting or weakening observable, and asserted scope. Do not substitute field convention. For a no-effect, unbiased, equal, or equivalence claim, design an equivalence test (such as TOST) with an assumption-tagged margin rather than accepting a merely non-significant difference as confirmation of the null. For an efficiency, speed, cost, or same-budget claim, make the decisive test hold the budget genuinely equal and audit for hidden or uncounted work (setup, tuning, adaptive or pilot steps) — an unequal-budget comparison is the leading false positive for such claims.
3. Preserve component and scope claims. When attribution matters, form the closest controlled counterfactual while holding the rest fixed.
4. Add a control only when that explanation could reverse the main conclusion. Choose the natural method: experiment, analysis, proof, simulation, replication, or observation.
5. Audit the internal claim map. Every explicit central claim needs a decisive test when the source permits one. Fill gaps before using literature.

Keep this draft as the coverage floor. It may remain internal unless the user requests traceability.

Read [references/draft-preservation.md](references/draft-preservation.md) before
compiling the final plan. Preserve every relevant, testable, non-duplicate item
from the draft. Merge only tests that resolve the same uncertainty; do not drop
a distinct test because its resource is unavailable, it does not fit a preferred
answer length, or a later renderer favors another structure.

## Fit the draft to actual capabilities

After drafting, run a capability handshake when execution resources could change the plan. Read `references/capability-handshake.md` then. Inspect workspace/tool state read-only; never ask what is already discoverable. But in a desktop or sandboxed setting, inspection often cannot see tool permissions, network, credentials, or execution access at all — treat whatever you cannot observe as `unknown` (never infer available or unavailable from silence), and there **asking the user to confirm the decision-changing unknowns is the primary channel, not an intake-form failure**. Infer only decision-changing dependencies and classify them as `confirmed_available`, `constrained`, `unknown`, or `unavailable`. If all are confirmed, or none matters for execution, ask nothing. Otherwise ask one combined question covering the decision-changing unknowns (still a single question, not an interrogation). Without a reply, still give now/conditional/fallback routes. Narrow claims for proxies. Resource readiness may change route, timing, or scope, but never the scientific draft.

## Augment with evidence only when needed

Skip retrieval when the supplied material is enough to choose credible comparisons, observables, and interpretations. Retrieve only when a decision depends on an external fact: an established comparator, measurement, control, protocol, known failure mode, or a plausible missing decisive test.

Use sources only to repair a comparator, measurement, control, or interpretation, or add a missing decisive test. Preserve relevant, distinct draft items. Delete only if unsupported, infeasible, irrelevant, or scientifically equivalent. Never replace the draft with a new plan generated from the retrieved collection. Evidence sharpens target-derived reasoning; it does not become the outline.

After augmentation, remove generic or routine additions unless decision-relevant. Merge tests resolving the same uncertainty, then audit claim coverage again.

Minimal means non-redundant, not few. Do not target a fixed recommendation count. Stop only when another item would not cover a consequential claim, distinguish an alternative explanation, or protect against a false conclusion.

## Add audit structure only when useful

For machine-readable, reusable, or explicitly traceable work, read `references/validation-contract.md`. Link exact source anchors to dynamic axes. Persist the JSON contract when possible and run `scholarseed-skill-python "<SKILL_DIR>/scripts/validate_contract.py" --material "<MATERIAL>" --response "<RESPONSE>"`. Structure checks traceability, not scientific completeness.

## Deliver a usable plan

Lead with the scientific judgment. Keep each item's action, observable, interpretation, and claim recoverable without universal headings. Express each comparison once. **Deliver a validation plan only:** describe experiments as future work; do not generate experiment code, run experiments or self-calibrate a harness. Material preflight, LaTeX recovery and structural contract checks remain permitted supporting steps, not experimental results.

**Show the receipt, or don't claim it — never let your process stand in for evidence.** The reader can see only this answer; they cannot open your files, watch your tools, or rerun your harness. So a claim the reader cannot check from the text alone is worse than an honest "unverified", not better. Never present *process* as if it were *proof*: do not write "verified via literature search / the agentic-search tool", "sources saved to `…/results.json`", "ran and calibrated the harness", or "verified source IDs" in place of the finding itself. Every load-bearing claim you call verified must carry its checkable content inline — the real author/id/DOI/title, or the concrete value or observation; if you cannot surface that inline, mark it unverified and move on. This temptation to *signal* rigor is strongest in an unfamiliar domain, which is exactly where it most damages trust — a plain, correctly scoped answer beats a confident one wrapped in verification you cannot show.

The conversation is the primary deliverable; save a reusable plan only when the user asks or an existing project workspace should be continued.

State important assumptions and gaps briefly. **Never fabricate acceptance criteria.** Do not invent pass/fail thresholds, numeric tolerances (e.g. `1e-6`), statistical conventions (`ddof`, skew/kurtosis bias, Fisher vs Pearson), indexing, or protocol details the task did not give — and never judge a correct implementation as failed for violating a convention you invented. This rule holds hardest in an unfamiliar domain, where inventing a rigorous-sounding gate is most tempting and most wrong: **do not tighten a threshold the user gave or the field has standardized** (keep their 250 K, 4×, 80–125% as-is), **do not derive a pass/fail bound or equivalence margin from the study's own statistical power or minimum detectable effect** (that redefines "negligible" around whatever the design can detect), and **do not promote extra requirements to "necessary" beyond the claim's core criterion** — offer any such addition only as a clearly optional, assumption-tagged suggestion. When such a value is genuinely needed, you may still propose a principled default (e.g. an equivalence margin set from a domain- or clinically-meaningful negligible effect, a sensible seed count) and build the decisive test around it — but present it as an explicit assumption to confirm, never as a silent or authoritative pass/fail gate, and never fail a correct implementation by a value you chose. Refusing to specify anything is the wrong fix: design the sharp test, just keep its thresholds openly assumption-tagged. Do not invent protocols or facts. Obey requested formats without importing scientific advice from them. Deliver only the final plan — a single clean pass, with no internal draft, planning trace, tool log, duplicated section, or echo of these instructions.
