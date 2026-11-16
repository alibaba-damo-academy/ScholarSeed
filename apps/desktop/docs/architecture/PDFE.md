---
id: arch-pdfe-overview
title: PDFE Workbench Architecture and Overview Design
doc_type: architecture
category: architecture
status: active
date: 2026-10-27
keywords: [desktop-app, webui, bridge]
summary: Design principles for an Electron mock workbench shared by product, design, and frontend teams, aligning scenario organization, data boundaries, extensibility, and acceptance criteria.
code_refs:
  - apps/desktop/preview/catalog.ts
  - apps/desktop/preview/Navigation.tsx
  - apps/desktop/preview/hierarchy.ts
  - apps/desktop/preview/service.ts
  - apps/desktop/src/main/pdfe.ts
---

<a id="pdfe-工作台架构与概要设计"></a>
# PDFE Workbench Architecture and Overview Design

## Scope / Non-goals

PDFE is a shared workbench for product managers (P), designers (D), and frontend engineers
(FE) to present the product, review interactions, and collaborate on development. It uses
repeatable mock scenarios to exercise the real product UI and observe its functionality,
states, and data boundaries, rather than maintaining a separate static prototype, designer-only
pages, or frontend demo shell.
The requirements baseline is a complete, usable mock of product functionality, interactions,
and states; the mere presence of buttons in a directory does not count as coverage. Missing
capabilities must be explicitly recorded, and each phase must remain within its authorized scope.

This document owns the design principles and high-level constraints that future feature
integrations must follow. Runtime assembly, interfaces, and lifecycle details are owned by the
[Preview Architecture](preview.md); Agent knowledge navigation and change authorization are
owned by [Roles and Scope](../work/pdfe.md). This document does not duplicate those sources,
serve as a phase-completion report, or grant permission to modify code, start, deploy, or release.

Non-goals: implementing real authentication, models, tools, or disk operations in the mock;
rewriting the production Store, protocols, or design system; or treating workbench display as
acceptance of real functionality. The scope and authorization of historical phases are recorded
only in their corresponding plans and do not exempt later page integrations or tests from
platform requirements.

**required**: PDFE maintains only valid requirements for currently supported versions; product
scope is not defined by legacy scenarios or test counts. Retired scenarios, mocks, samples,
dedicated hosts, and compatibility adapters with no continuing purpose should be removed when
their purpose ends; each legacy case does not need a replacement. When replacing a valid feature
entry point, use the current real entry point. Do not add buttons such as “Show hidden module” or
“Open hidden dialog” to support an old version. Retain conditionally displayed capabilities only
after verifying their permission, project-context, and platform conditions. Component-development
examples and useful diagnostic surfaces must have an explicitly separate identity; they must not
masquerade as product entry points or automatically become permanent E2E obligations. Removing
test-only code does not imply product code may be removed; product-code removal requires separate
checks of security, consumers, and data compatibility.

## Source of truth

| Responsibility | Source of truth |
| --- | --- |
| Normal product pages, operations, and reachability | [Composition root](../../src/renderer/src/app/composition.tsx), owning feature, and [renderer contract](renderer.md) |
| Page identity, scenario policies, behavior hints, and ownership | [catalog.ts](../../preview/catalog.ts) and [Chinese/English resources](../../preview/locales/) |
| Navigation groups and a few conditional direct-display rules | [hierarchy.ts](../../preview/hierarchy.ts), [Navigation.tsx](../../preview/Navigation.tsx), [collaboration.ts](../../preview/collaboration.ts) |
| Shared controls, information dialog, and workbench layout | [Console.tsx](../../preview/Console.tsx), [Header.tsx](../../preview/Header.tsx), [Controls.tsx](../../preview/Controls.tsx), [Divider.tsx](../../preview/Divider.tsx) |
| Scenario data and runtime ledger | [home.ts](../../preview/home.ts), [project.ts](../../preview/project.ts), [service.ts](../../preview/service.ts), and owning domain modules |
| Document samples and virtual files | [documents.ts](../../preview/documents.ts), [samples.ts](../../preview/samples.ts), [files.ts](../../preview/files.ts) |
| Electron host, bridge, and startup | [main](../../src/main/pdfe.ts), [preload](../../src/preload/pdfe.ts), [contract](../../src/pdfe.ts), [launcher](../../scripts/dev/pdfe.mjs) |
| UI assets, components, styles, and interactions | [DESIGN](../../DESIGN.md), [component guidelines](../design/components.md), [asset entry point](../../src/renderer/src/components/examples/ComponentsPage.tsx) |
| Acceptance criteria and production isolation | [testing guidelines](../quality/testing.md), [interface inventory](../work/preview-contracts.md), [output isolation check](../../preview/verify.ts) |

