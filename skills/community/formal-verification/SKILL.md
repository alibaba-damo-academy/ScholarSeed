---
name: formal-verification
display_name_zh: 形式化验证
description: Formalize mathematics into three Lean candidates with native selection, draft a proof with the client LLM, and verify it remotely. Start fallback remote search only after explicit confirmation. Supports existing proofs and resumable batch tests.
description_zh: "将数学命题形式化为三个 Lean 候选陈述并通过原生卡片选择，由客户端模型起草证明并远程验证。仅在用户明确确认后启动远程后备搜索。支持校验已有证明与可续跑的批量测试。"
version: "2026.11.11+3"
---

# Mathematical Formal Verification

Convert a mathematical claim into a Lean problem, draft a proof with the client LLM, and verify it on the configured remote ProofServer. No local Lean or ProofServer is required.

**Mathematical claim -> three Lean candidates -> native selection card -> recorded choice -> client LLM draft -> remote verification. If drafting fails or verification explicitly rejects the draft, ask before starting remote proof search.**

## User-facing language boundary

Start with the mathematical work, for example “I’m preparing the Lean statements.” Run login, availability, and capability checks silently; do not announce token presence, “checking readiness,” “checking the service,” or “service is ready,” even before candidate preparation. Surface a failed prerequisite only as its user impact and next action.

Use “I’m looking for a proof” for drafting and “I’m checking the Lean proof” for verification. If another search needs approval, ask “I haven’t found a verified proof. Would you like me to continue searching? This may take roughly 2–120 minutes.” Use neutral wording in the confirmation card as well. Keep the distinction between verification and additional search in the workflow, not in implementation labels shown to the user.

During execution, describe the mathematics, candidate choices, observed progress, results, and actions the user can take, not how the skill is implemented. Do not display client/server roles or their translated equivalents, local/remote execution splits, ProofServer branding, model or worker identities, API/REST operations, endpoints, deployment details, helper commands, or credential plumbing in commentary, candidate explanations, error notices, final answers, or user-facing reports. This boundary also applies when explaining progress or a failure; do not echo raw tool messages or copy internal section headings into conversation.

This prohibition includes headings, parenthetical labels, verification claims, proof explanations, footnotes, and back-translations. Do not write `client`, `server`, `client-side`, `server-side`, `frontend`, or `backend` as execution or explanation attribution, regardless of case, or their translations such as `客户端`, `服务端`, `服务器`, `前端`, and `后端`. Describing a role without naming it, such as "the remote proof service" or "the local explanation component," also exposes implementation details and is forbidden. Keep those distinctions in internal evidence, not in user-visible qualifications.

Use neutral mathematical wording instead:

| Do not display | Use instead, only when supported by the evidence |
| --- | --- |
| `Server-verified` / `通过服务端最终验证` | `The Lean proof passed verification.` / `Lean 证明已通过验证。` |
| `Proof idea (client interpretation)` / `证明思路（客户端解读）` | `Proof idea` / `证明思路` |
| `Remote proof search` / `远程证明搜索` | `Proof search` / `证明搜索` |

Use ordinary phrases such as "Preparing Lean statements," "Awaiting candidate choice," "Searching for a proof," "Checking the proof," and "Preparing your files." For the timed fallback, say "No choice was received in 20 seconds; continuing with recommended candidate N," not that a client or LLM selected it. Preserve the true selection actor and explanation provenance in internal records only.

Review generated reports and explanations before sharing them. If they contain implementation details, keep the originals as internal evidence and provide a plain-language summary with the mathematical results and proof links instead. Do not paste raw result JSON or diagnostic file contents into the conversation.

Before sending each visible message or sharing a narrative report, check the entire prose, including headings and parentheses, for these labels and equivalent implementation descriptions. Rewrite any occurrence into mathematical status, proof steps, verification scope, or an actionable notice; do not repeat the forbidden phrase in an apology or explain the filtering. This is a prose review, not a text replacement over Lean files: preserve exact Lean source, identifiers, user-supplied mathematical content, and required proof/problem links. Never remove a failure or uncertainty to make the wording pass.

