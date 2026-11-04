---
name: literature-review
description: >-
  Produce or revise an evidence-grounded literature review, survey, related-work
  section, or individual chapter from a precise research intent. Discover papers,
  extract cards, design an outline, draft with citations, generate figures and
  tables, and verify Markdown or PDF deliverables. Requires configured model
  backends and the independent agentic-search skill for new literature discovery.
description_zh: >-
  从一句精准的研究意图出发，生成或修订有证据支撑的文献综述、调研报告、
  相关工作章节或单独章节。完成论文检索发现、paper card 证据抽取、大纲设计、
  带引用的正文撰写、图表生成，并核验 Markdown 或 PDF 交付物。需要已配置的
  模型后端，新文献检索依赖独立安装的 agentic-search skill。
metadata:
  version: "2026.10.30+2"
version: "2026.10.30+2"
---

# Literature review — main-agent contract

## Roles and your loop

- Main owns task interpretation, delegation, outline revisions, user-visible choices, concrete exception decisions, final PDF inspection and full-manuscript corrections.
- Scripts own evidence processing, initial outline generation, concurrent chapter requests, assembly of complete native v1, one full-input delta refinement into editable v2, and publication.
- Search and figure subagents read their own role briefs; scripts supply the outline, chapter and refinement models' authoring instructions. Do not duplicate their authoring work or switch to legacy section-writing commands.

Run the stage command → read its compact result → take the action for that stage.

- Build every call from its current tool schema, documented request shape and returned identifiers; when the contract is not yet available, obtain it through the documented discovery surface before acting.
- Preserve each stage command's execution boundary: invoke it directly, keep the call attached until it returns its compact result or decision boundary, and let the stage runner own its internal sequencing.
- For a needed input shape not covered here, query that command's `--describe-input` before guessing fields: `writing configure/approve`, `outline configure`, `figures plan`, `evidence build`, or `papers import-local`.
- `--describe-input` returns required fields, supported variants and complete examples without writes or model calls; it is not a routine extra startup step. Use actual IDs and user quotes, never illustrative values.
- `outline configure --describe-input` also returns the current full outline and selected paper IDs when a workspace is available. Evidence-view options are for concrete exceptions only.
- On failure, start with the command's field-specific error, `next_action` and named artifact/log. Inspect implementation only for a concrete defect unresolved by public diagnostics, not to rediscover request shapes.
- CLI defaults to the compact JSON main view; all subcommands accept `--json` explicitly. `--json` does not imply `--full`, which returns complete supported command reports. Full artifacts/logs remain on disk; do not open them merely to reproduce a progress message.
- Send short updates at startup, stage transitions, before long calls and on concrete exceptions; during waits use observed status. Distinguish retrieved papers, fulltext sources, abstract cards and finished figures. No invented percentages/times and no routine approval questions.

## The path

After understanding the user's request and scope, before the first long-running
operation, use the host's existing conversation plan. In ScholarSeed, follow the
host's structured `scholarseed_bridge` plan contract; do not create a second
native flat plan. Outside ScholarSeed, use the host's native plan tool when
available. Default full-survey stages, in the user's language:

1. Determine research scope and output requirements.
2. Discover papers and prepare evidence.
3. Generate the outline and resolve publication choices.
4. Generate text and figures concurrently, then refine the manuscript.
5. Publish, inspect and deliver.

Treat these main stages as the stable structure of the task. In ScholarSeed,
read the current structured plan before each progress write and preserve every
root item's ID, content, order and parent relationship exactly. Use `update` to
change observed statuses and to add or update detailed child steps; put concrete
progress such as selected counts, authorization, publication choices and current
generation work in those children rather than rewriting a root title. Use
`revise` only when the user's requested scope or deliverables actually change.

| Stage | Commands / work | Result → next action |
|---|---|---|
| Configure | `doctor --no-network` → `init` → `writing configure` | Bound launcher and authoritative task → supply papers |
| Papers | `papers import-local` when applicable → `papers budget` → delegate discovery when needed | Imported sources → `run retrieval_adapt` |
| Evidence | `run retrieval_adapt` → product-owned retrieval checkpoint → `workflow evidence --from fulltext` | Handle error/review boundaries; `outline_display` → display the packet |
| Confirm | Display `outline review-packet`; `writing approve` for a real decision | Honor applicable authorization → `manuscript prepare` |
| Generate | `manuscript prepare` → figure branch and `manuscript generate` concurrently | v1 assembly and one refinement → editable v2 |
| Publish | `workflow publish` → bounded page check (first page + figure/table pages) → fix observed issues and republish | Deliver; report checks done and their limits |

## 1. Configure

### Do

