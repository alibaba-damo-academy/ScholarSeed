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
version: "1.2.0"
---

# Literature review — main-agent contract

This file is the main-agent contract. Public commands describe their input formats
on demand; only search and figure subagents have separate role briefs.
Search and figure subagents read their own role briefs; scripts supply the outline,
chapter and refinement models' authoring instructions. Do not duplicate their authoring work or switch to legacy section-writing commands.

Main owns task interpretation, delegation, outline revisions and user-visible
choices, concrete exception decisions, final PDF inspection and full-manuscript corrections.
Scripts own evidence processing, initial outline generation, concurrent chapter requests,
assembly of complete native v1, one full-input delta refinement into editable v2,
and publication.
All top-level chapters, including abstract, synthesis and conclusion, start
concurrently. Preserve received responses even when incomplete; do not regenerate
chapters for editorial defects. Figures run concurrently in one fresh subagent.
No additional critic or generated-image review follows this pipeline.

Subagent concurrency cap: at most one live search subagent and at most one live
figure subagent may exist at any time, and neither role is dispatched twice for
the same task. Concurrency inside a single CLI call is unaffected and stays as
parallel as possible: scripted chapter, image and refinement model calls still
run concurrently. Before each `spawn_agent` call, state the intended agent count
and that agent's disjoint write scope; after the call, record the returned agent
id and use only that id for `wait_agent`, `send_input` and `resume_agent`. Never
re-spawn because a wait timed out, a turn was interrupted, or a result looks
slow; keep waiting on or resume the recorded id. If a duplicate is detected,
`close_agent` the extra one before it writes task state, then report the incident.

After understanding the user's request and scope, before the first long-running
operation, create a visible TODO list using the host's native plan tool (such as
`update_plan`) when available. Default full-survey stages, in the user's language:

1. Determine research scope and output requirements.
2. Discover papers and prepare evidence.
3. Generate the outline and resolve publication choices.
4. Generate text and figures concurrently, then refine the manuscript.
5. Publish, inspect and deliver.

## 1. Bind and configure

Use the supplied skill path and caller directory. Run `<skill>/scripts/slr doctor
--no-network`, then `<skill>/scripts/slr init --workspace <caller/topic> --intent
"<original request>"`. Use a separate workspace per deliverable; do not overwrite
an existing survey. Explicit output destinations take precedence. For an existing
task without a launcher, omit `--intent` to preserve its task. Init returns a
launcher; use `./<topic>/slr` from the fixed caller directory for later calls.
Do not rely on persistent cd, aliases or exported variables. Discover paths only
for an invalid entry or a dependency doctor reports missing. The launcher binds
Python 3.12.x; `<skill>/scripts/setup` repairs that environment.

Configure the sole task through `writing configure --request FILE` (or `-` for
stdin). `01_input/writing_request.json` owns immutable original intent, ordered
verbatim follow-ups and current effective interpretation. Derived query/output
files and stage advice cannot override it; retired requirements files are ignored.
Keep local language/scope exceptions and only requested modules. Do not invent
length or section quotas from corpus size.

The request `language` is the document default. The outline assigns each
top-level chapter `language: default|chinese|english`; use `default` unless the
user explicitly requested a chapter exception. Preparation resolves defaults and
hard-injects the result into every independent chapter task. The outline view
shows language only beside non-default chapters, as part of the existing review
packet rather than a separate language-confirmation gate.

```json
{"user_requests":["正文中文，摘要内容英文。"],
 "effective_requirements":"保留研究范围；正文、标题和图注中文，摘要内容英文。",
 "language":"CHINESE","publication":{"format":"latex_pdf","citation_style":"numeric"}}
```

Copy only actual user follow-ups, never this example. Follow-ups require
`effective_requirements`. `publication` and `retrieval` merge immediate keys;
`constraints` replaces the complete list, so retain all still-applicable constraints.
Other supplied fields replace those fields. Every constraint needs unique `id`,
`kind`, typed `value` and `verbatim` copied from recorded user instructions:

