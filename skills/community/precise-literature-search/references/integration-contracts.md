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

`.pls-binding.json` in the run directory is the run's task identity evidence,
written by `scripts/task_binding.py` when the run is created: `schema_version`,
`skill` (absolute installed skill directory), `version` (the `SKILL.md` manifest
version), `workspace` (absolute run directory), `run_id`, `work_dir`, `python` and
`platform`. serve reads it to verify a `task activate` request against its own
skill inventory; it never trusts the run's own claim. Do not edit, move or hand-write
it, and do not add it to a stage's input bindings. Every `stage.py` result carries
`task_activation`, the bridge request derived from it, plus `task_activation_hint`.

Each round lives at `search/round-NNN/`: `request.json`, `metadata.json`,
`search_report.md`, and `work/` with its saved dispatch, plan, state, pool and query log.
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

`selected_paper_ids` is the candidate set the product authorization card is built
from, so it must list every paper the run proposes to read; the user's download
subset is chosen on that card and derived by serve, never written here by model
text. `download_open` enables the product's managed open-access route and is set
when the card is published for these candidates. `download_paid` enables the
non-arXiv route and still requires its own confirmation: use
`paid_download_confirmation: separate` when the user has deferred that access
decision, and the script pauses before non-arXiv acquisition. Papers outside the
product-granted subset are skipped even when they appear in this list.

`stage.py authorize-download` validates that IDs belong to the current metadata,
records the explicit/delegated decision and binds the round and file hashes.
`download-authorization.json` is written by the script, never by model text.
Changed selection or metadata needs renewed authorization. Auto decisions use
`auto_delegated` and require recorded initial delegation; they do not grant access
bypass. `confirmed_by_user` means the selection is explicitly authorized, either
directly or within that recorded delegation.

## Managed full-text acquisition

In a ScholarSeed conversation the full-text bytes are acquired by serve, not by
the skill sandbox. The bridge exists only as the `scholarseed_bridge` model tool
inside the serve process; the skill scripts never invoke a bridge command line
and never fetch anything from the network. The host model performs the tool
calls and relays their results into the run:

- `literature result` with `checkpoint=selection` publishes the product
  authorization card. Its `authorization` carries `disposition` and
  `granted_refs`: the `paper:<id>` subset serve derived from the user's
  persisted decision. The model must not guess or invent this subset.
- `literature acquire`
  - request: `{run, papers:[{paper_id, identifier, identifier_kind:"arxiv"|"doi", title}]}` —
    serve fetches by arXiv id (`identifier_kind:"arxiv"`) or by DOI
    (`identifier_kind:"doi"`, resolved through OpenAlex to the primary PDF).
  - response: `{ok, refs, storage:"managed", papers:[{paper_id, ref, revision, source_kind}], manifest:{selected,downloaded,failed,skipped}, failures:[{paper_id,code,reason}]}`
  - send every paper that appears in `granted_refs`, at most 5 papers per call;
    batch the rest. Use the paper's arXiv id when it has one, otherwise its DOI;
    never filter the granted subset by access metadata. A granted paper the saved
    responses never mention (or one that has neither identifier) becomes a
    terminal `skipped` manifest entry — never a downloader or recovery target.
- `literature receipt` (optional re-confirmation of the current turn's scope)
  - request: `{run}`
  - response: `{ok, run, authorization_type, disposition, scope_digest, question_id, issued_at, refs, papers:[{paper_id, title, revision, source_kind}]}`

`disposition` is `authorized`, `rejected` or `pending`; only `authorized` with a
non-empty granted scope allows acquisition or reading. Serve recomputes the
receipt from the durable decision and its managed-object map on every call,
because the run directory is writable by the model and cannot vouch for its own
authorization.

The model saves the acquire response verbatim as `downloads/acquire-result.json`
in the run directory — never rewritten, hand-authored or fabricated. That file
is host-relayed *input*, not evidence: `scripts/acquire_result.py` shape-checks
it (`ok:true`, `storage:"managed"`, `papers`/`failures` arrays, each `ref`
equal to `paper:<paper_id>`, a non-empty content `revision`, no paper reported
twice, no paper both acquired and failed) and asserts the record can narrow the
confirmed selection but never widen it. At the delivery gate
(`checkpoint=final`) serve re-verifies every managed manifest entry against its
own managed-object map and the authorized subset; a mismatch refuses delivery
with `literature_result_fulltext_unverified`.

Acquired entries are bound into `downloads/manifest.json` as `storage: managed`
with the serve-returned `ref` and `revision` and `file_path: null`. The skill
never fetches, downloads or unpacks full-text bytes inside the sandbox, and
never requests sandbox escalation or any elevated permission.

After all acquisition batches finish, `literature delivery` with the same run
freezes Serve's durable acquisition list and publishes a product save card.
Its `delivery_id`, `acquired` count and pending state are not file-save receipts.
Destination selection, saving, optional primary-PDF library admission, cancellation
and retry are product UI operations independent of the agent turn's read receipt.
The agent must not provide filesystem destinations or claim saved PDFs without a
confirmed product save outcome. Original managed PDFs remain outside the run.

Reading managed full texts uses the `pdf read` tool operation with the entry's
`ref_id` (`paper:<id>`); serve checks the authorization of every ref on every
read. Requests page through **evidence fragments**, not PDF pages:
`{"ref_id":…,"offset":0,"limit":…,"span":…}`, then advancing `offset` to the
response's `next_offset` until it is `null` (`span` is the consecutive source
fragments per window and may cross adjacent pages). `pdf list` returns the ref ids this turn
may read, and `pdf search` (`{"ref_id":…,"query":…}`) jumps to a targeted passage.
The text the reader actually used is cached at
`work-reading/<paper_id>.txt` and is the run-contained evidence named by
`reading-outcome.json`; that cache may be regenerated on demand and is never an
authoritative copy. Serve's managed store stays the source of truth.

## Downloads, reading and reports

Downloads write `downloads/manifest.json`; the managed route leaves its acquired
bytes in product storage, while the paid (paper-dl) route additionally writes PDF
files in `downloads/papers/` and attempt logs in `downloads/paper-dl-logs/`. The
paid route is a recovery path, not a metadata-driven non-arXiv downloader: its
targets come only from the manifest — granted papers recorded as `failed` (what
serve reported) or `action_required` — and a terminal `skipped` entry is never a
target. `download_route` identifies the managed (open-download) or paper-dl
(paid-download) adapter; `access_type` records evidence of open access
independently. A successful entry requires verification
against the truth of its own storage scope: a serve-held revision for `managed`,
a real run-contained file with a PDF signature for `run`.
Retry preserves verified successes and checks file identity, not a title alone.
Use `download_recovery.py --help` for explicit manual recovery/retry/skip actions;
terminal `skipped` entries are not recovery candidates.


Read [reading-outcome.md](reading-outcome.md) before claiming full-text reading.
The reading outcome binds downloaded IDs/files, the round and manifest hash.
Unreadable files become exclusions. Zero readable PDFs produce an honest
limitations answer, not invented summaries. A separate substantive abstract
alert uses `[A#]` attribution and cannot be cited as readable full text.

`read_report.md` records coverage and exclusions; `paper_summary.md` holds source-based
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
