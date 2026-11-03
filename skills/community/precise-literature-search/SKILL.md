---
name: precise-literature-search
description: Iteratively search a precise research question, present candidate papers for review and selection, download authorized full texts, verify PDFs, and synthesize evidence grounded in the verified files. Use when the user emphasizes finding specific papers to answer specific research questions that may need fulltext screening. It may run unattended when explicitly requested after this skill is selected. Do not use when the user primarily wants an autonomous narrative literature review, asks broad research questions, or simply wants to download specific papers. The host must be a ScholarSeed product session, where full-text acquisition and reading happen only through the in-process `scholarseed_bridge` product tool, so other hosts cannot download or read full texts.
description_zh: 围绕明确的研究问题开展迭代检索，展示候选论文供审阅和筛选，下载具有访问授权的全文，核验 PDF，并基于已核验文件中的证据形成综合分析。适用于用户强调查找特定论文来回答可能需要阅读全文才能回答的具体研究问题。选定本技能后，用户明确要求时可无人值守运行。如果用户的主要需求是自主撰写叙述性文献综述，提出宽泛的研究问题，或者下载具体文章，则不应使用本技能。宿主必须是书深（ScholarSeed）产品会话：全文获取与阅读只通过服务进程内的 `scholarseed_bridge` 产品工具完成，其他宿主不能下载或阅读全文。
version: "1.0.37"
---

# Precise Literature Search

Turn a research question into relevant papers and an evidence-based answer.
Clarify the research intent, search scholarly metadata and the public web,
review candidates, retrieve authorized full texts, and synthesize the verified
evidence into a cited report. Support interactive review and explicitly
requested autonomous execution, with saved artifacts for refinement and resume.

## Conversation intake

This skill owns its retrieval-specific clarification and confirmation; do not
run the host's general research clarification loop first. Preserve the original
request and actual user answers. Summarize explicit topic, dates, count, paper
types and hard conditions, leaving optional fields unspecified. Follow
[intent clarification](modules/intent/clarification.md) for the question contract.
Host context never bypasses the mandatory start confirmation or authorizes auto
mode, result acceptance or downloads.

## Before starting — mandatory confirmation

Before running any command, tell the user in their language that this
workflow may take substantial time and involve multiple rounds of clue
resolution, paper retrieval, downloading, and evidence screening.
Ask whether they want to begin through `request_user_input`: present one question
with explicit start and defer choices in the user's language (for example,
"开始检索" and "暂不开始"). This question tool is allowed before the first
command; it renders the selected Skill's isolated question component.

Then STOP and wait for an explicit affirmative response.
Do not execute `stage.py start`, initialize a run, or begin research
before receiving that response.

Use the host-confirmed card answer as the response. Only an explicit start choice
advances to Phase 0–1. Do not ask the user to type "开始" or "确认" after clicking
the card, and do not replace the card with a plain-text confirmation request.
Skipped, cancelled, timed-out or unanswered cards are not approval. If the
question tool is unavailable, report that the confirmation cannot be presented
and do not initialize a run or silently fall back to text confirmation.

Confirmation of the research scope is separate and does not satisfy
this start confirmation. Selecting this skill, requesting auto mode,
silence, or an ambiguous acknowledgement does not satisfy it either.

After the user confirms, continue with Phase 0–1. Auto mode may govern
later research decisions, but must not bypass this initial confirmation.

## Complete workflow

| Phase | Agent action | Script / next checkpoint |
|---|---|---|
| 0. Start | Save the original request; choose interactive or explicitly delegated auto mode | `stage.py start` → run directory, intent draft, next command and this turn's task activation request |
| 1. Confirm intent | Edit the generated draft; restate question, criteria and scope; clarify ambiguity | Confirm intent, then execute the returned search command |
| 2. Search | Follow exactly one mode prompt; collect and screen evidence | `stage.py search` → stage token, prompt and commands; `complete` → candidates |
| 3. Review | Show real candidates, relevance and limitations | Refine with feedback, stop at metadata, or accept candidates |
| 4. Select and download | The product authorization card carries the exact download subset; download only that scope | `authorize-download`, then the card and the bridge `acquire` tool call, then `download`; resolve or explicitly skip failures |
| 5. Read | Read under the product full-text authorization; inspect verified full texts in one batch | `reading` → reader prompt; `complete` → per-paper evidence and three-sentence summaries |
| 6. Finish or refine | Show summaries; ask whether to finish or revise | `report` and `complete` → final answer, or `refine` → Phase 2 |