| Kind | Value |
|---|---|
| required_section / forbidden_section | `{title, role?, position?}` |
| figure_count / table_count / total_citations | `{min?, max?}` |
| min_papers_per_section / min_paper_citations | nonnegative integer |
| venue_whitelist | nonempty string array |
| must_include_paper | object with title and optional identifiers |
| excluded_topic / angle / other | nonempty string |

Section constraint `role` is optional; normally omit it and let the outline model
choose from the section's meaning. When supplied, its only values are `foundation`,
`background`, `introduction`, `analysis`, `synthesis`, `conclusion`, `abstract`,
`component`. These are operational roles, not topic names: algorithm taxonomies
and cross-problem comparisons normally use `analysis`; their scientific scope
belongs in the title/description and analytical tasks. Terminal roles (`abstract`,
`synthesis`, `conclusion`) receive the full corpus. Do not invent new role strings.
Section `position` accepts `first`, `last`, `any`, or `after:<section title>`.

Explicit length uses `length_min`, `length_max`, `length_target`, optional
`length_unit` (words, cjk_chars, characters, pages). Full surveys default to
`writing_strategy:"chapter_delta"` and an abstract unless excluded. Components use
`output_scope:"section"`, optional `selected_section_ids`, default `whole`, and no
survey abstract requirement. The legacy `whole` field remains readable; all native generation uses the same
chapter-task and full-source delta pipeline.
Retrieval accepts `corpus_size:{target:40}` (optional positive min/max), dimensions,
time_range, temporal_policy and mode; corpus_size is never a bare integer.
Init supplies the default 40-paper target, independent of manuscript length.

`time_range` uses `start_year` and `end_year`, with integer years, not `start`/`end`.
For a user-requested 2010–2020 preference, a configure patch is:

```json
{"retrieval":{"time_range":{"start_year":2010,"end_year":2020},
 "temporal_policy":"soft_preference"}}
```

Use the actual requested years; this example does not set a default time window.
For an input shape not covered here, use that command’s `--describe-input`
before guessing field names. It returns fields and valid examples without writes
or model calls; it is not a routine extra startup step.

Text/image scripts prefer the environment's public `skill_model_client`; only
import failure selects direct transport. Runtime context or request failures do
not fall back. The framework owns routing, provenance and moderation; main never
constructs protocol metadata or guesses session IDs. File-producing text calls
mark only the current task text; image calls pass the actual drawing prompt.

Standalone direct text/image defaults: `https://scholarseed.damo.alibaba.com/v1/`. Text credentials use
`SCHOLARSEED_ACCOUNT_TOKEN`; images prefer `IMAGE_API_KEY` and fall back to
`SCHOLARSEED_ACCOUNT_TOKEN` when it is unset or empty. `TEXT_BASE_URL` / `IMAGE_BASE_URL` override endpoints. PaperHub binary
downloads independently use `SCHOLARSEED_API_KEY` / `PAPERHUB_URL`, default
`https://scholarseed.damo.alibaba.com/paperhub`. Never write secrets to task/artifact
files. Known retired defaults migrate; custom overrides remain supported.

## 2. Supply and discover papers

For local PDFs, first use `papers import-local --request FILE`:

```json
{"files":["/absolute/papers",{"path":"/absolute/a.pdf","title":"Actual title",
 "authors":["Actual author"],"year":2024,"doi":"10.example/actual-id"}]}
```

Use actual paths and known true metadata; directories are supported. Import copies
local snapshots without uploading PDFs, deduplicates identical bytes and reports
metadata_gaps. Inspect the first page and resubmit true metadata when available;
never infer year from file times or authors from PDF producer fields. Unknown
metadata stays unknown. Snapshots survive moved originals; changed/missing
snapshots or changed local configuration need explicit reimport.
Per-file objects accept only path, title, authors (an array of names), year, doi
and optional abstract (actual source text, never a summary invented by the agent).
Directory entries contain only path; metadata belongs to individual PDF files.