Source code describes current mechanisms; documentation describes design intent and constraints.
Registration, links, type-check success, or historical screenshots alone do not prove that a
feature is implemented, reachable, or accepted. When they diverge, verify against the actual owner.

## Current / Required / Gap / Advisory

- **current**: A development-only Electron PDFE host, isolated HTTP/SSE mock, shared renderer,
  shared login/theme/language controls, everyday and boundary navigation, and a UI asset entry
  point are in place. The project center already consumes scenarios for a genuinely empty list,
  ordinary data, pagination, large data sets, and forms. This does not mean all pages or states
  are complete.
- **required**: Use the same product, UI, and data source of truth; organize navigation around
  usage and simplify it as scenario counts grow; isolate the mock from production data, security,
  entry points, and artifacts; and define the effective scope and acceptance evidence for every
  capability.
- **gap**: Coverage conclusions for the project center do not extend to other business pages, all
  component states, or real authentication/model/tool behavior. Bind each result to the actual
  version, platform, and scenario. Verify platform-dependent behavior separately under the root
  requirements; do not extrapolate historical single-platform scope into proof of success on
  another platform or a permanent exemption from testing.
  The project center already has scenarios for initial task/project reads that wait, fail, and
  recover. Verify native lifecycle, normal-product regressions, and same-condition results in
  layers against the actual version; comparison of selected elements is not pixel-by-pixel
  comparison of every state. Quality gates and historical results alone do not replace the
  corresponding real-interaction acceptance.
- **advisory**: First complete one page as a repeatable vertical experience, then extend other
  features using the same principles. Prefer existing owners and data policies; do not create
  empty modules or ineffective toggles merely for directory symmetry.

## Ownership / Dependency

<a id="1-一个产品两个职责层"></a>
### 1. One Product, Two Responsibility Layers

```text
PDFE workbench control plane
  ├─ Select scenarios, shared controls, help, diagnostics
  └─ Electron host and restricted preload
          │ Scenario selection and instance-level operations
          ▼
Isolated scenario policy → data generator → instance ledger → contract adapter boundary
                                           │ Original HTTP / SSE / typed bridge
                                           ▼
                            Normal product renderer, components, styles, and state projection
```

The control plane prepares usable initial conditions; it does not duplicate the product UI. Once
a scenario is open, operations such as create, edit, open, pin, archive, and retry continue to use
the product's own buttons and forms. Do not directly populate the Store, handwrite internal events,
or create simplified controls and claim the feature is integrated.

Electron is the PDFE product presentation host. Browser/headless environments are used for
deterministic tests and shared-renderer verification; they are not restored as a second product
presentation entry point. UI consistency requires reuse of the real fonts, components, styles,
and host capabilities, with comparison under the same platform, content viewport, zoom, theme,
and language. Reusing source code alone does not prove pixel-level consistency.

All three user groups see the same features; do not add role selectors or role-specific mock
copies. All three may use Agents to modify code; differing knowledge areas do not imply different
permissions. Which owners may be changed is determined by the authorization for the current task.

<a id="2-页面优先层级随规模生长"></a>
### 2. Page-First Navigation That Grows with Scale

Use real product pages as navigation entry points. When a feature has many scenarios, they may be
organized around user tasks and then grouped into everyday use, data boundaries, and errors and
recovery. This is not a fixed multilayer template required for every page.