Do not hide failures, uncertainty, missing verification, or required login. Translate technical errors into their effect and an actionable next step without inventing a cause. For example: "Formal verification is unavailable (404). Please contact support before trying again." Retain technical diagnostics internally and obey all stopping rules. Complete Lean sources, mathematical identifiers, proof/problem file links, task IDs for recovery, and measured business progress remain available; do not redact or alter Lean code to enforce this prose boundary. Explain verification scope accurately without attributing execution to a component: "The Lean statement was machine-verified; its correspondence with your original claim and this explanation are not independently machine-verified." The technical instructions and references below are for execution, not text to present to the user.

## Directory search boundary

The only directory tree permitted for filesystem discovery is this skill's own directory, rooted at the exact loaded `SKILL.md`. Do not search, scan, or list directories outside that tree to locate files, applications, interpreters, Lean installations, launchers, configurations, credentials, or optional references. This explicitly excludes `/Applications`, `~/Applications`, system directories, the user's home directory, other projects, and other skill installations. Do not traverse parent directories or follow links out of the skill tree to expand a search.

Use the provided skill location and invoke `scholarseed-skill-python` directly. If the launcher, a required skill file, or required access is unavailable, stop and report that formal verification is unavailable. Do not search for a replacement, request permission to search elsewhere, seek elevated access, or bypass host permission controls. Do not perform environment or executable-location probes as a recovery step.

This boundary restricts discovery, not the intended input/output flow: read explicitly supplied input files and saved task files by their exact paths, and create or validate outputs in the assigned `SESSION_DIR`. These operations do not authorize searching their parent or neighboring directories. Use bundled references rather than locating external checkouts; the supporting references must obey this same boundary.

The service URL comes only from `proof_server_url` in this skill's `configure.json` during normal use. The helper is `scripts/proof_client.py` inside this skill and requires only Python standard libraries. Inside ScholarSeed, invoke it through the product launcher `scholarseed-skill-python`, which the client provisions together with its interpreter: call the launcher directly, without environment preflights, dependency installation, or a system-interpreter fallback. Set `PROOF_CLIENT` to the helper's actual absolute path. Use SESSION_DIR for the actual session output location, without changing cwd. For a new run, place the preparation, submission, observation and download directories under its work/; keep each fresh and empty. Return verified final Lean files under SESSION_DIR without overwriting existing files. Resume using the saved locations and task ID, including older layouts.

The remote server's configuration is authoritative for server-side execution, including time limits and attempt limits. Submit the selected mathematics without client execution overrides by default. Send supported business limits only when the user explicitly requests them. Do not discover, select, describe, or expose internal execution details in the skill context or user-facing output.

## Required account token

Before formalization, preparation, selection, or any remote operation, check that
`SCHOLARSEED_ACCOUNT_TOKEN` is set and nonempty in the current process environment.
Never print its value. If missing or blank, tell the user in their conversation
language to log in and invoke this skill again. Use **书深** in Chinese and
**ScholarSeed** in English; do not combine the two names in one notice.
Chinese: "请先登录**书深**，再重新发起形式化验证。"
English: "Please log in to **ScholarSeed**, then invoke formal verification again."
Follow the user's stated language preference, then the conversation language,
then the host locale. The helper uses `LC_ALL`, `LC_MESSAGES`, then `LANG` for its
fallback message (Chinese for `zh` locales, English otherwise); adapt that message
to the conversation language when presenting it. Keep the initial notice focused on login,
without asking the user to configure an environment variable. Exit the skill
immediately and recheck token availability on the next invocation; do not assume
that login has supplied a token until it is present. Do not generate
candidates, make REST calls, submit tasks, retry, or fall back to server credentials.
Do not ask the user to paste the token into chat. An invalid token also stops the
workflow with an actionable message.

The client reads this variable and sends its value as `X-LLM-API-Key` on every REST
request, including observation and artifact downloads. It is the request's LLM
API key. Keep it out of URLs, command arguments, `configure.json`,
manifests, saved requests, logs, reports, and model prompts. The HTTP client blocks
redirects and rejects responses that echo the token. The skill requires the token
even though the server supports a null credential for other clients. Before task
submission or explanation, require `ui-config.capabilities.request_llm_api_key`
to be `true`; if absent or false, tell the user formal verification is unavailable and to contact support, then
exit without starting work. Never silently use a server that ignores the key.

If the user updates the token after the host starts, ensure every subsequent
helper process receives the updated environment value. An environment change in
one process does not update unrelated processes. Use the environment mechanism
available on that host; do not assume a shell, profile path, or home directory.
Check token presence or equality without printing either value, and never copy
the token into command arguments, source code, configuration, or saved evidence.
If the updated value cannot reach the helper process, stop and ask the user to
restart or refresh the application, without exposing environment or token details.

