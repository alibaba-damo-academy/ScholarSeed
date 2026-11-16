# ProofServer client workflow

This reference describes internal execution only. Apply the [user-facing language boundary](../SKILL.md#user-facing-language-boundary) to every conversational update and report; do not display client/server roles or implementation details.

Apply the [directory search boundary](../SKILL.md#directory-search-boundary) to all resource discovery: search only inside this skill directory, never request expanded search access, and stop if the provided launcher or a required resource is unavailable.

## Required credential

All entry points require a nonempty `SCHOLARSEED_ACCOUNT_TOKEN` in the current process environment. If absent or blank, tell the user to log in and rerun the skill, then exit before formalization, file preparation, or any REST call. Follow SKILL.md's language policy: use **书深** in Chinese ("请先登录**书深**，再重新发起形式化验证。") and **ScholarSeed** in English ("Please log in to **ScholarSeed**, then invoke formal verification again."). Do not combine both names or ask the user to configure an environment variable in this initial notice. Recheck token availability on the next invocation. Never request the token in chat. The helper sends it only as the `X-LLM-API-Key` header; it never writes it into saved payloads.

When the user changes the token after the host starts, ensure each helper
process inherits the updated value. An environment change in one process does
not update unrelated processes. Use the host's available environment mechanism
without assuming a shell or profile path. Check equality or presence without
printing the token. This applies to submission, observation, and artifact
download alike.

## Client responsibilities

The host LLM generates exactly three complete Lean candidates locally. Display each complete source in a labeled Lean block, explain the differences, and label one recommendation. Preserve the claim, assumptions, and quantifiers. Then call the native `request_user_input` tool with one single-choice question and three candidate options, following [SKILL.md's selection-card contract](../SKILL.md#native-selection-card-contract). Prose choices or a sleep do not create a card. ScholarSeed's blocking question waits for an explicit answer when its live contract has no timed expiry; do not promise or simulate a 20-second fallback. Only a host-supported, confirmed expired/closed card permits the policy's timed fallback, recorded as `selection_actor: llm` with authorization and expiry evidence. An explicit user choice takes precedence and is recorded as `selection_actor: user`. Explicitly delegated tests can skip the card and interval. Preparation and selection make no REST calls.

Use the bundled [formalization prompt](client_autoformal_prompt.md). Do not locate external AutoFormal references or execute or import the server pipeline. The installed skill is self-contained.

Follow SKILL.md's presentation contract: check semantic completeness before offering candidates, put a plain-language comparison before the complete Lean blocks, and accept "Use recommended," "Change assumptions," or "Wait longer" alongside numbered choices. Changes to assumptions require a new candidate set and a fresh selection card. Any supported timer starts only after the full sources, recommendation, and card are visible; never submit while the card remains unresolved.

## Python integration

```python
from proof_client import prove_problem, confirm_candidate, submit_selected

prepared = prove_problem(
    original_claim, formalize=host_llm_callback,
    output_dir="/absolute/path/new-preparation",
)
# Display all three saved Lean sources and call the host's native selection tool.
# Execute this example only after the user has selected candidate 2.
confirm_candidate(prepared["preparation_dir"], 2)
# Only after direct drafting fails or verification returns rejected or inconclusive, and the user explicitly confirms search.
submitted = submit_selected(
    prepared["preparation_dir"],
    output_dir="/absolute/path/new-submission",
)
```

The synchronous callback returns a list of exactly three `{title, explanation, source}` objects, or an object containing that list under `candidates`. Each source contains imports, a named theorem, and an executable `by sorry`. `prove_problem` only prepares files and returns `awaiting_user_selection`; it does not render buttons or call the native input tool. The host must open the selection card and consume its submitted answer before confirmation. A supported timed fallback uses `confirm_candidate(..., selection_actor="llm", authorization=policy_reference, reason=review_record)` with the actual recommendation, policy citation, rationale, elapsed interval, and confirmed interaction expiry. Selection hashes bind the problem, manifest, and candidate source; changing them requires a fresh review under the same policy.

The remote server's configuration controls execution. The client sends the selected Lean and omits attempt/runtime limits unless the user requests them. Do not impose a short execution cap for a demo, interpret an observation window as a task deadline, inspect internal settings, or introduce execution overrides. `submit_selected` returns immediately by default; use bounded observations of the returned task ID. `run_lean` is also available for user-supplied Lean and must not bypass candidate selection for prose input.

An explicit server `BUSY` response stops this skill run immediately. The helper also normalizes `VERIFIER_BUSY` and HTTP 429 to `BUSY`; show "busy" to the user and do not retry the failed request or start another task. Observation timeouts and generic service errors are separate conditions.

HTTP 404 from any REST request also stops the skill run immediately, including discovery, submission, task observation, and artifact download. Tell the user formal verification is unavailable (404) and to contact support before trying again, with any known task ID; keep technical diagnostics in local evidence. Do not retry, resume polling, resubmit, or switch deployments. This overrides the ordinary observation-timeout recovery rule.

## URL and authentication

[configure.json](../configure.json) contains `proof_server_url`. Accept the service root including any mount path, or its full `/webapi/v1` base. Normal skill execution reads this file; no URL is built into the client and there is no environment URL fallback. A missing or invalid configuration fails before any REST call. Explicit URL arguments are for isolated tests and original-deployment task recovery. Keep `SCHOLARSEED_ACCOUNT_TOKEN` in the process environment, never in configuration files.

## REST operations

| Operation | Endpoint |
| --- | --- |
| Availability and business capabilities | `GET /health`, `GET /ui-config` |
| Check request | `POST /task-validations` |
| Elaborate statement, allowing proof gaps | `POST /lean-preflights` |
| Create Lean proof task | `POST /tasks` |
| Observe task | `GET /tasks/{id}` |
| Download problem and accepted proof | `GET /tasks/{id}/artifacts`, then named artifact paths |
| Bind delivery to a completed run | `GET /tasks/{id}/evidence` when supported |
| Verify a supplied complete proof | `POST /lean-verdicts` |
| Cancel when requested | `POST /tasks/{id}/cancellations` |

Lean submissions use `source`, a `.lean` basename, and `input_type: lean`. Optional `informal_statement` records the original claim. Omit attempt limits to use deployment defaults; a supplied `rounds` is an attempt limit, not a guarantee of success. Use only advertised business capabilities. Statement elaboration with proof gaps is not proof verification. A rejected statement, unavailable service, and unsuccessful search are distinct outcomes.

## Observation and delivery

Use the user's current conversation language and stated language preference, falling back to the host user locale. Set the general expectation that proof tasks can take roughly 2–120 minutes, without promising a completion time or expanding the task budget. Emit concise commentary using status, completed attempts, ordinary-language stage descriptions, and reported timings; show the task ID once at submission. Keep raw snapshots and diagnostics in local evidence files rather than loading them into the conversation. Observe in windows no longer than 45 seconds and provide brief updates about every 30–45 seconds or at meaningful changes. A wait timeout ends observation only. Automatically continue the same task within its existing budget unless a REST request returned 404; do not ask the user to approve each window, cancel, or resubmit because a proof is slow. Retain the task when responding to intervening user requests. Remaining runtime is not an ETA. Terminal failure, cancellation, or exhausted budget ends observation; do not silently retry or raise limits.

Acceptance requires complete evidence for the response contract. Encapsulated responses explicitly attest final verification with a proved or disproved outcome. Legacy evidence is checked internally and is never displayed as implementation metadata. The host still reviews correspondence between the downloaded Lean statement and the original prose. A local text or Lean audit is optional, not an acceptance gate.

Use SKILL.md's compact progress format and result-summary outcomes. "Explain progress" uses the latest confirmed stage; "Cancel" calls the cancellation operation and reports the returned state. "Resume task" observes the original task or completes its delivery, rather than creating another search. A cancelled or unsuccessful task is not restarted by resuming observation. BUSY and HTTP 404 still stop the current workflow without automatic retries.

Download the actual `problem.lean` and `proof.lean` and verify their hashes and run identity against server evidence where available. A missing or changed required artifact makes delivery incomplete. Always link the downloaded proof in a successful final answer. Remote attestation does not mean the client ran Lean locally.

Lead delivery with the outcome, exact claim and assumptions, a short supported explanation, proof/problem links, and a useful next action; put business task metadata afterward. Keep explanation provenance internal. Distinguish machine verification of the Lean statement from its correspondence with the prose and from explanatory summaries, without attributing execution to a client or server. SHA-256 checks file integrity and is not a proof certificate. Search failure does not establish falsity, and service unavailability does not establish a mathematical outcome.

Use SKILL.md's neutral final-answer wording and pre-send prose check. Headings and parenthetical notes are user-facing too: use "Proof idea" / "证明思路" without provenance qualifiers and describe successful verification without identifying an execution component. Review explanation artifacts before quoting them; preserve unsupported or failed verification as such rather than hiding it. These internal workflow terms are not delivery labels.

## Idempotent recovery

Retain `request.json`, `submission.json`, task ID and original deployment URL. Recover a lost creation response with the identical request and original idempotency key. Never change a saved payload while reusing its key. A request with retired execution overrides requires explicit migration to a new submission; do not silently rewrite it. Changed mathematics or limits require a new task and key. Finished failures are not automatically resubmitted. Some deployments may report an idempotency conflict after their configuration changes even for an identical replay. Retain the original key and evidence, report the conflict, and locate the original task before considering a new submission; a fresh key could duplicate work.

Use fresh empty output directories. Preserve interrupted delivery files and collect again in a new directory. The CLI emits neutral JSON on stdout and progress on stderr; exit 2 means rejection or incomplete acceptance evidence, and exit 3 means the observation window ended. Neither exit proves mathematical falsity.