Run `papers budget`. Pass its search_target and reliable local titles/DOIs to
discovery. For 0<N<40 unique local PDFs, the supplement is
`10 * ceil((40-N)/10)`; N>=40 keeps all locals and skips search. Do not silently
trim supplied papers. Default without local PDFs is 40.

When search_target>0 and discovery is needed, spawn one fresh subagent with
`fork_turns:"none"`. Exactly one: never a second concurrent or repeat searcher
for the same task. Supply this complete delegation:

- Fixed caller directory, workspace launcher, skill path and
  `references/roles/slr-searcher.md`, which the child reads itself.
- One precise natural-language literature-search intent translated once from
  the authoritative task. Preserve all research semantics. Include the explicit
  time range or task's recent-five-year default as a **soft preference**, retaining
  earlier foundational work; do not phrase it as a hard before/after cutoff.
- Task retrieval dimensions, exact search_target, reliable supplied titles/DOIs
  to exclude from supplemental discovery, and every retrieval constraint verbatim.
- Explicit `balanced` mode unless the user selected another mode/budget. Require
  complete, unabridged real abstracts, named authors and source publication years
  for selected discovered papers. Exclude missing/placeholder/truncated records;
  no abstract-recovery search or padding to fill the count.
- Invoke the independent `$agentic-search` through its existing interfaces; do not
  supply an AS installation/config path, invent flags or modify AS. The child
  imports its result with `import-search --source <AS-result-dir>` and returns
  compact status/limitations, not its paper pool.

Venue/citation-floor screening belongs to the deterministic adapter. The search
subagent implements excluded-topic requirements semantically during discovery;
there is no keyword recheck or extra excluded-topic LLM. Read its status_reason
for unresolved exclusions and shortfalls. AS owns its
fallback; do not repeat PaperHub checks or ask for tokens after Web fallback.

## 3. Advance evidence to the outline boundary

After import, or for a local-only task, run `workflow evidence`. It executes the
existing retrieval_adapt → fulltext → processing → outline generate → review-packet
commands, without new model stages. It stops on errors, retrieval cases needing
main's judgement, or the outline display boundary. It never approves or starts
manuscript generation. `status --stage workflow` reports observed progress.

| Returned boundary | Main action |
|---|---|
| retrieval_review | Read reasons/flagged records; report shortfalls and unresolved exclusions. Continue with `workflow evidence --from fulltext` when acceptable. |
| error / stage_review | Handle the named issue; resume explicitly from that stage, not from discovery. |
| outline_display | Display the supplied packet as below, even with automatic continuation authorization. |

Report `outside_time_range_retained.count` briefly without listing/rechecking
foundational papers. User venue/citation constraints that removed most papers
may need their decision; an empty requested subtopic or misleadingly thin corpus
needs a concrete exception. A reported shortfall after adequate search does not
by itself justify another search or a question; ask only when fulfilling the task
requires a change to user scope, constraints or delivery commitments.
Do not ask a time-window question already answered
by the task. Disclose exclusion uncertainty reported by the search subagent.
Partial status is not an automatic question to the user: resolve/report what is
already authorized.

Even when fulltext_candidates is zero, continue using actual supplied abstracts;
report the reading-depth limitation, not an unnecessary permission question.
Never describe abstract cards as full-text reading. Processing success is enough
to proceed, with no card-by-card audit. Inspect named processing errors using
`status --stage processing` and `papers show --ids ...`, correct the reported
source/configuration issue, then resume the failed stage. Selected discovery
papers already passed abstract eligibility; there is no papers repair command or
HTML abstract-recovery step. Local PDFs retain their original import/parse path:
if neither parsed text nor a real abstract is available, report the missing source
and reimport a corrected readable file when available. Do not drop supplied PDFs
or invent text to satisfy readiness. Valid extraction results are retained.
Resume only after checking the failed stage in `status --stage workflow` and that
its preceding inputs are current. `--from STAGE` executes that stage and all later
steps in the evidence chain; it does not automatically skip completed steps.
After an outline exists, use `--from review-packet` to display it. Outline generate
validates/reuses an existing outline without another model call; it is not a
revision mechanism.
Completed chapter task files survive failed-call recovery in `manuscript generate`.