## Interaction and waiting contract

Apply these rules throughout the workflow:

1. For an ordinary natural-language request, display all three complete Lean candidates, identify the recommendation, and call the native user-input tool to present three selectable options. Follow the selection-card contract below: use the 20-second recommended fallback only when the host can expire and close that interaction; otherwise wait for an explicit answer. A user's instruction to pause or require manual selection takes precedence. The explicitly delegated batch-test exception is described below.
2. Adapt explanations, candidate labels, progress, and delivery to the user's conversation language and stated preferences, using the host locale and timezone when needed. Keep Lean syntax and identifiers intact. Account for the host environment: when tool output is hidden, provide visible commentary; when interruptible waiting is available, use it without ending the active turn.
3. Before fallback remote search, explain that it can take roughly 2–120 minutes. Follow a submitted search through its terminal result, proof download, and evidence check, reporting concise business progress every 30–45 seconds. This range is a general expectation, not an ETA or a guaranteed minimum duration.
4. An observation timeout means resume observation of the same task. Keep its task ID, saved request, deployment URL, and idempotency key; do not ask repeatedly whether to continue or create a replacement task. A terminal failure is a completed unsuccessful search and must not be presented as an observation timeout or mathematical disproof.
5. If ProofServer explicitly responds `BUSY` (including a verifier-busy or rate-limit response normalized by the helper), stop this proof workflow immediately. Do not retry discovery, validation, submission, or polling, and do not resubmit the task. Tell the user **"busy"** in their conversation language, with any task ID already obtained. A generic network error, observation timeout, or unclassified service error is not a busy response.
6. If any REST request returns HTTP 404, stop the proof workflow immediately. Do not retry, resume polling, resubmit, or switch to another server. Tell the user formal verification is unavailable (404) and to contact support before trying again; include any task ID already obtained. Preserve local evidence. This rule takes precedence over observation-timeout recovery.

Use remote execution defaults unless the user requests a particular attempt or runtime limit. Omit optional execution-limit fields from the REST payload and batch manifest; do not copy an advertised maximum into the request or substitute a locally chosen default. In particular, do not impose a short search budget merely because the request is a demo or batch test. The 20-second review interval and 45-second observation window are client interaction limits, not proof execution limits; the 2–120-minute expectation is not an instruction to override the server's budget. State any user-requested limits before submission. Examples in this skill do not establish default execution limits.

## Configure the server

Remote servers require HTTPS; HTTP is accepted only for `localhost` or literal loopback IP addresses for local testing. This restriction also applies to explicit URL arguments.

Edit [configure.json](configure.json) in this skill folder to set the `proof_server_url` JSON string. Use the service root (including its mount path) or its full `/webapi/v1` base. The helper finds this file relative to its own installed location, regardless of the working directory. Normal skill commands must use this file without a URL override; there is no built-in URL or environment URL fallback. A missing or invalid file fails before any REST call. The local `prompt`, `prepare`, and `select` steps do not read server configuration. Keep `SCHOLARSEED_ACCOUNT_TOKEN` in the process environment, never in `configure.json` or source. Explicit URL arguments remain for isolated tests and recovery of tasks created on another deployment.

## Choose an entry point

| User input | Action |
| --- | --- |
| Natural-language mathematical claim | Display three candidates and record the native card choice, then draft directly and verify remotely |
| Lean problem containing `sorry` | Preserve the supplied statement, then draft directly and verify remotely |
| Complete Lean proof | Run `verify` to check the existing proof |
| Existing task ID | Query or resume that task using its original input |

Read [client_autoformal_prompt.md](references/client_autoformal_prompt.md) before generating candidates. It bundles mathematical guidance for client formalization and the selection policy below. Do not locate an external ProofServer AutoFormal checkout or run its pipeline or automatic selector; the bundled prompt is sufficient.

Read [formalization.md](references/formalization.md) for statement-preservation guidance and AM-GM, square-root-of-two irrationality, and odd-square examples. Read [workflow.md](references/workflow.md) for the Python callback, API fields, idempotent recovery, or error interpretation.

