# Design evidence and tooling

## Scope / Non-goals

Public contributors must be able to implement and review UI without an internal design service.
Use confirmed public requirements, the [Public design contract](foundations.md),
[foundations](foundations.md), [components](components.md) and the actual component registry.

## Source of truth

The public [Engineering guide](components.md) owns discovery
and the relevant implementation workflow. An externally supplied design is additional evidence,
not permission to change business requirements or weaken accessibility and security.

## Current / Required / Gap / Advisory

Mark what is current, required, unverified or advisory. Record a supplied design's revision, state,
viewport and publicly available source. Do not present a private node ID or historical screenshot as
reproducible public evidence. If an exact design is unavailable, state the gap and use the confirmed
semantic tokens and requirements; do not invent pixel-level provenance.

## Enforced by

Run `pnpm ops ci check docs desktop` and the applicable type/tests and real themes, keyboard,
narrow-window and consumer flow checks. Static gates and a screenshot alone do not prove complete
interaction acceptance. Design-platform writeback, uploads and publication need their own authority.
