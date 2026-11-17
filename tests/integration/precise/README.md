<a id="precise-集成测试不在-runall-门禁内"></a>
# precise Integration Tests (Not in the run_all Gate)

This directory is **not registered** in `apps/serve/tests/run_all.py` and is therefore outside the CI gate. There are existing failures in this directory (see below); registering it as-is would keep the gate red. To add it to the gate, first fix these failures and register the suite name in `apps/serve/tests/run_all.py`.

<a id="手动运行"></a>
## Manual Run

All four `PYTHONPATH` entries are required (the last is this directory; without it, imports of same-directory modules such as `browser_pool_support` fail and incorrectly report an otherwise-OK suite as an error):

```bash
SK=skills/community/precise-literature-search
PYTHONPATH="$SK/scripts:$SK/modules/search:$SK/modules/search/tools:tests/integration/precise" \
  python3 -m unittest discover -s tests/integration/precise -p "test_*.py"
```

The standard library alone is sufficient; the repository venv is not required. The suite starts real subprocesses and browser-pool slots and takes about 40–60 seconds in full.

<a id="基线2026-09-28originshushenreleasemvpv02opensource--0623d28e2"></a>
## Baseline (2026-09-28, `origin/shushen_release/mvp_v0.2_open_source` = `0623d28e2`)

71 tests, 5 failures, all pre-existing (the baseline has been consistent across multiple runs since 2026-09-27; see work item 87299389):

- `test_paid_pool_integration`: 4 cases (the old fixtures lack current runtime state, authorization, and product acquisition failure records, so they do not reach the target logic)
- `test_browser_pool::test_released_slot_with_executor_lock_uses_wait_path`: 1 case

<a id="当前分支复核2026-09-30macos"></a>
## Current Branch Recheck (2026-09-30, macOS)

After the paid-download tests switched to fixtures prepared using the current runtime-state and authorization contracts, 4 cases passed. The full suite ran 118 tests in an environment able to read browser process information; only the browser-pool wait-path test above failed, and one test was skipped for the platform. In a restricted sandbox that prohibits calling `ps`, browser-related tests may also fail; do not conflate those results with results from a normal environment.

<a id="历史"></a>
## History

- `test_environment.py` was removed on 2026-09-28 (work item 87299389): the `scripts/environment.py::download_environment()` it tested (a whitelisted env that kept product credentials out of Chrome/downloader subprocesses) was removed in balance refactor `d8e07d813`, but the test was not updated and became a permanently failing dead test.
- The subprocess env-sanitization capability described above is **currently outside** the Skill boundary: downloader/Chrome subprocesses inherit the sandbox's full env. The current controls are sandbox outbound networking and deny-read (proposal 116 P4), plus Serve not injecting bridge credentials into the sandbox. Whether to restore a whitelisted env is a separate security-hardening issue (to be decided in a separate work item); this directory does not assert that behavior for now.