- Use the supplied skill path and caller directory. Identify the execution tool's OS/shell (not the desktop shown in a screenshot). On Windows use `<skill>\scripts\slr.cmd doctor --no-network --json`; on macOS/Linux/WSL use `<skill>/scripts/slr doctor --no-network --json`. If a host executes argument arrays, use the product Python launcher `scholarseed-skill-python <skill>/scripts/bootstrap.py`.
- Doctor reports the actual OS, Python, output capabilities and `runtime.cli` as argv plus shell-specific commands. Use that resolved CLI for `init --workspace <caller/topic> --intent "<original request>"`; do not mix Windows and WSL interpreters or paths. If the environment is missing, follow the returned setup command first. Doctor is read-only.
- Use a separate workspace per deliverable; do not overwrite an existing survey. Explicit output destinations take precedence.
- For an existing task without a launcher, omit `--intent` to preserve its task.
- Init returns the platform launcher and `runtime.cli`; reuse its exact argv or the matching shell command for all later calls and delegated roles. POSIX workspaces have `slr`, Windows workspaces have `slr.cmd`. Do not rely on persistent cd, aliases, activation or exported variables.
- Before running the bound workflow, call the `scholarseed_bridge` model tool with `capability=task`, `operation=activate`, and a request containing `task_type=literature_review`, `skill_name=literature-review`, the bound `skill_version` and `skill_path`, and the session-workdir-relative `workspace`. The product resolves and returns the run identity from the verified binding; do not compute or pass `run_id`. Do not invoke a bridge command in a subprocess.
- Take `skill_version` and `skill_path` from the actual workspace binding (`.slr-binding.json`, fields `version` and `skill`), not memory or examples. Never guess activation fields or values. Keep using the bound `runtime.cli` for stage commands; neither the launcher nor a read-only status command automatically activates or renews a product task lease.
- If a checkpoint returns `task_context_missing`, perform its `next_action`: verify the original binding and activate through the model tool in this turn, then retry the checkpoint only after activation succeeds. If the binding is absent or invalid, restore or initialize it through the documented entry first; do not fabricate metadata or switch workspaces to bypass the failure.
- After a failed review request, do not submit the same request again while inputs and state are unchanged. Follow `next_action` (or `action`), and resolve `validation_errors` against `request_schema`; a successful activation or a verified input/artifact correction permits retry. Task mismatch, stale context or denied authorization is not permission to restart or bypass the checkpoint.
- Reuse the exact `workspace` returned by task activation for every literature review checkpoint. Do not substitute a stage directory or an absolute path. Existing surveys bound to the session root use `workspace="."`; new surveys use a separate relative directory.
- Discover paths only for an invalid entry or a dependency doctor reports missing. The launcher binds the product Python 3.12.x and performs product skill admission. Use `<skill>/scripts/setup` on POSIX or `<skill>\scripts\setup.cmd` on Windows; `SCHOLARSEED_PYTHON` is supplied by the product. Setup verifies its environment; never create a private skill venv. Existing workspace bindings take precedence; a moved or incompatible binding must be restored before resuming.
- Configure the sole task through `writing configure --request FILE` (or `-` for stdin).
- `01_input/writing_request.json` owns immutable original intent, ordered verbatim follow-ups and current effective interpretation. Derived query/output files and stage advice cannot override it; retired requirements files are ignored.
- Keep local language/scope exceptions and only requested modules. Do not invent length or section quotas from corpus size.

### Request rules

- The request `language` is the document default. Each top-level outline chapter uses `language: default|chinese|english`; choose `default` unless the user explicitly requested a chapter exception. Preparation resolves defaults and hard-injects the result into every independent chapter task.

```json
{"user_requests":["正文中文，摘要内容英文。"],
 "effective_requirements":"保留研究范围；正文、标题和图注中文，摘要内容英文。",
 "language":"CHINESE",
 "publication":{"format":"latex_pdf","template":"ctexart","citation_style":"numeric"},
 "constraints":[{"id":"abstract-language","kind":"other",
   "value":"摘要内容英文","verbatim":"摘要内容英文"}]}
```

- This example demonstrates value shapes only: `publication.template` is the string `"ctexart"`, never an object such as `{"type":"ctexart"}`. Copy only actual user follow-ups and source text, never the example's content. Follow-ups require `effective_requirements`.
- `publication` and `retrieval` merge immediate keys; `constraints` replaces the complete list, so retain all still-applicable constraints. Other supplied fields replace those fields.
- A request for a complete reference list is fulfilled by the publisher. Preserve it in the task text or an `other` constraint; never translate it into a `required_section` called References/Bibliography/参考文献. Reference lists are not model-authored outline nodes, even when the user requests them at the end.
- Every constraint needs unique `id`, `kind`, typed `value` and `verbatim` grounded in one recorded user instruction. Prefer a direct contiguous quote. A lightly normalized or shortened quote is accepted when more than 60% of its characters remain in the same order within `intent`, `user_instructions`, or one `user_requests` entry. Do not join unrelated fragments or quote derived `effective_requirements`; use separate constraints for separate requirements.