Keep the project center's structure simple:

```text
Project Center
├─ Everyday use: ordinary data, empty projects and tasks, existing project with no tasks, create and edit
└─ Data boundaries: pagination, large data sets, long names/titles, cross-batch task reads
```

- First use and empty states belong to everyday use. Empty data is not the same as being logged
  out; a search with no matches is not the same as a genuinely empty list.
- Show a small number of conditional scenarios directly as buttons; do not add vague intermediate
  layers such as “Full-page experience / Project management / Task browsing.” Collapse only larger
  combinations such as multi-condition pagination. The threshold is owned solely by
  `PDFE_MIN_GROUP_SCENARIOS` and must not be duplicated across pages.
- Multiple groups may remain expanded at once, with consistent indentation. Search temporarily
  expands matching content; clearing the search preserves the user's previous expansion choices.
  Browsing navigation and reading help must not reset product data or drafts; scenario policies
  apply only when a scenario is explicitly opened or reset.
- Show only error and recovery policies that are actually integrated. Do not add empty groups or
  buttons that do nothing. Put gaps in the notes and acceptance record; do not remove requirements
  or present “not integrated” as a successful empty state.
- Verify the actual navigation and consumers for normal product entry points; component
  registration alone is insufficient. Old layouts or duplicate mappings may leave current
  navigation with `navigation: hidden`; child features belong through parent-page/group metadata,
  not duplicate pages.
- Equivalent entry points may converge on a default presentation with `aliasOf` while preserving
  stable IDs. Merge them only when their data conditions and request policies are equivalent;
  do not silently merge distinct failures or business states just to reduce the number of buttons.

Navigation organization is not a data-directory structure. Changing pages, features, or groups
must not duplicate project, task, sample, or response inventories.

<a id="3-面板用于操作说明用于理解边界"></a>
### 3. Panels for Operations, Help for Understanding Boundaries

Scenario buttons should primarily express “what conditions apply and what can be tried.” Derive
their count from actual policies, and use concise behavior hints such as “Try: create project / open
task / edit, pin, archive.” Do not crowd primary navigation with “mock capability points / scenario
declarations / pending verification,” test steps, or technical implementation categories.

Put detailed steps, simulation limitations, unsupported items, and verification boundaries in a
separate dialog opened by the question-mark icon at the top; show request diagnostics in a
collapsible section. Operations should provide feedback for the current scenario, in-progress
work, and failures. Do not hide adapter problems with a default-success fallback. Maintain copy,
hints, accessible names, and error feedback in Chinese and English resources under the normal
product internationalization rules.

UI assets are shared foundational assets for product prototyping, design, and development. Keep a
single entry point and reuse real component examples. They are not a separate design system and do
not mean every component and state is covered in the current phase.

<a id="4-公共能力与场景状态分开保存"></a>
### 4. Store Shared Capabilities Separately from Scenario State

| Capability | Effective semantics and invariants |
| --- | --- |
| Simulated login | Logged-in/logged-out selection changes only the isolated identity and corresponding responses; it does not access real authentication or credentials, or implicitly clear projects and tasks |
| Theme and language | Reuse normal product options; retain them across scenarios, resets, and reloads in the current isolated instance; do not write personal configuration |
| Fixed-identity scenario | Explicit scenario policy takes precedence; workbench help explains the precedence, while the global login selection remains selected and is not falsely presented as effective in that scenario |
| Open/reset scenario | Restore the target scenario's data and page position, cancel old asynchronous work, and retain global login, theme, and language selections |
| Reload only | Preserve the current instance ledger without resetting data; unsaved page input may be lost, so this is not equivalent to “lossless docking” |
| Dock, pop out, resize, collapse, and restore | Dock on the right side of the window by default, with independent pop-out; host adjustment must not recreate product documents or clear product drafts and workbench filters |
| PDFE startup width | Reserve the workbench's default width in addition to the normal product default width; constrain it to the main display's available width, preserve the product minimum-window constraint, and do not change the official client's default size |

