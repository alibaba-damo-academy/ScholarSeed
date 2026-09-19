# Selection contract

Assess the complete confirmed intent before ranking or tiering. A count is a
ceiling, not a quota. Select promising papers by agent judgment even when some
details await reading. Read [EVIDENCE_REVIEW.md](EVIDENCE_REVIEW.md) for candidate
reviews and cached findings. Balance submits these through its
worker; full and quick use `selection_evidence.py` and `paper_select.py --request`.

Every selected ID must exist in the current pool, have current source/intent
bindings and a reason explaining its relevance and important uncertainties.
Per-criterion proofs and exact metadata quotes are not required. Known conflicts
with the requested scope still exclude a paper. Keep model ranking; empty
selection is valid and must remain empty through finalization.

Finalized papers carry `intent_review.verification_status: candidate`. They may
enter the existing authorized download and reading workflow without another
eligibility gate. Selection does not mean all clues or the answer are verified;
the reading stage resolves those questions from the actual papers.

```bash
"$PLS_PYTHON" "$SKILL_DIR/modules/search/paper_select.py" \
  --request "$REQUEST_JSON" --intent "$RUN_DIR/intent.json" --pool "$WORK/pool.json" \
  --output "$WORK/baseline.json" --max-results <request-budget>
```

Append `--exclude-id ID` for excluded papers. Save final reviewed choices to
`work/selection.json`; do not treat the baseline as approval of unreviewed items.

For related recommendations, keep source-supported `confirmed_connections`
(statement plus its own evidence quotes) separate from `unmet_criteria` (current
criterion key, `unmet` or `unverified` status, and reason). An unverified citation
relationship belongs in a gap; a shared task or architecture does not establish
that citation. Do not supply a separate freeform recommendation reason. Reports
render these connections, quotes, and gaps directly. Exact-quote and freshness
checks establish provenance only; assessing whether the quote supports a claim
remains the agent's responsibility.
