# Isolated writing and optional CPES interfaces

Read this for standalone model execution, external response acceptance, usage interpretation or an explicitly requested figure/table explanation. The default ScholarSeed route is defined only in [SKILL.md](../SKILL.md); use its controlled generation tool, not a shell bridge or standalone writer inside the client.

## Standalone writing

Use the compatible Python environment and paths established by the entry. If `workflow.py prepare` already returned a request, use it directly. Otherwise prepare the index with the [reading tools](reading-pipeline.md) and freeze a request:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/writing.py" request \
  --index "$HINT_OUTPUT/work/reading/reading.json" \
  --language "$HINT_NOTE_LANGUAGE" --out "$HINT_OUTPUT/work/request.json"
```

Resolve language from the user or conversation: the isolated writer does not inherit conversational context. Add only inspected extra B sources with `--sources ...`, candidate sections with `--sections ...`, or selected evidence images with `--images ...`. Retrieve necessary omitted context before freezing; this no-tools writer cannot fetch it. Image readiness does not mark an image reviewed. Request preparation includes `references/writing-guide.md` once, followed by the material-only packet. Requests bind the guide, packet, index, schema, images and writer code; changed inputs require fresh preparation.

The default request outputs Markdown with a hidden source marker at each paragraph's end, without an output JSON Schema. Use `--stream`; only the prose is previewed, and the paragraph-local source groups become `source-map.json` locally. A paragraph can cite multiple sources, and sources can support several paragraphs. For an explicitly required legacy buffered JSON call, prepare with `--output-format json_schema`.

With an already configured local Codex CLI, make the primary writing call once:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/writing.py" run \
  --request "$HINT_OUTPUT/work/request.json" \
  --out-dir "$HINT_OUTPUT/work/writing" --stream
```

This uses one ephemeral App Server thread/turn and inherits local Codex configuration. Use model/profile overrides only when requested; client mode rejects them. Streaming supports `--model` but not `--profile`. If a named profile is required, explicitly omit `--stream` for the buffered `codex exec` path. Unsupported protocols fail without fallback. `--timeout` defaults to 300 seconds. No automatic installation, API fallback, warmup or retry occurs.

Streaming sends unvalidated Markdown to stdout and completion JSON to stderr. On successful validation it saves `final/note.md` and `final/source-map.json`. Buffered mode returns JSON on stdout and leaves final assembly to the caller, using the reading reference. Interrupted or failed previews are not formal deliverables. Early text does not guarantee lower latency or token use.

## Accept an external response

An external caller supplies JSON with `output_text` containing the Markdown draft (or the JSON draft for an explicitly prepared JSON request) and optional provider `usage`:

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/writing.py" accept \
  --request "$HINT_OUTPUT/work/request.json" --response "/absolute/response.json" \
  --out-dir "$HINT_OUTPUT/work/writing" --publish
```

This is offline; `--publish` assembles the final pair. Omit it only when intentionally assembling separately. Normal structure, source and ownership checks apply. Raw responses remain unchanged. Acceptance can remove one JSON fence and escape identifiable interior ASCII quotes in free-text fields, recording changes and hashes in the receipt; it does not repair ambiguous structure, source IDs or identity values.

The runner retains `response.json`, `draft.json` and `receipt.json`. Receipts bind request/output hashes, outcome, elapsed time and reported usage. Completed unchanged results can be reused without another call. Failed/interrupted directories refuse redispatch; a fresh directory is a new possible model call, not a free retry.

Missing image-token counts remain unknown. Reused usage belongs to the original call; do not add it again. `new_model_calls` counts writer dispatches, not underlying provider requests. Offline/mock checks do not establish writing quality, token savings or full PDF extraction.

## Explicit figure/table questions

```bash
"$HINT_PYTHON" "$HINT_SKILL_DIR/scripts/machine.py" info
```

This bundled CPES fork needs no external checkout; `cpes_machine/upstream.json` records provenance. Its figure/table rules retain their upstream `candidate_with_known_issues` status. `info` lists versions, boundaries and CLI shapes; use the relevant subcommand's help only when executing that interface. It also exposes `prepare-pdf`, `prepare`, `request`, `assemble` and explicit `run`.

Outputs are CPES cards, not literature notes; integrate relevant explanations with their provenance. Reuse compatible completed results. Native reading/writing uses Python 3.11+ and `requirements.txt`; full figure/table conversion additionally needs the existing CPU/Paddle/PaddleOCR environment. HINT does not install those heavy dependencies. Running `info` does not test OCR or figure extraction.


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
