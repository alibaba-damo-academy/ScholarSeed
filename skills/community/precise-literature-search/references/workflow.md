# Workflow reference

## Run storage

Create each run at `<working-directory>/.precise-literature-search/runs/<YYYYMMDD-HHMMSS-random>/`. Store runtime outputs there, never in the installed skill. Use UTF-8, two-space JSON and atomic JSON replacement. Retain all completed artifacts after failure.

## Interaction modes

Use interactive mode by default. Enter auto mode only when the original request
explicitly asks for auto, autonomous, unattended, or no-interaction execution.
Do not infer auto mode from silence or an ordinary acknowledgement.

In interactive mode, every prompt names the next action. Empty input never
invents a paper-dl/non-arXiv scope or resolves a login/CAPTCHA/manual-verification action.

In auto mode, the user's original request delegates ordinary research-process
decisions to the host. The host uses the same artifacts and states, resolves
interaction checkpoints without another user message, and records delegated
intent and paper-selection decisions with `confirmation_source: auto_delegated`
or `decision_source: auto_delegated`. Auto mode uses
`PAPER_DL_MODE=autodev`, skips rather than bypasses human-intervention items,
and continues from any verified downloaded files.

Expected paths:

```text
state.json
progress.json
request.txt
intent.json
search/round-NNN/{request.json,metadata.json,search_report.md,work/}
search/round-NNN/work/{plan.json,state.json,pool.json,query-log.json,selection.json,results/}
selection.json
downloads/{papers/,paper-dl-logs/,manifest.json}
paid-action.json
read_report.md
paper_summary.md
final_report.md
iterations/round-NNN/{selection.json,download-manifest.json,paid-action.json,read_report.md,paper_summary.md,review.json}
```

All long stages follow `references/progress.md`: write real events to the one
top-level `progress.json`, relay them in the user's language, and emit a
heartbeat after no more than 20 seconds of silence in interactive and auto
mode. Omit unknown totals. A stage may say “no action required” once at startup;
routine events and heartbeats never repeat it. Only a real `action_required`
state emits a user-action prompt. Failure, cancellation, and completion events
are immediate.

## States and transition conditions

| State | Enter when | Interactive behavior |
|---|---|---|
| `INITIALIZED` | A unique run and raw request exist | Yes, to intent drafting |
| `INTENT_DRAFTED` | A precise restatement/draft exists | No; wait for confirmation |
| `INTENT_CONFIRMED` | Interactive user confirmation, explicit auto delegation, or the user supplies an already clarified and explicitly confirmed intent | Yes, start search |
| `SEARCHING` | A new immutable outer round was allocated | Yes, delegate one Search Agent when available or use the host fallback |
| `REVIEW_PENDING` | Metadata and the search report for the round exist | No; wait for the user to refine, accept, pause, ask questions, or respond freely |
| `REFINEMENT_REQUESTED` | Interactive user or auto host supplies retrieval-changing feedback | Yes, start the next round |
| `RESULTS_ACCEPTED` | Interactive user or auto host accepts the result set | Yes, resolve the download choice through the product authorization card |
| `DOWNLOAD_DECISION_PENDING` | Results are accepted but selection is not confirmed | No; wait for download scope |
| `DOWNLOADING_OPEN` | Confirmed selection permits the managed acquisition route | Yes, invoke the internal `open-download` module, which records what serve acquired by arXiv id or DOI |
| `PAID_DOWNLOAD_PENDING` | The managed acquisition results were recorded and the manifest still lists granted papers serve reported as failed, awaiting a separate start confirmation | No; show the remaining non-arXiv count without a backend name and wait |
| `PAID_ACTION_REQUIRED` | Paid module needs a local CDP browser or reports a detected manual intervention | No; wait for CDP readiness or the user to resolve the displayed prompt |
| `DOWNLOADING_PAID` | Dedicated CDP Chrome or Edge is ready | Yes, invoke paper-dl interactive adapter and relay live prompts |
| `READING` | At least one product-acquired managed success exists (or a run-contained verified PDF); the text the reader used is cached under `work-reading/` | Yes, execute the verified batch with the reader prompt |
| `REPORT_REVIEW_PENDING` | Non-empty verified paper-summary and status-report artifacts exist and have been presented | No; wait for finish or report feedback |
| `FINAL_REPORTING` | Interactive user or auto host finishes report review and the cited answer report has not yet been validated | Yes; follow the final-report prompt and validate `final_report.md` |
| `COMPLETED` | The cited final answer report is validated, or honest metadata-only delivery is complete | Terminal |
| `FAILED` | A step error is recorded | Resume only after inspecting artifacts and fixing the cause; final-report failures have the bounded recovery described below |

