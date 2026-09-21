# Candidate review and evidence cache

These shared checks bind candidate judgments to the current paper and request.
They do not change retrieval strategy or permit more queries.

## Bounded review context

Reuse the runner's evidence view and existing `pool_inspect.py` bounded slices;
never dump the complete pool. Obtain keys for at most 20 candidate IDs in one
call, reusing the returned scope/intent keys throughout this review:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/selection_evidence.py" context \
  --request "$REQUEST_JSON" --work-dir "$WORK" --id ID1 --id ID2
```

Replace IDs with those actually inspected. This returns `intent_key`,
`scope_key`, `required_criterion_keys`, and each paper's `evidence_key`, not
another copy of the evidence pool. Use the request to interpret the criterion
keys; do not infer requirements from abbreviated labels alone.

## Review before tiering

Each selected record's `intent_review` retains `intent_key`, `eligible` and
`reason`, plus `schema_version: "1.1"`, `scope_key` and `evidence_key` from the
current context. `eligible: true` means the agent recommends the paper as a
candidate for review/reading. Explain the relevance and important uncertainties
in `reason`; it does not mean every clue is already proved.

```json
{"schema_version":"1.1","intent_key":"COPY_CURRENT_KEY","scope_key":"COPY_CURRENT_KEY","evidence_key":"COPY_CURRENT_KEY","eligible":true,"reason":"The method and dataset make this a promising candidate; verify the ablation values during reading."}
```

`criteria` is optional. It may contain only useful observations, each with a
current `criterion_key`, `verdict` and `reason`. Supported verdicts are `supports`,
`clear`, `unknown` and `contradicts`; unknown details do not block selection,
while an explicit contradiction excludes the paper. Keys must be unique and
belong to the current request. `required_criteria` in context is the checklist
of user requirements, not a mandatory proof checklist for candidate admission.

Observations may include optional `evidence: [{field, quote, source?, locator?}]`.
Field names are unrestricted strings: metadata, public Web, citation relationships
or already available full-text excerpts may inform the judgment. There is no
exact-substring or displayed-quote validation for candidate selection. Keep
inferences/paraphrases in `reason` and source text in `quote`; retain useful
source/section/table locators. Do not claim to have read an unavailable source.
This does not grant new retrieval or download permissions to a search worker.

Runtime checks retain scholarly identity, current paper/request bindings, known
year/language conflicts, explicit negative reviews and result limits. Missing
metadata does not block a candidate. Finalization writes
`intent_review.verification_status: candidate` for all selected papers; this is
preserved for downstream authorized download and reading. It is not a claim of
full-text verification. Empty selections remain empty.

Balance generates the bound review from `selection_reason` and optional
`criteria`. Full and quick modes save the review on pool/selection records and
use `paper_select.py --request` plus the common finalizer.

## Reuse verified hypotheses

This optional verified-finding cache remains stricter than candidate admission:
it accepts exact metadata quotes only. It is not required to select a candidate.
For material entity/relationship findings supported by current pool evidence,
save a compact reusable decision once. Do not rewrite immutable plans or use
the cache to turn metadata into full-text evidence. Write a JSON array at
`$WORK/hypotheses-input.json`, containing only new or changed decisions:

```json
[{"name":"<resolved entity or relationship>",
  "rationale":"<what the evidence establishes for the confirmed question>",
  "evidence":[{"paper_id":"ID1","field":"abstract",
               "quote":"<exact supporting text>"}]}]
```

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/selection_evidence.py" save-hypotheses \
  --request "$REQUEST_JSON" --work-dir "$WORK" --input "$WORK/hypotheses-input.json"
```

This merges up to 24 current decisions into `state.json.verified_hypotheses`,
binding each to intent/feedback and 1–8 source quotes. Save only findings that
could prevent repeated analysis, not a summary of every candidate. Source-quote
verification is programmatic; the rationale remains the agent's assessment.

Before a repeated entity review or on resume, reuse valid cached decisions:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/selection_evidence.py" read-hypotheses \
  --request "$REQUEST_JSON" --work-dir "$WORK"
```

Changed scope or source evidence invalidates a cached item. Reassess only the
changed or unresolved questions, within the saved mode budget. An empty cache
does not authorize repeating completed discovery calls.