Interactive is the default. Auto mode requires an explicit request for automatic,
unattended or no-interaction execution. It delegates research choices within the
confirmed scope, records decisions, uses `PAPER_DL_MODE=autodev`, and skips access
interventions. Both modes allocate a dedicated Chrome or Edge from the shared
browser pool and download over CDP; auto mode does not launch headless Chromium.
Silence or ordinary acknowledgement is not auto authorization.

## User-facing language

Keep skill instructions in English. In conversation, use the user's language
and describe actions rather than internal stages. Use these aligned labels:

| Internal concept | English | 中文 |
|---|---|---|
| tier 1 | Core matches | 核心相关 |
| tier 2 | Broader matches | 拓展相关 |
| tier 3 | Supporting references | 补充参考 |
| Evidence reading | Read the full texts to check information relevant to your question | 阅读全文，核对与研究问题相关的信息 |
| Metadata | Paper titles, abstracts and bibliographic details | 标题、摘要等论文信息 |

Do not use internal terms as unexplained question labels. Generated search
reports use bilingual group headings; conversational summaries use the matching
label in the user's language. Keep numeric `tier` fields unchanged in
machine-readable artifacts.
These groups describe relevance, not verified findings or paper quality.
When referring to a subset, give its actual count and displayed paper numbers;
never copy an example count or show “Tier 1 (1–12)” as a user-facing option.

## Paths

Save UTF-8 request and feedback files. Artifacts belong in the working directory WORK_DIR,
under `.precise-literature-search/runs/<run-id>/`. SKILL_DIR is the absolute directory containing this file. Use absolute paths for bundled tools.
WORK_DIR is the current working directory.

### Product Python

Start and resume this Skill with `scholarseed-skill-python`, the host-provided
launcher for the bundled Python 3.11+ runtime. Do not select a system Python,
Homebrew Python, `py`, or a repository/Skill `.venv` yourself. The stage runner
supplies `PLS_PYTHON` and executable commands from its active product interpreter;
use those values unchanged in stage handoffs and subagents. Do not reuse an
interpreter chosen manually in an earlier attempt.

By default the download adapter runs that same Python with `-m paper_dl`, not
the `paper-dl` console script, whose shebang may reference the build machine.
Do not set `PAPER_DL_EXECUTABLE` or `PAPER_DL_ROOT` as an automatic workaround.
Honor an external downloader only when explicitly selected by the user; if an
inherited override has unclear provenance, report it and ask before changing it
or continuing. A successful external override does not verify the product path.

If the product launcher, `paper_dl`, or another required dependency is missing,
stop the affected stage and report the failing command and error. Do not install
dependencies, switch interpreters, or invoke a discovered `paper-dl` launcher.
For native PowerShell syntax, follow [the Windows guide](references/windows.md).

### Product task identity

serve authorizes full-text operations only for a turn whose product task identity it
verified itself. Every `stage.py` command returns `task_activation`: the exact
`scholarseed_bridge` request for this run. Call that tool with the request unchanged
once per turn, before the first `literature` or `pdf` operation of that turn. The
lease belongs to the turn that activated it, so a resumed run activates again.

Do not compute the request yourself, change its fields, supply a different `run_id`,
or invoke a bridge command in a subprocess: serve re-reads the run's binding file and
checks it against its own skill inventory, and rejects any mismatch. When a
`literature` or `pdf` call returns `fulltext_authorization_task_required`, activate
the lease and retry the same call. If activation itself fails, stop and report the
returned reason; never claim full-text results without it.

## Agent delegation

The current agent decides whether to use subagents based on task size,
context load, and opportunities for parallel work. Do not delegate by default.
Use subagents when the expected benefits of context isolation or parallel
execution outweigh startup and handoff overhead.


## Phase 0–1: start and confirm intent

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" start \
  --work-dir "$WORK_DIR" --request-file "$REQUEST_FILE"