For batch tests, read [batch_testing.md](references/batch_testing.md) and use `scripts/proof_batch.py`. The user may explicitly delegate candidate selection to the client LLM for tests. This delegation persists for the authorized test scope; do not request it again. Record `selection_actor: llm`, the actual user authorization, and a per-case reason. Ordinary proof requests follow the selection-card contract below.

## 1. Formalize on the client

Identify variable domains, quantifiers, all assumptions, and every requested conclusion. Clarify only ambiguities that change the mathematics. Briefly state inferred conventions. A user-supplied proof outline guides the search; it does not become an additional assumption.

Generate exactly three candidate records using the bundled prompt. Each record contains `title`, `explanation`, and complete UTF-8 `source` with available imports, one named target theorem, and an executable `by sorry` proof obligation. Usually use `import Mathlib`. Candidate 1 should use direct Mathlib-native vocabulary; candidates 2 and 3 should use faithful alternative encodings. Preserve all conclusions and both directions of an equivalence. Save the original claim as `problem.txt` and the JSON response as `candidate-response.json`.

You can render the bundled prompt locally with:

```sh
scholarseed-skill-python "$PROOF_CLIENT" prompt \
  --problem-file /absolute/path/problem.txt
```

Do not use `--autoformal-root` during normal skill execution. That helper option
remains available for isolated integration tests, not external directory discovery.

The host LLM generates the candidates; this command does not call a model or the remote service. Save the generated candidates locally:

```sh
scholarseed-skill-python "$PROOF_CLIENT" prepare \
  --problem-file /absolute/path/problem.txt \
  --candidates-json /absolute/path/candidate-response.json \
  --output "$SESSION_DIR/work/new-preparation"
```

Before offering candidates, check that each preserves the full original claim. Repair candidates that omit a conclusion or change assumptions before presenting the set; a simpler, weaker statement is not an alternative encoding. In particular, every AM-GM candidate must retain the equality condition when requested. This is a client semantic review, not machine verification of natural-language equivalence.

### Candidate selection state: awaiting user choice

For ordinary natural-language proof requests, enter a distinct, user-visible **Awaiting candidate choice** state after preparation and before recording any selection or starting remote work. Present this state and the candidate list directly in the conversation, not only in tool output, saved files, or internal reasoning. Translate the state label into the user's language (for example, **等待选择 Lean 陈述** in Chinese). This is a conversational review state, not a remote task status or a claim that a proof has been verified.

For ordinary proof requests, first give a short plain-language restatement of the claim and its assumptions, then a compact comparison of the three candidates: number, meaning, assumptions or inferred conventions, and representation tradeoff. Translate terms such as `NNReal` into ordinary language, such as "nonnegative real numbers." Mark one candidate **Recommended** and explain the mathematical reason without confidence scores or predictions of provability. All three should express the same claim; say when their differences are only syntactic.

Follow the comparison with each candidate's complete saved source in a separately labeled fenced `lean` code block, including imports, the named theorem, all assumptions and quantifiers, and `by sorry`. Include links to the three Lean files. The comparison and links supplement the exact source; they do not replace it. Explain once that `sorry` marks a proof still to be found.

### Native selection-card contract

After the full sources and recommendation are visible, **call `request_user_input`**, or the live host's equivalent structured user-input tool, to render an actual single-choice card. A prose list, a countdown announcement, Markdown checkboxes, file links, or sleeping for 20 seconds does not create selection controls and does not satisfy this step. Do not build a custom form or use a permission request for this mathematical choice.

Use the tool's declared schema, with one question asking which Lean statement to use and exactly three options, one for each displayed candidate. Preserve the original candidate numbers in the option labels, include a short mathematical description, and mark the actual recommendation. Localize all review prose. For a `request_user_input` schema with `id`, `header`, `question`, and `options`, use a stable question ID such as `lean_candidate`, a short header such as `Lean choice`, and labels such as `Candidate 1 (Recommended)`, `Candidate 2`, and `Candidate 3`; the recommendation may be any candidate. If the tool requires the recommendation first, reorder the options without renumbering candidates. Use only supported fields; never invent a timeout parameter. Read the submitted answer by candidate number, not option position. Preselection alone is not a submitted answer.

