# Preview implementation contract

## Update triggers

Update this contract with confirmed scope or consumer changes. Execution logs and private screenshots
are separate records and do not silently revise product requirements.

## Stop condition

Do not claim complete preview migration until applicable deterministic and real product acceptance
is evidenced for the final revision. Missing cases remain gaps, not waived requirements.

Historical execution logs are not current acceptance evidence.

## Scope / Non-goals

Established on 2026-10-20. User goal: provide product managers, designers, and frontend developers
with a shared Web + mock scenario workbench that displays every page and includes simulated
conversations, tool calls, and approvals; real Electron reuses the complete UI, styles, and data
consumption logic with real business data. The three user workflows are described in
[Architecture positioning](../../architecture/preview.md#使用者与协作闭环). Architecture and decisions
are maintained only in [Preview architecture](../../architecture/preview.md); this plan does not
establish a separate proposal.

**The current Goal authorizes implementation of related code, mock scenarios, tests, and documentation**,
including team collaboration and isolated runtime verification. Authorization must still be checked
separately for real model calls, changes to personal configuration, dependency installation,
deployment, and Git commit/push/merge/release.
The first release does not include public-network/static hosting and does not duplicate pages.

## Source of truth

Responsibilities, protocols, isolation, and coverage classifications follow
[Preview architecture](../../architecture/preview.md); actual commands follow the
[Desktop package](../../../package.json) and [testing conventions](../../quality/testing.md).
Before implementation, read the then-current source, applicable AGENTS, and Owner; historical paths
or test results cannot be used to determine the current state. The support/difference inventory for
interfaces and samples is in [Backend contracts and adaptation boundaries](../preview-contracts.md);
do not establish a parallel protocol.

## Current / Required / Gap / Advisory

- **current**: Existing Web entry point, component gallery, feature assembly, and HTTP/SSE/bridge boundaries have been checked.
- **required**: Establish isolation and sharing first, deliver an interactive vertical slice next, then complete every page item by item.
- **current**: The preview entry point displays the real home page and console; screenshots have been captured of isolated startup and project creation in real Electron, with no real model request sent.
- **gap**: P0/P1/P2 are in progress; some simulated protocols, full-directory integration, and final acceptance in both environments remain open, so the work cannot be called complete overall.
- **advisory**: Estimate total effort after P0; file count cannot be used to estimate work across all pages and complex states.

## Ownership / Dependency

| Workflow / role | Write boundary and deliverables | Collaboration constraints |
| --- | --- | --- |
| Architecture/startup owner | Preview configuration, shared startup assembly, typed preview bridge, production-exclusion gate | Sole writer for shared entry points and contracts; do not widen real preload permissions |
| Scenario-service owner | Same-origin HTTP/SSE, scenario identity, in-memory state, reset, network isolation | Align contracts with domain Owners; do not implement a second real business service |
| Product manager/requirements owner | Business scenarios, requirement links, normal/error branches, and observable expectations | Review workflows and copy in the shared workbench; do not treat simulated results as real business acceptance |
| Domain UI owner | Scenarios and public display hooks for the relevant feature, plus necessary local decoupling | Reuse UI and styles; change a page only at boundaries directly related to integration |
| Designer/design-system owner | Scenario selection experience, theme/language, design comparison, and feedback | Change real tokens/components; do not maintain dedicated page copies |
| Verification owner | Coverage inventory, independent assertions, Web scenarios, and real Electron regression | Do not change production behavior to achieve isolation; tests must not copy the simulator algorithm to validate itself |

These are responsibility roles; they do not presume specific people or start persistent workflows.
P1 bridge/service work may proceed in parallel after the P0 contract is frozen; P3 domains may
proceed in parallel after P2 validates the shared protocol. Shared entry points and documentation
retain a single writer.

<a id="开发里程碑"></a>
## Development milestones

This round continues to address the P2 real-session gap: cancel an actively appended long stream
through the original Composer; the original failure-continuation entry point triggers a real preview
SSE disconnect, then resumes streaming from the production `from_seq` to recover missing deltas and
the terminal state. The directory explicitly configures execution and transport policies, while the
service retains the sole Session ledger; waiting for the transport handshake does not pause domain
progress.
First use HTTP regression coverage to prove that the old stream really closes, work completes during
the disconnect, the cursor remains continuous, and reset cancels the old handshake. Then exercise
stop/retry/re-entry through the public UI and capture final screenshots. Do not substitute approval
cancellation for stream cancellation or fake reconnection by resending a turn.
This round makes no real model calls, changes no personal credentials or production source, and does
not inherit Git delivery authorization.

This round continues P3 developer settings: the original page and account client share an
instance-local simulated summary ledger. Complete ordinary/managed lists, empty states, read
pending/persistent-failure states, one-time display-value generation, close/reload, revocation,
rotation, and retry after pending/failed changes. Do not add mock branches to production pages.
Simulated capability is not real authentication, and `preview-only:` cannot authenticate. Managed
routes return the explicit not-ready/not-issued state in the real DTO; they do not call the real
account service or align sessions.
First prove the isolated-credentials prerequisite in real Electron. If it is not met, verify only the
runnable page without credential changes and disclose the gap; do not open a settings page that
automatically prepares real managed credentials just to satisfy acceptance. This implementation
does not add Git delivery.

This round continues P3 archive management: default task/project tabs, history from the same ledger
and the original archive tree, restore, cancel and delete, pending states, and retry after failure;
distinguish single-task operations from single/batch project operations according to the actual UI.
The insufficient project-read error surface remains an open gap.
Also clarify virtual-root synchronization and cleanup of test-owned instances. The entry-point owner
is the sole writer for shared bridge/contracts/test assembly; the domain owner maintains archive and
HTTP behavior, and the consumer owner maintains directory/spec. In real Electron, explicitly note
that the initial tab synchronizes authorized roots. Separately, use the public UI in a task-exclusive
isolated directory to create one unique empty project, and archive, cancel, and confirm its
unregistration only for that exact ID; verify that directory bytes remain. Do not operate on existing
projects/tasks, call a model, or delete disk files. This does not inherit phase-level Git delivery
authorization.

This round continues the P3 data-storage vertical slice: shared original page → explicit virtual
directory selection/cancellation → original PUT → restart prompt, persistence across reload, and
retry after delay/failure. The entry-point owner is the sole writer for the typed bridge/preview host;
scenario service and directory/consumer spec have separate owners. Do not change the real home or
migrate projects. There is currently no separate retry UI for read errors; retain this gap. Real
Electron uses a read-only mount; Web results do not substitute for native selection and directory
writes.

| Phase | Status / dependency | Deliverable increment | Exit criteria |
| --- | --- | --- | --- |
| P0 Inventory and contracts | In progress | Page/surface inventory, three user workflows, capability classification, request egress, and scenario protocol | Every page has an Owner, entry point, display classification, and requirement source; product review, visual review, and frontend debugging loops are defined; all direct connections and module-level initialization are identified |
| P1 Isolated preview foundation | In progress; P0 | Standalone startup command, scenario service and preview bridge, minimal real home page, console | Real home page displays without Serve/account/model credentials; unknown requests/external network are blocked, and storage isolation, initialization order, and production exclusion are verified |
| P2 Complete session slice | In progress; P1 | Real conversation page, streaming content, tool cards, approvals, and delivery demo | Approval/rejection produce their respective outcomes; cancel/retry/re-entry are interactive; history, snapshots, and SSE agree, with no real tool calls |
| P3 All-page integration | In progress; close P2 gaps in parallel | Domain scenarios for projects, materials, literature, settings, each viewer, and auxiliary surfaces | Every P0 inventory item has an accessible scenario and consumer spec; zero non-native renderer integrations remain missing; only native-dependent areas may be marked as shell/substitute areas |
| P4 Cross-role collaboration loop | Incrementally in progress; P3 not complete | Resumable scenario links, requirements/expected results, one-click reset, latency/failure controls, diagnostics, and screenshot comparison | Product managers can review branches without code; designers can compare real visuals; frontend developers can debug requests/events and hot-reload; theme/language/window/keyboard and state-isolation matrix passes |
| P5 Electron regression and handoff | Incremental acceptance in progress; P4 not complete | Real-service regression, platform evidence, usage instructions, and coverage report | Electron does not load mock, and real data displays through the shared UI; applicable macOS/Windows flows and final screenshots are complete; gaps are disclosed individually |

P1 and P2 are independently demonstrable milestones, but do not mean that “all pages” are complete.
Basic theme/language/reset capabilities for P4 should be added incrementally starting in P1; P4
completes the full operating experience and matrix without deferring isolation capabilities required
by the foundation.
Representative Electron regression for P5 proceeds incrementally from P1/P2; do not wait until the end
to discover that shared paths have diverged.
Each batch of UI changes delivers mock data/scenarios/tests and backend adaptation notes together;
verify that real Electron runs at every phase. Mark backend contracts as supported or awaiting
adaptation; after adaptation, compare visuals and interactions using the same scenario instead of
creating a separate real-data page.

<a id="p0首次实施交付清单"></a>
### P0: First implementation delivery checklist

- Cross-check the inventory across registry, navigation, settings, viewers, standalone entry points,
  and important overlays; the currently visible menu is not the complete set.
- For each core scenario group, record the requirement source, expected result, and three user
  workflows; share one scenario rather than duplicating it by role.
- Classify pages as interactive preview, shell/substitute area, or not integrated; explain the reason
  for unavailability and how each will be completed.
- Record API, account, SSE, bridge, and resource requests; confirm that preview defaults to no
  credentials, no external network, and no real-user reads/writes.
- Define scenario declarations, instance identity, and reset lifecycle; identify the actual Owner
  for required DTO/event contracts.
- Submit domain-based task lists and effort estimates, then freeze the P1 write scope; do not promise
  an uninspected page count.

<a id="p2首条演示场景及分支"></a>
### P2: First demo scenario and branches

| Action | Observable result | Counterexample that must be asserted |
| --- | --- | --- |
| Open a project and send a message | The real Composer submits it and text appears incrementally | Do not fill the Store directly to fake a send |
| Approve a tool request | Tool card shows progress, approval awaits a response, and the turn remains pending | Do not deliver before a response |
| Approve / reject | Continue the simulated operation or show the rejection result, respectively | Repeated clicks must not advance more than once; rejection must not end with the approval result |
| Cancel / fail / retry | Show the corresponding state; retry starts through the existing product action | Do not hide errors by refreshing the entire preview or replay an already answered approval |
| Re-enter after switching away | History, pending requests, and terminal state agree; resumed stream has no duplicates | Old connections and responses from before reset must not contaminate the current scenario |
| View simulated delivery file | Viewer in the same workspace reads the sample bytes | A preview in the UI does not mean disk write/model delivery succeeded |

<a id="交付拆分与依赖"></a>
### Delivery breakdown and dependencies

**required (archive closure)**: Current consumer regression exposed background-refresh read starvation
on the shared archive page, an incorrect user-role label in original history, and premature closure
of project asynchronous unregistration confirmation. First fix each issue in its production Owner,
then verify using the same mock scenario and real Electron. Do not adjust delays, disable polling, or
rewrite the history protocol to hide failures.
When cleaning up test instances, retain failure screenshots and the complete trace; let the test host
close the browser context normally.
Continued implementation this round does not inherit completed Git delivery authorization; do not
add commits, pushes, or MR changes.

Recommended delivery batches: P0 documentation/inventory, P1 startup isolation, P2 sessions, and P3
domain pages. Each batch must have runnable results and consumer tests; do not submit unused
fixtures/builders alone. The current root entry points below do not start a real model:

```bash
pnpm ops dev browser --mock
pnpm ops ci test integration --scope desktop --suite preview-contract
pnpm ops ci test integration --scope desktop --suite preview-ui
pnpm ops ci check preview-bundle
```

`dev:preview` listens only on the loopback address by default and opens its output URL in an isolated
browser context; a regular browser must use a separate context without user cookies. UI tests create
an isolated browser context. Locally, the default is the installed Chrome; set
`SCHOLARSEED_PREVIEW_BROWSER_CHANNEL` to choose a supported channel. Browsers are not automatically
downloaded or installed.
`pnpm ops ci check preview-bundle` requires real output to be generated first with
`pnpm ops cd build local --stage app`; it fails explicitly if output is missing.
These entry points do not mean that all scenarios have passed; phase results are determined by the
commands, screenshots, and coverage records from that run.
Each P3 domain package can proceed without waiting for other domains to finish, but the final
all-pages requirement must not be reduced.

<a id="正反例"></a>
## Examples and anti-patterns

Example: P1 first verifies the real home-page components and security isolation, P2 then verifies all
approval branches, and P3 expands page by page against the inventory.
Anti-patterns: requiring every Store to be decomposed before preview is possible; marking all pages
complete based only on component screenshots; returning success for every unintegrated interface.

## Enforced by

Documentation delivery is enforced by the runtime root and Desktop `docs:check`, applicable
convention checks, and `git diff --check`; these do not constitute product acceptance.
For product implementation, run adjacent unit/protocol behavior tests first, followed by `typecheck`,
documentation/reuse/internationalization gates, and aggregate tests. A new preview E2E project must
be registered in P1 and have an actual consumer in the same batch; do not report its results together
with real live projects.

| Verification area | Required evidence |
| --- | --- |
| Startup/security | Startup without Serve/credentials; tests rejecting unmatched requests, external network, account access, storage contamination, and stale responses |
| Protocol/interaction | Session and approval branches driven through the real UI; HTTP/SSE snapshot consistency and duplicate/cancellation tests |
| Page coverage | Mapping from inventory to scenarios to consumer specs; classification denominator and unintegrated items; results for every applicable state |
| Cross-role use | Complete product workflow/copy review, visual review, and frontend request/event debugging using the same scenario; non-developers need not edit source or assemble interface responses |
| Visual experience | Actual Web workflow, final screenshots with each inspected; theme/language/long-content/keyboard/window results |
| Electron sharing | Real backend and real user path, final-version screenshots; confirm no mock dependency and no samples in artifacts |
| Platform/native | Real macOS/Windows evidence for each affected scope; preserve exact prerequisites and errors for blockers |

Keep screenshots and runtime artifacts in a locally ignored directory; provide absolute paths at
delivery and explain what each proves.
Protocol tests do not prove model behavior; simulated approvals, tools, and system actions in preview
do not count as real product success.