```

Add `--auto-delegated` only when explicitly requested. Start returns `run_dir`,
`intent_file` (a complete, unconfirmed draft), `task_activation` (see Product task
identity) and an executable `next_command`.
Edit that file from the user's request: restate the intent and fill supported
criteria; leave unspecified values empty or null. The copied request is a draft,
not an inferred scope. Follow [intent clarification](modules/intent/clarification.md)
for material ambiguity and confirmation. Set `confirmed: true` and the appropriate
`confirmation_source` only after user confirmation or explicitly delegated intent
resolution, then run `next_command`. A user-provided already-confirmed scope needs
no repeated confirmation. No discovery before confirmed intent.

## Phase 2: search

Choose `balance` by default; an explicit choice wins:

- `balance`: one entity-resolution, PaperHub and citation iteration; default
  60-minute ceiling, at most 20 eligible papers, no result-count or tier quota.
- `fast_mock`: one-paper quick search for explicit quick requests or smoke tests;
  it still retrieves real scholarly records.
- `full`: entity/probe planning with up to eight adaptive iterations.

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" search \
  --run-dir "$RUN_DIR" --intent "$INTENT_FILE" --profile balance
```

Optional `--max-results` and `--time-budget-seconds` respect mode/user limits.
Read only the returned prompt. Use returned commands and inputs; balance starts
with `worker_context_command`, which already includes its paths and local stage token.

