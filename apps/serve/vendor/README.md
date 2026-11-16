# L1 extraction distribution

`deep_rnd_l1-0.2.6-py3-none-any.whl` is the fixed, provider-independent single-paper extractor from the sibling `deep_rnd` repository. Serve imports `knowledge_layer.comprehend`; it does not import the research checkout or read its model configuration at runtime. The wheel contains only the extraction API, prompts, schema and their standard-library helpers. It has no third-party dependencies or model credentials.

`provenance.json` records the source revision, each shipped source file's SHA-256, and the wheel SHA-256. The product dependency is pinned in `apps/serve/pyproject.toml`; the workspace source and byte hash are pinned in `pyproject.toml` and `uv.lock`.

Version 0.2.6 (`l1/v2.5`) gives each built-in paper type one expanded output template and validates supplied field types against it. The existing mandatory substantive fields remain mandatory; optional scientific omissions do not become invented claims. Unambiguous misplaced wrappers and empty scalar absence are normalized locally.

Recovery is restricted to validator-selected field paths and their dependent evidence. Valid fields, result order and source IDs are preserved; a legacy full-wrapper response is projected onto that same allowlist. Invalid JSON/truncation belongs to the existing extraction recovery budget, not an additional transport retry. Serve still permits one extraction plus one recovery. Valid source IDs survive optional citation cleanup; missing whole maps and un-sourced result tuples can trigger recovery. No provider-specific structured-output capability is assumed.

Failed partial output, source snapshot/mapping and attempt diagnostics are saved in the local `literature_material_failures` table, separate from successful assets. Callers receive the stable error code and a short field-error summary. Failure records are not reusable assets and cannot replace a successful L1. This is a shared extraction/product adapter change: review selection, chapter scheduling and AI reading prose/citation-repair policy are unchanged. Existing 0.2.4/0.2.5 assets remain compatible.

Validation is deterministic with mocked model responses, including all four paper types and the library/PDF joint-output adapter. Actual model acceptance and App execution are intentionally not performed in this change.

Version 0.2.5 adds an optional caller-owned model invocation to the shared extraction kernel. Literature review retains its input preparation, transport and retry budgets. The default library/PDF extraction path and prompt version are unchanged. Both 0.2.4 and 0.2.5 saved assets remain reusable.

Version 0.2.4 binds source IDs inside generated experimental result records and adapts them to the existing result/source_map schema. Numbered source blocks preserve indented table layout. Existing validation, retry counts and low-latency presentation remain unchanged. No existing assets are regenerated; model acceptance is pending user verification.

The shipped source files match the committed `source_commit`; `source_dirty` is false. `restored_base_commit` records the older extraction baseline, and the source-file hashes identify the shipped content.

To update, prepare an isolated wheel-build environment from the workspace lock, then run from the product checkout:

```sh
.wheel-venv/bin/python scripts/cd/wheel.py --project <deep_rnd-source> --outdir apps/serve/vendor --builder pip --no-build-isolation
```

Use a new distribution version for subsequent changes after this version is committed. Update the Serve dependency and workspace path, run `uv lock --refresh-package deep-rnd-l1`, refresh the provenance file, and run the extraction and release dependency contracts. Never edit the wheel in place after release.

Desktop's existing dependency export excludes this local distribution from registry requirements and records it as `product_wheels`. The bundler installs it with the product distributions. Export verifies source/version/hash against `uv.lock`; snapshot rejects a changed or omitted wheel. Windows places it in the existing product `pylibs` directory; other targets install it into the bundled interpreter. No new bootstrap path or dynamic `sys.path` injection is used.

Library/PDF reading, conversation reuse and review material extraction consume the shared assets. This patch does not change review selection or chapter scheduling. The existing admitted bundled-skill Python entry uses the product interpreter. Ordinary task venvs remain isolated and do not inherit this distribution.
