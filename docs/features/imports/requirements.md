<a id="资料-copy-导入需求恢复草案"></a>
# Resource COPY Import: Recovered Requirements Draft

<a id="状态与范围"></a>
## Status and Scope

**Status: Awaiting confirmation by the feature Owner; this is not an approved PRD or release acceptance baseline.**

This draft was recovered using the `spec-miner` method from current specifications, source code, and existing tests, and records bounded product observations already completed. Authorization to include the generated requirements in Git review does not mean each requirement is approved or that the product goal has changed.
Technical and lifecycle boundaries remain owned by [Resource Import and Task Center](../imports.md). This page contains only a draft for requirements review and repeatable verification; it does not create another executor, machine schema, or technical source of truth.

- Analysis baseline: `e0f983706b4b0d05ee8678de47cb286f53db4416`.
- Sources: the import specification in that revision, the ordinary Desktop entry point, the synchronous import API, Resources/Content implementation, version writer, and existing contract tests. Functionality was not inferred from code names.
- Scope: COPY local files into a project resource library, duplicate-name confirmation, renaming, versioned replacement, and version read-back.
- Excludes: LINK, web and literature-attachment imports, as well as cancellation, batch-interruption recovery, and all cross-platform behavior.
- `OBS-01` through `OBS-12` below are stable candidate observation IDs in this draft, all awaiting confirmation by the requirements owner. They are not formal Requirement/Check IDs approved by a technical document. Formal evaluations must be linked to an existing ID for the relevant requirement. If the association cannot be verified, treat the work as exploratory and do not count it toward release coverage.

<a id="两类入口必须分开"></a>
## Keep the Two Entry Points Separate

Ordinary product entry: native picker → ImportDialog → importResourceFiles →
createResourceImport → POST `/api/resource/import-jobs` → background Content COPY →
resource list and version initialization.

Synchronous-capability entry: POST `/api/resource/import` → request/project/resource-root validation → conflict plan →
`needs_resolution` → explicit decision, `plan_token`, `Idempotency-Key` → exact rename or
versioned replacement.

Do not summarize these paths as “all imports already have duplicate-name confirmation.” Backend capability, a conflict component in the UI, or passing source assertions alone do not prove that ordinary users can access the corresponding capability.

<a id="候选功能要求"></a>
## Candidate Functional Requirements

“Should” marks a candidate requirement submitted for review, not one that is approved or accepted. Source evidence supports implementation observations; existing tests support test expectations. Neither alone proves that the product goal is correct.

