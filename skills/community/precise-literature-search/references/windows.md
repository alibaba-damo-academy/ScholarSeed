# Native Windows execution

Target Windows 10+ x64 with Python 3.11+ and Chrome. The scripts use the same arguments and JSON contracts on both platforms; use `scholarseed-skill-python` and the [product Python contract](../SKILL.md#product-python), not a host `python3` or `py` command. The default downloader runs the active product `python.exe` with `-m paper_dl`. `.venv/Scripts/paper-dl.exe` belongs only to an explicitly user-selected `PAPER_DL_ROOT`, not default runtime discovery.

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

Use `config/paid-download.ps1` when dot-sourcing local scripts is permitted by the user's existing PowerShell policy. Do not change execution policy for this workflow. Chrome is discovered in LOCALAPPDATA, PROGRAMFILES, and PROGRAMFILES(X86); set `PAPER_DL_CHROME_EXECUTABLE` to an absolute `.exe` path if needed.

All skill copies share one browser pool. Its root stays outside run directories and should be on local NTFS. Owned profile directories use private inheritable Windows ACLs for data newly created or copied by these tools. Manually migrated profiles must already have private permissions; prefer fresh profiles or `create-template`, since existing child files can retain explicit ACLs. A paused lease retains its browser after the caller exits; resume the same run, or use `scripts/browser_pool.py abandon --run-dir ...` after the adapter stops. Hard cancellation or a host without a console can require explicit abandon. Job/process ownership failures retain the slot instead of killing guessed PIDs.

Keep paths short when external tools reject long paths; use a project such as `C:\work\papers`. An optional offline Chrome profile template is only suitable for the same machine/account, and may require re-login because Windows Chrome encrypts cookies. Each slot can be logged in separately instead. Close the source Chrome before copying; links and junctions in copied profile data are rejected.

Windows-specific tests are included, but only a successful native Windows CI run and real Chrome download/login checks establish Windows runtime validation. Do not describe macOS-only test results as Windows validation.
