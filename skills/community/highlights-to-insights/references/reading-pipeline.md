# Local reading tools and draft contract

Read this only for a material/context gap, scope correction, draft format or separate assembly. The normal entry already prepares and freezes materials; do not repeat that preparation. `scripts/reading.py` is local and calls neither a model nor the network. It uses the bundled native-line reader and PDF dependencies, without an external CPES checkout.

## Prepare or correct materials

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" prepare \
  --pdf "$HINT_PDF" --out-dir "$HINT_OUTPUT/work/reading"
```

Optional inputs are `--notes ...`, `--goal "..."`, `--visual "/absolute/checked-review.json"` and `--scope "/absolute/checked-scope.json"`. Only provide observations actually checked. Unchanged preparation can be reused after input, code, engine and packet checks; changed/partial inputs require a fresh directory. Earlier incompatible packet versions must be prepared again.

- `reading.json` retains the complete native text, geometry, source catalog, candidate sections, annotation/application provenance, coverage and hashes.
- `packet.md` supplies selected original evidence, all reading signals and material-status information; writing instructions live in `writing-guide.md` and are added when preparing the writing request. It retains body prose including abstract and deferred Methods, marked appendix context and necessary related units. Unmarked appendix, references and backmatter remain locally retrievable. There is no body character cap; shared blocks are emitted once. Unknown/mixed prose is conservatively retained.

Selection, section boundaries, object regions and mark-context associations are candidates, not verified semantic completeness. Native blocks may split paragraphs, formulas or captions. Recover needed continuations/definitions before freezing; grouped fragments do not verify an equation. Skipped objects and unresolved references remain local. There is no automatic semantic retrieval, supplement fetching, OCR or flattened-highlight detection. Native-poor pages remain gaps unless visual/OCR follow-up is explicitly requested.

## Source handles and retrieval

| Handle | Meaning |
| --- | --- |
| B | Native paper text with line IDs and geometry |
| A | Reconciled PDF/application/visual record with original IDs and channels |
| N | Supplied independent-note paragraph with file and line range |
| S | Candidate section retrieval handle; not a citation ID |

Display aliases such as `B007` resolve to canonical IDs such as `B00007` through `source_aliases`. Either form is accepted, but both forms of one source are a duplicate citation. IDs are stable within the frozen extraction; use actual returned values. Spatial overlap or a nearby note does not establish an exact semantic target.

Search the full local index, then show only needed sources/context:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" search \
  --index "$HINT_OUTPUT/work/reading/reading.json" --query "grid regularization" --limit 8
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" show \
  --index "$HINT_OUTPUT/work/reading/reading.json" \
  --sources A00001 B00002 --with-context --max-chars 12000
```

Use `--sections S00001` instead of `--sources` for candidate-section retrieval. Search is literal; no matches do not prove absence. `--max-chars` bounds display, not tokens; increase it or narrow the selection when fields are truncated. Inspected extra B IDs/sections can be added to a writing request as described in [cpes-machine.md](cpes-machine.md); the isolated writer cannot fetch omitted evidence itself.

## Correct a concrete scope error

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" scope \
  --index "$HINT_OUTPUT/work/reading/reading.json"
```

This returns boundaries, roles, status and binding hashes without dumping body text. Inspect the relevant passages before preparing an override:

```json
{
  "schema_version": 1,
  "pdf_sha256": "actual hash returned by scope",
  "native_index_sha256": "actual hash returned by scope",
  "overrides": [{"first_source_id": "B00020", "last_source_id": "B00030", "role": "body"}]
}
```

Roles are `body`, `appendix`, `references` or `backmatter`. Use either an inclusive range or `source_ids` for individual IDs, not both. Unknown/duplicate IDs, reversed ranges and hash mismatches fail. Reprepare into a fresh directory with `--scope <file>` and use its new index. Partial overrides do not establish complete review.

## Explicit visual inspection

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" crop \
  --index "$HINT_OUTPUT/work/reading/reading.json" \
  --source A00001 --out "$HINT_OUTPUT/work/detail.png" --dpi 140
```

For a region use `--page 7 --rect x0 y0 x1 y1` instead of `--source`. Coordinates are unrotated PDF points relative to the CropBox top-left; crops are page-clipped with default 12-point padding (`--padding` changes it). Rotated application data needs visual checking. A personal note without a PDF page cannot be cropped into one.

Open the resulting image and expand it when the complete object, legend, caption, continuation or definitions are missing. Source crops can include nearby native lines and may default to the full page for flagged visual/unlocated marks; this does not prove the marked target or completeness. Cropping alone never marks a page reviewed. For a requested page overview:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/render_pages.py" "$HINT_PDF" \
  --out-dir "$HINT_OUTPUT/work/overview" --pages none --overview
