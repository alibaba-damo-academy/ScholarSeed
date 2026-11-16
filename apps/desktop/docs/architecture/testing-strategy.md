<a id="desktop-测试架构逻辑单元--api-接口--pdfe-ui--llm-真实链路"></a>
# Desktop Testing Architecture (Logic Units / API Interfaces / PDFE UI / Real LLM Flows)

## Scope / Non-goals

Raw samples and example projects shared by evaluation, automated tests, and PDFE follow the [shared examples design](../../../../docs/architecture/examples.md): reuse immutable definitions and prepare the smallest independent copy for each test objective. Do not perform the action under test in advance or treat a protocol fixture as real integration.

**Target division (required)**: Logic is covered by unit tests, APIs by interface tests, UI by PDFE-based Mock APIs driving the real shared renderer, and real user-task flows by [LLM evaluation](evaluation.md). The first three layers provide fast, stable, repeatable feedback through programmatic drivers and assertions. Real flows are driven by a model and assessed through independent review; programs still verify deterministic facts such as files, state, and security boundaries.

**Owner A** maintains deterministic tests and shared preparation/observation capabilities. **Owner B** maintains real-flow evaluation, baselines, and run deliverables. PDFE provides UI-state preparation and an isolated execution surface; it is not a fourth scoring method. Existing, still-valid program-driven real-model E2E tests continue to be reported under A; do not automatically reassign them to B or delete them because of the target division.

Key choices: retain Node, Python, Playwright, and existing Owners; put state combinations in a low-cost layer so each UI case does not depend on a real backend/model. Keep native integration for IPC, processes, installation, and updates separately. Documentation changes do not weaken existing strict/full checks, real-data safety assertions, or package acceptance. Non-goals are building a new test platform, changing the product to support isolation, or redefining requirements. This document maintains the architecture design only; the inventory of existing tests, migration arrangements, and staged acceptance belong in the implementation plan (non-public execution/provenance record omitted).

Determine test scope from valid requirements for currently supported versions, source consumers, and real reachable paths, not from historical inventory. For retired capabilities with no continuing use, remove their tests, scenarios, mocks, samples, and dedicated adapters; do not migrate every case or retain stand-ins. For still-valid capabilities whose entry points were replaced, use the current real entry point; do not add substitute buttons for old tests. Conditional visibility does not mean retirement; permissions, error recovery, availability after selecting a project, and platform-specific capabilities still require verification. Separately verify requirements, consumers, security, data compatibility, and platform usage before deleting product code; do not delete a feature merely because tests are failing or slow.

## Source of truth

