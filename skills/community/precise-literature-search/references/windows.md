# Native Windows execution

Target Windows 10+ x64 with Python 3.11+ and Chrome or Edge. The scripts use the same arguments and JSON contracts on both platforms; use `scholarseed-skill-python` and the [product Python contract](../SKILL.md#product-python), not a host `python3` or `py` command. The default downloader runs the active product `python.exe` with `-m paper_dl`. `.venv/Scripts/paper-dl.exe` belongs only to an explicitly user-selected `PAPER_DL_ROOT`, not default runtime discovery.

Translate Bash examples into PowerShell when that is the current shell:

- Set environment variables with `$env:NAME = 'value'`, not `export`; remove them with `Remove-Item Env:NAME -ErrorAction SilentlyContinue`.
- Define `$SKILL_DIR`, `$WORK_DIR`, and `$RUN_DIR` as PowerShell variables with actual absolute paths. Use a single-line command or PowerShell syntax, not Bash `\` continuation.
- Invoke a quoted executable with `& 'C:\path with spaces\python.exe' ...`. Keep each argument separate. Executable overrides support `.exe` and `.py`, not `.cmd` or `.bat` wrappers.
- Use `[System.IO.Path]::GetTempPath()` and Python's `tempfile` for temporary paths. Do not assume `/tmp` or `mktemp` exists.
- Use `$env:USERPROFILE` where examples refer to the user's home directory.
- Set `$env:PYTHONUTF8='1'` and `$env:PYTHONIOENCODING='utf-8'`. Write JSON and Markdown with `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`; PowerShell 5 `Out-File` defaults to UTF-16.

Interactive defaults:

```powershell
$env:PAPER_DL_MODE = 'interactive'
$env:PAPER_DL_ZOTERO_MODE = 'off'
Remove-Item Env:PAPER_DL_CDP_ENDPOINT, Env:PAPER_DL_CDP_PROFILE, Env:PAPER_DL_AUTO_LAUNCH_CHROME -ErrorAction SilentlyContinue
```

Use `config/paid-download.ps1` when dot-sourcing local scripts is permitted by the user's existing PowerShell policy. Do not change execution policy for this workflow. Chrome is preferred, then Edge, then Chromium, across LOCALAPPDATA, PROGRAMFILES, PROGRAMFILES(X86), and PATH; set `PAPER_DL_CHROME_EXECUTABLE` to an absolute `.exe` path if needed.

All skill copies share one browser pool. Its root stays outside run directories and should be on local NTFS. Owned profile directories use private inheritable Windows ACLs for data newly created or copied by these tools. Manually migrated profiles must already have private permissions; prefer fresh profiles or `create-template`, since existing child files can retain explicit ACLs. A paused lease retains its browser after the caller exits; resume the same run, or use `scripts/browser_pool.py abandon --run-dir ...` after the adapter stops. Hard cancellation or a host without a console can require explicit abandon. Job/process ownership failures retain the slot instead of killing guessed PIDs.

The downloader writes its library with native Windows paths, so its cache lives
at a short per-user root (`~/.paper-dl/library`), never inside the run
directory. Before every batch the adapter verifies that every native path it
hands the tool — including atomic-write temp forms — fits the 259-character
budget and fails fast with a `long_path_blocked` error naming the remedies
otherwise. For anything else an external tool rejects, keep paths short; use a
project such as `C:\work\papers`. An optional offline Chrome or Edge profile template is only suitable for the same machine/account, and may require re-login because Windows browsers encrypt cookies. Each slot can be logged in separately instead. Close the source browser before copying; use `--browser edge` for an Edge template, which must not be mixed with Chrome profiles; links and junctions in copied profile data are rejected.

## Worker snapshot paths

The shared JSON/text I/O helpers encode absolute Windows paths with the extended
path prefix at the filesystem boundary, including UNC shares. They do not require
an administrator to enable `LongPathsEnabled`. Snapshot identifiers retain their
relative `results/worker-output-<sha256>.json` form and full digest. Temporary files
use a short random name in the destination directory before atomic replacement;
the destination filename is not repeated in the temporary filename. Extended
prefixes are not written into snapshot identifiers or persisted path contracts.

| Behavior | macOS | Windows |
| --- | --- | --- |
| Shared JSON/text reads and atomic writes | Native paths | Extended local/UNC paths |
| Snapshot identity and digest | Unchanged | Unchanged, forward-slash identifier |
| Containment comparison | Resolved identity | Resolved identity with consistent prefix form |
| Registry changes or mapped-drive workaround | None | None |
| External Chrome/downloader path handling | Tool-dependent | Downloader library cache at a short per-user root; pre-flight `long_path_blocked` budget check; browser tool-dependent |

Do not infer successful Windows execution from portable syntax tests. Run
`tests/integration/precise/test_filesystem.py` with the product Python on Windows,
then exercise a real Desktop search and snapshot pagination in a long session
directory with the normal user's permissions and `LongPathsEnabled=0`. macOS
checks exercise real local file I/O and portable Windows path encoding only.
The existing containment checks remain in place; path encoding is not a new
symlink/junction sandbox or a replacement for filesystem authorization.

Windows-specific tests are included, but only a successful native Windows CI run and real Chrome or Edge download/login checks establish Windows runtime validation. Do not describe macOS-only test results as Windows validation.