Do not add role switches, product-layout size forms, zoomable canvases, or global failure/delay
switches that are not covered by a requested policy. Shared preferences are retained for the
instance lifecycle; persistence across development-service restarts is not promised.

<a id="5-数据清楚可复用易适配"></a>
### 5. Keep Data Clear, Reusable, and Easy to Adapt

Sample identity, example projects, and external dependencies shared by evaluation, automated
tests, and PDFE follow [Shared Example Design](../../../../docs/architecture/examples.md). That
document distinguishes the currently scattered inventory from the proposed shared definitions.
This document continues to own scenario policies and the instance ledger; the shared example
design and actual records distinguish wiring status and acceptance gaps.

Separate the following responsibilities along existing owners; do not create empty shells merely
to add layers:

| Layer | Responsibilities and constraints |
| --- | --- |
| Reviewed base samples | Stable identity, original bytes, manifest, and digest verification; do not mix in user files or casually replace content with placeholders |
| Data generator | Generate projects and tasks by count and content characteristics, using one set of relationships, stable identities, and time references |
| Scenario configuration | Explicitly declare data conditions, feature hints, and request policies; do not infer behavior from scenario names or maintain duplicate count inventories |
| Instance ledger | Store mutable projects, sessions, virtual files, accounts, and asynchronous resources; reads and writes must be consistent within an instance and isolated across instances |
| Contract adapter | Convert at the boundary to real product DTOs, HTTP/SSE, and bridge responses; do not duplicate production business rules on each page |

Pagination capacity, name limits, and batch-read rules refer to real product sources of truth.
The per-batch read size is not a total-count limit. Large data sets must verify reachability of
the last item, no gaps or duplicates across batches, correct task ownership, and valid page
indices after data changes. Creation, modification, and reply times have explicit semantics;
reads do not refresh timestamps, and insertion order must not masquerade as real sorting.

Check required fields and currently consumed fields against the actual protocol. Do not invent
unused statistics or recovery metadata merely to make fields look complete. The existence of
fields does not mean state combinations are covered; empty, loading, error, no-match, and non-empty
data states must be verified separately.

File seeds explicitly distinguish `empty`, `example`, and `reviewed`: an empty VFS/new project
does not read unrelated samples; the project center reads the top-level shared base project; and
format-specific or historical special cases retain their reviewed inventory. Re-verify shared
bytes when reading them, and fail strictly when a required file is missing. After a successful
review, reuse the reviewed cache; a failed review must not be cached as successful. Special cases
still load their full inventory; do not misstate this mechanism as support for selecting samples
by every format.

Reset, deletion, and destruction must cancel old timers, streams, and in-flight work. Before
asynchronous work completes, recheck the instance, generation, and identity to prevent old
responses from contaminating a new scenario. Unknown requests must fail explicitly and enter
diagnostics; never forward to the real network or return a successful placeholder response.

<a id="ui-自动化测试的承载边界"></a>
### UI Automation Test Ownership Boundary

