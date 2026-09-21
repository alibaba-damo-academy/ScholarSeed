# arXiv module (internal: open-download)

## Responsibility

Download only confirmed selected papers with an arXiv identifier and update the manifest. The internal route is `open-download`; eligibility is based on an arXiv identifier, not a generic OA flag. Do not attempt non-arXiv records, choose papers, handle publisher access, read PDFs, or infer interactive consent or auto delegation.

## Current implementation

Use `adapter.py` to filter the confirmed selection to papers with an arXiv ID. Never download a non-arXiv record merely because metadata says `open_access: yes`. For each eligible paper, derive the public `https://arxiv.org/pdf/<arxiv-id>` URL and fetch it directly without credentials. Accept an arXiv ID as open-access evidence even when cached metadata says `open_access: no` or does not advertise full text. Bound each response at 100 MB, retry transient transport/server failures, require a PDF signature and minimum size, write atomically under `downloads/papers/` using the paper title as the filename, and verify the retained file. Add a stable short suffix only when selected papers have colliding safe titles. `placeholder.py` remains available only for deterministic offline workflow tests.

## Input

Reuse a PDF only through `downloads/arxiv-files.json`, whose entry binds the
paper ID, exact arXiv ID/version, run-relative path and SHA-256. The adapter
persists that binding after each download for interrupted-batch recovery.
Reserve existing files across rounds; unbound files, changed IDs or
content-hash mismatches trigger a fresh download to a collision-safe path,
without overwriting or treating the old PDF as another paper's evidence.

Read a confirmed `selection.json`; interactive selection is user-confirmed, while an explicitly delegated auto selection also records `decision_source: auto_delegated`. Resolve its `metadata_path` under the provided run directory.

## Output

Write `downloads/manifest.json` with one result per selected paper, run-relative verified paths for successes, honest skips/failures, and counts. A failure for one paper does not discard successful files or prevent later papers from being attempted.

User-visible progress calls this the `arXiv` batch. Do not label it generic OA: eligibility is an arXiv identifier, not the metadata OA flag.

## Invocation

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/module_runner.py" \
  --module open-download \
  --input "$RUN_DIR/selection.json" \
  --output "$RUN_DIR/downloads/manifest.json" \
  --run-dir "$RUN_DIR"
```

This batch requires public network access. On the first invocation, the host must start the complete command with its required network capability instead of waiting for a failed probe. In Codex, invoke it with `sandbox_permissions=require_escalated` and a narrowly scoped justification for public arXiv PDF access. The adapter cannot grant its own network permission.

The arXiv host is fixed to `https://arxiv.org`; there is no PaperHub download endpoint, token, or endpoint override in this module. `ARXIV_PDF_TIMEOUT` controls the per-request timeout in seconds and `ARXIV_PDF_ATTEMPTS` controls bounded retry attempts.

Keep execution-policy classification as a defense in depth. If the adapter reports `execution_blocked`, stop the batch immediately and do not continue through the remaining papers. Classify unavailable network capability as an environment blocker, not as a scholarly-access failure.

## Errors

Exit nonzero for missing confirmation, unsafe metadata paths, invalid configuration, malformed top-level input, or `execution_blocked`. Record selected IDs absent from metadata and exhausted/invalid arXiv-backed requests as per-paper failures. Record every non-arXiv paper, including records marked OA, as `skipped`. Keep previously verified files when an individual item cannot be processed; an authorized rerun reuses them.

## Authorization and scope

The adapter accesses only public arXiv PDF URLs. It does not use API tokens, browser sessions, institutional access, publisher sites, or paid-access credentials. All non-arXiv records are outside this module's scope regardless of their OA metadata.

## Acceptance checklist

- Require explicit interactive selection confirmation or initial auto delegation.
- Process only arXiv-backed papers.
- Skip non-arXiv records, including `open_access: yes` records.
- Do not let stale availability metadata block an arXiv-backed paper.
- Use only the arXiv ID and public arXiv PDF URL.
- Never send the PaperHub Bearer token from the download module.
- Verify file existence, minimum size, and PDF signature.
- Store verified PDFs directly under `downloads/papers/` with title-derived names.
- Never touch paid sources or credentials.
- Pass contract and partial-failure tests.