| Kind | Value |
|---|---|
| required_section / forbidden_section | `{title, role?, position?}` |
| figure_count / table_count / total_citations | `{min?, max?}` |
| min_papers_per_section / min_paper_citations | nonnegative integer |
| venue_whitelist | nonempty string array |
| must_include_paper | object with title and optional identifiers |
| excluded_topic / angle / other | nonempty string |

- Section constraint `role` is optional; normally omit it and let the outline model choose from the section's meaning. Its only values are `foundation`, `background`, `introduction`, `analysis`, `synthesis`, `conclusion`, `abstract`, `component`; do not invent new role strings.
- Roles are operational, not topic names: algorithm taxonomies and cross-problem comparisons normally use `analysis`; scientific scope belongs in the title/description and analytical tasks. Terminal roles (`abstract`, `synthesis`, `conclusion`) receive the full corpus.
- Section `position` accepts `first`, `last`, `any`, or `after:<section title>`.
- Explicit length uses `length_min`, `length_max`, `length_target`, optional `length_unit` (words, cjk_chars, characters, pages).
- Full surveys default to `writing_strategy:"chapter_delta"` and an abstract unless excluded; `output_scope` is `survey`, which is also the default when omitted. Components use `output_scope:"section"`, optional `selected_section_ids`, and no survey abstract requirement. All native generation uses the same chapter-task and full-source delta pipeline.
- Retrieval accepts `corpus_size:{target:40}` (optional positive min/max), dimensions, time_range, temporal_policy and mode; corpus_size is never a bare integer. Init supplies the default 40-paper target, independent of manuscript length.
- `time_range` uses integer `start_year` and `end_year`, not `start`/`end`. Use the actual requested years; query `writing configure --describe-input` when an example is needed, without treating example years as a default time window.

### Framework-owned routing and configuration failures

- Text/image scripts prefer the environment's public `skill_model_client`; only import failure selects direct transport. Runtime context or request failures do not fall back.
- The framework owns routing, provenance and moderation; main never constructs protocol metadata or guesses session IDs. File-producing text calls mark only the current task text; image calls pass the actual drawing prompt.
- Standalone direct text/image defaults: `https://scholarseed.damo.alibaba.com/v1/`. Text uses `SCHOLARSEED_ACCOUNT_TOKEN`; images prefer `IMAGE_API_KEY` and fall back to `SCHOLARSEED_ACCOUNT_TOKEN` when unset or empty. `TEXT_BASE_URL` / `IMAGE_BASE_URL` override endpoints.
- PaperHub binary downloads independently use `SCHOLARSEED_API_KEY` / `PAPERHUB_URL`, default `https://scholarseed.damo.alibaba.com/paperhub`. Known retired defaults migrate; custom overrides remain supported.
- Never write secrets to task/artifact files.

## 2. Papers

### Do: import local sources and obtain the search budget

For local PDFs, first use `papers import-local --request FILE`:

```json
{"files":["/absolute/papers",{"path":"/absolute/a.pdf","title":"Actual title",
 "authors":["Actual author"],"year":2024,"doi":"10.example/actual-id"}]}
```

- Use actual paths and known true metadata; directories are supported. Import copies local snapshots without uploading PDFs, deduplicates identical bytes and reports `metadata_gaps`.
- Inspect the first page and resubmit true metadata when available. Never infer year from file times or authors from PDF producer fields; unknown metadata stays unknown.
- Snapshots survive moved originals; changed/missing snapshots or changed local configuration need explicit reimport.
- Per-file objects accept only path, title, authors (an array of names), year, doi and optional abstract (actual source text, never an invented summary). Directory entries contain only path; metadata belongs to individual PDF files.
- Run `papers budget`; pass its `search_target` verbatim and reliable local titles/DOIs to discovery. Default without local PDFs is 40; N>=40 unique local PDFs keeps all locals and skips search. Do not silently trim supplied papers.

### Do: delegate discovery when search_target > 0 and discovery is needed

Spawn one fresh search subagent with `fork_turns:"none"`; never a second concurrent
or repeat searcher for the same task. Before spawning, state the intended agent
count and disjoint write scope; record and reuse the returned agent id, including
after timeouts or interruptions. Supply this complete delegation:

- Fixed caller directory, workspace launcher, skill path and [searcher role brief](references/roles/slr-searcher.md), which the child reads itself.
- One precise natural-language literature-search intent translated once from the authoritative task. Preserve all research semantics. Include the explicit time range or task's recent-five-year default as a **soft preference**, retaining earlier foundational work; do not phrase it as a hard before/after cutoff.
- Task retrieval dimensions, exact search_target, reliable supplied titles/DOIs to exclude from supplemental discovery, and every retrieval constraint verbatim.
- Explicit `balanced` mode unless the user selected another mode/budget. Require complete, unabridged real abstracts, named authors and source publication years for selected discovered papers. Exclude missing/placeholder/truncated records; no abstract-recovery search or padding to fill the count.
- Invoke the independent `$agentic-search` through its existing interfaces; do not supply an AS installation/config path, invent flags or modify AS. The child imports its result with `import-search --source <AS-result-dir>` and returns compact status/limitations, not its paper pool.

