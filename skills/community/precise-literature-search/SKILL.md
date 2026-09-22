---
name: precise-literature-search
description: Iteratively search a precise research question, present candidate papers for review and selection, download authorized full texts, verify PDFs, and synthesize evidence grounded in the verified files. Use when the user emphasizes finding specific papers to answer specific research questions that may need fulltext screening. It may run unattended when explicitly requested after this skill is selected. Do not use when the user primarily wants an autonomous narrative literature review, asks broad research questions, or simply wants to download specific papers.
description_zh: 围绕明确的研究问题开展迭代检索，展示候选论文供审阅和筛选，下载具有访问授权的全文，核验 PDF，并基于已核验文件中的证据形成综合分析。适用于用户强调查找特定论文来回答可能需要阅读全文才能回答的具体研究问题。选定本技能后，用户明确要求时可无人值守运行。如果用户的主要需求是自主撰写叙述性文献综述，提出宽泛的研究问题，或者下载具体文章，则不应使用本技能。
version: "1.0.11"
---

# Precise Literature Search

Turn a research question into relevant papers and an evidence-based answer.
Clarify the research intent, search scholarly metadata and the public web,
review candidates, retrieve authorized full texts, and synthesize the verified
evidence into a cited report. Support interactive review and explicitly
requested autonomous execution, with saved artifacts for refinement and resume.

## Before starting — mandatory confirmation

Before running any command, tell the user in their language that this
workflow may take substantial time and involve multiple rounds of clue
resolution, paper retrieval, downloading, and evidence screening.
Ask whether they want to begin.

Then STOP and wait for an explicit affirmative response.
Do not execute `stage.py start`, initialize a run, or begin research
before receiving that response.

Confirmation of the research scope is separate and does not satisfy
this start confirmation. Selecting this skill, requesting auto mode,
silence, or an ambiguous acknowledgement does not satisfy it either.

After the user confirms, continue with Phase 0–1. Auto mode may govern
later research decisions, but must not bypass this initial confirmation.

## Complete workflow

| Phase | Agent action | Script / next checkpoint |
|---|---|---|
| 0. Start | Save the original request; choose interactive or explicitly delegated auto mode | `stage.py start` → run directory, intent draft and next command |
| 1. Confirm intent | Edit the generated draft; restate question, criteria and scope; clarify ambiguity | Confirm intent, then execute the returned search command |
| 2. Search | Follow exactly one mode prompt; collect and screen evidence | `stage.py search` → stage token, prompt and commands; `complete` → candidates |
| 3. Review | Show real candidates, relevance and limitations | Refine with feedback, stop at metadata, or accept candidates |
| 4. Select and download | Obtain a separate exact paper/access selection; download only that scope | `authorize-download`, then `download`; resolve or explicitly skip failures |
| 5. Read | Confirm reading; inspect verified PDFs in one batch | `reading` → reader prompt; `complete` → per-paper evidence and three-sentence summaries |
| 6. Finish or refine | Show summaries; ask whether to finish or revise | `report` and `complete` → final answer, or `refine` → Phase 2 |

Interactive is the default. Auto mode requires an explicit request for automatic,
unattended or no-interaction execution. It delegates research choices within the
confirmed scope, records decisions, uses `PAPER_DL_MODE=autodev`, and skips access
interventions. Silence or ordinary acknowledgement is not auto authorization.

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
`intent_file` (a complete, unconfirmed draft) and an executable `next_command`.
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

Call native Web directly when the mode's discovery strategy needs it, then
record actual queries, durations, statuses and raw results through the mode's
recording command. This is retrospective accounting: local scripts cannot
intercept native Web or enforce its call count. Replaying saved results is
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

Present numbered candidates with title, identity, access status, tier, relevance
and a concise summary of the available evidence. State source failures, coverage
limits and details still needing full-text verification. A promising candidate
can proceed to authorized download without proving every clue at search time.
Allow refinement, metadata-only stopping or acceptance. Do not infer download
permission from accepting the candidate set.

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