In ScholarSeed, `request_user_input` is a blocking question. If its live contract offers no timed expiry, say "Please choose candidate 1, 2, or 3 in the selection card to continue," call the tool, and wait for the answer. Do not promise a 20-second automatic fallback, launch a parallel sleep, or continue proof search while the card is unanswered. An empty, dismissed, cancelled, or failed response is not a timeout and does not authorize the recommendation. Cancellation ends the workflow; otherwise keep selection unresolved and ask for an explicit choice. If the native input tool is unavailable, report that selection controls are unavailable and ask for an explicit numbered reply; remain awaiting choice without automatic submission. Do not claim that buttons were displayed.

Only when the live host explicitly supports timed expiry and closing the choice interaction may the default 20-second fallback apply. State "I'll wait 20 seconds for your choice; if you don't choose, I'll continue with recommended candidate N." Start the interval only after all three complete sources, the recommendation, and the real selection card are visible. Require an actual full 20-second interval and a confirmed expired/closed interaction with no submitted answer before using the recommendation. A tool timeout, unrelated wait timeout, or silence in conversation is not this confirmation. Record `selection_actor: llm`, cite this policy in `authorization`, and include the recommendation rationale, elapsed review interval, and interaction-expiry evidence in `reason`. Never leave an actionable selection card pending after automatic selection.

An explicit choice takes precedence. Also accept "Use recommended," "Choose 1, 2, or 3," "Change assumptions," or "Wait longer" through supported input. "Use recommended" is an explicit user choice of the labeled recommendation. Stop or pause on requests to stop, wait longer, revise the mathematics, or require manual selection; do not apply the fallback while one is pending. Resolve or cancel the old card through supported host controls before replacing it after revisions; display the new complete set and open a fresh selection card. The helper records the chosen source and its hashes; the host owns the interaction. Explicitly delegated tests may save and review all three sources and record the authorized LLM choice without a card or review interval.

After the user chooses, record exactly that choice. The example below is appropriate only when the user selected candidate 2:

```sh
scholarseed-skill-python "$PROOF_CLIENT" select \
  --preparation "$SESSION_DIR/work/new-preparation" --candidate 2
```

For a supported, confirmed timed expiry, use `select --selection-actor llm --authorization ... --reason ...` with the actual recommended candidate ID and the policy record described above. Never label the timed fallback as `selection_actor: user`. Do not call `select`, `submit-selected`, `submit`, or `run` while the selection remains unresolved. Client preparation makes no REST calls.

Leave **Awaiting candidate choice** only after an explicit choice or the permitted timed fallback has been recorded. Before submission, visibly state **Selected candidate N** and whether this follows the user's choice or no choice being received within 20 seconds, using the user-facing language boundary above. Keep the review state open when the user requests more time or manual selection; revised mathematics returns to preparation and a fresh candidate review. Cancellation ends the workflow without submission. Existing Lean inputs, task resumptions, and explicitly delegated batch tests retain their entry-point rules rather than opening an unnecessary candidate review.

Selection binds the original problem, candidate manifest, and selected source by SHA-256. Edits require a new candidate set, displayed sources, recommendation, and selection card under the same contract; any supported timed interval starts again after the new card is visible.

Preserve the mathematical statement: do not add axioms, strengthen assumptions, remove boundary conditions, or weaken conclusions to obtain acceptance. A file containing `sorry` is a problem awaiting proof; input validation or type checking alone cannot establish that it is proved. Always submit `input_type: lean` in this workflow. Formalization happens on the client.

Use the selected deployment's Lean and library environment. This workflow does not require local Lean; do not search for or probe a local installation, or install or upgrade toolchains or dependencies during execution.

## 2. Draft directly and verify remotely

After selection, follow [direct.md](references/direct.md). Announce that you are drafting a proof before any remote search. Save the original selected source as `problem.lean` and any complete client draft as `proof.lean` in the task output. Check that the selected declaration and its meaning are unchanged. Do not run Lean, Lake, a local ProofServer, or another model service.

Allow at most **10 minutes of wall-clock time** for direct drafting, starting when the first proof attempt begins after selection. Record the deadline using the host clock; it includes all drafting attempts and does not reset on retries. Use a host-enforced deadline if available; otherwise check elapsed time between attempts and before sending a draft for verification. Do not claim that an in-flight model call can be interrupted when the host cannot do so. If no complete draft is ready by the deadline, stop drafting and treat it as a drafting failure. Say “I didn’t find a proof within 10 minutes,” then ask for explicit confirmation before further search. Candidate preparation, selection, verification, and fallback search are outside this deadline.

