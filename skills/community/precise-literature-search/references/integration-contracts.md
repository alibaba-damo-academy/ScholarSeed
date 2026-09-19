# File contracts

Use this reference only for exact input shapes or contract failures. The complete
workflow lives in `SKILL.md`. `scripts/stage.py` and its local guards implement
serialization, stage tokens, authorization, input hashes and result validation.
No host agent registry or native-tool hook is needed.

## Current release and identity

Run state, search request and search plan use schema `2.0`. Older versions are
rejected, not migrated. `workflow.json` records the run ID and explicit initial
auto delegation. `stage-lease.json` binds a stage token to the round and input
hashes. A changed request, selected paper, PDF or report invalidates its binding.
A stage is completed once; retry a failed completion with the same inputs/token.

Each round lives at `search/round-NNN/`: `request.json`, `metadata.json`,
`report.md`, and `work/` with its saved dispatch, plan, state, pool and query log.
Keep the mode, input scope and deadline on resume. `prepare_search.py` supports
only `fast_mock`, `full` and `balance`; all use the current evidence contract.
Metadata and abstract evidence are never full-text reading evidence.

## Intent and search

Use intent schema `1.1` from `modules/intent/clarification.md`: original request,
precise intent, research questions, include/exclude criteria, time range, types,
language, optional count and confirmed status. User-specified limits are ceilings.
The stage command creates the search request from that intent and feedback.

Mode prompts define planning and bounded retrieval. Balance uses the worker's
small decision inputs; other modes use the same shared tools. All selections
need the current paper/scope-bound review in `modules/search/EVIDENCE_REVIEW.md`.
The agent decides which papers are promising enough to read and records its
reason; criterion coverage and exact metadata quotes are not admission gates.
Unknown details may pass to reading. Finalized papers carry
`intent_review.verification_status: candidate`, not a verified-answer claim.

A zero-match balance result may include up to three `related_recommendations`,
with current source quotes, explicit unmet/uncertain criteria and no tier. These
are separate from `papers` and cannot be download selections. Empty pools and
service errors must keep their actual status, not become fabricated results.

## Selection input

After the separate user download decision, save a JSON object like this with
actual values (the ID below is only a shape example):

```json
{
  "schema_version": "1.1",
  "run_id": "<current-run-id>",
  "metadata_path": "search/round-001/metadata.json",
  "selected_paper_ids": ["<actual-paper-id>"],
  "download_open": true,
  "download_paid": true,
  "paid_download_confirmation": "included_in_selection",
  "read_after_download": true,
  "confirmed_by_user": true,
  "decision_source": "user_explicit"
}
```

“All” enables both routes, including openly available non-arXiv papers. ArXiv-only
enables `download_open`; numbered selection enables its applicable routes.
Use `paid_download_confirmation: separate` only when the user has deferred that
access decision; the script pauses before non-arXiv acquisition. A numbered
selection does not authorize papers outside its exact list.

`stage.py authorize-download` validates that IDs belong to the current metadata,
records the explicit/delegated decision and binds the round and file hashes.
`download-authorization.json` is written by the script, never by model text.
Changed selection or metadata needs renewed authorization. Auto decisions use
`auto_delegated` and require recorded initial delegation; they do not grant access
bypass. `confirmed_by_user` means the selection is explicitly authorized, either
directly or within that recorded delegation.

## Downloads, reading and reports

Downloads write `downloads/manifest.json`, PDF files in `downloads/papers/` and
attempt logs in `downloads/paper-dl-logs/`. `download_route` identifies the arXiv
or non-arXiv adapter; `access_type` records evidence of open access independently.
A successful download requires a real run-contained file with a PDF signature.
Retry preserves verified successes and checks file identity, not a title alone.
Use `download_recovery.py --help` for explicit manual recovery/retry/skip actions.

Read [reading-outcome.md](reading-outcome.md) before claiming full-text reading.
The reading outcome binds downloaded IDs/files, the round and manifest hash.
Unreadable files become exclusions. Zero readable PDFs produce an honest
limitations answer, not invented summaries. A separate substantive abstract
alert uses `[A#]` attribution and cannot be cited as readable full text.

`report.md` records coverage and exclusions; `paper_summary.md` holds source-based
per-paper findings and three-sentence interaction summaries; `final_report.md`
answers the question with numbered citations and a matching References section.
Use only the returned stage completion command for finalization. Refinement
archives the current round and preserves its evidence; later search excludes
previously considered download candidates rather than repeatedly offering them.

## Validation and failure

`references/schemas/` contains JSON schemas; `scripts/validate_json.py` performs
runtime checks without third-party dependencies. The mode/stage scripts add
identity, evidence, budget, authorization and filesystem checks. Passing format
checks does not prove scientific relevance or truth.

Network/query errors remain in logs; exact successful retries resolve only the
same query/parameters. Cancellation leaves partial successes resumable. Never
erase authorization, locks or state to force a failed transition. Correct the
input/output or begin an explicitly revised round.