```

Checked observations use the format in [source-formats.md](source-formats.md). Requested figure/table explanations use the CPES interface instead of inferring visuals from caption text.

## Compact draft and local assembly

The model supplies prose and source choices, not raw provenance:

```json
{
  "title": "A coherent literature note",
  "sections": [{
    "title": "",
    "paragraphs": [
      {"text": "Original paper title  \nFirstAuthor et al. · Journal · Year", "source_ids": ["B00001"], "identity": "paper_summary"},
      {"text": "Opening prose about the paper's problem and approach.", "source_ids": ["B00007"], "identity": "paper_summary"}
    ]
  }],
  "omissions": []
}
```

Writing requirements passed through `workflow.py prepare --requirements` are frozen in the writing request, separately from the reading goal and packet. `preparation.json` retains the complete preparation report; normal execution uses the compact stdout handoff.

The default writer returns Markdown with one `[[hint:identity|source_ids]]` marker at the end of every prose paragraph, including the two-line bibliographic block. Each marker can list several comma-separated B/A/N IDs; sources may be reused across paragraphs. Titles and section headings have no markers. Only prose is displayed: streaming hides markers, and local acceptance converts the adjacent bindings into the following draft for validation and assembly without asking the model to output JSON. The legacy numbered `[[SOURCE_MAP]]` format remains supported by offline parsing; new requests use paragraph-local markers.

Acceptance normalizes an extra blank line inside the opening two-line bibliography when its second line has the `Author · Journal · Year` form. It remains one source-bound bibliographic unit. This exception does not merge body paragraphs or invent missing sources.

Example values are placeholders, not sources or bibliographic facts to copy. The opening section title is empty. Its first paragraph is the bibliographic block, with two spaces and a newline between original title and author/journal/year; prose follows in the next paragraph. Use `et al.` for multiple authors only and omit unavailable facts. Later section titles are nonempty; choose their wording freely and follow the writing guide or the user’s explicit request for their count.

Every paragraph has `text`, real `source_ids` and `identity`: `paper_summary`, `mixed`, `reader_thought`, `model_explanation` or `model_suggestion`. Actual reader words require their A/N sources; highlighting alone cannot establish `reader_thought`. One paragraph can combine sources and a source can support several paragraphs. Text allows soft line breaks but no internal blank lines. Outer whitespace/line endings are normalized.

`omissions` can be empty. Reasons for unused A/N signals are optional; B blocks need none. Missing, empty, duplicate or overlapping explanations remain warnings for a partially grounded note, without requiring invented reasons or another model call. The writer rejects a response citing no supplied reading signals with `reading_signals_unreferenced`; paper-only input remains supported.

For standalone buffered drafts or external acceptance without `--publish`, assemble once:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/reading.py" assemble \
  --index "$HINT_OUTPUT/work/reading/reading.json" \
  --draft "$HINT_OUTPUT/work/writing/draft.json" --out-dir "$HINT_OUTPUT/work/writing/final"
```

Streaming and `accept --publish` already assemble; do not repeat it. The assembler writes `note.md` and `source-map.json`, fills original excerpts/records/geometry, and binds paragraph order and exact final lines with text/file hashes. Repeated text has distinct paragraph IDs and ranges. Invalid structure, references or ownership, changed inputs and existing outputs fail before publication. Local structural checks do not prove scientific correctness or visual completeness; source interpretation is checked within the writer's single pass.


Paragraph boundaries follow Markdown blank lines. Acceptance collects all local
source markers within each paragraph into one deduplicated source group, keeping
sentences after an inline marker in that same paragraph. Mixed identity labels
produce a mixed paragraph. A separate unreferenced paragraph still fails. Final
Markdown contains no markers; the independent JSON map carries the associations.

Markdown compatibility is applied locally before validation: ATX heading levels
1–6 and setext headings are accepted, then normalized to the note's title/section
format. Ordinary inline citations such as `[A017][B012]` or `[A017, B012]` join the
same paragraph's source group; without an explicit identity they are recorded as
`model_explanation`, never inferred to be the reader's thoughts. IDs still must
resolve in the frozen source catalog. Code, escaped brackets and inline links/images
are preserved and do not establish provenance. Unsupported block structures and
reference-link definitions fail explicitly rather than losing content. Missing
paragraph evidence is not invented. The preferred hidden-marker streaming protocol
is unchanged; fallback ordinary citations may appear until final acceptance.

The input presents full reading-mark and comment text before paper evidence. Related
paper units appear before background and carry context backlinks; each selected
paper unit is included once. These backlinks are candidates for writing, never
automatically converted into paragraph citations. Local acceptance rejects zero
reading-signal coverage, while partial coverage is published with warnings. The
Desktop preview separately lists unreferenced selected marks/comments for review.