- Execution and selection: [Desktop scripts](../../package.json), [Playwright](../../playwright.config.ts), [ci:test](../../../../scripts/ci/test.cjs), and [gitlab jobs](../../../../.gitlab-ci.yml).
- Acceptance minimum: [testing and acceptance standards](../quality/testing.md); profile, quarantine, quality.json, and L1–L4 follow the [development entry point](../../../../docs/runbooks/development.md#验证分层与-ci-编排器).
- Preparation and isolation: [runtime](../../e2e/fixtures/runtime.ts), [Electron fixture](../../e2e/fixtures/electron.ts), and [project seeding](../../e2e/fixtures/workbench.ts); [c8](../../.c8rc.json) owns coverage.
- The architecture, Skill, and scenario contracts for model-driven execution/review belong in [evaluation.md](evaluation.md).
- UI scenarios and isolation belong to [PDFE](PDFE.md), the [preview architecture](preview.md), and [catalog](../../preview/catalog.ts); the current execution entry point is [native config](../../preview/native.config.ts).
- The existing API/data-flow inventory belongs to [Serve tests](../../../serve/tests/) and [run_all](../../../serve/tests/run_all.py); cross-package protocols belong to [root tests](../../../../tests/).

## Current / Required / Gap / Advisory

The following reflects a static review of source on this branch; it is not evidence that tests passed in this run.

| Status | Verified Facts or Goals |
| --- | --- |
| **current** | Node/Python logic and contract tests, real route/storage integration, Chromium render, Electron E2E, and UI/style ratchets exist. Existing runners mix resource types; their names do not mean they are layered. |
| **current** | PDFE has contract tests and a native UI test surface. See the implementation plan for the actual inventory and execution wiring; coverage cannot be inferred from the existence of test files. |
| **current** | Playwright has smoke/live/workbench/update and conditionally registered package projects. Live and some workbench/package cases still programmatically drive the real product/model and remain existing A coverage. |
| **current** | ci:test defaults to offline; strict disables temporary quarantine but remains offline; with-external is full. Offline omits named external cases; it is not a recorded replay or a global network outage. |
| **required** | Layer new logic, interface, UI, and real-task tests as described below; align Mock/real APIs with consumer contracts; obtain authorization and account for costs separately for product, Driver, and Judge calls. |
| **gap** | Target layering, shared interface contracts, call-source/budget reporting, and real-task coverage are not yet fully closed. The implementation plan records actual gaps and their handling order. |
| **advisory** | Measure stability and speed using first-run failure rates and elapsed time for the same scope and environment; do not claim improvement by reducing assertions or increasing retries. |

Actual projects and cases are determined by testMatch and dependencies; do not infer model costs from names such as smoke/live. A skip due to missing configuration means only that the case was not run; do not record product tokens as zero when no data is available.

<a id="总体结构与关键决策"></a>
## Overall Structure and Key Decisions

```text
Requirements / change risk
  ├─ Logic → fixed inputs, dependency-port fakes → unit assertions
  ├─ API → real routes/services, isolated storage → interface and data-invariant assertions
  ├─ UI → PDFE Mock API/SSE, real shared UI → control and state assertions
  └─ User task → real client/backend/necessary models and tools → LLM-driven operation, independent review
                     └─ reuse programmatic checks for terminal states, artifacts, and security facts
Report each layer separately → assign defects to the original Owner → add regression at the lowest reproducible layer
```

| Decision | Choice and Rationale | Rejected Approach and Cost |
| --- | --- | --- |
| Execution system | Reuse Node/Python for logic and APIs, PDFE/Playwright for page states, and assign real tasks to B; retain native integration. | Running every check end-to-end against the real system increases external dependencies, cost, and failure-triage time. |
| Run selection | Cases declare product-model and external prerequisites; retain existing profile and named-skip semantics. | Splitting cases into zero/nonzero-token groups by directory would misclassify mixed workbench/package scenarios. |
| Test isolation | Reuse the shared startup path and fixtures to construct independent initial state. | Changing production configuration precedence, persistence, or registry for isolation changes the system under test. |
| Basis for passing | Assert observable invariants, state transitions, and real side effects; constrain model text with stable structure/facts. | Exact answer matching is brittle. Adding model scoring to a test facility makes it B's evaluation and must not be represented as programmatic regression. |

Logic/API/UI/task are layers based on observation objectives; A/B classify by driver and judgment method; L1–L4 describe execution timing; model-call source defines cost attribution. These four dimensions do not imply one another, and a single file may still contain checks from different layers.

<a id="测试分层与共享契约"></a>
## Test Layers and Shared Contracts

<a id="目标分层与选层规则"></a>
### Target Layers and Layer-selection Rules

| Layer | System Under Test and Dependencies | Main Assertions | Does Not Prove |
| --- | --- | --- | --- |
| Logic unit / A | Pure functions, reducers, state machines, transformations, and policies; fixed inputs and existing port fakes | Outputs, state transitions, combination boundaries | Route wiring, real storage, or DOM |
| API interface / A | Real routes/services and isolated SQLite/files; substitute only external dependencies outside the system under test | Parameters, authentication/authorization, responses/errors, SSE order and terminal states, transactions, idempotency, reopen/readback, and rejected side effects | Full UI reachability or real model quality |
| PDFE UI / A | Mock HTTP/SSE/controlled Bridge with the real product renderer, components, and styles | Loading/empty/error/retry states, forms/pagination, focus/keyboard, themes/narrow windows, and layout | Real authentication, backend/disk side effects, or model/tool execution |
| Real task / B | Real client, backend, storage, and any models/tools required by the task; synthetic raw inputs | User goals, real terminal states, artifact facts, content semantics, and experience consistency | Unselected exception matrices or full-platform release acceptance |
| Native special evaluation / original Owner | Electron main/preload, IPC, processes, browser-native surfaces, install/update | Capability boundaries, security refusals, lifecycle, and platform semantics | A real host or signed-install pass inferred from a Mock Bridge |

Choose a layer by asking "which invariant needs what minimum real dependency?" Do not classify by filename, directory, or runner name. Replacing fetch in `api.test.ts` proves only the client request/parsing contract, not backend interface behavior. Checking only a JSON schema does not prove a route reaches real storage. Component render tests may continue to verify local DOM, but cross-page state combinations should use PDFE rather than duplicating pages or maintaining a full Mock service per suite.

<a id="按变更风险选择验证层"></a>
### Select Verification Layers by Change Risk

The development task's delivery owner (which may be Codex) proposes the minimum necessary scope based on this diff and actual consumers, then checks invariants against confirmed requirements and original Owner contracts. B maintains criteria and results for real tasks within that scope. Ask the relevant Owner to confirm only when expectations or ownership are ambiguous; do not add human waits to routine checks. Deliver this judgment with the existing task description; do not create an approval role or mandatory matrix. The minimum necessary scope is the union of the risk areas below and existing required gates, not a replacement of existing acceptance with lower-layer passes.

| Change Impact | Primary Verification | Additional Real Observation Required |
| --- | --- | --- |
| Pure logic, transformation, or policy | A unit tests | Follow consumer impact; do not call a model by default when external behavior and wiring are unchanged. |
| Page state, controls, and layout | A's PDFE UI; render may cover local DOM | Retain real page evidence when normal product results are affected; B checks the corresponding real flow when cross-layer wiring is involved. |
| API, error semantics, or storage | API Owner's real interface/data integration; A checks UI consumption | B checks the corresponding real flow when user-action results, persistence round trips, or cross-layer protocols are affected. |
| Model, Prompt, tool, authorization, orchestration, or delivery artifact | B's affected real tasks; A adds rule/interface/UI regression | List representative tasks, terminal states, and artifact/side-effect facts; page quick evaluation alone is insufficient. |
| IPC, native lifecycle, or install/update | Original Owner's platform-specific checks and existing hard assertions | Accept against affected platforms and artifacts; LLM does not replace native security or signing checks. |

If a required real task lacks a baseline, environment, permission, or budget, retain it as not accepted for that feature and explain the exact gap. Do not cancel a required task because page quick evaluation can run, and do not initiate model requests or expand side-effect permissions on your own. For tool/document-only changes, check their real consumers; do not start the product or run a model just to fill a layer.

<a id="共同真源与最小交接"></a>
### Shared Sources of Truth and Minimal Handoffs

| Information | Sole Owner and Consumers |
| --- | --- |
| Business expectations | Confirmed by the requirements Owner; A, PDFE, and B cite the same confirmed requirement and do not approve separate standards. |
| HTTP/SSE/Bridge semantics | Owned by the original interface Owner; PDFE adapters and A's real-interface and consumer tests check it together. Mocks are not the protocol source of truth. |
| UI scenarios and instance state | PDFE Owner owns policies, seeds, and ledger; A consumes controls and states without copying pages or a full Mock service. |
| Real tasks and independent judgment | B owns task criteria, frozen inputs, and results; the original Owner provides factual observations. Hidden references must not enter the Driver or product. |

In the existing task description, test description, or scenario build for an affected feature, retain enough traceability to link "confirmed requirement/existing requirement ID and applicable revision → related test/scenario/real-task link → each layer's objective and gap." When no stable ID exists, cite the confirmed requirement; do not create an ID scheme for a simple change. Do not require metadata registration for every unit test or create a master table, registry, or four duplicate lists. Store an association once and have other assets reference it; update it only when an affected link, condition, or expectation changes.

`catalog` and `previewConsumption` continue to own links from pages/scenarios/states to UI tests; do not turn them into a business requirements library or claim they already map requirement IDs. B's requirements/build continues to own the evaluation baseline. Express its relationships to A/PDFE with ordinary links; do not require new fields, adapters, or machine protocols. Send expectation conflicts to the requirements Owner and interface differences to the interface Owner for contract review. Preserve the original requirement and failure; do not automatically choose a new standard based on implementation, mocks, or model judgment. Mark affected checks as blocked for now; independent items may continue.

<a id="codex-增量维护边界"></a>
### Codex Incremental-maintenance Boundaries

Codex uses the layer-selection and handoff rules above in existing development tasks: requirements/diff → Owner and consumers → affected checks → layered results and evidence → defect feedback. This does not introduce a new scheduler, Skill, or background automation. A task maintains only the affected logic tests, interface checks, PDFE scenarios, or evaluation baseline; rescanning the entire library, rebuilding all baselines, or running every model task is not a prerequisite for each change.

For refactors/fixes that do not change requirements, retain evaluation expectations; when dynamic input values change, update only this run's reference. When confirmed requirements change, incrementally maintain the original assets within this task's write authority; if the rationale is unclear, keep the item pending confirmation and do not change standards to turn the result green. In the existing task result, state "no update needed / incrementally updated / blocked and not accepted," with rationale and evidence locations; no new file or duplicate report is needed. Detailed procedures remain with the existing development/evaluation Skill.

<a id="逻辑与真实数据链路分离"></a>
### Separating Logic from Real-data Flows

**required**: Business-logic unit tests use fixed inputs and mocks/fakes at existing dependency ports. They do not connect to SQLite (including in-memory SQLite), a real backend, or a model, and do not start a browser, native process, or compiler. Cover combination boundaries for data transformations, reducers, and decision rules at this layer; do not mock the core logic under test. DOM, focus, and keyboard interactions belong to real-browser render tests. Their API/bridge may be mocked, but the result is not product acceptance.

Real SQLite, filesystems, routes to storage, reopen/recovery, idempotency, transactions, and security refusals belong to data-flow integration tests. IPC/processes, real network timing, and compilation belong to native integration tests. B evaluates critical cross-layer user tasks with real Electron and the backend; retain existing programmatic real-flow tests until equivalent coverage and gate changes are confirmed. Mock layers verify consumers only and do not replace real-data invariants. Do not turn all parameterized tests into expensive end-to-end tests, or replace existing storage/security assertions with fakes and remove their original coverage. Test layers are independent of offline/full, strict, and L1–L4.

**required**: When reusing file/worker-level browsers and servers, isolate context and state per case and retain failure-path cleanup; do not share a mutable database across cases. Do not repeatedly build or publish for ordinary logic tests, but retain real build/native gates. When partitioning coverage, retain the denominator and threshold; do not assume c8 covers independent Chromium/Electron execution.

Source regex checks lock down semantic wiring only and follow the feature-level proportion limits in the acceptance standards. Event names and protocol values belong in the original constants/contracts; do not create a production bypass for tests. Tighten coverage targets gradually using real reports; do not lower existing thresholds.

<a id="pdfe-稳定性与-mock真实契约"></a>
### PDFE Stability and Mock/Real Contracts

**required**: Give each case an independent instance ledger/scenario state. Operate through product controls and the original API consumer path; do not directly fill the Store or dispatch internal events. Wait for observable state/request results; do not use fixed sleeps or retries to hide race conditions. Observe bounded animation completion, focus, and scrolling in the real render, and clean up failure paths too. Prepare loading, failure, delay, and event sequences only for the selected objective; do not add production test branches.

**required**: The interface Owner aligns mocks with real interfaces for the UI's actual consumption scope, checking fields, nulls, pagination, errors, authorization, and SSE ordering/terminal states. PDFE does not need to reproduce the entire backend. Explicitly describe deviations for known failure scenarios; unknown requests must not fall back to success. Extract shared assertions into the original Owner only when there is stable reuse value. Otherwise retain small independent tests and contract references; do not add an adapter layer merely for uniformity. Reusing definitions does not mean generating expected values from the same implementation; assert real routes, storage, and security side effects independently.
**gap**: The current shared contract is not fully wired; do not infer completion from the name `preview-contract`.

Map requirements to layers using the minimal handoff above; Mock definitions cannot approve product requirements on their own.
[preview report](../../preview/report.ts) describes declared test associations only; it is not a run-pass or acceptance report.

<a id="稳定性与反馈时间"></a>
### Stability and Feedback Time

Do not reduce correctness, security, or necessary coverage for valid current requirements. Subject to that constraint, test quality depends on first-run stability, total feedback time, and maintenance cost. Lower-layer state combinations should not depend on real models/network. Isolate state and asynchronous resources between scenarios. An intentional delay in a tested scenario is an input condition, not an arbitrary wait to remove; do not shorten it to hide a race.

Measure first-run failures/skips/retries and full wall-clock time under the same version, platform, scope, and resource conditions, including preparation, execution, waiting, reporting, and resource release. Explicitly mark phases as unknown when existing timing cannot be decomposed; do not infer build/cleanup time by subtraction. Retain first failures; do not claim stability based on a green retry. For routine changes, prioritize affected low-cost checks and reduce duplicate builds, preparation, and wasted waits; do not speed up by deleting assertions. Render fixtures in one file with no mutable server state may reuse the existing Vite/Chromium host, but each case must create an independent BrowserContext to isolate routes, storage, DOM, and store. Close the context after each case and release the host and cache after the file. Do not generalize this reuse to services with mutable request queues or to real Electron. Refer to the [existing tiered targets](../../../../docs/runbooks/development.md#验证分层与-ci-编排器); do not set separate thresholds for this system. Slower full/native checks cannot be presented as rapid editor-loop feedback.

State sample size in stability conclusions and cache, load, and execution scope in performance comparisons. A small number of all-green runs is preliminary evidence for this run only; it does not prove a long-term absence of flaky behavior. Do not claim a speedup without a comparable baseline. Repeatable source, test files, or mocks do not directly prove stable execution. Record specific samples, bottlenecks, and follow-up batches only in the implementation plan.

Trigger verification by impact, not commit count: for a small change, run the minimum RED/GREEN checks, affected cases, and necessary static checks; after completing a same-responsibility refactor, run the full module checks; after cross-module interfaces stabilize, review before freezing integration/PDFE, then close out against the required delivery scope. Check invariants early for changes to shared mocks, Electron lifecycle, security, collectors, and reporting flows. Locate failures before targeted retesting; reuse version evidence proven unaffected by unchanged code. Documentation-only changes do not start Electron or models. Do not repeat full PDFE, the whole library, or smoke checks for every small commit.

Do not set an aggregate deadline for full Desktop unit tests or the serial native follow-up stage; let cases and resource cleanup finish naturally. Retain per-case timeouts, explicit cancellation, nonzero failure exits, and report-integrity constraints. Do not apply this no-aggregate-deadline policy to the fixed packaging gate.

For mixed browser/compilation resource supplements, follow the Desktop Owner's serial-file policy; root CI does not increase host concurrency using a generic CPU quota. Independent CPU phases for logic/API may run in parallel under their Owner's quota; do not create a generic worker pool to resolve contention. Partition logic coverage and real-Electron probes into mutually exclusive parts of the same collection manifest. Native probes reuse the existing serial phase; do not run them concurrently with c8-instrumented logic files. Do not add runners or duplicate manifests, and do not reduce native security assertions. Keep policy gates separate from temporary scenario isolation; scenario quarantine must not expand into skipping an entire runnable policy gate. Root CI and domain entry points reuse Owner recipes; an aggregate test and its submodules retain only one continuously executed entry point. Persistence-lifecycle assertions requiring a real compiled library belong to the native subset. The owning test file prepares that real capability once through the existing compile Owner; missing input or compilation failure is a failure, not a reason to skip logic tests due to a missing manually set environment variable.

The fixed packaging gate is the complete `pnpm ops ci test smoke`, not the Playwright smoke project or the full PDFE suite. Run it for every actual package build; during development, verify it in advance when relevant infrastructure changes or delivery is frozen. The [smoke manifest](../../../../scripts/ci/smoke.json) is the source of truth for budget and required cases. Full subprocess wall-clock time must not exceed 900 seconds, including preparation, collection, execution, reporting, lock cleanup, and exit. Timeouts, omitted cases, unexpected skips/retries, corrupt reports, or cleanup failures must exit nonzero and block packaging; do not meet the limit by raising it, using quarantine, or force-killing processes.

<a id="真实链路交接与缺陷回流"></a>
### Real-flow Handoff and Defect Feedback

B owns completing user tasks from raw inputs through real pages, with an independent Judge synthesizing the review against frozen criteria. Programs verify file contents/summaries, business terminal states, authorization scope, cancellation convergence, and real side effects; model visual inspection does not replace security or persistence assertions. A page-click ack, HTTP 200, or model self-report does not mean success. PDFE screenshots and simulated events are UI regression evidence only, not B's real-flow results.

For the same requirement, separately record the objectives and gaps checked by logic, API, UI, and real-task layers; do not add their percentages together. Route defects found and confirmed by LLM back to the lowest layer that can reproduce them stably and add programmatic regression there. Retain checks requiring a real host/model. When migrating a still-valid check, list the original check, receiving layer, consumer, and verification evidence; do not remove necessary coverage before it is covered elsewhere. Clean up items confirmed retired with no continuing use according to the scope above; do not perpetuate old product forms.

<a id="准备操作观察与报告"></a>
### Preparation, Operation, Observation, and Reporting

The table below describes high-level logical interfaces. Extend specific fields within the original Owner; do not create a generic intermediate protocol.

| Interface | Provided/Maintained by A | Usage Boundaries for B or the Runner |
| --- | --- | --- |
| Preparation | Non-secret material identity, Home/profile/workspace, and cleanup ownership; reuse e2e/fixtures | B may read-reference materials and preparation contracts; do not copy fixtures or seed hidden answers into the product. |
| Operation/observation | Existing product entry points such as the main harness; operation acknowledgments, session/turn identity, DOM/artifact facts | A's programs and B's Driver may both consume these. A successful ack does not mean the task succeeded; new capabilities belong to the original code Owner. |
| Run record | Case/version/platform, input identity, model prerequisites, attempt, status, product usage, and evidence references | Reuse existing runner reports and add only missing facts; B cites evidence and does not treat a Test as the sole basis for semantic conformance. |
| Defect handoff | Case, actual observations, expectation rationale, failure source, and evidence location | The run owner retains investigation/reporting responsibility; code fixes belong to the original product or tool Owner. |

Observe conversation terminal state, background-task terminal state, and artifact visibility separately. For cancellation, verify actual stopping and final side effects. Recover using the original session/run identity; do not substitute reseeded results for recovery. Do not use a window-preserving drive to prove native close behavior.

The default mixed Python suite retains its original module entry point and unittest lifecycle. Any unittest defined in a module must be executed by the runner; verify that the plan is nonempty, successful runs omit no planned cases, and the same subprocess returns the expected acknowledgment. Handwritten quiet scripts report suite-level results, not fabricated per-case coverage; nonempty stdout is not proof of execution. Retain and list normal conditional skips and expected failures at the default entry point; they do not count as acceptance for the corresponding platform.
Explicit per-case reporting and packaging smoke still require exact identity, complete cleanup, and passage of every required case. Do not use default-entry verification as a substitute for strict per-case judgment. Both modes reuse the [same observer](../../../serve/tests/observations.py) and do not maintain a second case manifest. The default entry point does not alter the caller's runner/result, and neither mode starts an extra process layer.

<a id="运行成本与失败处理"></a>
## Runs, Costs, and Failure Handling

**The delivery owner for each run is responsible for all authorization, budget, and reporting for that run.** A manages product-model costs in A scenarios; B manages product, Driver, and Judge costs in B scenarios. List costs by source; do not attribute product costs from B scenarios to A. When reusing existing evidence, cite its original run and cost instead of counting it again. Account separately for costs incurred by Codex while writing tests during development.

The run plan freezes cases, environment, execution prerequisites, product-model/tool permissions, time/retry limits, and cost ceiling. Cases that do not need a model do not carry a real connection. Cases that do need one use an approved isolated connection; do not automatically fall back to user configuration or switch to another model. Once the budget/timeout boundary is reached, perform no new operations and cancel in-flight tasks through product-supported paths. Report cancellation that does not converge; do not claim it stopped. The driver cannot guarantee exact truncation of costs for requests already sent.

Record execution process separately from assertion conclusions. Missing prerequisites, runner errors, timeout/cancellation, and failed programmatic assertions are not the same product defect; leave attribution unknown when evidence is insufficient. A retry is a new attempt; retain the first failure. Report planned, executed, skipped, failed, and retried cases for the same version/platform; do not write zero for unknown usage/cost. Passing A assertions proves only A's observation objective, not B's open-ended semantic quality.

<a id="与现有准入的关系"></a>
## Relationship to Existing Gates

| Timing | A's Deliverable | Constraints That Remain |
| --- | --- | --- |
| L1 editing | Targeted feedback from affected tests | Accelerates feedback only; does not gate acceptance. Escalate unknown mappings according to existing rules. |
| L2 commit/MR | Deterministic logic/API/UI regression and execution-scope report; trunk/release merges follow strict | Actual execution is determined by existing runners; explicitly disclose named external omissions, quarantine, and unrun items. |
| L3 release | Retain full, ci:package, installed E2E, and authorized product turns; B delivers page quick evaluation and required real tasks determined by change risk. | A required task missing prerequisites remains unaccepted; page quick evaluation is not a substitute. Do not lower existing gates or rewrite quality.json success semantics. |
| L4 main flow | B drives real tasks and reuses programmatic fact checks; retain valid scripted coverage until migration. | Costs/side effects still require authorization; a development build is not an installed build. |

<a id="验证边界"></a>
## Verification Boundaries

Each layer stands on its actual dependencies and observation objective. A real flow does not require all lower-layer coverage work to be complete, but it cannot be claimed accepted without the necessary operation/observation capabilities. Contract checks for cost-attribution tools do not replace actual requests and source evidence; a classifier passing does not prove the real source by inference.

Isolation must not overwrite real user state, copy all sessions, or modify production precedence. For the final version, inspect screenshots, DOM/files/processes, and real side effects. For platform semantics, provide separate macOS/Windows evidence according to the [cross-platform requirements](../../../../docs/runbooks/development.md#跨平台开发与验收); native web views require composed screenshots. Do not substitute a single platform, mock, or healthz for product acceptance. Explicitly mark missing prerequisites as unaccepted; do not adjust production behavior to make tests "isolate successfully."

## Ownership / Dependency

A maintains this overview, deterministic logic/API/UI tests, and retained native/E2E gates. B maintains real-task evaluation, evaluation overview, development Skill, and assets. The PDFE Owner maintains scenario policies, isolation ledger, and UI test surface. Code ownership and dependency directions across Desktop/Serve/Runtime/Adapter/Trace remain unchanged. The technical source of a failure does not change run-delivery responsibility. Review shared-tool changes under their original Owner and have both sides coordinate interface impact.

<a id="正反例"></a>
## Examples and anti-patterns

- Example: PDFE verifies three authorization UI states, interface tests assert the decision and side effects, and B drives a real task to verify authorization and artifacts; retain each layer's conclusion separately.
- Anti-pattern: Use successful mock authorization to prove real tool execution, or ask the Judge to infer database transactions/cancellation from screenshots alone.
- Example: Keep existing scripted real-model checks classified under A and assign new real tasks to B; migrate only after equivalent coverage and gate changes are confirmed.
- Anti-pattern: Reassign to B only because the product calls an LLM, delete existing E2E tests, or claim zero tokens for the entire flow because a facility does not call a model.
- Example: Use simulated responses to verify the consumer, and separately accept the real-model flow under its authorization.
- Anti-pattern: Change a mock or skip a real turn and then claim the product AI feature passed.

## Enforced by

Existing packages, Playwright, adjacent tests, gitlab, and ci:test own execution. See the implementation plan for specific implementation gaps and arrangements; this document creates no new gate. Document checks do not prove that a facility makes zero calls, that a product has zero cost, or that real acceptance passed.

## Update triggers

When adding/changing cases, fixtures, call sources, profile/skip/quarantine, coverage, shared interfaces, or cost attribution, A updates the corresponding section and informs affected Owners. Add tests for new features according to risk; do not create a new core branch per feature. Optimize parallelism/coverage only with evidence from the same scope; reassess the execution choices above when necessary.

## Stop condition

Architecture conclusions stop at the declared layers, dependencies, and evidence boundaries; do not extrapolate to unverified layers or platforms. A sound design does not mean implementation, test migration, or product acceptance is complete. Record execution progress and stage conclusions only in the implementation plan.