## 4. Display and record publication choices

Use `result` inside the workflow response (or the direct `outline review-packet`
response) in exactly this order:

1. Summarize the user's research request and personalized preferences in 1–2 sentences.
2. Display `outline_markdown`: hierarchical chapters/subsections with each figure
   or table ID and caption nested under its owner. No paper lists/counts,
   descriptions, analytical tasks, rationale, purposes or separate planning tables.
3. Ask for citation format and template together using available packet options.
   Reuse prior explicit choices and automatic-continuation authorization. Do not
   add a separate outline-confirmation question or repeat unchanged choices.

Complete surveys retain this combined confirmation unless explicitly waived.
Defaults, preselection, silence and timeout are not authorization. An explicit
waiver uses `outline_review:"auto"` plus `auto_authorization` quoting an actual
recorded user request; components default to auto. Record a real decision with
`writing approve --request FILE`, using packet_id, actual user_response and
optional publication changes (and message_id if supplied by the host).
Reading the packet is not displaying it. No reply means no dependent generation.
Changes update only affected requirements; revised plans must be displayed and
honor applicable approval. For revisions, main edits the complete current outline;
obtain it and its fields via `outline configure --describe-input` (or read the
current outline.json). Submit it with `outline configure --request FILE`, which
only validates and saves; it does not call an LLM or grant approval. Then display
`outline review-packet` and reuse or obtain the applicable real publication choice.
An initial outline validation failure follows the same rule: repair the saved
`candidate_path` and configure the complete candidate instead of rerunning the
outline model for local schema, ID, enum, caption, duplication or ownership errors.
Rerun the model only when that candidate is unreadable, truncated or needs a
substantive scientific redesign that cannot be made safely from the task and evidence.
Do not call the outline model again for additions, removals, splits or table/figure
changes. After v2 handoff, make paper changes directly in v2. Never fabricate a
user response or packet ID.

## 5. Generate native chapters and figures; assemble v1 and refine v2

Run `manuscript prepare` once. Check its section, figure and table slots against
those confirmed by the user. Task packets preserve the complete assigned evidence,
requirements and analytical tasks; they are not output schemas or caches.

If figures exist, immediately dispatch one fresh-context figure subagent before
waiting on the manuscript command.
Exactly one subagent owns every figure id; never split figures across concurrent
subagents. Supply caller directory, launcher, skill path,
returned figure_brief path and `references/roles/slr-figure-planner.md`. The child
reads its full inputs, queries `figures context --ids ...` for required prerequisite
prose, authors prompt/caption together, submits `figures plan --request`, and runs
`figures plan-generate`. Keep the existing image-generation order: complete the
actual images, postprocessing and LaTeX wrappers before v1 assembly. No placeholders,
extra image review or semantic image regeneration. Technical failures can retry
unfinished figure tasks; completed siblings are retained.

Run `manuscript generate` concurrently. The task supplies a fixed chapter opening
at the end of the prompt: `\section{...}` and its label for LaTeX, or `## ...` for
Markdown. The model returns only the raw continuation. The script saves opening
plus continuation as a complete chapter under `05_generation/chapters/`; the
assembler concatenates chapters without adding their headings again. Abstracts
receive the appropriate opening/closing wrapper; unsectioned components receive
no invented heading. No model-authored JSON wrapper or JSON backslash escaping is
required. Chapters write their planned subheadings, mathematics, citations and
native tables; the assembler adds the document template and byline. Figure-owning prose
explains the figure and uses `\ref{fig:F1}`; it never writes a placeholder, image
path, figure environment, figure caption or label.