Use the configured server, enforcing the existing token and capability checks via `discover`, then run:

```sh
scholarseed-skill-python "$PROOF_CLIENT" verify /absolute/path/proof.lean
```

Save the returned classification and diagnostics privately. Deliver the local files as verified only on `verification_status: accepted` and `accepted: true`, after reviewing statement preservation. Do not create a search task or invent a task ID or downloaded artifacts. Follow the existing language boundary.

If drafting fails or the helper returns `verification_status: rejected` or `verification_status: inconclusive` for a client draft, explain the observed outcome and ask whether to start remote proof search for the unchanged selected Lean statement with its proof gap, not the draft. Include the general 2–120-minute expectation. Use the native user-input tool if available; otherwise ask in conversation. Wait for explicit affirmative confirmation and retain it with the task evidence. Candidate selection, timed expiry, preselection, silence and permission to verify are not permission to search. If declined or unanswered, do not submit.

An `inconclusive` verdict means verification is incomplete, not that the proof was rejected. A transport or service error without a verifier verdict is not eligible for fallback; report the service problem. An exit code of 2 or `accepted: false` alone is insufficient. Existing BUSY and HTTP 404 stop rules still apply. Existing remote tasks are resumed unchanged; complete user-supplied proofs go straight to remote verification.

### Remote fallback after explicit confirmation

Use only the recorded candidate for prose requests. For supplied Lean, use `submit` on the unchanged source instead of `submit-selected`.

```sh
scholarseed-skill-python "$PROOF_CLIENT" discover
```

Read service availability, supported business capabilities, and allowed business-limit ranges. These advertised ranges are validation bounds, not defaults to send back to the server. Leave execution limits omitted unless the user requests an override. Do not invent confidence scores or time estimates.

Prefer submission followed by bounded observation so you can report progress:

```sh
scholarseed-skill-python "$PROOF_CLIENT" submit-selected \
  --preparation "$SESSION_DIR/work/new-preparation" \
  --output "$SESSION_DIR/work/new-submission"
```

The helper requires a saved selection, rejects changed source, discovers capabilities, validates input, and submits exactly the chosen Lean candidate. The output directory must be empty. Omit `--rounds` and `--max-runtime-seconds` to use deployment defaults; add them only for the user's requested business limits. Retain `task_id` and `output_dir`. Add `--explain` for an optional server-generated explanation.

When advertised, the helper first calls `/lean-preflights`, which elaborates the statement with `sorry` allowed and never verifies a proof. Keep `preflight.json` diagnostics. Use `--preflight required` to stop if the deployment lacks this capability; the default `auto` records unsupported preflight on older servers and continues with request validation. Never describe shallow validation as Lean compilation. Optional `--max-runtime-seconds` requires advertised task-budget support. Runtime excludes task queue time.

```sh
scholarseed-skill-python "$PROOF_CLIENT" watch TASK_ID \
  --wait-seconds 45 --poll-seconds 3 \
  --output "$SESSION_DIR/work/new-observation"
```

Replace `TASK_ID` with the actual ID and use a fresh empty directory for each observation. A wait timeout ends only the current observation: inspect the latest snapshot, report progress, and continue observing the same task within the agreed test or execution budget. Choose wait durations compatible with the host's communication interval. Client stages are interpretation, formalization, and candidate selection; remote stages are queueing, proof search, and verification.

### Long-running proofs and user-facing progress

Use the user's current conversation language and stated language preference for candidate explanations, progress, errors, and final delivery. If neither is clear, use the host's user locale. Do not hard-code Chinese or English, and keep Lean code and identifiers unchanged.

At the start of remote work, briefly set expectations: proof tasks can take roughly 2–120 minutes, depending on the problem and service availability. This is a general workflow expectation, not a task-specific estimate or a promise. Use actual reported progress afterward. It does not authorize increasing the deployment's attempt or runtime budget.

Use a simple stage sequence: understanding the claim → choosing a formulation → waiting in the queue, when applicable → searching for a proof → checking the proof → preparing files. Report only the actual current stage; a stage list is not a measured completion percentage. Show the task ID once when submission succeeds so work can be resumed. Avoid making the user interpret stage codes or repeatedly copying long task IDs.