The PDFE owner provides repeatable isolated state and scenario lifecycle. A performs programmatic
assertions through real product controls; PDFE does not own API business semantics or real-task
criteria. Shared responsibilities, risk-based test layering, contract ownership, minimum
relationships, and stability constraints are maintained only in [Testing Architecture](testing-strategy.md#测试分层与共享契约); this document does not create a second checklist or set of requirements.

Scenario adapters evolve along the original interface DTOs and instance ledger. They support only
responses and controlled failures consumed by the UI; they do not duplicate the backend business
state machine. The original interface owner defines the semantics of interface changes, while
PDFE adjusts only affected policies and data incrementally. Reuse existing tests for affected
scenarios; do not add scenario copies for requirement IDs.
Intentional loading/failure delays retain their scenario semantics. Observe host build, window
lifecycle, and UI assertion costs separately under the testing architecture; do not create a
browser presentation shell or remove native assertions to speed things up.
Native screenshots prove UI consumption on that simulated runtime surface only. Real routing and
storage are proven by interface integration; real tasks belong to [LLM Evaluation](evaluation.md).
Do not present simulated events or screenshots as results from real models, tools, or disk.

**current / gap**: `preview-contract` is wired to contract tests, and `preview-ui` is wired to
native Electron PDFE tests. The existing CI orchestrator selects required migrated native
regressions by explicit title and independently checks example completeness. The orchestrator
owns the actual inventory; do not store counts or copies in this architecture or add the full
native UI suite to packaging smoke tests. Shared interface-contract and legacy browser-spec
migrations remain partial. Other scenarios do not inherit this wiring conclusion; specific
inventory, entry points, and migration schedule belong to the implementation plan
(non-public execution/provenance record omitted).
The presence of test files or reuse of the same renderer does not mean tests passed or stability
improved.

<a id="6-不污染正常产品"></a>
### 6. Do Not Contaminate the Normal Product

The PDFE main/preload, startup entry point, mock service, samples, test bridge, and development
resources are isolated from the normal product entry point and production dependency/artifact
closure. The normal product must not enter Mock by default, change request destinations, or load
simulated data. Do not read, migrate, or overwrite real users' accounts, configuration, projects,
sessions, or persisted data.

Changes shared with real pages do affect the normal product: change only explicitly authorized
behavior and add the corresponding normal-product regressions. Do not add PDFE-specific business
branches to shared pages. Build isolation does not prove normal startup, functionality, or native
behavior has passed.

Preserve CSP, sandbox, contextIsolation, IPC-origin validation, and network isolation. The renderer
must not receive Node or Electron capabilities. Host changes must follow the typed contract and
their respective owners; do not weaken the security boundary for presentation convenience.

<a id="7-后续功能接入的设计核对项"></a>
### 7. Design Review Questions for Future Feature Integrations

These are design constraints, not a second execution Skill. Implementation follows existing
owners and development guidelines.

| Question | Acceptable design basis |
| --- | --- |
| Where does the user open the feature? | Real product page and public controls; registration or an old route alone does not prove a current entry point |
| How many setup scenarios does the user need? | Everyday path, genuine empty state, and necessary data/error branches; list a small number directly rather than forcing every hierarchy level |
| Which data can be reused? | One generator, seed, and domain ledger, with explicit request policies; do not duplicate page data |
| How does interaction continue? | Original product components, public requests, and state projection; not a one-time display followed by workbench-only operations |
| Will shared selections be lost? | Retain login/theme/language across scenarios and explicitly describe fixed-policy and reset boundaries |
| Could real product behavior be affected? | Evidence for ownership, change scope, user-data protection, and entry/dependency/artifact isolation |
| How is completion proven? | Layered verification and real-runtime evidence for the final version, with unimplemented items and platform gaps explicit |

<a id="8-功能迭代版本试点"></a>
### 8. Feature Iteration Version Pilot

- **current**: “Project Browsing” in the project center is the single-feature pilot. The ordinary,
  project-without-tasks, and fully empty scenarios share one feature definition in
  `preview/iterations.ts`; scenarios reference only the feature identity, and compatibility
  aliases inherit the original scenario's feature. Do not maintain version data again in scenarios,
  copy, or pages.
- **current**: `introducedIn` records the product iteration in which a feature was first added;
  `changes` retains evidence-based feature update versions and summaries. Use `null` when there is
  no reliable evidence for historical attribution, and display “Version added: pending
  confirmation”; do not guess from package versions, Git dates, or the current branch. The pilot
  has no confirmed numeric version yet, so filters offer only “All iterations” and “Version
  pending confirmation”; add/update scope selection is available only for confirmed iterations.
- **current**: Version badges and filters apply only to PDFE navigation; they do not change product
  pages, mock data, login, language, or theme. The filter persists in this instance's
  `sessionStorage` and survives scenario switches. Features outside the pilot remain under “All
  iterations” and are not automatically assigned to “Pending confirmation.” When filtering,
  retain necessary parent nodes and expand matching items.
- **required**: Confirm the initial-added version against actual iteration plans before entering
  it, then keep it stable. Add an update record only for a substantive change in product behavior;
  adding a mock, fixing an implementation, changing layout, or retesting does not count as a new
  product capability. Requirement IDs, requirement versions, scenario implementation revisions,
  and this round's verification results do not substitute for the feature's added version.
- **required**: Extend later features by maintaining each feature definition once and having its
  owning scenarios reference it. Generate version options from feature definitions, sort by
  numeric segments, support four-part iteration numbers, and do not introduce a second version
  inventory.
- **gap**: The pilot's historical version is still unconfirmed; do not claim that additions or
  updates for any numeric version have been verified. This round implements only one feature;
  do not bulk-label other pages or claim delivery based on the existence of mock registration or
  tests.

<a id="正反例"></a>
## Examples and anti-patterns

| Good example | Counterexample |
| --- | --- |
| The project center has only everyday and boundary groups; a small number of conditions are clicked directly | Mechanically create page/feature/everyday/state folders on every page |
| Open the real form through the original create button and write to the same mock ledger | The workbench creates its own form or edits the Store directly to show “success” |
| Empty projects and tasks are genuinely empty, with login state selected independently | Misrepresent logged-out, no search matches, or read failures as an empty list |
| Multiple scenarios reference one data generator and the official pagination constants | Copy a JSON file, counts, and page capacity into every navigation group |
| Unsupported interfaces fail and are diagnosed; known failures recover under explicit policies | Unknown requests all succeed by fallback, or retry secretly swaps in successful data after a few attempts |
| Record HTTP, headless, Electron, and normal-product conclusions separately | Treat one component screenshot or shared source as acceptance of all native behavior |

## Enforced by

Document structure and links are checked with `pnpm ops ci check docs workspace` and
`pnpm ops ci check docs desktop`; these checks do not prove that a feature is integrated.

For product changes, select deterministic, mock HTTP, shared-renderer/headless, real Electron, and
normal-product acceptance as appropriate under the [testing guidelines](../quality/testing.md),
and verify applicable scope with the [production isolation check](../../preview/verify.ts).
By default, do not run tests that take over the mouse or window focus, automatically launch a
foreground Electron app, or inject internal state to impersonate user actions. If no authorized
independent native environment is available, retain the acceptance gap; do not use headless as
proof of native behavior.

Acceptance must cover at least data conditions, genuine empty states, normal interactions, the
last paginated item and cross-batch reads, search, retention of shared selections, reset/re-entry,
instance isolation, and asynchronous cleanup. Real authentication, services, models, file systems,
and cross-platform behavior each require applicable real evidence; do not mix them into mock
success counts. Record the final version, commands, results, and screenshot areas inspected. Keep
raw runtime evidence ignored; do not turn phase records into permanent capability guarantees.

## Update triggers

- When page reachability, scenario organization, shared capabilities, or data lifecycle changes,
  update the corresponding mechanism's source of truth and the affected design constraints here.
  Do not maintain a second count or state inventory here for ordinary new scenarios.
- Change this document when design principles change; change `preview.md` when assembly,
  transport, or interface details change; and change `work/pdfe.md` when role knowledge or
  authorization boundaries change. Maintain navigation and registry as well, without creating a
  second copy of the main content.
- Before advancing a new feature, verify current source and actual gaps. After completion, update
  the corresponding owner and verification conclusion. Completing a project-center phase does
  not automatically authorize other pages, environment configuration, remote synchronization, or
  release.

## Stop condition

If a proposal requires copying the product UI, creating another business state machine, falling
back to success, bypassing real interactions, reading user data, weakening security boundaries,
or canceling required acceptance, stop that proposal and return to the actual owner to correct the
design.
When states remain unimplemented, runtime is blocked, platform behavior is unknown, or required
evidence is missing, do not claim complete delivery. Continue independently authorized work and
state the gaps clearly. Publishing this document does not mean the overall PDFE Goal is complete.