### Return and ownership

- Read the searcher's `status_reason` for unresolved exclusions and shortfalls. After import, or for a local-only task, run `run retrieval_adapt` as its own command. Never start `workflow evidence` without `--from`.
- Venue/citation-floor screening belongs to the deterministic adapter. The search subagent implements excluded-topic requirements semantically during discovery; there is no keyword recheck or extra excluded-topic LLM.
- AS owns its fallback; do not repeat PaperHub checks or ask for tokens after Web fallback.

### Discovery failure is a blocking boundary

Natural-language requests and explicit skill selection follow this same path.
Main must not replace the searcher/import-search/retrieval_adapt chain with direct
`scholarseed_bridge search/run`, shell HTTP queries or an improvised paper pool.
The searcher may use AS's own documented fallback; main does not own a second one.

If discovery, import or retrieval adaptation fails or produces no usable evidence,
retain its artifacts and report the exact returned error, status_reason and
next_action, including invocation_id when available. Stop before full-text,
outline, manuscript or publication stages. Keep discovery blocked in the plan;
do not mark it completed because retries were exhausted. Resume only after the
reported prerequisite is resolved through the owning command or the user changes
the scope. Do not hand-write or publish a replacement review, invent statistics,
or create success reports to make a result card look complete. A result checkpoint
may show the retained incomplete state; it is not authorization to bypass stages.

## 3. Evidence

### Do

Run `run retrieval_adapt` as its own command. Resolve any reported retrieval case
that needs main's judgement before continuing. Once retrieval returns usable
`SUCCESS` or `PARTIAL_SUCCESS`, and before any full-text, processing or
`workflow evidence` command, wait for the product authorization in this same turn:

