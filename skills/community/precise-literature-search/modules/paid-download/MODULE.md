# non-arXiv download module

## Responsibility and authorization

Recover granted papers that serve could not acquire: the targets come only from
`downloads/manifest.json` — entries recorded as `failed` (what serve reported for
a granted acquisition) or `action_required` from a previous paid batch — never
from metadata access flags or identifier kinds. A terminal `skipped` entry (the
product did not grant the paper, or it has no arXiv/DOI identifier serve can
fetch) is never a download target, whatever its metadata says about access.
Use `non-arXiv` in user-visible messages;
`paid-download` remains the internal module name, not a claim that a paper is paid.

Require a confirmed `selection.json` with `download_paid: true`, referenced
metadata and real DOI, URL or arXiv identifiers. An explicitly delegated auto
selection records `decision_source: auto_delegated`; a generic reply does not
authorize downloads or unattended execution. Never bypass paywalls, login,
CAPTCHA or verification.

## Execute and resume

Use the provisioned adapter through the shared runner. Missing Python 3.11+,
wheel, dependencies or browser is an environment blocker,
not permission to install packages or switch to test data. `placeholder.py`
is an offline test fixture only, never a production fallback.

Follow the [product Python contract](../../SKILL.md#product-python) on every
attempt, including resume: do not choose another Python or set
`PAPER_DL_EXECUTABLE` / `PAPER_DL_ROOT` to recover from a startup failure.
External downloader configuration requires the user's explicit selection.

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/module_runner.py" \
  --module paid-download \
  --input "$RUN_DIR/selection.json" \
  --output "$RUN_DIR/downloads/manifest.json" \
  --run-dir "$RUN_DIR"
```

For a paused batch, execute the same command with `--resume`. Do not start a
second adapter for the same run. Cancellation is authoritative: keep the batch
attached to the workflow so cancellation reaches and reaps its child processes.

Interactive access is the default. In both modes, the adapter owns browser allocation,
verified loopback CDP attachment, process cleanup and retries. Wait when all
three browser slots are occupied; do not attach to another browser or remove
locks to force capacity. A login/CAPTCHA pause retains its lease for resume.
Direct the user to the opened paper tabs in the dedicated Chrome or Edge; use the safe
`action.papers` links only if tab creation failed. Generic publisher portals
are sign-in starting points, not article evidence.

Use `PAPER_DL_MODE=autodev` only for explicitly authorized unattended execution.
It adds `--autodev` to the same verified CDP connection, skips
login/CAPTCHA/manual-solve items, and releases the slot when the batch ends.
It does not launch headless Chromium or pause for human intervention. Zotero mode must stay
`off` in both modes. Browser/CDP startup failures are execution errors, not
grounds for an alternate attachment or reconnection workaround.

## Results and recovery

The adapter writes `downloads/manifest.json`, verified PDFs under
`downloads/papers/`, and attempt inputs/reports under
`downloads/paper-dl-logs/`. The paper-dl library cache is not a run artifact:
the adapter points `--storage` at `~/.paper-dl/library` — short by construction
so the tool's native Windows paths survive deep run directories — and it fails
fast with `long_path_blocked` before starting any batch whose native downloader
paths would exceed the Windows path budget. Relay its concise `[DOWNLOAD STATUS]` queue and
per-paper events using the user-visible label `non-arXiv`, not backend names;
do not invent percentage progress or repeatedly print the whole manifest.
A downloaded PDF is not yet read full-text evidence.

PDF publication follows the actual filesystem result, not drive-name comparison:

| Behavior | macOS | Windows |
| --- | --- | --- |
| Rename | Try atomic replacement; only `EXDEV` triggers copying | Same, including volumes mounted under the same drive |
| Cross-device publication | Exclusively create a sibling temporary file, copy, close, then atomically replace | Same; close the temporary handle before replacement |
| Verification and cleanup | Verify PDF signature and SHA-256 before deleting the copied source | Same; file-lock or permission errors during source cleanup retain verified success with a warning |

Copy, publication or verification failure remains a failed download and preserves
the copied source for retry. Temporary-file cleanup errors are reported without
masking the original failure. The prewritten identity ledger supports recovery;
it does not itself prove that publication succeeded.

Prior successes are revalidated before retry. Relocated-file recovery requires
the paper identity, identifier hash, contained path and PDF SHA-256 binding in
`downloads/paper-dl-files.json`. A title or preferred filename alone never
authorizes reuse. Preserve unbound PDFs and request reacquisition or
explicit manual recovery. Preserve managed (`downloaded`) successes and partial
non-arXiv results; only remaining or invalid entries are retried.

Follow persisted `action_type`, safe message and resume token for manual work.
The manifest remains authoritative even if preparing intervention tabs fails.
Exit code 1 can represent a valid partial downloader report; absence of a valid
report is an error, not success.

For explicit whole-batch skip:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/download_recovery.py" skip-and-read \
  --run-dir "$RUN_DIR" --manifest "$RUN_DIR/downloads/manifest.json"
```

Manual verification releases the browser lease only when no action remains.
Skipping one paper must not release a browser still needed by another paper.
After `completion_notice.browser_pool_released=true`, no browser action is
needed: never tell the user to close a browser that may now belong to another
run. Unverified cleanup is an error; never delete ownership files or kill by
process name.

`download_route` records the internal module; `access_type` separately records
evidenced `open` or conservative `unknown`. Positive OA discovery may correct
stale metadata. Existing `paid` manifests remain readable.

## Conditional references

- Platform configuration, browser ownership internals, login templates or
  explicit abandonment: read [download runtime maintenance](../../references/download-runtime-maintenance.md)
  only when diagnosing or maintaining that subsystem.
- Native Windows execution: read [the Windows guide](../../references/windows.md).
- Distribution version, SHA-256, public source, license and reproducible build:
  `vendor/provenance.json`; dependency and optional-translator notices:
  `vendor/THIRD_PARTY_NOTICES.md`.
