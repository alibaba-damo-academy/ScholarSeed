<a id="pdfe-工作台角色知识与修改范围"></a>

# PDFE Workbench: Role Knowledge and Change Scope

## Scope / Non-goals

PDFE is a product-delivery workbench shared by product managers (P), designers (D), and frontend engineers (FE).
All three roles can modify code through agents such as Codex. A role determines default knowledge and task focus; it does not represent account permissions or limit a role's coding ability. Do not maintain role-specific product pages or mock copies.

This document is the sole source for role tasks and change scope. For product design principles and future integrations, first read the [PDFE overview](../architecture/PDFE.md). Preview assembly, isolation, and message boundaries are defined in the [preview architecture](../architecture/preview.md); requirements, design, components, and business mechanisms remain with their original owners.
Knowledge layers follow [knowledge governance](../../../../docs/architecture/knowledge.md); do not copy standards into role entry points.

## Source of truth

| Task perspective | Required knowledge entry points | Deliverables and review focus |
| --- | --- | --- |
| P Product manager | Confirmed requirements and acceptance criteria for the current feature; expectations and constraints in the [scenario catalog](../../preview/catalog.ts); the relevant feature owner | Requirement status, business flow, copy, and normal/error/boundary cases; compare expected and actual behavior without treating current source as a substitute for product requirements |
| D Designer | [DESIGN](../../DESIGN.md), [public design contract](../design/foundations.md), [component reuse](../design/components.md), [interaction rules](../design/interaction.md), and business rules for the current scenario | Page layout, visual hierarchy, component states, theme, language, keyboard focus, long content, and supported sizes; distinguish design evidence from semantic inference |
| FE Frontend engineer | [renderer](../architecture/renderer.md), [ownership](../architecture/ownership.md), [mock consumption contract](preview-contracts.md), [testing rules](../quality/testing.md), and the relevant requirements/design | Shared page implementation, domain scenarios, HTTP/SSE consumption, and regression-testable interactions; do not create parallel state projections or loosen interface/host boundaries |

Product managers may change styles, designers may add business scenarios, and frontend engineers may maintain confirmed requirement links.
Whether a particular change is allowed depends on the explicit task scope, not on a job title.
For this task, the user confirmed the scope as the complete Mock feature set of the existing product; there is no need to wait for an external PRD. Check completeness against all product entry points, shared UI, domain-owner contracts, and the component registry. Do not treat the existing scenario catalog as the complete feature set. When semantics are unclear, locate the original owner and mark the question for confirmation rather than introducing a new business rule. Scenario registration, execution coverage, and human acceptance are separate facts.

## Current / Required / Gap / Advisory

- **current**: A shared renderer, scenario catalog, and separate viewport are implemented. All three roles see the same feature navigation and scenario buttons; the workbench has no role switcher. Agents read this document according to their responsibilities and task scope; it does not duplicate domain content. Task-context helpers do not automatically grant write access. Task-diff checking, capture of the actual source baseline, and full Agent-host validation remain in development.
- **required**: Before each Agent change, specify the role, target requirement/page/scenario, files and behavior that may change, prohibited scope, verification method, and stop condition. Different tasks for the same role may have different change scopes.
- **required**: Path access does not mean semantic authorization. When a file mixes service, path, persistence, permission, configuration, or global-state logic, do not treat it as a page/data change just because its extension is `.tsx` or it is under `preview/`.
- **gap**: The complete Mock feature inventory, per-state coverage, and full product acceptance are not yet closed out. The existence of role entry points does not prove that all requirements, page states, or Agent scope constraints have been verified.
- **advisory**: Keep stable identities for each requirement and scenario. Issue records and screenshots should reference them; switching roles must not create a second set of product facts.

## Ownership / Dependency

<a id="三层修改范围"></a>

### Three Layers of Change Scope

| Layer | Permitted content and prerequisites | Does not authorize |
| --- | --- | --- |
| Mock samples and scenarios | Samples, copy, boundary data, and existing policy parameters specified for this task; preserve instance isolation and production DTOs | Permission to change all of `preview/`, or to change service routes, transport, admission, instance lifecycle, bridge, or isolation policy |
| Shared page presentation layer | Pages/files/interactions explicitly named for this task; reuse existing components and tokens; record impact on the real product | Permission to change all of the renderer, global Store, interface semantics, registered capabilities, or every component with the same name |
| Scope extensions and handoff | If a dependency is found, report the required owner, specific change, and risk for separate confirmation in this task | Default permission to change API/DTO/SSE/IPC, main/preload/Serve, authentication/permissions, persistence, mock engine, global components/tokens, dependencies, builds, or releases |

An Agent must not use preview-only UI, direct Store writes, internal events, or always-successful samples to work around a real product defect.
When scope must be expanded, stop the dependent action and continue independent authorized work; do not silently broaden permission.
If a production component lacks a capability, extend it through its owner. Do not copy a replacement component to keep the page task's scope unchanged.

<a id="任务契约与交接"></a>

### Task Contract and Handoff

The task contract must include at least the role, target requirement and scenario, files and behavior that may change, prohibited content, verification, and stop conditions.
Bind the contract to the starting source revision and existing dirty state to protect others' changes; do not attribute all uncommitted diffs to the current Agent. Later checks must use the actual diff created after this task began.

At handoff, report separately: this task's diff, scope violations or uncovered items, requirement and design basis, mock-consumption verification, affected real-product verification, and the revision, scenario, steps, theme/language/size, and screenshots.
Knowledge conventions are not a sandbox. Path or syntax checks cannot prove semantic compliance; retain human review and record gaps.

## Enforced by

Applicable AGENTS, actual owner contracts, component/style ratchets, and original test criteria remain in effect.
Documentation links are checked by `pnpm ops ci check docs desktop` and the workspace documentation checks.
Role-scope tools, real Codex use, and full-scenario regression are accepted separately. Passing documentation checks or successfully copying a task prompt does not prove that an Agent correctly followed role knowledge.

<a id="正反例"></a>

## Examples and anti-patterns

Positive example: a designer selects the same session scenario, adjusts the shared presentation layer within the explicit task scope, reuses existing components/tokens, preserves the product draft, and submits the exact diff plus theme/keyboard/real-product verification results. If requirement support is missing, mark it for confirmation first.

Counterexamples: changing Serve or IPC by default because the role is frontend engineer; rewriting isolation because a file is under `preview/`; treating every candidate path as authorized after copying task context; or treating a passing mock as real acceptance.

## Update triggers

Update this document when role responsibilities, change scope, owner navigation, task contracts, or handoff facts change.
Record domain-mechanism changes in their original source documents; role entry points should update only relevant links and reading conditions.

## Stop condition

Stop broadening the reading scope once you have identified the actual owner and change scope for this task. If requirement support, write authorization, or prerequisites for real verification are missing, keep the item open; do not infer permissions from a role, historical commands, or this document.