Call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"review","request":{"workspace":"<workspace returned by task activation>","checkpoint":"retrieval"}}`.

Send this checkpoint once with only `workspace` and `checkpoint`; do not add a
manually computed `run_id` or issue a parallel retry while it waits for authorization.
Keep waiting on that model tool call until it returns. Do not call `request_user_input`,
construct or relay an authorization question, or poll another tool. When it returns
`authorization.disposition=authorized`, read the current structured plan and update
it with its root items unchanged so retrieval is completed and a full-text /
PaperCard child step is in progress;
only after that plan write succeeds may you run `workflow evidence --from fulltext`.
That workflow continues fulltext → processing → outline generate → review-packet,
without new model stages, and stops on errors or the outline display boundary. On
rejection, failure, interruption or stale state, make no full-text or later-stage
writes and end the turn with the retrieval artifacts retained.

The checkpoint publishes the actual candidate and selection card; the product
owns the `综述检索授权` interaction. Keep the existing plan tree unchanged while
waiting. Do not replace this checkpoint with `request_user_input` or a separate
authorization question.

ScholarSeed observes the candidate artifacts and interrupts an unauthorized
full-text stage. If a ScholarSeed continuation grants authorization, resume the
saved task after candidate selection without searching, selecting or asking for
authorization again; perform the plan transition above before continuing from
fulltext. A rejected continuation grants no full-text or later-stage writes:
retain the artifacts and plan for an explicit later resume. Any permitted
title/abstract-level response must be labeled `未读取原文`. This pause is not a
skill failure and does not authorize another retrieval or reading route.

The workflow runner also enforces this boundary: an accidental `workflow evidence`
or `workflow evidence --from retrieval_adapt` can run retrieval only and returns
`fulltext_authorization`; it never enters full text. Treat that return as a demand to
execute the same product checkpoint, never as authorization. Use
`status --stage workflow` for observed progress.

### Return → action

| Returned boundary | Main action |
|---|---|
| retrieval_review | Read reasons/flagged records; report shortfalls and unresolved exclusions. When acceptable, run the blocking product checkpoint; only then continue with `workflow evidence --from fulltext`. |
| fulltext_authorization | Run the blocking product checkpoint above; only an authorized disposition permits `workflow evidence --from fulltext`. |
| error / stage_review | Handle the named issue; check the failed stage and current preceding inputs before resuming explicitly from that stage, not from discovery. |
| outline_display | Display the supplied packet using the Confirm sequence, even with automatic continuation authorization. |

- Report `outside_time_range_retained.count` briefly without listing/rechecking foundational papers.
- User venue/citation constraints that removed most papers may need their decision; an empty requested subtopic or misleadingly thin corpus needs a concrete exception.
- A shortfall after adequate search does not by itself justify another search or a question; ask only when fulfilling the task requires a change to user scope, constraints or delivery commitments.
- Do not ask a time-window question already answered by the task. Disclose exclusion uncertainty reported by the search subagent.
- Partial status is not an automatic question to the user: resolve/report what is already authorized.

### Recovery and work owned by scripts

- `fulltext_candidates = 0`: continue using actual supplied abstracts and report the reading-depth limitation, not an unnecessary permission question. Never describe abstract cards as full-text reading.
- Fulltext acquisition uses the PaperHub document ID with the existing Hub timeout/retry policy, then a known arXiv ID with a 3-second connection limit and a 10-second total fallback budget. Missing IDs or unsuccessful downloads leave the supplied abstract as evidence. Local PDF snapshots retain priority.
- Table-layout findings are advisory: the parser's extracted sentence text proceeds to LLM paper-card generation. Unreadable sources and other fatal parsing errors remain explicit. Paper cards and other extraction results remain local artifacts.
- Processing success is enough to proceed, with no card-by-card audit.
- For named processing errors, use `status --stage processing` and `papers show --ids ...`, correct the reported source/configuration issue, then resume the failed stage.
- Selected discovery papers already passed abstract eligibility; there is no `papers repair` command or HTML abstract-recovery step.
- Local PDFs retain their original import/parse path: if neither parsed text nor a real abstract is available, report the missing source and reimport a corrected readable file when available. Do not drop supplied PDFs or invent text to satisfy readiness. Valid extraction results are retained.
- Resume only after checking the failed stage in `status --stage workflow` and that its preceding inputs are current.
- `--from STAGE` executes that stage and all later steps in the evidence chain; it does not automatically skip completed steps.
- After an outline exists, use `--from review-packet` to display it. `outline generate` validates/reuses an existing outline without another model call; it is not a revision mechanism.

## 4. Confirm

### Do: display and record publication choices

Use `result` inside the workflow response (or the direct `outline review-packet`
response) in exactly this order, even with automatic continuation authorization:

1. Summarize the user's research request and personalized preferences in 1–2 sentences.
2. Display `outline_markdown`: hierarchical chapters/subsections with each figure or table ID and caption nested under its owner. No paper lists/counts, descriptions, analytical tasks, rationale, purposes or separate planning tables. Show language only beside non-default chapters, within this packet rather than a separate language-confirmation gate.
3. After rendering the outline, call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"review","request":{"workspace":"<workspace returned by task activation>","checkpoint":"outline"}}`. Use the actual activated workspace, not a hand-authored display-card payload.
4. Follow `confirmation.state`: `auto` or `approved` continues after display; `required` needs a real confirmation; `awaiting_display` uses the product five-minute confirmation below. The outline bridge publishes the confirmation card and waits for its result. Save its returned `confirmation` object unchanged and run `writing review-complete --request FILE` before interpreting the answer. Retain explicit user publication choices and use only usable packet options. Do not make the user choose unchanged settings again. Once the decision is recorded, update the existing structured plan without changing its root items; mark the outline stage from observed state and represent the chosen publication settings in a child step.

For publication choices, display only usable `options.format_labels` and `options.citation_styles[].label` values. Use `publication_display` for the current settings. Each label is the complete user-facing description; do not append explanations, examples, template IDs, compiler details, source names, or metadata fields. The PDF format label already describes its output, so do not separately present its template as another choice.

- New complete surveys default to `outline_review:"timeout_auto"` with `review_timeout_seconds:300`. Preserve existing tasks' policies. If the user explicitly requires waiting for approval, use `required`; immediate automatic continuation still uses `auto` plus a real `auto_authorization` quote. Components default to auto.
- Configured publication settings alone do not establish user approval. A preference to minimize questions does not supply a missing confirmation; an existing valid approval or explicit automatic-continuation policy does.
- In ScholarSeed, use the outline bridge's product confirmation card, not another question tool. Do not switch modes to ask, end the turn while the bridge is waiting, or start shell polling alongside it.
- Record a real decision with `writing approve --request FILE`, using packet_id, actual user_response and optional publication changes (and message_id if supplied by the host).
- Reading the packet is not displaying it. A timeout is a policy decision only when the displayed `timeout_auto` window has actually expired and `review-timeout` has recorded it; never fabricate a user response or packet ID. Other modes retain their existing approval rules.

### Five-minute review

In ScholarSeed, `literature.review` with `checkpoint:"outline"` owns the confirmation
window. Its card asks whether to write using the displayed outline, output format and
citation style, and accepts free-text changes. `timeout_auto` waits five minutes;
`required` waits for an actual answer; `auto`/`approved` do not ask again.
Consume the returned `confirmation` with `writing review-complete --request FILE`.
An answer stops the window; only actual confirmation permits `writing approve`.
Revision, pause and cancellation must not be approved. A timeout result records
`timeout_default` without a user response; deliver its notice before manuscript preparation.
Never call `review-start`, `review-wait` or `review-timeout` in parallel with this bridge.
If the bridge fails or is cancelled, do not fall back to silent automatic continuation.