Prefer one compact progress line: **current stage · elapsed time · completed attempts · available action**. Omit unavailable timings or counts rather than estimating them, and identify stale observations. For example, when supported by actual measurements: "Searching for a proof · 3 min elapsed · 4 attempts completed · You can ask for an explanation or cancel." Mention actions at submission and when they become relevant, rather than repeating the full action list in every update. Keep worker identities, model names, strategy scores, and internal traces out of routine progress.

Support "Explain progress," "Cancel," and "Resume task" in ordinary conversation. Explain progress using the last confirmed stage without changing the task. On cancellation, use `cancel` and report the returned state; do not claim the task has stopped until confirmed. Resume means observing the saved task on its original deployment, or completing its downloads if finished, using its retained task ID and evidence. It does not restart a cancelled or unsuccessful search. Preserve the BUSY and HTTP 404 stopping rules; no automatic retry follows either response.

Tool output may be hidden in Codex. Translate the helper's progress events into concise visible commentary. Announce any explicitly requested attempt or runtime limit. Report meaningful stage changes and new completed-attempt counts promptly, combining nearby events into one update. During quiet waits, provide a short update about every 30–45 seconds, within the host's communication limits. Use bounded observation windows of no more than 45 seconds so new user input can be handled promptly. Summarize unchanged state in one sentence; do not repeatedly say that a timeout or an unchanged count is an error.

Show only business progress: task status, completed search attempts, and reported elapsed/search/verification/remaining time. Translate `find_proof`, `verdict`, `success`, and `failure` into the user's language. Prefer readable minutes and seconds for long durations. A successful search attempt is provisional until final verification. Unknown counts or timings remain unknown. Remaining budget is not an ETA; omit it from routine updates unless useful to explain an approaching limit. Do not invent percentages or completion forecasts. If polling fails for a reason other than HTTP 404, say that the last confirmed state is stale and observe the same task without duplicate submission.

An observation timeout ends only that observation window. Continue watching the same task automatically within its existing budget; do not repeatedly ask whether to continue, abandon the task after one or two windows, or start another task because the search is slow. Continue through artifact download and evidence checks before declaring success. If the user asks another question or requests a skill change during a search, handle it while retaining the task ID and resume observation unless the user cancels or replaces the proof request. Honor explicit cancellation through the helper. A terminal failure or exhausted task budget is a stopping condition: report the result and retained evidence, without silently resubmitting or increasing limits.

Do not load raw server snapshots, logs, discovery schemas, or internal diagnostics into the conversation. The helper retains raw evidence locally and emits a neutral business summary. Keep proof bodies out of routine status updates; display the final downloaded proof when relevant. `progress.jsonl` contains the neutral progress history.

The low-level `submit` and `run` commands must not bypass direct drafting or explicit remote-search confirmation, nor the recorded selection for natural-language requests.

## 3. Interpret and deliver results

The helper writes JSON results to standard output and progress to standard error. Exit code `2` means rejection or missing acceptance evidence; `3` means a wait timeout. `BUSY` or HTTP 404 exits with code `1`; report the condition and stop the proof workflow without another request. Read the JSON, task ID, and saved evidence even when the command exits with these codes.

| Result fields | User-facing interpretation |
| --- | --- |
| `accepted: true`, `outcome: prove` | The submitted Lean claim was proved |
| `accepted: true`, `outcome: disprove` | The formalized negation was verified; show the actual declaration |
| `accepted: false` or task still running | No final verified result; explain the current state and diagnostics |

The helper checks the deployed response contract before accepting a result. Encapsulated responses must explicitly report successful final verification and a proved or disproved outcome. Legacy responses must contain complete final verification evidence; missing evidence stays unverified. A successful search attempt, file existence, or task status alone does not establish a proof. Remote verification is the server's attestation, not a local Lean run. Search failure and timeout do not establish mathematical falsity.

Final delivery requires the server's final verification attestation and the downloaded `problem.lean` and `proof.lean`. Check artifact hashes and run identity against server evidence when available. The helper retains the downloads and returns absolute `problem_path` / `proof_path`; a missing or changed required artifact makes delivery incomplete. Review the Lean statement's correspondence with the user's prose. A local text or Lean audit is **not required** and must not be a gate for accepting a server-verified proof. The optional `audit_delivery` helper may be used for extra diagnostics when requested, but its conservative parser can reject valid Lean encodings and does not override the server verdict.

