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

Write `intent.json` conforming to `references/schemas/intent.schema.json` (schema `1.1`). Start with `confirmed: false`; resolve the scope and record `request_clear`, `user_explicit` or `auto_delegated` as specified by [clarification.md](clarification.md) before setting `confirmed: true`.

Always include all 11 required fields, including empty arrays and nullable year bounds. Use `language: null` and `max_results: null` when the user did not specify them; do not invent an English-only condition or a requested paper count. The positive `search-request.max_results` is a separate execution budget (default 20 when unspecified), which must be disclosed as a tool limit and must not exceed an explicit user result limit. Nested search requests validate the same full intent contract.

## Errors

Stop with a clear capability or input error when the request is missing, empty, unreadable, malformed, or the host cannot perform intent drafting. Do not substitute the raw request as a fabricated precise intent.

## Replacement boundary

Retain the clarification gate and JSON contract when replacing the prompt or adding local helpers. Document dependencies here and do not expose a second skill.

## Acceptance checklist

- Follow the entry clarification gate before retrieval.
- Ask only about seriously plausible readings that materially change results.
- For a clear initial request, state the scope and continue; if needed, ask only about concrete retrieval forks and do not reconfirm resolved scope.
- Build `precise_intent` from the original request and explicitly approved facts; in auto mode disclose conservative assumptions without inventing concrete criteria.
- Preserve uncertainty as nulls or empty arrays.
- Distinguish scope resolved from the request, explicit user decisions, and explicitly delegated assumptions.
- Avoid network or credential use unless explicitly documented and authorized.
- Pass contract and smoke tests.