For a standalone host without ScholarSeed's product confirmation bridge only:

1. Display the outline and `publication_display` settings together with `confirmation.timeout_notice`: the user has five minutes to reply, otherwise those settings will be used. Then call `writing review-start --request FILE` with the actual `packet_id` and `displayed:true`; include a host message ID only when available. Generating or rereading a packet does not start/reset the timer.
2. Keep this turn alive with an interruptible host wait, or call `writing review-wait --packet-id ID --wait-seconds 30` repeatedly, processing incoming messages between calls. A host scheduler can instead wake this same task at the returned `deadline_at`. Do not end the turn merely saying “waiting” unless the host has actually arranged its wakeup. The CLI does not install a background scheduler or wake a stopped agent by itself.
3. On any user reply, immediately call `writing review-response --request FILE` with the current packet ID and actual reply before interpreting it. This stops the timer, including for “wait”, cancellation or revision requests. Use `writing approve` only for real confirmation. A revised task/outline needs its new packet displayed before a new timer starts; do not restart a paused packet automatically.
4. When status is `expired`, first handle any pending user input, then call `writing review-timeout --packet-id ID`. Send its `notice` to the user before `manuscript prepare`, stating that no reply was received and naming the default settings. This records `decision_source:timeout_default` with `user_response:null` and preserves all user-specified choices. Unavailable publication choices require repair, not silent substitution.
5. Repeated callbacks reuse `decision_id` and `notice_id`. Resume the same task and deduplicate notices; do not spawn a second generation branch. `STATE_BUSY` means retry the same queued event after the current writer finishes. Late replies are follow-ups. On recovery, query `writing review-status`; keep the saved deadline and discard callbacks for stale packets.

### Revisions → action

Changes update only affected requirements; revised plans must be displayed and
honor applicable approval. Main edits the complete current outline; the outline
model is not a revision mechanism.

| Situation | Action |
|---|---|
| User requests additions, removals, splits or table/figure changes | Obtain the current outline and fields via `outline configure --describe-input` (or read current outline.json). Main edits it completely and submits `outline configure --request FILE`; do not call the outline model again. Then display `outline review-packet` and reuse or obtain the applicable real publication choice. |
| Initial outline validation fails on local schema, ID, enum, caption, duplication or ownership | Repair the saved `candidate_path` and submit the complete candidate via `outline configure --request FILE` instead of rerunning the model; display the revised plan and honor applicable approval. |
| Initial candidate is unreadable, truncated, or needs substantive scientific redesign that cannot be made safely from the task and evidence | Only then rerun the outline model. |
| Paper changes after v2 handoff | Edit v2 directly. |

`outline configure` only validates and saves; it does not call an LLM or grant approval.

## 5. Generate

### Do: prepare and start the concurrent branches

- Run `manuscript prepare` once; check its section, figure and table slots against those confirmed by the user. Task packets preserve the complete assigned evidence, requirements and analytical tasks; they are not output schemas or caches.
- If figures exist, immediately dispatch one fresh-context figure subagent before waiting on the manuscript command. Exactly one owns every figure id; never split figures across concurrent subagents or re-dispatch the role for the same task.
- Before spawning, state the intended agent count and disjoint write scope; record and reuse the returned id, including after timeouts or interruptions.
- Supply caller directory, launcher, skill path, returned figure_brief path and [figure-planner role brief](references/roles/slr-figure-planner.md). The child reads its full inputs, queries `figures context --ids ...` for required prerequisite prose, authors prompt/caption together, submits `figures plan --request`, and runs `figures plan-generate`.
- Complete actual images, postprocessing and LaTeX wrappers before v1 assembly. No placeholders, extra image review or semantic image regeneration. Technical failures can retry unfinished figure tasks; completed siblings are retained.
- Run `manuscript generate` concurrently with figures. All top-level chapters, including abstract, synthesis and conclusion, start concurrently. No additional critic or generated-image review follows this pipeline.
- Use `status --stage writing` for observed progress.

### Script-owned generation contract