When the mode needs Web, discover the current executor's available capability via
[Web search capability](modules/search/DECISION_INPUTS.md#web-search-capability), then
record actual queries, durations, statuses and raw results through the mode's
recording command. This is retrospective accounting: local scripts cannot
intercept Web providers or enforce their call counts. Replaying saved results is
idempotent; classification repairs are not new searches. On resume, reuse saved
outcomes. Research-stage tokens, state and deadlines still apply. If Web fails
or is unavailable, preserve the failure and coverage limitation; never invent results.

Assess candidates against the full intent before tiering. The agent may select
promising papers for reading even when some clues remain unverified. Explain the
selection and remaining uncertainty; per-criterion proofs and metadata quotes
are optional. Selection is a candidate handoff, not confirmation of the answer.
Reuse bounded views and valid cached findings; never pad results to fill a count.
In balance, if no useful in-scope candidate exists, up to three separately labelled
related papers may be shown; these alternatives are not download choices.

Execute the returned `complete_command` after the search output is ready. It
validates the saved inputs, results and stage token before changing run state.

## Phase 3: review or refine

Before asking the user to select papers or a download scope, publish the completed
search round in a ScholarSeed conversation. After the search `complete_command`
succeeds, activate this turn's task lease and call the `scholarseed_bridge` model tool with
`{"capability":"literature","operation":"result","request":{"run":"<actual run directory relative to the session working directory>","checkpoint":"search"}}`.
Use this checkpoint only for this active skill's run under
`.precise-literature-search/runs`, never for an `agentic-search-results` directory
or another skill's output. The checkpoint is mandatory and must not be omitted
from the request.
This existing checkpoint publishes the current `search_report.md` and `metadata.json`
referenced by `state.json`, and displays the literature search-result card; it does
not request full-text authorization. Require `ok: true` and a non-empty `card_id`
before claiming delivery or continuing to download choices. On failure, preserve
the run, report the delivery failure, and do not proceed to download selection.
Do not rerun retrieval to repair publication or defer this step to `checkpoint=selection`.
Outside ScholarSeed, when the bridge is unavailable, present the candidates and
local report path without claiming a product card exists.

Present numbered candidates with title, identity, access status, tier, relevance
and a concise summary of the available evidence. State source failures, coverage
limits and details still needing full-text verification. A promising candidate
can proceed to authorized download without proving every clue at search time.
Allow refinement, metadata-only stopping or acceptance. Do not infer download
permission from accepting the candidate set.

Distinguish the user's requested outcome without adding a mandatory question.
Use the English or Chinese label according to the user's language:

- “Paper list only; finish this task” / “只要论文列表，结束本次任务”: prepare the candidates
  and relevance explanations, close the run with `metadata-only`, then deliver the list.
- “Continue with abstract-based analysis; do not read full texts” / “不读全文，基于摘要继续分析”:
  prepare an answer from the available titles and abstracts, with paper identities
  and explicit “Full texts not read” / “未读取原文” limitations. Close the run with
  `metadata-only`, then deliver that answer in the final response. The command closes
  saved workflow state, not the obligation to answer; do not leave the run at
  `REVIEW_PENDING` when ending the turn. Do not enter the PDF reader/final full-text
  report flow, invent page citations, or label this answer as full-text verified.
- “Select papers and continue to full-text reading” / “选择论文，继续阅读全文”: use the existing product authorization card below;
  do not add another download-scope or reading-confirmation question.

Do not call either no-full-text outcome “Stop at metadata” / “停在元数据阶段”. Follow a clear request
directly; clarify only when it is unclear whether the user wants a list or an answer.

For refinement, save concrete feedback and run `stage.py refine --run-dir
"$RUN_DIR" --feedback-file "$FEEDBACK_FILE"`, then `stage.py search --run-dir
"$RUN_DIR"`. The mode and feedback carry forward. A material scope change needs
an updated confirmed `--intent`. In interactive mode, only after the user explicitly
confirms the new scope, set `confirmed: true` and `confirmation_source: user_explicit`.
Use `confirmation_source: auto_delegated` only when initial auto delegation was
recorded. An explicit mode change uses `--profile`.
To stop before downloads, use `stage.py metadata-only --run-dir "$RUN_DIR"
--decision-source user_explicit`.

## Phase 4: authorize and download

Before writing an intermediate download-request file (for example, `$RUN_DIR/work/acquire-papers.json`), create its parent directory if it does not exist.

Present the candidate list with identity, access status, tier and relevance.
The product authorization card carries the download subset selection; do not
ask a separate scope question and do not infer download permission from
accepting the candidate set. Some sources need login, subscription or human
verification. Use arXiv/non-arXiv in messages;
`download_open` and `download_paid` are the two internal route fields.

Save the exact selection to `selection.json`, bound to the current round's
`metadata.json`, as described in [selection input](references/integration-contracts.md).
The search worker's `search/round-NNN/work/selection.json` is a ranked search
artifact, not the confirmed download selection. First pass the confirmed input to
`stage.py authorize-download`; this validates and registers the run-level
`selection.json`. In a ScholarSeed conversation, activate this turn's task lease
(see Product task identity), then publish that registered
selection with the product-owned `checkpoint=selection` flow. The skill stage is
preparation, not the product authorization decision. Do not start either download route
until the product checkpoint returns `authorization.disposition=authorized`.
A rejection, publication failure, or interruption ends the current turn immediately
and preserves the run for resume.
On a later product continuation after rejection, follow its instruction to answer
from titles and abstracts, as described above; rejection is not a request to
terminate the research task. Never retry authorization without a new user request.

Keep waiting on the blocking checkpoint until it returns; keep the existing
plan unchanged while waiting and continue in the same turn only on authorization.
The product owns the `精准检索授权` interaction, including the download subset
chosen on that card. Do not call `literature authorize` for this task or ask a
separate reading-confirmation question; acquisition and reading remain behind
the card's decision.

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" authorize-download \
  --run-dir "$RUN_DIR" --selection "$SELECTION_FILE" --decision-source user_explicit
```
Then call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"result","request":{"run":"<actual run directory relative to the session workdir>","checkpoint":"selection"}}`. Its `authorization` carries `disposition` and `granted_refs`: the `paper:<id>` subset that serve derived from the user's persisted card decision — never guess or invent it. Only after it returns `authorization.disposition=authorized`, call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"acquire","request":{"run":"<same run directory>","papers":[{"paper_id":"<id>","identifier":"<arxiv id or doi>","identifier_kind":"arxiv","title":"<title>"}]}}` for every paper in `granted_refs` — serve acquires by arXiv id or DOI — at most 5 papers per call, batching the rest. For each paper send its arXiv id with `"identifier_kind":"arxiv"` when it has one, otherwise its DOI with `"identifier_kind":"doi"`; do not filter the granted subset by access metadata. Save the acquire response verbatim as `downloads/acquire-result.json` in the run directory — never rewrite, hand-author or fabricate it; when several batches were needed, carry every batch's reported entries into that one record unchanged. Then run `stage.py download`, which treats that record as untrusted input: it shape-checks it, asserts it never exceeds the confirmed selection, and binds the managed entries into `downloads/manifest.json`. Never fetch full-text bytes inside the sandbox. A paper the record never mentions — because it is outside the granted subset or has no arXiv/DOI identifier serve can fetch — is recorded as a terminal `skipped` entry: it is never routed to a downloader and no full text may be claimed for it. No PDF copy is written into the run directory; serve re-verifies every managed entry against its own object map at the delivery checkpoint.
```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" download --run-dir "$RUN_DIR"
```

If the checkpoint returns `literature_result_selection_not_prepared`, run the
preparation command once with the already confirmed selection and retry the same
checkpoint. Do not substitute the worker selection, change scope, or bypass the
product gate.

Authorization binds current IDs, selection, metadata and round. Changed inputs
require a new decision. In auto mode use `auto_delegated` for decision-source;
the script accepts it only when initial delegation was recorded.

Before the first download, explain once: a host stop control may leave the
background downloader running; send “stop download” (or its language equivalent)
to cancel it. On cancellation, interrupt the original active command, verify its
child processes stopped, then use scoped browser cleanup. Do not merely stop
polling, kill by process name, or close a browser another run may now own.

At `PAID_DOWNLOAD_PENDING`, obtain the separately requested non-arXiv confirmation
before `download --confirm-non-arxiv`. The paper-dl route only recovers granted
papers that serve reported as failed (plus `action_required` items from a previous
paid batch); a terminal `skipped` paper — ungranted, or without an arXiv/DOI
identifier — is never a download or recovery target. At `PAID_ACTION_REQUIRED`, show the safe
instructions and wait for the user to resolve them before `--intervention-resolved`.
Never automate login, CAPTCHA or subscription access. Do not save credentials.
Use [download recovery](scripts/download_recovery.py) to retry unsuccessful items,
recover manually provided files or explicitly skip failures. Empty input does
not resolve an intervention. Preserve verified successes.

Report computed acquired/selected counts and unresolved counts. Managed acquisition
is not a user-visible PDF directory: never report `downloads/papers/` or a managed
object path as the user's download location. Mention browser release only when
the returned notice confirms it.

### Download admission

Serve acquisition automatically saves each successful PDF as a literature item with its
own primary attachment and links it to the current session's project. Check the separate
`admission` result: downloaded does not mean admitted. A failed admission does not require
another download.

After every download or recovery batch with verified successes, including a partial batch
waiting for login, immediately call the native `scholarseed_bridge` tool with
`{"capability":"literature","operation":"ingest","request":{"run":"<actual run directory relative to the session workdir>"}}`.
`stage.py download` returns this as `download_admission` when its manifest contains
successes, including a blocked download with partial successes. Preserve and report the
download error while admitting those successes. Status, reading, report, resume and
cancel commands do not request admission.
After a recovery batch or an explicit admission retry, use the native request above.
Do not ask the
user to import manually or wait for reading/final-report. This product operation verifies
the actual PDFs, saves their complete search metadata, and publishes an “Open full text”
card. Repeating it for the same run is safe and does not duplicate admitted papers.
Report any `failures` independently and retry admission when recoverable. Ingest returns
admission receipts separately from `delivery`. Large results include `total_papers`,
`total_failures` and `next_cursor`: continue the same native ingest request with its
unchanged `run` and the returned `cursor` until `next_cursor` is null. These pages only
read saved receipts; they do not download or admit again. Report every failure, including
failures on later pages. If `receipt_delivery.ok=false`, the complete receipt could not
be stored; saved papers still remain in the library. Report that error and retry ingest
without downloading again. `delivery.ok=false` means
the chat card was not published, not that saved papers were lost. Report that error and
retry ingest without downloading again; bounded cards preview a few papers and link to
the existing library for the rest. Never fabricate
library IDs or bypass the product interface with filesystem/database writes.


After registering every successful download or recovery batch through ingest, including
managed acquisition and paper-dl files, and finishing this round's download stage,
call the `scholarseed_bridge` model tool with
`{"capability":"literature","operation":"delivery","request":{"run":"<same actual run directory relative to the session workdir>"}}`.
Serve freezes its recorded acquisition batch and presents one product-owned save
dialog. The user chooses a project folder or a local folder independently of automatic
library admission. The library option reuses valid existing papers and restores deleted
papers only when the user explicitly confirms saving with that option selected. Automatic
ingest retries must not restore user-deleted papers. Never supply destination paths or fetch PDF
bytes in the sandbox. The returned delivery ID and acquired count do not mean
the PDFs have been saved. User cancellation does not revoke authorized reading.
Continue the research without waiting for the save dialog; report only confirmed
product results separately: library admission and resource saving are different outcomes.
If resource saving was not confirmed, say "not saved to resources", even when library
admission succeeded. The product
card remains available for saving later, retrying failures, and opening the folder.
Refining the same run starts another acquisition batch without changing earlier
delivery receipts. If no acquisition was attempted, do not call this checkpoint.

## Phase 5: read verified full texts

After the product full-text authorization (or recorded auto delegation):

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" reading \
  --run-dir "$RUN_DIR" --decision-source user_explicit
```

Resolve or explicitly skip failures first. Activate this turn's task lease before
the first bridge call of the turn (see Product task identity), then read the
downloaded papers.
For a managed entry, read it by calling the `scholarseed_bridge` model tool
with `{"capability":"pdf","operation":"read","request":{"ref_id":"paper:<id>","offset":0}}`,
advancing `offset` to the response's `next_offset` until it is `null` (`offset`
indexes evidence fragments, not PDF page numbers; `span` sets the fragments per
window) — serve
checks the authorization of every ref on every read — and
cache the text actually used at `work-reading/<paper_id>.txt`, which
`reading-outcome.json` names in `file_path`. A run-contained PDF left by the
paid route is read directly at its `file_path`. Optionally call the
`scholarseed_bridge` model tool with
`{"capability":"literature","operation":"receipt","request":{"run":"<run directory>"}}`
to re-confirm this turn's authorized scope (`disposition` plus granted refs);
no separate reading-confirmation question is asked. Verify evidence from the
full texts, not from metadata. If no verified full text exists, the script
records an honest zero-full-text outcome without reading.
Follow [reading outcomes](references/reading-outcome.md). Complete with the returned
command, then show each readable paper's three-sentence interaction summary.

## Phase 6: finish or iterate

After an explicit finish decision (or recorded auto delegation):

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" report \
  --run-dir "$RUN_DIR" --decision-source user_explicit
```

Follow its prompt and returned completion command. Keep outputs distinct:
`read_report.md` owns coverage/status/exclusions; `paper_summary.md` owns per-paper
full-text evidence and relevance; `final_report.md` answers the question with
cross-paper synthesis and numbered citations. Reading may contradict the original
selection reason. Never substitute a PDF signature or abstract for read evidence.

In a ScholarSeed conversation, `complete --stage final-report` validates the run
but does not itself deliver the files. After it succeeds, publish the terminal
artifacts through the product-owned checkpoint, with this turn's task lease active
(see Product task identity) and using the actual run path relative
to the session working directory:

Call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"result","request":{"run":".precise-literature-search/runs/<run-id>","checkpoint":"final"}}`.

The checkpoint snapshots `final_report.md` as the final artifact and
`paper_summary.md` plus `read_report.md` as supporting artifacts. Claim delivery only
when the command returns `ok: true` and all three artifact
references. On failure, preserve the completed run, report that delivery failed,
and do not say the files are available in ScholarSeed. This checkpoint is separate
from the literature search-result card and does not republish intermediate files.


If the user refines, return to Phase 3. In auto mode refine only for a concrete
gap and a different retrieval direction; stop when further work is unlikely to
add useful evidence. Preserve source limitations, including no-answer outcomes.

## Resume and errors

ScholarSeed observes the run artifacts and may interrupt an unauthorized download.
If its continuation message grants authorization, resume the saved run immediately
after candidate selection without searching, selecting or asking for authorization
again. Re-activate this turn's task lease and read the product receipt for the
authorized subset before acquisition. If the continuation rejects authorization,
read no full text; any permitted metadata-only response must be labeled
`未读取原文`. Never treat this authorization pause as a skill failure or bypass it
through another download or reading route.

Use `stage.py status --run-dir "$RUN_DIR"` for counts/paths, and `stage.py resume
--run-dir "$RUN_DIR" --token "$STAGE_TOKEN"` for an interrupted stage. It retains
the request, plan, deadline and input bindings. Stop an optional executor before
resuming locally. To abandon its stage, first stop the active command/executor,
then `stage.py cancel --run-dir "$RUN_DIR" --token "$STAGE_TOKEN"`; a later resume
returns a new token. Never clear files or edit hashes to force recovery.

Keep successful outputs when a command fails; correct only the failed output
and retry completion. Relay [progress](references/progress.md) changes and quiet
20-second heartbeats without repeating unchanged reports. Consult
[workflow states](references/workflow.md) for transition diagnosis, or
[integration contracts](references/integration-contracts.md) for exact file shapes.