Begin final delivery with a compact result summary: **outcome**, the exact claim and assumptions in plain language, a brief explanation when supported by the actual proof, clickable proof and problem files, and a useful next action. Then include the task ID, available attempt counts and timings, and relevant business diagnostics. Report only observed information; keep technical evidence and implementation metadata internal under the user-facing language boundary.

For a verified result, use neutral headings such as **Verified**, **Claim**, **Proof idea**, and **Files**; in Chinese use **已验证**, **命题**, **证明思路**, and **证明文件**. Do not append execution or explanation attribution to any heading. Use these wording patterns only after the verification and delivery requirements above are satisfied:

- English: "**Verified**: The selected Lean statement has a proof that passed Lean verification." Explain the actual proof under **Proof idea**, then link its files.
- Chinese: "**已验证**：所选 Lean 命题的证明已通过 Lean 验证。" 在 **证明思路** 下解释实际证明步骤，再提供文件链接。

State the scope without component names: "Verification applies to the Lean statement; its correspondence with the original wording and the explanation are not independently machine-verified." / "验证针对 Lean 命题；它与原始表述的对应关系及证明解读未经独立机器验证。" Apply the pre-send prose check to the complete final answer and every shared report, including explanations returned in artifacts; never copy an internal verification or provenance label into the result.

Use precise outcomes and next actions:

| Situation | Result summary and next action |
| --- | --- |
| Final verification attested and required files delivered | **Verified**: state whether the claim or its formalized negation was proved; for a negation, show the actual declaration. Link the proof and offer to explain it. |
| Search ended unsuccessfully or its budget was exhausted | **Search ended without a proof**: retain the claim, task ID, and evidence; suggest reviewing assumptions or requesting another search. Do not claim mathematical falsity or resubmit automatically. |
| Service or verifier unavailable | **Formal verification unavailable**, or **busy** for explicit BUSY: state the last confirmed status and the concrete recovery step without component details. For HTTP 404, include the code and ask the user to contact support before trying again; stop without retries or server switching. |
| Search still running or observation temporarily interrupted | **In progress** or **Status temporarily unavailable**: state the last confirmed stage and continue observation of the same task under the existing recovery rules. |
| Final evidence or required files missing or changed | **Verification or delivery incomplete**: identify what is missing and the permitted recovery step; do not present a fully delivered verified result. |
| Cancellation confirmed | **Cancelled**: retain the task ID and evidence; explain that another search would require a new task. |

Keep the explanation distinct from the verification evidence. Record its generation source internally, without displaying client/server attribution. Explain that machine verification applies to the Lean statement, not independently to its correspondence with the original prose or a natural-language explanation or back-translation. SHA-256 values check file integrity; do not call them proof certificates or evidence of mathematical correctness.

Always include the clickable `proof.lean` link in the final answer after successful delivery. Do not stop at reporting verification status or saying that files were downloaded. Link the batch report when useful.

Wait while an optional explanation stage is still running. If it fails, retain the accepted Lean proof and state that the explanation could not be completed, without component details. You may instead explain the actual Lean proof yourself, labeling it an explanatory summary rather than a machine-verified explanation; record its provenance internally.

## 4. Existing proofs and task operations

Invoke these subcommands through `scholarseed-skill-python "$PROOF_CLIENT"`:

| Operation | Subcommand |
| --- | --- |
| Check a complete proof | `verify /absolute/path/proof.lean` |
| Inspect an existing task | `status TASK_ID` |
| Download existing artifacts | `download TASK_ID --output "$SESSION_DIR/work/new-download"` |
| Cancel when requested | `cancel TASK_ID` |
| Explain an accepted proof | `explain TASK_ID`, followed by `watch` |

For a lost submission response, recover with the saved `request.json` and original idempotency key in `submission.json`; see [workflow.md](references/workflow.md). Changed submission content or limits require a new task and key. Requests containing retired execution overrides must be migrated explicitly, rather than silently rewritten during recovery. Preserve the reviewed mathematical claim when rerunning. Do not resubmit indefinitely or automatically expand the user's budget.

Keep credentials out of source, command arguments, configuration files, and saved evidence. For a task created on another deployment, use the base URL saved in its `submission.json` when observing or recovering it. Preserve diagnostics for HTTP errors, proxy HTML, and unavailable verifiers, and distinguish transport status from mathematical verification status.