The normal flow is:

```text
INITIALIZED → INTENT_DRAFTED → INTENT_CONFIRMED → SEARCHING
→ REVIEW_PENDING ─┬→ REFINEMENT_REQUESTED → SEARCHING
                  └→ RESULTS_ACCEPTED → DOWNLOAD_DECISION_PENDING
                      → DOWNLOADING_OPEN
                      → [PAID_DOWNLOAD_PENDING → DOWNLOADING_PAID
                          ↔ PAID_ACTION_REQUIRED]
                      → READING → REPORT_REVIEW_PENDING
                          ├→ FINAL_REPORTING → COMPLETED
                          └→ REFINEMENT_REQUESTED → SEARCHING
```

When the user supplies an already clarified and explicitly confirmed intent, bypass intent drafting and confirmation without entering auto mode:

```text
INITIALIZED → INTENT_CONFIRMED → SEARCHING
```

Metadata-only selection goes from `DOWNLOAD_DECISION_PENDING` to `COMPLETED` after an explicit no-full-text summary. A run with zero verified downloads also completes with an honest metadata-only result; it must not enter `READING` or claim a full-text report.

For user-facing wording and no-full-text outcomes, follow SKILL.md's
“User-facing language” and Phase 3. `metadata-only` closes the skill run; it does
not generate an abstract-based answer. If the user requests analysis without
full text (including the product's continuation after rejected authorization),
prepare that answer, close the run with `metadata-only`, then deliver the answer
in the final response. Do not end the turn at `REVIEW_PENDING` or mistake script
completion for answer delivery. A request for only the paper list needs no further
analysis. Neither path authorizes PDF access.

## Required user stops in interactive mode

Stop at these points:

1. After the intent restatement, until the user confirms or modifies it. Skip this stop for a trusted host-confirmed intent; continue to require every later interactive stop.
2. After each metadata review, wait for the user to refine the search, accept the result set, pause with the current results, ask questions, or respond freely. Do not require a fixed command or force a listed choice.
3. After result acceptance, present the candidate list with identity, access status, tier and relevance, and publish the product authorization card (`checkpoint=selection`); the card carries the download subset selection and the full-text authorization, and serve returns the granted subset as `authorization.granted_refs` — never infer it from model text. Do not ask a separate scope question and do not infer download permission from accepting the candidate set.
4. At `PAID_DOWNLOAD_PENDING`, after internally recording the managed acquisition results, wait until the user confirms downloads for the papers serve reported as failed when that scope was not explicitly included in the selection. Terminal `skipped` papers — ungranted, or without an arXiv/DOI identifier serve can fetch — are not part of that scope and are never download or recovery targets. State that these sources may require login or a subscription; do not expose the backend downloader or call the entire batch paid. Skip this stop when `paid_download_confirmation` is `included_in_selection`.
5. At `PAID_ACTION_REQUIRED`, until the CDP browser is ready or the user resolves the detected login/CAPTCHA prompt.
6. At `REPORT_REVIEW_PENDING`, until the user finishes or supplies feedback for another search.

Do not combine result acceptance with assumed download consent. Do not interpret ordinary acknowledgements as paid resume confirmation.

## Auto checkpoint resolution

In explicitly requested auto mode, do not stop at the six interaction checkpoints
above. Confirm the conservative intent from the original request, review and
accept or refine metadata results, select relevant and diverse papers, write a
delegated confirmed selection, and continue through the managed acquisition
route and reading.
When the post-open gate returns `confirm_paid_download`, report its outcome and
advance immediately from `PAID_DOWNLOAD_PENDING` with
`PAPER_DL_MODE=autodev`; do not start or wait for an interactive CDP browser.

At `REPORT_REVIEW_PENDING`, inspect the confirmed intent, report, paper summaries,
coverage, exclusions, and prior rounds. Use `report-review --decision refine` only
for a concrete evidence or coverage gap and a substantially different retrieval
direction, and store the host-authored feedback in the existing review/search
request fields. Pass `--decision-source host_agent` when recording either auto
decision. Otherwise use `report-review --decision complete` and generate
the final report. Stop refining after a round adds no usable new full text or when
another search is unlikely to materially improve the answer. Preserve all normal
validation. A substantive abstract from a selected paper without readable full
text may produce an explicitly attributed `[A#]` high-relevance reminder, but it
must never be treated as full-text evidence.

## Search iteration

The current agent follows the selected balance, full or fast_mock prompt.
`stage.py search` creates the round and returns its local stage token. Each
command checks the token and saved inputs. `stage.py complete` validates outputs
before entering REVIEW_PENDING. A current run can resume its saved round and
deadline; other release formats are rejected. See SKILL.md for commands.

## Download execution boundary

Use the capability matrix in `SKILL.md` and the selected download module's invocation rules. If the download stage is blocked by a missing or inconsistent `downloads/acquire-result.json`, remain in `DOWNLOADING_OPEN`; complete the `scholarseed_bridge` tool calls the script's reason asks for, save the verbatim acquire response, and rerun the stage. Do not relabel the event as an arXiv access failure and do not download inside the sandbox yourself.

In the download-scope prompt, relayed download progress, and consolidated completion summary, describe papers only as `arXiv` or `non-arXiv`; never expose `PaperHub`, `paper-dl`, module IDs, or internal fields. Include verified acquired counts, failure/skip/action-required counts, and verified browser-cleanup status when applicable. After the managed batches finish, call `literature delivery` for the same run to present the product save dialog once. Acquired does not mean saved or added to the library. Only product save receipts establish those outcomes; otherwise report "acquired, not saved" and point to the save card. Never invent a `downloads/papers/` location for managed PDFs. User cancellation does not block authorized reading. Reading proceeds through `pdf read` and caches the text actually used under `work-reading/`. No separate reading-confirmation question is asked. Internal logs may retain backend names.

## Paid resume semantics

The CDP setup and resume path below applies to interactive mode.

Interactive downloads claim one of three user-level browser leases after identifying real pending work. The pool starts and verifies an exclusive Chrome or Edge/profile/port; a fourth run waits. Login/CAPTCHA `action_required` keeps that lease for the same run. Startup failures are execution errors. Resume verifies lease and browser ownership before invoking the downloader. Terminal cleanup closes only registered process groups and releases only after their exit is verified. The resume token is workflow metadata, never a session secret. See `modules/paid-download/MODULE.md` for pool configuration and explicit abandonment.

When the CDP browser is ready, record `DOWNLOADING_PAID` and call the same module with `--resume`. The configured adapter verifies CDP readiness, attaches paper-dl to the visible user-controlled Chrome or Edge, and streams its output. If a CAPTCHA/login notice appears, immediately tell the user to resolve it in that Chrome or Edge and keep waiting; never automate the verification. If the returned manifest remains `action_required`, save the new action, set `PAID_ACTION_REQUIRED`, and stop until the intervention is resolved. A `completed` manifest may contain failures but means the browser interaction is over; use the consolidated arXiv/non-arXiv completion summary and report verified pool cleanup without naming the backend downloader; never ask the user to close a released slot browser.

After a completed batch and filesystem PDF verification, invoke `scripts/download_recovery.py plan` when any paper remains failed, action-required, or not-attempted; a terminal `skipped` paper is never a recovery candidate. Present exactly three choices: manually download to the supplied title-based target paths and then run `verify-manual`; resume paper-dl, which preserves successes and retries only unsuccessful entries; or skip the remainder and read verified PDFs. Manual verification atomically updates the manifest only for files with a `%PDF-` signature and reports the IDs that remain unsuccessful. It retains the lease while any paper remains `action_required`. For whole-batch skip, execute `download_recovery.py skip-and-read --run-dir "$RUN_DIR" --manifest "$RUN_DIR/downloads/manifest.json"` before reading; this releases the browser safely. For explicit termination, stop the adapter first, then use `browser_pool.py abandon --run-dir "$RUN_DIR"`. Failed cleanup stays reserved.

`PAPER_DL_MODE=autodev` is an explicit unattended alternative. It skips, rather than bypasses, CAPTCHA/login/manual-solve items and continues the batch.

## Failures and recovery

Record the failing step, timestamp, message, and transition to `FAILED`. Keep previous metadata, files, and manifest entries. Diagnose missing inputs, invalid contracts, command exit codes, and missing/empty outputs before resuming. Never convert a failure to success merely to advance the state.
