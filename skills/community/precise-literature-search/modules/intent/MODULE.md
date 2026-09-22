# Intent module

## Responsibility

Convert one raw request into the stable `intent.json` shape. The host LLM owns ambiguity detection, interactive user questions, restatement, and explicit auto delegation.

Before drafting, read and follow [clarification.md](clarification.md). It is the
authoritative entry gate: in interactive mode ask one material retrieval fork per
turn; in both modes preserve the user's boundaries and never add unsupported
intent details.

## Implementation

Use the host LLM. This module has no command adapter or deterministic fallback: the host applies the clarification gate, writes the draft, and owns interactive confirmation or conservative auto confirmation. `module_runner.py` must fail closed for this host-LLM module.

## Input

Accept UTF-8 request text, or a JSON object with `original_request` or `request`.

## Output

Write `intent.json` conforming to `references/schemas/intent.schema.json`. Interactive mode starts with `schema_version: 1.0` and `confirmed: false`, and only the user's explicit confirmation or correction may set it to `true`. An explicit auto request may write schema `1.1` and set `confirmed: true` with `confirmation_source: auto_delegated` after a conservative interpretation.

Always include all 11 required fields, including empty arrays and nullable year bounds. Use `language: null` and `max_results: null` when the user did not specify them; do not invent an English-only condition or a requested paper count. The positive `search-request.max_results` is a separate execution budget (default 20 when unspecified), which must be disclosed as a tool limit and must not exceed an explicit user result limit. Nested search requests validate the same full intent contract.

## Errors

Stop with a clear capability or input error when the request is missing, empty, unreadable, malformed, or the host cannot perform intent drafting. Do not substitute the raw request as a fabricated precise intent.

## Replacement boundary

Retain the clarification gate and JSON contract when replacing the prompt or adding local helpers. Document dependencies here and do not expose a second skill.

## Acceptance checklist

- Follow the entry clarification gate before retrieval.
- Ask only about seriously plausible readings that materially change results.
- In interactive mode, ask one question per turn and obtain one explicit final confirmation.
- Build `precise_intent` from the original request and explicitly approved facts; in auto mode disclose conservative assumptions without inventing concrete criteria.
- Preserve uncertainty as nulls or empty arrays.
- Keep confirmation under interactive user control or explicit initial auto delegation.
- Avoid network or credential use unless explicitly documented and authorized.
- Pass contract and smoke tests.
