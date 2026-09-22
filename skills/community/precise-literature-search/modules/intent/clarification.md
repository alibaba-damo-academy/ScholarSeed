# Entry clarification

Use this procedure before retrieval. Keep every user-facing message in the
user's language and never expose internal checks or artifact paths.

If the host identifies an explicit auto, autonomous, unattended, or no-interaction
request, do not ask clarification or confirmation questions. Resolve ambiguity
conservatively from the original request, leave unsupported optional criteria empty
or null, disclose material assumptions in `precise_intent`, set
`schema_version: 1.1`, set `confirmed: true`, and add
`confirmation_source: auto_delegated`. Do not expand the scholarly scope or
invent criteria. Otherwise follow the interactive procedure below.

## Decide whether to ask

Ask only when two or more seriously plausible readings would retrieve
materially different paper sets. Do not ask merely because a request is broad
or could be made more detailed. If a term or named result is not credible or
the request has no resolvable topic, ask the user to confirm or restate it
before continuing.

Check the request in this order:

1. **Sense:** identify query terms with competing domain meanings.
2. **Relations:** preserve bound phrases; clarify whether juxtaposed or
   overlapping topics mean their intersection or separate searches.
3. **Premise:** clarify only recognized, nameable divisions of a field.
4. **Scope and boundary:** establish a retrieval anchor and actively elicit
   exclusions. Accept broad scope when the user chooses it.
5. **Required inputs:** ask for an omitted value only when retrieval cannot
   start without it. Do not ask about search engines or query construction.

Ask one question per turn, choosing the most decisive unresolved fork first.
Describe alternatives neutrally in research terms, without UI pickers. Re-run
all five checks after each answer because resolving one fork may reveal the
next. Re-ask when an answer remains contradictory or does not settle the fork.

Do not assume a conventional value silently. If the user deliberately skips a
question, state the narrowest safe default (or no exclusions for an exclusion
question), wait for approval, and record it as assumed. Do not front-load
choices that can be made only after seeing retrieved clusters.

## Materialize the intent

In interactive mode, exit only after every material fork is answered, explicitly
skipped with an approved default, or absent. Compose `precise_intent` as one self-contained
English statement using only:

- the user's original content;
- facts supplied in clarification replies; and
- defaults the user explicitly approved, marked as assumed where useful.

Preserve bound phrases, exclusions, dates, paper types, languages, and other
specifics the user supplied. Add no representative works, methods, emphases,
or exclusions of your own. Check both directions: nothing user-supplied was
dropped, and nothing unsupported was added.

Fill the remaining `intent.json` fields only from the same supported facts.
Use `null` or empty arrays for unspecified optional values. In particular, include `language: null` and `max_results: null` when the user did not specify a language or result count; keep all 11 required intent fields. The separate search request uses a positive tool budget (default 20), not a fabricated user criterion. In interactive mode,
write the draft with `confirmed: false`, present the precise restatement once, and
wait; only the user's explicit confirmation or correction may then set
`confirmed: true`.
