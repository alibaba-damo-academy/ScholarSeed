# Resumable batch tests

For each new proof case, follow the direct drafting and remote verification flow
in SKILL.md. Do not submit a search for a verified draft. Obtain explicit user
confirmation covering drafting failures and rejected or inconclusive verifier verdicts before adding them to the
remote search manifest. Candidate-selection delegation does not authorize
remote search. Existing tasks resume unchanged.

Check `SCHOLARSEED_ACCOUNT_TOKEN` before preparing or resuming a batch. If missing or blank, tell the user to log in and rerun the skill, then exit without remote calls. Follow SKILL.md's language policy: use **书深** in Chinese and **ScholarSeed** in English, without combining both names. Recheck token availability on the next invocation. The token travels only in the HTTP header and must never enter the manifest, saved requests, progress, or reports.

Formalization stays in the client LLM. Prepare exactly three complete Lean candidates per problem with `proof_client.py prepare`. Do not send natural-language inputs to the server AutoFormal pipeline. Keep mathematical statement review separate from kernel verification.

For an ordinary proof request, show all three full Lean sources and open the native selection card under [SKILL.md's contract](../SKILL.md#native-selection-card-contract). Wait for an explicit answer when the tool has no timed expiry; a 20-second recommended fallback requires host-supported, confirmed interaction expiry and is recorded as an LLM choice. For tests where the user explicitly delegates selection, skip the card and interval and record the user's actual authorization and the client's reason for the selected encoding. Never manufacture a user delegation string or label an LLM choice as a human choice.

Example local manifest (paths are relative to this manifest unless absolute):

```json
{
  "delegated_selection_authorization": "Replace with the actual user's delegation for this test",
  "options": {
    "preflight": "required"
  },
  "cases": [
    {
      "id": "compact_image",
      "tier": "library",
      "preparation": "prepared/compact_image",
      "candidate": 1,
      "reason": "Uses the native compactness predicate with the exact hypotheses",
      "expected": "prove"
    }
  ]
}
```

If human selections already exist, omit `candidate`, `reason`, and the top-level delegation. Every preparation must have a valid saved `selection.json`. This example deliberately omits attempt and runtime limits so the remote execution defaults apply. A demo or batch request does not imply a short proof-search budget. Add `rounds` or `max_runtime_seconds` only when the user requests those business limits, and announce them before submitting. Explain the general 2–120-minute expectation in the user's language; neither that range nor a 45-second observation window changes the remote task budget. Older deployments may lack preflight or task budgets: discover first; omit unsupported optional budgets and explicitly set `preflight: auto` only when proceeding with shallow validation is appropriate. Do not claim that unsupported preflight ran.

Run one bounded observation window:

```sh
scholarseed-skill-python /absolute/path/formal-verification/scripts/proof_batch.py \
  /absolute/path/batch-manifest.json --output /absolute/path/new-batch \
  --concurrency 4 --wait-seconds 45 --poll-seconds 3
```

Continue with the same manifest, deployment and output directory plus `--resume`. Exit 3 means the observation window ended; remote tasks may still run. The runner saves task IDs and exact idempotency keys before moving on. A lost submission response can be replayed with the saved payload/key; finished failures are not silently resubmitted. New problems, repairs, or changed budgets need a new run. Keep earlier failures as evidence. A client observation timeout does not expand the server runtime allowance or cancel tasks.

Each case gets raw request, selection, preflight diagnostics, progress, task snapshot and downloaded delivery files. Interrupted downloads are retained; a later collection uses another delivery directory. `batch.json` is resumable state and `report.md` links every delivered proof/problem. Summarize active cases, completed/verified counts, the latest business stage and completed-attempt count and observation failures in visible Codex commentary about every 30-45 seconds. Do not paste every raw polling event or claim an ETA from budget remaining.

Before sharing a batch report or explanation, apply SKILL.md's user-facing language boundary and pre-send prose check to its headings, parentheses, and body. Keep raw provenance and execution diagnostics internal; if the generated report contains them, share a neutral summary with the verified outcomes and proof/problem links instead. Do not relabel an incomplete or failed case as verified while rewriting its prose.

Keep an interrupted batch active and resume it without another confirmation. Handle intervening questions or skill edits while retaining its task IDs, then resume observation unless the user cancels or replaces the proof request. Preserve terminal failures as results rather than silently submitting replacements. Distinguish declaration rejection, unsuccessful search, observation/transport problems, and incomplete proof delivery in the final report.

Expected outcomes:

- `prove`: independently accepted proof plus complete, integrity-checked artifact delivery.
- `disprove`: independently accepted proof of the exact supplied negation plus complete, integrity-checked artifact delivery. A false claim needs a paired `<name>_disprove` declaration in all reviewed candidates.
- `reject_preflight`: statement rejected before any proof-search task. A preflight outage is an infrastructure error, not a successful negative sample.

Track these outcomes separately. Report success per tier, completed-attempt counts and reported timing. Attempt counts do not predict the remaining work. Automatic repairs are disabled, so repair success rate is unmeasured until separately labeled repair attempts are run.

Use a layered sample set, for example:

| Tier | Suggested undergraduate samples | Expected outcome |
| --- | --- | --- |
| Library | Lagrange's theorem; continuous image of a compact set; irreducible polynomials divide a product | Prove |
| Composition | Kernel normality through group operations; injective iff surjective on a finite set; boundedness from convergence; rank-nullity with an explicit finite-dimensional hypothesis | Prove |
| Boundary | A continuous real function need not have a root without a sign-change condition | Disprove the explicit paired negation |
| Negative elaboration | An undefined predicate; a real variable incorrectly used as a polynomial | Reject preflight |

This yields ten cases. The client LLM must generate and review three faithful encodings for each; these are problem specifications, not prevalidated Lean files. Keep standard-library controls separate from remote proof generations and do not count previously generated proofs as newly generated successes.
