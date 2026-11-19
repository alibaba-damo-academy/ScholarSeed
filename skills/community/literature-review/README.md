# Literature Review

**English** · [简体中文](README_zh.md)

The review card uses the shared document preview and opens details in the host
workbench through a receipt. Skill development previews use sample data, not a
real session or model. They do not verify the final manuscript. Actions on
the manuscript still use the declared host capabilities.

This Skill produces a full review, related-work section, chapter, or untitled
passage. It supports Quick and Standard; Deep is not implemented. See
[SKILL.md](SKILL.md) for the workflow and its [mode matrix](SKILL.md#3-mode-matrix)
for trade-offs.

Unless the user requests otherwise, both modes use numeric (numbered) citations.
Standard defaults to PDF with the Standard Chinese template for Chinese or NeurIPS for English;
Quick defaults to Markdown without a template. The execution plan shows these settings for review.

## Task Preparation

Long-running commands stay in the host's managed foreground session; a yield interval is not an execution deadline. Continue the returned session rather than detaching with `nohup` or shell backgrounding. `writing configure --describe-input` provides the complete input contract when several fields need clarification.

The outline example includes a figure with narrative paper tokens in both content planning and visual guidance, alongside plain IDs in paper_ids. Quick and explicit no-figure requests omit this figure example; assets remain in the middle section of the survey excerpt.

Chapter drafting requests the complete body, including every planned subsection and analysis task; only the script-provided heading is omitted. Abstracts retain their separate body-only framing.

Source completion also covers figure/table narrative fields and updates each asset's own source list, preserving empty lists that authorize corpus-wide evidence. Optional asset qualifications use an array (`[]` when empty); unused visual guidance may be omitted or `""`, not null. Quick treats the complete citation token as an opaque identity and demonstrates its placement in prose.

The survey outline example places its table-bearing section between two prose sections to demonstrate continuation after an asset. It illustrates layout, not a required chapter count or complete survey; single-component examples retain their requested scope.

Chinese abstracts default to 300–600 Chinese characters; English abstracts remain at 150–250 words. Length checks are advisory, and explicit user or template requirements take precedence. Quick citation guidance includes an inline prose example using the complete supplied token.

Outline normalization adds exact cited corpus papers omitted from a section's source list and records the additions. Sections with explicit local instructions require review instead of automatic expansion. Chapter inputs identify document-wide asset assignments; only table-owning chapters receive table layout and caption guidance. Quick model inputs provide complete citation tokens rather than bare citation keys.

Standard evidence extraction uses the framework's shared `card`, `common_fields`,
and `source_map` block protocol, also used by AI reading. It does not generate
another user-facing reading. The framework assembles the same validated L1 JSON;
writing, citation identities, and reuse of compatible saved cards are unchanged.
Complete blocks with malformed JSON get syntax-only repair without original text
or images. Missing blocks and content errors still use source-grounded recovery
restricted to allowed fields. Neither path relaxes evidence checks. Quick uses
abstracts directly and does not extract cards.

Evidence diagnostics are internal to the review workspace under
`_logs/evidence/<stage>-<run-id>/`, not manuscript deliverables. Each invocation
keeps timestamped events and complete, credential-redacted responses, including
failed extractions, returned repair fields, model usage, source fallback, download
retries and cache reuse, and separate download and parse timings. Parsed-text
size records characters, UTF-8 bytes, and a conservative byte-based token bound,
not a tokenizer count. Actual request usage is recorded separately. These files
may contain unpublished paper-derived content. Do not publish them as review
outputs or treat the logs as proof of successful extraction.

Automatic routing and manual selection share lightweight preparation without
invoking ARG. Reuse settled intent and answers. Establish a user-supported
subject and source scope; if the subject or supplied-only paper collection is
missing, ask only for the missing research inputs. Library access alone is not
a selection. Preserve explicit delegation, resolve only necessary ambiguity,
and narrow overly broad scope only when needed, while allowing explicit panoramic
coverage. Use at most three clarification rounds. Defer language, format, mode,
and other delivery settings to the execution agreement, which displays the
actual subject and source scope. Complete requests proceed without another
preparation question.

Then use the field mapping in `SKILL.md` to construct the complete initialization
request. The main workflow retains the execution contract. Initialization saves
`writing_request.json`; product preparation determines source readiness. The
execution agreement explains how settings and defaults affect the user's work.
Provide technical detail when requested.

## Architecture

Quick uses its single Markdown worker; Standard uses native chapter generation,
asset assembly, source refinement and publication. These are the only writing
paths. Shared template preambles are owned by the layout module. Task setup and
approval remain management operations, not separate authoring engines.

The main agent owns user intent, the execution agreement, coordination,
exceptions, and delivery checks. The search subagent uses the independent
`agentic-search` Skill. Standard starts the figure subagent only if the plan
includes figures. The literature scripts handle outlining and writing, with
evidence extraction and refinement in Standard. Code owns assembly, publication,
protocol validation, and identity checks.

Quick reads original abstracts only and delivers Markdown. It does not access
or download full text, extract cards, require sentence-level provenance,
generate figures, or compile other formats. After outlining, it uses one writing
call for the requested manuscript, chapter, or passage. If figures, PDF, or DOCX
are requested, recommend Standard in the first agreement; do not silently drop
requirements. Standard prioritizes full text with abstract fallback and supports
paper cards, parallel chapters, figures, and one full-input refinement pass. It
supports existing PDF, DOCX, and Markdown material at different levels of
granularity. Both modes share bibliography identity, authorization, and recovery
rules.

After assembling the chapters and required figures and tables, Standard makes
one normal full-input refinement pass and checks scope, language, format,
citations, and the actual deliverables. On refinement failure, keep v1, the raw
response, and diagnostics; do not report success. It does not add paragraph-level
fact auditing or a separate scientific review. Framework operations generate
cards, common fields, and source maps without a human-facing reading or display
summary. The review consumes only the content projection and ordinary paper
citation keys.

The framework cache distinguishes assets by full-text version independently of
visible literature records. Reuse valid cards. Generate cards only when missing
or when extraction has failed, and save successful results without replacing a
valid card on failure. The cache does not import papers automatically. When the
user later explicitly imports metadata or a PDF, associate the matching full
text and existing L1. Subsequent readings can use that asset without extracting
the card again. Metadata completion and source priority affect only the task view,
not fields in the user's library.

Show the agreement before retrieval. The product waits for confirmation or
changes, proceeding with the displayed agreement after five minutes by default.
Disable the timeout when the user explicitly asks to wait. Apply explicit changes
only to the affected fields. Do not add a post-outline confirmation by default;
honor any extra checkpoint the user requests. Full-text authorization remains
separate. A plan timeout grants no paper access. Import into the library only on
an explicit user action; the cache never imports automatically.

Use PDF for full-text input. PaperHub uses verified `pdf=true`. Framework PDF
tools own parsing, segment numbering, and coverage; the review does not maintain
a LaTeX input parser or local mapping validator. PDF output can still use LaTeX.

Before layout parsing, use a lightweight text probe of up to 200 pages to find
the main-text boundary. A standalone references heading needs corroborating
entries, and a supplement cover needs a clear heading. A table of contents or
an ordinary mention is not a boundary. Include the full boundary page so
adjacent main text is not lost. Parse all candidate pages when there are at most
40; otherwise parse the first and last 20. Apply the same page budget if no
boundary is confirmed, including in PDFs longer than 200 pages. Keep the original
file and page numbers. Record selected pages, boundaries, and probe errors in
local diagnostics only, without adding agent confirmations or user notices.

Figure, table, and equation layout warnings do not reject successful nonempty
text extraction. Corrupt files, unsafe archives, and empty extraction still
fail. Scan LaTeX math delimiters by escape parity without backtracking on an
unclosed delimiter.

Give LaTeX chapters the existing template's concise capability guide for macros,
math notation, and fonts. Define blackboard-bold capital letters used for
indicator functions. Before the existing v1 refinement, attempt one precompile
for at most 10 seconds. Success adds no refinement context; source errors become
repair inputs. Timeout or unavailable tooling uses the same template guide and
repair instructions. Precompile output under `_internal/compilation_precheck/`
does not overwrite the manuscript or deliverables and does not replace final
v2 publication compilation.

## Tasks and Sources

`01_input/writing_request.json` is the task source of truth. The `execution`,
`deliverable`, `sources`, and `publication` fields own execution strategy,
document type and granularity, allowed corpus, and output format, respectively.
Do not overwrite the original intent. Preserve additional instructions verbatim.

Task activation prepares the exact selected papers. The product fills trusted
missing metadata and available original abstracts, preserving versions,
provenance, and all selections. Both modes share abstract admission. Ready papers
enter the corpus; records still missing an abstract, identity, or bibliography
details appear on a visible follow-up list without blocking ready papers.

The product persists activation, plan, and outline responses as content-addressed
receipts before returning `receipt_ref`. Pass that reference directly to
`--receipt`; the CLI validates its digest, operation, and task binding. The
main agent interprets free-text changes; outline approval reads the original
response and identity from the receipt. `papers import-selected --receipt REF`
consumes the prepared list; the public CLI no longer accepts assembled per-paper
`items[]`. Existing material snapshots remain readable. Receipts do not renew
turn activation or grant full-text access.

Enable the persistent product tracker only for the agreed execution workflow,
using the product operations plan guide. Follow its Bridge/dedicated-tool routing,
reuse returned revisions and update only at stage boundaries. Do not save progress
JSON or call `slr progress`. Start publication before publishing.

Use the source-permission mapping in [SKILL.md](SKILL.md) when constructing
requests. Keep exact parameter values in requests and explain the permitted
papers and search in ordinary language. Query field descriptions only when
needed. If only specified papers are allowed, use the ready subset without
searching for more; if none are usable, wait for additional material. If
additional search is allowed, compute the number to retrieve from the ready
unique papers. Standard merges,
deduplicates, and freezes the selected and new papers before one product
full-text authorization. It then reads the full text or reuses compatible L1.
The framework parses PDFs as shared assets; do not send a separate model
conversation to reread them. Importing local PDF snapshots is a Standard action.

Before freezing the corpus, reactivation can include newly supplied abstracts.
After freezing, additions update the library only; the current task keeps its
snapshots and outputs, and new materials are for future tasks. Existing
workspaces keep their original import receipts.

`papers budget` returns the actual number to retrieve. The search subagent
returns that number. Truncate excess results in returned order before
deduplication; do not automatically search again. Do not cap user-provided
materials by the mode's default count. Follow existing source policy for missing
sources, abstracts, authors, or years rather than fabricating metadata.

## Paper Identity

Authoring contexts separate task/settings JSON from unescaped paper evidence.
They keep user requests, research scope
and applicable constraints, not execution estimates, confirmation settings or source
locators. Chapter input contains one local plan and one complete local asset inventory;
figure/table meaning, qualifications, ownership and reference labels remain available.
Abstracts still run concurrently, using type-specific contributions, headline findings,
conditions and author-stated limitations instead of complete cards. Selected fields
remain untruncated; sparse cards fall back to the original abstract. Other chapters
retain their assigned full business-content cards. Quick model input retains titles,
years, abstracts and complete citation tokens, without author lists or duplicate bare
citation keys. Internal bibliography mappings retain the original citation keys.
The figure brief supplies shared requirements and mode contracts once; per-figure
packets contain local plans and evidence references without choosing an image mode
or size unless already specified. No saved cards or user requirements are rewritten.
Each figure plan identifies a reader question and the relationship the drawing
must show. Image prompts use direct labels and a paper-white, deep-green editorial
palette by default. Figure-specific user style and language choices take precedence.
Conceptual illustrations show the relevant objects and their interactions. Their
captions introduce the subject and explain one useful comparison or takeaway.
The paragraph citing each figure develops the mechanism, evidence and limits.
In single-column PDFs, study comparisons with sentence-length cells default to a
multipage table near the first reference. Compact tables and two-column venues
use layouts appropriate to their available space.
Outline plans contain no chapter dependency graph. Necessary definitions and their
sources belong in local descriptions, analytical tasks and paper assignments.
Chapter roles determine evidence scope, not execution order. Abstracts remain
parallel with a lightweight global view; figures use confirmed plans and records
without waiting for chapter prose. Assembly still waits for required assets, and
the existing full-source refinement reconciles the completed text. Source-file and
asset dependencies needed for publication are unchanged. Older workspaces are not
silently migrated to the new outline protocol.

Use the original `paper_id` only for internal association. Outline requests use
P aliases; citations in prose use explicit markers such as `[[paper:P01]]`. The
adapter restores structured IDs and inline citation keys from the request map.
Parse citation and narrative fields separately; do not replace ordinary P text
globally. Reject ambiguous or unknown aliases and wrong request bindings.

Save the original response and mapping for every request, separately from the
normalized candidate. `outline import` binds the external response to its
original request and evidence digest. Chapter and front-matter references must
come from the evidence actually supplied. Valid IDs do not prove a scientific
claim is supported by the original paper.

## Publication

The final file is returned as singular `deliverable`; `source` names the editable manuscript. Workflow and stage reports retain their distinct schemas. For LaTeX, `compile.origin` records an invocation ID, the main source file's SHA-256 (not the whole dependency closure), and a manifest under `_logs/compilation/`. Each LaTeX/BibTeX command has an ordered pass record and retained output/engine-log snapshots. `diagnostic_pass_index` selects the final diagnostic pass, and `log_path` points to its retained log. The engine-log change marker records filesystem change, not a guarantee of complete input provenance. Identical overflow values do not prove a stale run, and log glyph dumps are not citation-validation results.

PDF uses the existing Chinese or English LaTeX templates. Markdown and DOCX
share a native Markdown source. DOCX exports locally through python-docx and
markdown-it-py; it does not use an online converter. It supports headings, text,
lists, tables, images, references, and common editable Word math. Unsupported
math commands fail explicitly instead of being dropped or converted incorrectly.

After the scripts deliver editable v2, the main agent edits it and its actual
dependencies before running `workflow publish`. Publication does not require
generation JSON as permission to edit, and does not reassemble over edits. Old
workspaces are not migrated automatically; existing user state stays unchanged.

Inspect the PDF first page and the pages that contain figures and tables. Open
DOCX in the product document viewer. A structural check or parseable file is not
visual or scientific acceptance.

### Local Reference Metadata Protocol

Markdown publication retains visible reference text and `ref-<citekey>` anchors.
On an empty anchor, `data-scholarseed-reference` holds percent-encoded UTF-8 JSON
at version `1`. The `title`, `authors`, `year`, `publication`, `url`, and
`doi` fields are strings; missing values are empty strings. Data comes only from
the current publication's local BibTeX entries. Numeric, IEEE, ACM, GB/T, and
author-year styles share one producer. It does not enrich data online or infer
fields from rendered references.

Desktop accepts only known versions and field types within the length limit
and treats metadata as untrusted text. Attribute encoding and anchor escaping
grant no HTML execution. Title links allow only HTTP or HTTPS, with an explicit
DOI link as a fallback when no source URL is present. Unknown, corrupt, or
missing metadata does not break the original citation anchors; show the original
references without guessing authors, years, or journals. Markdown edits must
retain the full empty-anchor attribute so metadata remains available on reopening.

## Time and Models

Outline generation uses temperature 0.6 with thinking enabled. In `config/model_config.fast.json`, `stages.outline_generation.reasoning_effort` defaults to `low`. Set it to `medium` or `xhigh` for more reasoning, or remove the field to use the provider default. Setting `thinking` to `false` disables thinking and omits the effort field.

Processing times are soft estimates, not cutoffs. Continue agreed work when it
takes longer, explaining completed work, the current stage, and an
evidence-based estimate of additional time. A slower task alone needs no
confirmation; actual changes and user-dependent blockers retain their decision
boundaries. `execution.budget_seconds` is an estimate, not a deadline.
`_status/budget.json` records script and delegated retrieval intervals as partial
diagnostics, not active model time, end-to-end duration, or a performance
guarantee. Use product Trace for full timing evidence.

Prefer the public `skill_model_client`. The framework owns model routing,
credentials, review, and transport retries. Use standalone transport only when
the public module cannot be imported, not when context setup or a request fails.
Do not save credentials, change user model configuration, or create a private
Python environment for a mode.

## Distribution and Verification

The Skill source is this directory. Keep the version, generated package manifest,
and product dependencies consistent. Build-time file inventories are generated,
not committed or edited by hand. Repository maintainers follow the prebundle
procedure in the repository’s `skills/ADAPTATION.md`.

On macOS use the bound `slr`; on Windows use the bound `slr.cmd` or product
Python argument arrays. Resolve relative paths against their explicit workspace;
resolve external and system paths at their owning boundary. Preserve the existing
cross-platform file locking, process cleanup, and product admission rules.

Verify task decisions, sources and citations, both generation modes, each output
format, package consistency, and the real Desktop path. Real product acceptance
needs the final revision, a real model, the authorization interaction, and
inspected screenshots. Deterministic fixtures do not substitute for this.
Record each platform separately.

## Publication Preferences

Chinese PDF uses **Standard Chinese** (`standard_chinese`, source
`assets/templates/standard_chinese/standard_chinese.tex`). The legacy `ctexart`
task identifier stays readable. English PDF offers NeurIPS, IEEE Transactions,
ICLR, ICML, and AAAI layouts. Template sources and frozen hashes are recorded in
`assets/templates/manifest.json`; layout does not change the citation style.
GB/T 7714—2025 omits online-carrier suffixes and consultation dates in entries
while retaining source metadata internally.

Standard defaults to five chapter jobs. Explicit figure and table counts are
enforced; when unspecified, choose counts from the evidence, allowing zero.
Quick supports Markdown tables but no images. Image requests require an actual
decision to use Standard.