Offer all papers, arXiv-only papers, or numbered papers. “All” includes authorized
non-arXiv acquisition, including openly available non-arXiv copies. Some sources
need login, subscription or human verification. Use arXiv/non-arXiv in messages;
`download_open` and `download_paid` are the two internal route fields.

Save the exact selection to `selection.json`, bound to the current round's
`metadata.json`, as described in [selection input](references/integration-contracts.md).
The search worker's `search/round-NNN/work/selection.json` is a ranked search
artifact, not the confirmed download selection. First pass the confirmed input to
`stage.py authorize-download`; this validates and registers the run-level
`selection.json`. In a ScholarSeed conversation, then publish that registered
selection with the product-owned `checkpoint=selection` flow. The skill stage is
preparation, not the product authorization decision. Do not start either download route
until the product checkpoint returns `authorization.disposition=authorized`.
A rejection, publication failure, or interruption ends the current turn immediately
and preserves the run for resume.

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" authorize-download \
  --run-dir "$RUN_DIR" --selection "$SELECTION_FILE" --decision-source user_explicit
scholarseed-bridge literature result \
  --json '{"run":"<actual run directory relative to the session workdir>","checkpoint":"selection"}'
# Run only after the checkpoint returns authorization.disposition=authorized.
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
before `download --confirm-non-arxiv`. At `PAID_ACTION_REQUIRED`, show the safe
instructions and wait for the user to resolve them before `--intervention-resolved`.
Never automate login, CAPTCHA or subscription access. Do not save credentials.
Use [download recovery](scripts/download_recovery.py) to retry unsuccessful items,
recover manually provided files or explicitly skip failures. Empty input does
not resolve an intervention. Preserve verified successes.

Report computed verified/selected counts, unresolved counts and the absolute
PDF directory. Mention browser release only when the returned notice confirms it.

## Phase 5: read verified full texts

After reading confirmation (or recorded auto delegation):

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" reading \
  --run-dir "$RUN_DIR" --decision-source user_explicit
```

Resolve or explicitly skip failures first. Read the downloaded papers.
Verify evidence from the PDFs, not from metadata. If no verified PDF
exists, the script records an honest zero-full-text outcome without reading.
Follow [reading outcomes](references/reading-outcome.md). Complete with the returned
command, then show each readable paper's three-sentence interaction summary.

## Phase 6: finish or iterate

After an explicit finish decision (or recorded auto delegation):

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/stage.py" report \
  --run-dir "$RUN_DIR" --decision-source user_explicit
```

Follow its prompt and returned completion command. Keep outputs distinct:
`report.md` owns coverage/status/exclusions; `paper_summary.md` owns per-paper
full-text evidence and relevance; `final_report.md` answers the question with
cross-paper synthesis and numbered citations. Reading may contradict the original
selection reason. Never substitute a PDF signature or abstract for read evidence.

In a ScholarSeed conversation, `complete --stage final-report` validates the run
but does not itself deliver the files. After it succeeds, publish the terminal
artifacts through the product-owned checkpoint, using the actual run path relative
to the session working directory:

```bash
scholarseed-bridge literature result --json \
  '{"run":".precise-literature-search/runs/<run-id>","checkpoint":"final"}'
```

The checkpoint snapshots `final_report.md` as the final artifact and
`paper_summary.md` plus `report.md` as supporting artifacts. Claim delivery only
when the command returns `ok: true` and all three artifact
references. On failure, preserve the completed run, report that delivery failed,
and do not say the files are available in ScholarSeed. This checkpoint is separate
from the literature search-result card and does not republish intermediate files.

If the user refines, return to Phase 3. In auto mode refine only for a concrete
gap and a different retrieval direction; stop when further work is unlikely to
add useful evidence. Preserve source limitations, including no-answer outcomes.

## Resume and errors

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