| ID | Candidate Requirement (EARS) | Applicable Entry and Basis | Known Verification Boundary |
| --- | --- | --- | --- |
| OBS-01 | When a user copies a file without a conflict, the system shall create a content-identical copy in the selected project's resource library and create its initial version. | COPY; import policy and Content; contract check for conflict-free COPY. | A real import and v1 read-back were observed for a specified older revision; this does not mean all formats pass. |
| OBS-02 | When a synchronous COPY plan contains a same-name conflict, the system shall return a pending-confirmation state and plan ID and shall not import the entire source batch before confirmation. | Synchronous entry only; conflict branch in `import_sources`. | Static implementation and existing test expectations; the synchronous entry was not run in this round. |
| OBS-03 | When the ordinary product COPY entry encounters a same-name file, whether the system must first offer rename or replace choices must be confirmed by the feature Owner. | Ordinary UI and background job; entry-point policy is undecided. | No confirmation appeared in the specified older revision; it automatically created a second name. Do not automatically approve this observed behavior as the goal. |
| OBS-04 | When a user confirms a rename, the system shall retain the original file and create the exact new name in the frozen plan, without silently choosing another name if the target changes. | Synchronous confirmation; plan revalidation and Content EXACT creation. | Static implementation and test expectations; automatic renaming does not substitute for acceptance of explicit confirmation. |
| OBS-05 | When the target supports versioned replacement and the user confirms replacement, the system shall retain the exact old bytes, commit the new content, and append a version under the same file identity. | Synchronous confirmation; `commit_versioned_replace`. | The replacement branch was not given real verification in this round. |
| OBS-06 | When a confirmation request is replayed with the same idempotency key and semantics, the system shall return the original result without creating a duplicate file or version. | Synchronous confirmation; mutation receipt and request digest. | Existing tests expect rename/replacement replay behavior; no real replay was performed. |
| OBS-07 | When the plan-bound state of a source or target changes before confirmation, the system shall reject the stale plan without overwriting the updated data. | Synchronous confirmation; plan digest, source revision, and target revision. | Existing tests express rejection of source/target changes; real concurrency has not been verified. |
| OBS-08 | When decisions are duplicated, missing, extra, or inconsistent with the plan, the system shall reject the confirmation request. | Synchronous request model, decision mapping, and conflict-set validation. | Static implementation; not all request combinations or full suite coverage were verified. |
| OBS-09 | When the target is not eligible for versioned replacement, the system shall reject replacement; a same-name directory does not authorize merging, recursive deletion, or replacement. | Synchronous confirmation; backend eligibility projection and replacement-branch validation. | Existing directory and unsupported-type checks; no real acceptance in this round. |
| OBS-10 | When the project, resource root, request structure, and COPY mode have all passed validation, if a planned confirmation request lacks an idempotency key, the system shall return a stable error and shall not enter import execution. | Synchronous entry; `idempotency_key_required` maps to HTTP 400. | Analysis of the explicit source call is complete; other prerequisite errors may be returned earlier. No real missing-key request was sent. |
| OBS-11 | While an import submission is busy, the UI shall prevent duplicate submissions. The replace button shall be enabled only when every conflict item is eligible for replacement. | ImportDialog busy state and backend replacement-eligibility projection. | Static implementation; double click, mixed eligibility, and keyboard paths were not specifically verified. |
| OBS-12 | When a user views version history, the system shall show the history for the corresponding file and allow its version content to be read back; it shall not treat v1 of different files as v1/v2 of the same file. | Version history UI, file identity, and version-content read. | Both files' respective v1 contents were actually read back for the specified older revision; this does not prove a complete recovery or replacement lifecycle. |

<a id="源码与测试依据"></a>
## Source and Test Basis

The following entry points correspond to the analysis baseline. Update the mapping if source moves or behavior changes; old line numbers do not prove behavior in a new revision.

| Responsibility | Basis |
| --- | --- |
| User import and conflict interaction | `importSources`, `resolveConflict`, and `canReplace` in [ImportDialog](../../../apps/desktop/src/renderer/src/features/resources/ImportDialog.tsx) |
| Ordinary and confirmation actions | `importResourceFiles` and `resolveResourceImport` in [store](../../../apps/desktop/src/renderer/src/store.tsx) |
| Frontend requests | `createResourceImport` in [background jobs](../../../apps/desktop/src/renderer/src/features/resources/imports.ts); `importResources` in the [synchronous API](../../../apps/desktop/src/renderer/src/features/resources/api.ts) |
| Backend entry and validation | `resource_import` in the [synchronous route](../../../apps/serve/service/resources/api/routes.py); `ResourceImportRequest` in the [request model](../../../apps/serve/service/resources/api/schema.py) |
| Planning, decisions, and replay | `_plan`, `_decision_map`, `_replayed`, `import_sources`, and `_execute` in the [import policy](../../../apps/serve/service/resources/service/importer.py) |
| Background execution and I/O | [jobs](../../../apps/serve/service/resources/service/jobs.py); `plan_import_sources` and `import_sources` in [Content](../../../apps/serve/service/content/service/port.py) |
| Versioned replacement and receipt | `commit_versioned_replace` and `product_mutation_receipt` in [history](../../../apps/serve/service/resources/service/history.py) |
| Existing checks | [Import contract](../../../apps/serve/tests/contract_resource_import.py); [frontend checks](../../../apps/desktop/src/renderer/src/resources.test.ts), some of which are source assertions and do not prove that the real UI is reachable |

Recovery capability for a single-file mutation does not promise atomic commit of the entire batch. Verify progress, task terminal state, resource visibility, and actual contents separately. There is no basis for a performance SLA; do not infer performance requirements from the word “background,” a constant, or a single elapsed-time measurement.
Content and the current import specification own security boundaries. This draft must not expand path, project, or source permissions.

