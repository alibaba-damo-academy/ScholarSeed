# Progress protocol

Use one top-level `RUN_DIR/progress.json` for every long stage in interactive and
auto mode. The file is the machine contract; host commentary is the user
interface.

## Host behavior

- Before search, download, PDF reading, or final-report generation, write a
  `running` event with `scripts/progress.py update`.
- Relay each new progress event as a short appended message in the user's
  language. Do not depend on in-place terminal-line updates in Codex App.
- While a child command or delegated agent is running, poll or wait for at most
  20 seconds. If no real event arrived, run `progress.py heartbeat` and relay
  the emitted state. Never leave the user without a progress message for more
  than 20 seconds during a long stage.
- A real event resets the silence timer. Emit action-required, failure,
  cancellation, and completion events immediately.
- At stage start, the host may say once that no user action is currently
  expected. Do not repeat “no action required” or its localized equivalent on
  routine events or heartbeats. Search, reading, and reporting have no
  per-item user-action state; report only their progress facts.
- Only emit a user-action message for a real `action_required` state. Within
  per-paper work, only paper-dl/non-arXiv may produce this state for login,
  CAPTCHA, browser setup, or another detected intervention. Show one concrete
  next action and stop or continue waiting as the workflow requires.
- Use `current/total` only when the stage has an actual task list. If the total
  is unknown, omit it; never invent a denominator or percentage.

Recommended localized shape:

```text
[Search 2/12] Querying PaperHub | 42 seconds elapsed | 18 papers found
[Download 2/10] Downloading title.pdf | 1 completed
[Reading 3/8] Reading title.pdf | 2 completed
[Action required] Complete login in the dedicated Chrome or Edge | Tell me when to continue
```

The bundled renderer intentionally emits compact English lines so any host can
parse and localize them. Do not expose English renderer text unchanged when the
user is speaking another language.

## Commands

Start or update a stage:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/progress.py" --run-dir "$RUN_DIR" update \
  --stage search --activity "Querying PaperHub" --current 2 --total 12 --completed 18
```

Emit a heartbeat only when the last running event is at least 20 seconds old:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/progress.py" --run-dir "$RUN_DIR" heartbeat
```

For an immediate user stop:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/progress.py" --run-dir "$RUN_DIR" update \
  --stage download --activity "Waiting for login" --status action_required \
  --action "Complete login in the dedicated Chrome or Edge, then tell the host to continue."
```

Valid stages are `search`, `download`, `reading`, and `reporting`. Normal
statuses are `running`, `action_required`, `completed`, `failed`, and
`cancelled`. `started_at` is preserved across updates within one stage;
`updated_at`, `elapsed_seconds`, and `sequence` make polling deterministic.