- The task supplies a fixed chapter opening at the prompt end (`\section{...}` and label for LaTeX, `## ...` for Markdown); the model returns only raw continuation. Scripts save opening plus continuation under `05_generation/chapters/` and assemble without duplicating headings.
- Abstracts receive the appropriate opening/closing wrapper; unsectioned components receive no invented heading. No model-authored JSON wrapper or JSON backslash escaping is required.
- Chapters write planned subheadings, mathematics, citations and native tables; the assembler adds the document template and byline. Figure-owning prose explains the figure and uses `\ref{fig:F1}`; it never writes a placeholder, image path, figure environment, figure caption or label.
- Every LaTeX chapter receives the template's concise package and mathematical-notation capabilities; Markdown chapters retain their existing context. Indicator notation uses explicitly defined uppercase blackboard-bold symbols supported by the existing templates.
- Ownership follows the source hierarchy: an asset assigned to chapter `2` may appear in `2` or its subsections; one assigned to `2.2` stays within `2.2`, not sibling `2.3` or another chapter. LaTeX floating to a different PDF page does not change content ownership.
- The publisher also owns the bibliography heading and entries. Chapters write inline citations only; no manual reference list, `thebibliography` or `bibitem`. Short tables use width-bounded wrapping columns; tables too tall for a page use standalone `longtable` with repeated headers and preserved evidence, not a float or unreadably scaled box.
- Scripts wait for all chapter calls and the completed figure branch, then assemble `05_generation/full_draft_v1.tex` (or `.md`) with actual figure wrappers and captions.
- One refinement model receives the entire source, local included text, requirements, outline and evidence; it can repair the full assembled publication source, including templates, headings, formulas and captions.
- Before refinement, LaTeX v1 receives one isolated compilation pass bounded by 10 seconds. Successful compilation leaves refinement context unchanged; source errors enter that same refinement request with a repair task. A timed-out or unavailable compiler supplies the concise template capabilities and a notation/dependency repair task instead. Final publication still compiles the current v2.
- LaTeX chapters with planned tables receive a width-bounded authoring contract. Deterministic table layout preflight after v1 assembly adds precise warnings and repair instructions to that refinement request only if a table fails; if all pass, no table-specific instruction or status field is added.
- The refinement delta uses target/before/after with unique exact matches and no overlapping replacements; no hashes are needed. Applying it produces `05_generation/full_draft_v2.tex` (or `.md`).

### Return / failure → action

| Situation | Action |
|---|---|
| Transport failure or blocking call configuration / failed image request | Retry only the failed task. Correct the blocking issue and resume with `manuscript generate`; completed chapter task files and responses remain as task results. |
| Received chapter response is incomplete or has content/format defects | Preserve it; refinement and main repair it. Never regenerate chapters for editorial defects. |
| Refinement delta is malformed or unapplicable | Preserve raw response and report issues; v1 is handed off as the editable v2 base. No second refinement or chapter rewrite follows. |
| Editable v2 is handed off | Continue with `workflow publish`; main owns corrections. |

There are no chapter/refine/image/compile caches, acceptance receipts, asset seals
or hash-based edit permissions.

## 6. Publish

### Do: publish the current v2

- For GB/T 7714 use the explicitly versioned `gbt7714_2025` numeric style. PDF uses the bundled CTAN style; Markdown is a simplified deterministic layout, not submission-grade national-standard typesetting. Do not silently substitute a different edition or an unsupported style.
- To change citations after delivery, use `writing configure --request <patch.json>` with `{"publication":{"citation_style":"gbt7714_2025"}}`, then `workflow publish` in the same workspace. This synchronizes the existing v2 bibliography style and republishes without redrafting prose. Never hand-write reference entries or replace BibTeX with `thebibliography`/`bibitem` to imitate a requested standard. If the source is already manual, restore its original BibTeX-backed source first.
- Report only the missing fields returned by `citation_metadata`, by citation key. Bibliographic `number` (issue) and `pages` are optional output fields: preserve and render supplied values, but do not warn, mark them as pending verification, reduce completeness, or initiate enrichment solely because they are absent. Completeness measures the configured metadata policy, not the presence of every possible bibliographic field. Do not invent publication place, publisher, issue numbers, pages or access dates, and do not claim complete standard compliance from a successful compile alone. Inspect the bibliography pages when verifying a citation-style change.

- Use one entry: `workflow publish`. It checks the current source, compiles/exports it and renders the first PDF page plus actual figure/table pages, including longtable continuation pages. `inspection_scope.pages` maps physical PDF page numbers to asset labels and image paths; `pages_to_read` is the same image list.
- Check messages describe the current source and bibliography; old outline coverage is advisory, not an editing permission.
- The final PDF is named from the document title; whitespace, colons and other cross-platform unsafe filename characters are normalized to underscores.

### Return → inspect, repair and deliver

- Compilation failure is blocking and leaves the source available for direct repair.
- Duplicate bibliography structures or multiply defined citations also block successful publication. Repair the reported source or bibliography and republish; do not report these as harmless retained warnings.
- Main owns all paper-related corrections after handoff: prose, claims, formulas, section structure, captions, tables, citations, templates and layout.
- Directly edit `05_generation/full_draft_v2.tex` and the local files it actually uses, including `.tex`, `.bib`, images and styles. Use the Markdown v2 for native Markdown tasks.
- Exported `06_output/survey.*` files are delivery copies; edit the v2 source, then run `workflow publish` again.
- Visual check scope: open the first-page image and the rendered pages that contain a figure or table, and inspect clipping, math, duplicated headings/captions, blank space and glyphs. Do not open any other page image in the default flow; widen the scope only on an explicit user request or when a check message names a specific page.
- If `inspection_scope.complete` is false, resolve its missing/ambiguous labels or page mappings and republish. Available images are only a partial check set; do not claim that every figure/table was inspected.
- Fix observed issues directly in v2 and repeat the same publication command.
- Report actual checks, pages inspected, remaining issues and evidence limits. Reporting this limit is the complete required action; it is not a request to additionally verify uninspected pages or scientific content.