The script waits for all chapter calls and the completed figure branch, then
assembles the complete `05_generation/full_draft_v1.tex` (or `.md`), including
actual figure wrappers and captions. It sends the entire source, local included
text, requirements, outline and evidence to one refinement model. That model can
repair the full assembled publication source, including templates, headings,
formulas and captions. LaTeX chapters with planned tables receive a width-bounded
table authoring contract. After v1 assembly, deterministic table layout preflight
adds precise warnings and table-repair instructions to the existing refinement
request only when at least one table fails; when every table passes, refinement
receives no table-specific instruction or status field. Its structured delta uses target/before/after,
with unique exact matches and no overlapping replacements. No hashes are needed.
Applying the delta produces `05_generation/full_draft_v2.tex` (or `.md`).

Transport failures retry only the failed task. Resume with `manuscript generate`
after correcting a blocking call configuration or failed image request; completed
chapter responses remain as task results. A completed response with content or
format defects is never regenerated: refinement and main repair it. Malformed or
unapplicable refinement deltas preserve the raw response and report issues; v1 is
handed off as the editable v2 base. No second refinement or chapter rewrite follows.
There are no chapter/refine/image/compile caches, acceptance receipts, asset seals
or hash-based edit permissions. Use `status --stage writing` for observed progress.

## 6. Publish and edit the current v2

Use one entry: `workflow publish`. It checks the current source, compiles/exports
it and renders PDF pages 1–3. It never regenerates chapters, invokes refinement or
reassembles v2 from earlier outputs. Check messages describe the current source
and bibliography; old outline coverage is advisory, not an editing permission.
Compilation failure is blocking and leaves the source available for direct repair.
The final PDF is named from the document title; whitespace, colons and other
cross-platform unsafe filename characters are normalized to underscores.

Main owns all paper-related corrections after handoff: prose, claims, formulas,
section structure, captions, tables, citations, templates and layout. Directly edit
`05_generation/full_draft_v2.tex` and the local files it actually uses, including
`.tex`, `.bib`, images and styles. Do not update JSON, run accept, or repair old
pipeline state. Generation JSON can be absent without preventing publication.
Use the Markdown v2 for native Markdown tasks. Exported `06_output/survey.*` files
are delivery copies; edit the v2 source, then run `workflow publish` again.

Open the returned first-three-page images and inspect clipping, math, duplicated
headings/captions, blank space and glyphs. Fix observed issues directly in v2 and
repeat the same publication command. Report the actual checks, pages inspected,
remaining issues and evidence limits. Compilation and screenshots do not establish
scientific correctness or the quality of uninspected pages.

Historical v3 files are not batch-renamed. For an old workspace, explicitly copy
its final publication source and dependencies into a separate publication workspace
as v2. Do not confuse an old intermediate v2 with the final v3. Existing reviews
remain unchanged until explicitly imported or revised.

## Output, progress and exceptional detail

CLI defaults to the compact main view; `--full` returns complete supported command
reports. Full artifacts/logs remain on disk. Do not open them merely to reproduce
a progress message. Send short updates at startup, stage transitions, before long
calls and on concrete exceptions; during waits use observed status. Distinguish
retrieved papers, fulltext sources, abstract cards and finished figures. No invented
percentages/times and no routine approval questions.

For a needed structured input, query the existing interface with --describe-input:
writing configure/approve, outline configure, figures plan, evidence build, or
papers import-local. It provides required fields, supported variants and complete
examples; outline configure also returns the current full outline and selected
paper IDs when a workspace is available. Use actual IDs and user quotes, not the
illustrative values. Evidence-view options are for concrete exceptions only.

Start with the command's field-specific error, next_action and named artifact/log.
Inspect implementation only for a concrete defect unresolved by public diagnostics,
not to rediscover request shapes. There are no separate stage reference documents.

Only searcher and figure-planner role briefs are active. Obsolete role instructions
and design history are recoverable from Git, not runtime inputs.
Do not launch experiments or claim speed/quality improvements without authorization
and measurements. Necessary small file operations outside public CLI use the bound
Python; ordinary JSON operations do not require a Node REPL.
