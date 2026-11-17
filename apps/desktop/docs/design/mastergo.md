# External design provenance

## Scope / Non-goals

External design platforms are optional evidence providers, not prerequisites for public development.
The platform-neutral [tooling contract](tooling.md) and public [Public design contract](foundations.md)
own the reproducible requirements. Private project IDs, credentials, raw DSL, screenshots and platform
connection instructions are not part of this checkout. Missing source evidence remains a gap; it must
not be relabelled as exact design or complete visual acceptance.

## Source of truth

Public requirements, [foundations](foundations.md), [components](components.md) and the actual
registry own reproducible constraints; no private inventory file is required.

## Current / Required / Gap / Advisory

- **current**: the public checkout contains tokens, components, design requirements and their gates.
- **required**: cite the actual available design revision and distinguish requirements from observations.
- **gap**: omitted private evidence does not establish exact visual provenance or current acceptance.
- **advisory**: use supplied, authorized external designs as additional evidence rather than prerequisites.

## Ownership / Dependency

Public contracts live beside their implementation. Private design connection details and raw evidence
belong to private supplements, not public build or review dependencies.

<a id="正反例"></a>
<a id="examples-and-counterexamples"></a>
## Examples and anti-patterns

Good: compare a confirmed requirement with the actual semantic token and consumer state.
Bad: claim pixel-exact acceptance from an inaccessible node or a static registry check.

## Enforced by

`pnpm ops ci check docs desktop` validates structural sources and inventories. Applicable real UI,
theme, keyboard and narrow-window checks remain required; this gate cannot prove them.

## Update triggers

Update public design contracts with mechanism or confirmed requirement changes; record relevant
external evidence revisions only when they actually inform that change.

## Stop condition

Stop claims of exact design or complete acceptance when evidence is missing; retain the gap and
continue independently authorized implementation or verification without fabricating provenance.