### ScholarSeed result and deliverable publication

After generation and verification, or when execution stops with usable partial
artifacts, call the `scholarseed_bridge` model tool with
`{"capability":"literature","operation":"review","request":{"workspace":"<workspace returned by task activation>","checkpoint":"result"}}`.
Publish once per settled result state, not for ordinary progress. If a later
authorized recovery changes the standard result artifacts, publish the settled
`result` checkpoint again; the product retains immutable history and displays
the newest snapshot for that workspace and checkpoint.

The review checkpoint reads actual artifacts to arrange the review card;
it does not publish user-facing file cards. After the final write of each
independent user-facing deliverable, call the `scholarseed_bridge` model tool
with `{"capability":"artifact","operation":"publish","request":{"path":"<actual deliverable path relative to the session workdir>","role":"final"}}`.
Use `supporting` for additional deliverables. Do not publish temporary, cache,
runtime-state, source-input or incidental files. A successful review checkpoint
does not mean a file was published. If either tool call fails, report the failure
and retain the existing file links; never claim its card appeared.

Do not hand-author a literature-review display-card payload, add a second
summary, manufacture missing checks or turn producer statuses into new research
conclusions. Preserve report verdicts, reasons, verification findings and material
degradations, including WARN, FAIL, NOT_CHECKED, hallucinated references and
missing-fulltext limitations. The local citation audit establishes bibliography
consistency, not online existence or claim-to-original-text support. Do not label
an original-text claim verified without actual evidence and a separate assessment.
A generated document is not necessarily a complete or verified review. Do not
automatically import papers or launch a search when opening them, or rerun
unchanged failed stages; recovery requires an explicit user request.

### Post-publish scope limits

- After handoff, correct only issues observed in inspected pages, named in check messages, or raised by the user. The single refinement already covered editorial quality; no proactive full-manuscript re-reading follows publication.
- No claim-by-claim or theorem-by-theorem verification of the manuscript against source papers in the default flow.
- The bibliography is assembled deterministically from retrieved metadata; do not re-verify or normalize entries (years, venues, author names, DOIs) against the web or other external sources. Report a suspected metadata defect instead of silently researching and rewriting it.
- Deliver the exported `06_output` files as-is; no extra packaging or standalone source archives unless the user asked.

### Publication boundaries and existing workspaces

- `workflow publish` never regenerates chapters, invokes refinement or reassembles v2 from earlier outputs.
- Do not update JSON, run accept, or repair old pipeline state. Generation JSON can be absent without preventing publication.
- Historical v3 files are not batch-renamed. For an old workspace, explicitly copy its final publication source and dependencies into a separate publication workspace as v2; do not confuse an old intermediate v2 with the final v3.
- Existing reviews remain unchanged until explicitly imported or revised.

## Invariants

- At most one live search subagent and one live figure subagent; neither role is dispatched twice for the same task. The cap does not limit concurrency inside one CLI call: scripted chapter, image and refinement model calls remain as parallel as possible.
- Before each `spawn_agent`, state the intended agent count and disjoint write scope; record the returned id and use only that id for `wait_agent`, `send_input` and `resume_agent`. Never re-spawn after a timeout, interruption or slow result; keep waiting on or resume the recorded id.
- If a duplicate is detected, `close_agent` the extra one before it writes task state, then report the incident.
- Never fabricate a user response or packet ID. Timed continuation requires the displayed `timeout_auto` policy and a validated expired-window receipt; it is not a user approval. Manual `required` mode cannot be bypassed by a timeout.
- Preserve received chapter responses, even incomplete ones, and completed figure siblings; use the one refinement or main's v2 edits for editorial repairs, never semantic regeneration or a second refinement.
- Post-publish checking is bounded: first page plus figure/table pages only, no claim-by-claim or theorem-by-theorem source verification, and no bibliography re-verification. Wider checks require an explicit user request or a named error.
- One workspace per deliverable; never overwrite an existing survey. Secrets stay out of task/artifact files.
- Only searcher and figure-planner role briefs are active; there are no separate stage reference documents. Obsolete role instructions and design history are recoverable from Git, not runtime inputs. No legacy section-writing commands.
- Do not launch experiments or claim speed/quality improvements without authorization and measurements.
- Necessary small file operations outside public CLI use the bound Python; ordinary JSON operations do not require a Node REPL.
