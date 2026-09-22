# Download runtime maintenance

For runtime maintainers and explicit browser-pool recovery only. Routine
research runs call the adapter; they do not reproduce these algorithms.

## Provisioned configuration

The adapter resolves `PAPER_DL_EXECUTABLE` or `PAPER_DL_ROOT` overrides first.
Under the ScholarSeed product the host pins the interpreter (`SCHOLARSEED_PYTHON`
is set), so the adapter runs the provisioned module entry `-m paper_dl` on that
active interpreter rather than the `paper-dl` console script: the pip-generated
console script embeds a build-machine-absolute shebang that breaks once the
bundled backend is relocated. A missing `paper_dl` module is an environment
blocker, never a trigger to install packages or switch environments. Without a
pinned interpreter (standalone use) it falls back to the skill's
`.venv/bin/paper-dl` (`.venv/Scripts/paper-dl.exe` on Windows), then `PATH`.
Supply one tested runtime during installation. The runtime reports PDFs through
`original_path`.

All skill copies share the user-level browser pool at `~/.paper-dl/browser-pool/`.
Set `PAPER_DL_BROWSER_POOL_DIR` consistently to override it, outside every run.
`PAPER_DL_CHROME_EXECUTABLE` selects Chrome. Unsupported `PAPER_DL_CDP_ENDPOINT`,
`PAPER_DL_CDP_PROFILE` and disabled-auto-launch settings are rejected. Other
settings are `PAPER_DL_CONFIG`, `PAPER_DL_EMAIL`, `PAPER_DL_PAPER_TIMEOUT` and
`PAPER_DL_BATCH_TIMEOUT`; `PAPER_DL_PROFILE` applies only to autodev. Credentials,
cookies and tokens must not enter tracked configuration or run artifacts.

Interactive execution needs process inspection, private profile writes and
loopback access. Use the host's normal filesystem/process permissions; no integration hook is needed.

## Owned browser lifecycle

The three-slot pool allocates only for real pending papers. Each lease owns a
Chrome process group, a persistent profile and an explicit nonzero loopback
port. Port 0 changes Chrome's automation semantics and is not used. The pool
verifies the owned child's CDP stderr announcement against the endpoint;
an external process winning the bind race is not accepted. Other stderr is
discarded. The runtime connects with
`--connect-cdp … --no-headless --keep-open --no-zotero` and disconnects without
taking browser ownership. `autodev` runs outside this pool.

Run, allocation and slot-execution locks protect ownership. A lease ID and
resolved run path reject stale resume/release attempts. Supervisors acknowledge
initialization over a pipe before registration, avoiding transient macOS Python
launcher identities. Only after registration is saved does the parent open the
startup gate. Timeout/EOF reaps the still-unauthorized direct child. Completion
and cancellation stop and verify both owned process groups before release;
unknown cleanup stays reserved for explicit abandonment. Never kill by name.

Fresh profile reuse clears page-restoration and download/history state while
retaining login stores; unexpected restored pages are rejected. Paused resumes
preserve pages. The default logical slots use `~/.paper-dl-cdp-profile`,
`~/.paper-dl-cdp-profile-pool/slot-1` and `~/.paper-dl-cdp-profile-pool/slot-2`.
A custom pool stores profiles at `<pool>/slot-N/profile`. Saved leases retain
their recorded paths. Skip a profile held by unrelated Chrome; never attach to
or close that Chrome.

The adapter saves per-paper successes and pending actions before intervention
tab setup, and writes PDF identity bindings before relocation. Core retains
`action_reason`, `manual_challenge` and institutional-access state. EOF exits
interactive prompts into resumable actions. Per-paper timeout is a hard limit
(autodev caps it at 180 seconds); batch timeout separately limits the process
group.

## Optional user-installed translators

The bundled downloader does not contain Zotero translator sources or generated
adapters. Normal skill downloads leave translators disabled. If an operator
explicitly chooses to enable trusted, separately obtained translators, convert
them with `scholarseed-skill-python -m paper_dl.translators.sync` and keep the resulting adapter
directory outside the repository, skill installation and run directories.

Set `browser.translators_dir` in the YAML selected by `PAPER_DL_CONFIG` to that
absolute directory. The downloader validates its manifest and containment before
loading adapters. Translator code executes in the active browser page and keeps
its upstream license; never enable an unreviewed directory. The direct downloader
CLI can use `--no-translators` to override YAML without changing the skill's
tracked configuration. Zotero Desktop/Connector remains a separate integration
and stays disabled by this skill.

## Inspect or abandon

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/browser_pool.py" status
# Explicit abandonment only; stop the active adapter first.
scholarseed-skill-python "$SKILL_DIR/scripts/browser_pool.py" abandon --run-dir "$RUN_DIR"
```

Abandon refuses an executing run. If ownership cannot be verified, resolve the
known processes through explicit maintenance and retry; never delete state to
force reuse. Keep the original pool setting when resuming or abandoning a run.

## Optional authorized login template

Fully quit the Chrome owning the source profile and keep it closed while
creating an authorized template:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/browser_pool.py" create-template \
  --source-profile "$HOME/.paper-dl-cdp-profile"
```

The private `<pool>/profile-template` imports `Default` and `Local State`.
New slots copy it; existing profiles and paused browsers are never overwritten.
No live login synchronization occurs. Creation rejects active/changing sources,
links, special files, overlap and existing destinations. It retains login
stores, clears page/download history and old download-directory preferences.
Never launch Chrome on the template or log its contents. A copied login does
not guarantee access or avoid CAPTCHA.

To refresh, create a distinct `--template-dir /new/template/path` and configure
`PAPER_DL_PROFILE_TEMPLATE` consistently. Missing/invalid explicit templates
fail initialization, not silently fall back. Updates affect only profiles not
yet created. To provision fresh slots, use a new shared pool after existing
runs finish; do not delete an owned slot profile.

## Replacement invariants

Retain ownership checks, authorization pauses, no-bypass behavior, cancellation,
resumable actions, unattended manual-item skipping, verified identity-bound PDF
recovery, per-item continuation and completion notices. Keep login/session
material only in private profiles/templates. Verify pause, partial failure,
resume, cancellation, containment, identity and smoke-test behavior when
replacing the runtime.