<a id="重复验证场景草案"></a>
## Repeatable Verification Scenario Draft

These scenarios are for people to read; they are not fields in a delivered runner. For each run, pin the source/artifact, single environment, input files, and required revision; use an independent initial state and preserve first-run failures. Number retries separately; do not retry until green.

| Scenario and Links | Given / When | Then and Required Observations |
| --- | --- | --- |
| A Conflict-free copy, OBS-01/12 | An isolated project has no same-name file. Use the ordinary UI and native picker to copy a test file containing an `original` marker. | The item is visible in the list; source and copy bytes match; history contains only the initial v1 and can be read back; source and other projects remain unchanged. |
| B Same name in ordinary entry, OBS-03/12 | A is set up. Another source directory contains a same-name file with an `incoming` marker. Import through the same UI. | Record whether confirmation appears, what the user selects, and when the first write occurs. If the Owner approves a requirement for prior confirmation, there must be no import before selection. A final list screenshot alone cannot prove that no dialog appeared during the whole flow. Check both contents, file identities, and history. |
| C Explicit decision, OBS-02/04/05/09/11 | Enter conflict confirmation through an approved real entry point; select rename and replace from separate baselines. | No import occurs before confirmation; rename retains the original and creates the exact new name; replacement retains the same identity and old bytes and appends a version; unsupported eligibility, busy state, and errors are observable. |
| D Failure and replay, OBS-06/07/08/09/10 | Construct source changes, target changes, repeated confirmation, invalid decisions, invalid replacement, and a missing-key request separately. | On rejection, check the error and ensure the target/history did not change improperly; replay creates no duplicate file or version. Check UI, interface, and actual side effects independently; do not present an API probe as a user path. |

Terminal screenshots, raw requests/responses, file digests, and version read-back are distinct observations. If necessary evidence is missing, mark `inconclusive`; if not run, mark `not_evaluated`. Only after approval may each item receive pass/fail against frozen criteria. Do not replace semantic and user-path judgment with keywords, counts, passing tests, or product self-report.

<a id="已有运行概要与未覆盖"></a>
## Existing Run Summary and Coverage Gaps

On 2026-10-21, two Markdown files with the same name but different contents were imported in sequence through the native picker using real Electron, renderer, Serve, and an isolated test data root on macOS arm64 at the analysis-baseline revision:

- The first file retained the original marker and created v1.
- No duplicate-name confirmation was observed on the second import. The ordinary UI requested a background import job and automatically created a file suffixed with `(2)`.
- The original file bytes were unchanged, and the new file contained the incoming content. Each of the two independent `file_id` values had only its initial v1; the corresponding historical content was read back through the UI, and no v2 was appended to the original file.

This is a revision-bound run summary, not evidence that the latest target branch passes, and it does not establish that the synchronous replacement API is faulty.
Detailed screenshots, requests, and logs remain in a local ignored run directory under the governance rules. This page provides independently reproducible preconditions, steps, and criteria; it does not make a personal path or local attachment the team's only requirements record.
Replacement, replay, stale plans, directory restrictions, batch interruption, recovery, and Windows have not received real verification. This documentation addition does not restart the product, call a model, modify production code, or declare the full feature accepted.

<a id="待负责人决策与维护"></a>
## Owner Decisions and Maintenance Needed

1. For a same-name collision in ordinary COPY, should the user confirm first, or may the background process rename by default? Keep OBS-03 pending until confirmed; do not treat the observed automatic rename as an automatically approved expected baseline.
2. If entry-point policies differ, specify which user entry points use synchronous confirmation so API capability is not mistaken for UI delivery.
3. Establish release-coverage links only after confirming the applicable requirements, Owner, and existing formal requirement IDs. Do not automatically generate formal product IDs or relax criteria to retroactively approve existing behavior.
4. When requirements are approved, entry points change, plan/version contracts change, or observation capabilities change, the requirements owner maintains status, the evaluation owner reviews links and evidence, and developers update the current technical source. These responsibilities do not substitute for one another.
