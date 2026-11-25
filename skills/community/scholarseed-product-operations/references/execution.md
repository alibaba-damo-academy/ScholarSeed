# Execution Environment

**English** · [简体中文](execution.zh.md)

Read before executing local code or installing dependencies, whether for research
computation, data processing, file conversion or software work. This guide owns
environment use, not research methods or permission grants. Do not load search,
library, plan or Bridge workflows unless the actual task also requires them.

## Use the Session Environment

User Python code and dependency installation use the session's cwd-bound venv,
including outside registered projects. Unless the user's current message
explicitly specifies an interpreter or command path to run, use the host-provided
task interpreter in SCHOLARSEED_TASK_PYTHON or the session's python command;
install with that interpreter's `-m pip`, not an unrelated pip executable. A
shell-local `cd` does not switch environments. Inspect only the interpreter/dependency
information needed for the task, not credentials or unrelated configuration.

Never fall back to product Python or change global Python settings when the task
environment is missing or damaged. Report the failing command and actual error,
then stop dependent execution. Do not guess another environment, activate a
different project's venv or silently repair the host.

`scholarseed-skill-python` is reserved for admitted bundled Skill scripts under
their own instructions. It is not an interpreter for arbitrary user code, an
installation target or a substitute for an unavailable task environment.
Do not copy user scripts into bundled Skill directories to gain access to it.

## Execute Within Scope

Use existing dependencies when sufficient. Install only what the authorized task
requires, respecting network and write restrictions; dependency installation is
not permission for a global upgrade or changes to unrelated projects.
Use the actual shell's quoting and argument conventions, treating file paths and
URLs as data. Do not assume POSIX paths or executable layouts on Windows.
Keep inputs intact, respect the supplied working/output directory and avoid
overwriting another session's work. Prefer bounded reads and relevant file/text
search over dumping large files into context; use available tools rather than
requiring an unverified executable.

For text or file search, prefer `rg` or `rg --files` when available; otherwise
use available alternatives. Do not use Python merely to dump large file contents.
For network downloads, dependency installation or long-running parsing commands,
use a generous wait window (e.g., `yield_time_ms` >= 30000, backing off to
60000–120000 while active without new output) instead of tight 1–5 second
`write_stdin` polling loops or prematurely interrupting an active transfer.

Verify the requested result, not only the process exit code. Report incomplete
execution or validation honestly. Follow the [project guide](project.md) for
project changes/tests and the [file-artifacts guide](scholarseed-bridge/guides/artifacts.md)
when delivering generated files. Research methods, evidence interpretation and
business checkpoints remain with the relevant research/task skill.
