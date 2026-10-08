# managed acquisition module (internal: open-download)

## Responsibility

Record the confirmed selected papers whose full text the product has already acquired — serve fetches by arXiv id or DOI — and shape that record into the download manifest. This module performs no acquisition at all: the `scholarseed_bridge` tool calls (`literature acquire`) are made by the host model, and this module only consumes the host-relayed record of what serve acquired. The internal route is `open-download`; every per-paper classification comes from that relayed record, never from metadata access flags or identifier kinds. Do not attempt to fetch anything, choose papers, handle publisher access, read full texts, or infer interactive consent or auto delegation.

## Current implementation

`adapter.py` reads the host-relayed acquisition record at `downloads/acquire-result.json` — the verbatim `literature acquire` response the model saved after its `scholarseed_bridge` tool call — and shapes the whole confirmed selection against it. `scripts/acquire_result.py` treats that file as untrusted input: it shape-checks it (`ok: true`, `storage: "managed"`, `papers`/`failures` arrays, each `ref` equal to `paper:<paper_id>`, a non-empty content `revision`, no paper reported twice, no paper both acquired and failed) and asserts the record can narrow the confirmed selection but never widen it. Serve performed the fetch, verified the PDF and keeps the bytes in its managed store; this module holds no endpoint, credential, timeout or retry configuration, opens no network connection, and writes no PDF bytes. Record exactly what the relayed record reports per paper: acquired papers carry `storage: managed`, the `paper:` ref and the content revision serve returned, and their message names the identifier serve fetched by (`arXiv:<id>` or `doi:<doi>`); serve-reported failures stay per-paper failures and never discard the papers it did acquire. `placeholder.py` remains available only for deterministic offline workflow tests.

## Input

Read a confirmed `selection.json`; interactive selection is user-confirmed, while an explicitly delegated auto selection also records `decision_source: auto_delegated`. Resolve its `metadata_path` under the provided run directory, and read `downloads/acquire-result.json` from the same run. The authorization scope comes from serve, not from the run directory: it is the `granted_refs` subset serve derived from the user's persisted card decision, and the host model is responsible for sending every granted paper to `literature acquire` — with its arXiv id, or otherwise its DOI — at most 5 per call. This module never talks to serve itself; classification is driven entirely by the relayed record: a selected paper the record acquires is `downloaded`, one it reports as a failure is `failed`, and one the record never mentions is a terminal `skipped` (outside the granted subset, or no arXiv/DOI identifier serve can fetch) — never as acquired, and never routed to any downloader.

## Output

Write `downloads/manifest.json` with one result per selected paper, honest skips/failures, and counts. Successful entries point at product managed storage (`storage: managed`, `ref`, `revision`, `file_path: null`); this module writes no run-directory PDF copies and keeps no `downloads/arxiv-files.json` identity index. Per-paper outcomes: listed in the record's `papers` → `downloaded`, with a message naming the acquisition identifier (`arXiv:<id>` or `doi:<doi>`); listed in the record's `failures` → `failed` with serve's code and reason; never mentioned in the record → terminal `skipped` ("The product did not acquire this paper: it is outside the granted subset, or it has no arXiv/DOI identifier serve can fetch. This is terminal — it is never routed to a downloader and no full text is claimed for it."); selected ID missing from metadata → `failed`; this route not selected by the user (`download_open` not true) → `skipped`. There is no "skipped because non-arXiv" class and this release produces no `not_attempted`. A failure for one paper does not prevent later papers from being recorded.

User-visible progress events call this the managed acquisition batch (`[DOWNLOAD STATUS] managed …`); consolidated user-facing summaries keep the arXiv/non-arXiv labelling required by `references/workflow.md`. Outcomes come from the relayed record, never from the metadata OA flag.

## Invocation

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/module_runner.py" \
  --module open-download \
  --input "$RUN_DIR/selection.json" \
  --output "$RUN_DIR/downloads/manifest.json" \
  --run-dir "$RUN_DIR"
```

The adapter never fetches bytes itself and never invokes a bridge command line; the product tool calls are the host model's job. If `downloads/acquire-result.json` is missing when the stage runs, the adapter exits nonzero with the exact `scholarseed_bridge` acquire call to make: call the tool for the granted papers, save its verbatim response to that path, and rerun the stage. Outside a ScholarSeed host there is no acquisition channel and no download route; the stage stays blocked and reports the reason instead of requesting sandbox escalation or any elevated permission.

## Errors

Exit nonzero for missing confirmation, unsafe metadata paths, malformed top-level input, or a missing/unreadable/inconsistent acquisition record (including a record that reports `ok: false`, a non-managed storage, papers outside the confirmed selection, a `ref` that does not match its `paper_id`, a missing revision, a duplicated paper, or a paper both acquired and failed). Record selected IDs absent from metadata and serve-reported acquisition failures as per-paper `failed` entries, and every paper the record never mentions as a terminal `skipped` entry.

## Authorization and scope

Full text reaches this module only as serve's relayed acquisition record, so every byte it records was fetched by serve under the user's full-text authorization for this turn, limited to the serve-derived `granted_refs` subset. The record is input, not proof: serve re-verifies every managed entry against its own managed-object map and the authorized subset at the delivery checkpoint (`checkpoint=final`) and refuses delivery with `literature_result_fulltext_unverified` on any mismatch. This module does not use API tokens, browser sessions, institutional access, publisher sites, or paid-access credentials, and it never requests sandbox escalation or any elevated permission. A terminal `skipped` paper — ungranted, or without an arXiv/DOI identifier serve can fetch — is never routed to a downloader: the paid/paper-dl route recovers only granted papers serve reported as failed.

## Acceptance checklist

- Require explicit interactive selection confirmation or initial auto delegation.
- Consume only the host-relayed `downloads/acquire-result.json`; never call a bridge command line and never fetch from the network.
- Shape-check the record and reject any paper outside the confirmed selection.
- Classify solely from the relayed record: acquired → `downloaded`, serve-reported failure → `failed`, never mentioned → terminal `skipped`, so a subset grant never blocks reading.
- Never produce `not_attempted`, and never route a terminal `skipped` paper to a downloader or recovery plan.
- Keep metadata access flags out of the classification; they only inform the recorded `access_type` evidence.
- Never fetch, download or unpack full-text bytes inside the sandbox.
- Record `storage: managed` with the serve-returned ref and revision; keep `file_path: null` and no run-directory PDF copy.
- Report serve-side failures per paper without claiming batch success.
- Never touch paid sources or credentials.
- Pass contract and partial-failure tests.
