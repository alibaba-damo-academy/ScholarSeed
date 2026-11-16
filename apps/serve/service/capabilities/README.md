<a id="本地插件作者契约"></a>
# Local Plugin Authoring Contract

The Skill Center provides an “Add Skill” upload entry and a “Create with ScholarSeed” task entry, and displays the system-bundled `plugin-create`. The creation entry reuses existing project selection, requirement input, and Skill enablement confirmation; it does not bypass task admission or directly run a model. Enabled plugins, checked candidates, and installation cards can all preview conversation components. Preview does not grant business permissions; installation still requires explicit inspection and confirmation.

<a id="当前范围"></a>
## Current Scope

The current source provides an author CLI, the product `plugin-create` Skill, candidate checks, conversation-component previews, explicit installation confirmation, enabled-component registration, and a generic interaction entry. After installation, the workflow is still driven by Skill instructions and tools; custom JavaScript is rendered in the conversation and does not create a standalone plugin page. Component availability depends on its enabled state in Settings, not on the user first entering `/技能` (the “/Skills” command); enabling does not render it immediately or automatically execute the entire Skill. This document describes implementation mechanics; it does not mean that real-product, four research workflows, or cross-platform acceptance has passed.

Plugins continue to use the existing Skill ZIP and `.scholarseed-package.json` integrity manifest. The new `.scholarseed-plugin.json` describes the plugin only; it cannot replace the package manifest or use `.scholarseed.json` to masquerade as a bundled Skill's permissions. The current protocol uses a root `SKILL.md` as its entry point.

<a id="离线-cli"></a>
## Offline CLI

Run in a Python environment with the product backend installed:

```bash
python -m service.cli.plugins describe
python -m service.cli.plugins describe --identity
python -m service.cli.plugins prepare ./contract.json
python -m service.cli.plugins validate ./my-plugin/.scholarseed-plugin.json ./request.json
python -m service.cli.plugins --host-version 0.2.0 pack ./my-plugin --name my-plugin --version 0.1.0 --output ./my-plugin.zip
python -m service.cli.plugins --host-version 0.2.0 check ./my-plugin.zip
```

`--host-version` explicitly selects the compatibility-check target; if omitted, the version of the installed `scholarseed` distribution is used. In a source checkout, the verified interpreter may be used with `PYTHONPATH=apps/serve` as specified by the development conventions; this does not make a source check equivalent to acceptance of an installed product.

All output is JSON. `describe` returns the actual Pydantic JSON Schema; `pack` reuses the existing Skill packer, does not execute scripts in the source directory, and does not overwrite an existing ZIP; `check` verifies file digests, descriptor identity, compatibility range, and declared resources in the actual ZIP. Exit code 0 means the corresponding offline check passed; 1 means it failed. Command-line argument errors retain argparse's nonzero exit code.

`describe --identity` returns the contract `version` and the SHA-256 of normalized content. Full `describe` includes the descriptor schema, component-request schema, SDK state shape, and message-size limit. Static contract exploration may be skipped when both exactly match the author's snapshots; this is not a Desktop version and does not waive checks for the current slot, permissions, dependencies, or installation. `validate` checks the complete request and that slot's input schema. It does not create an interaction, reserve a slot, or grant permission. Errors for required fields return the field path and missing field name without echoing user input; fix that field rather than deleting other materials or populated values to pass validation.

A running Agent can call `component/preflight` through `scholarseed_bridge`, passing `{"slots":["research.my-selection"]}`. The result reports whether each slot is available and any occupied/reserved reason. It includes occupied slots that are not currently visible, without exposing other plugin contents. If the registry is unavailable, the call fails explicitly; unknown is not treated as free. The check does not reserve resources, so installation and enablement must check for races again.

<a id="创建方式"></a>
## Creation Workflow

When using the product `plugin-create`, first state the research objective, input sources, user decision points, deliverables, and prohibited side effects. After the AI clarifies necessary gaps, it generates source code, preview scenarios, and a ZIP. The user inspects and previews it from the installation card, then explicitly installs it. Successful creation does not mean the generated Skill is actually usable; verify card callbacks and subsequent workflow with real materials.

`prepare` checks the local contract snapshot against the current host contract once. If they match, it reuses the snapshot; otherwise, it returns the current contract without repeating discovery. It grants no permission and reserves no slot; dynamic conflict and installation-safety checks still run. Publishing an installation card returns only `published` and the fixed package identity. It does not mean installation succeeded and does not block the creation conversation. Each revision in a multi-turn edit uses a new version, ZIP path, and request ID; old cards still point to the old package. The user can preview, install, or retry later without resending the creation message.

Product sessions use the author CLI through `scholarseed-skill-python -m service.cli.plugins`. The entry point dispatches only registered product command handlers; it does not execute arbitrary `-m` modules or accept subcommands for installing plugins or Python dependencies. Bundled Skill scripts are no longer checked against the factory inventory before execution; product Python script-path restrictions and session authorization remain unchanged, and ordinary task Python does not gain the product environment.

Product sessions invoke the authoring CLI with `scholarseed-skill-python -m service.cli.plugins`. Only registered commands are dispatched; arbitrary modules, plugin installation, and Python dependency installation are not supported. Bundled Skill scripts no longer have to match the build inventory to run. Script path restrictions and session authorization still apply; ordinary task Python stays separate from product Python.

The product Skill's [scaffold.py](../../../../skills/community/plugin-create/scripts/scaffold.py) provides a display-only OpenUI comparison template. The package includes a fixed layout, input schema, and sample, but no JavaScript or legacy UI SDK dependency. At runtime, the Agent passes business data through a dedicated slot; preview and production display reuse the Desktop OpenUI Renderer. The template does not support confirmation, drafts, or a workbench. Existing executable plugins continue to use the original SDK. The script does not install plugins; after changing the workflow, layout, and sample, package it with the author CLI and preview it in the host. `pack` has checked its output bytes; ZIPs from external sources or that have changed must be checked again.

Component authors should use the [Interaction Guide](../../../../skills/community/plugin-create/references/interaction.md) and [Test Template](../../../../skills/community/plugin-create/references/testing.md); scientific analysis workflows must also follow the [Evidence Standard](../../../../skills/community/plugin-create/references/evidence.md). Preview uses the same component and bridge, replacing only the execution side with sample business responses. Standalone HTML can carry a sample experience, but cannot replace acceptance of host isolation, permissions, or the real waiting workflow.

`pack` accepts directories only, and output must be outside the source directory. Dependency declarations in an existing `.scholarseed-package.json` are retained by default; they may also be specified explicitly with `--dependencies <JSON文件>` (`JSON文件` means a JSON file). The dependency format reuses the existing reviewed-dependency declaration rules, but the tool does not install dependencies, run probes, or claim that the declared dependencies are actually usable. If the source has no dependency manifest, it is treated as an empty declaration; authors must explicitly add any required dependencies.

<a id="最小声明"></a>
## Minimal Descriptor

```json
{
  "schema": 2,
  "id": "my-plugin",
  "version": "0.1.0",
  "host": ">=0.2.0,<0.3.0",
  "skill": "SKILL.md",
  "capabilities": ["interaction.answer"],
  "components": [{
    "id": "method-selection",
    "slot": "research.method-selection",
    "entry": "components/selection.js",
    "preview": "components/scenario.json",
    "input_schema": {"type": "object"},
    "output_schema": {"type": "object"},
    "actions": [{"id": "select", "capability": "interaction.answer"}]
  }, {
    "id": "question",
    "slot": "interaction.question",
    "public": true,
    "preview": "components/question.json",
    "actions": [{"id": "choose", "capability": "interaction.answer"}]
  }],
  "configuration": []
}
```

The plugin ID and version must match the Skill in the final package. `components` may be empty. A custom component supplies a package-local UTF-8 JavaScript `entry`; a public reference uses `public: true` and omits `entry`. A preview is a JSON object containing `data` and `responses`; `responses` must cover exactly the component's actions, with each response containing `state` (`resolved`/`failed`/`cancelled`) and `data`. Component IDs, slots within one package, and action IDs within a component must be unique. Custom slots across all enabled plugins must also pass the host's mutual-exclusion check; plugins do not own public slots. File existence and valid encoding do not prove code safety or correct browser execution.

`input_schema`, `output_schema`, and an action's `input_schema` default to `object`. The host-published restricted JSON Schema may be used; external references and unsupported keywords are prohibited. The host validates input when creating a custom interaction, and validates action input and results when an action is returned. See [descriptor.py](service/descriptor.py) for the exact supported scope; generic JSON validation is not literature authorization or project-access validation.

An action consists of `id` and `capability`; capability names use the `能力.操作` form (capability.operation) and must also appear in `capabilities`. This describes a request only; it cannot add arbitrary HTTP routes, host imports, or launch commands. The offline CLI has no trusted runtime capability registry, so it always explicitly returns `capabilities_verified: false`; the existence of an operation in Agent Bridge does not mean the UI can call it.

Configuration fields include `key`, `type`, `label`, and optional `required` and `default`. Currently only string/integer/boolean are supported, and defaults must match their types exactly. Manifests cannot carry credentials or a secret type. Defining configuration does not mean it has been saved or injected into the runtime environment.

Type checking does not automatically detect secrets in ordinary strings. Developers must still review configuration and resources; rejecting a secret field type is not comprehensive credential-leak detection.

<a id="报告语义"></a>
## Report Semantics

- `valid`: no errors were found in this offline structural check; warnings are not suppressed.
- `validation_stage: offline`: UI rendering and product runtime validation have not yet been performed.
- `integrity_verified`: the ZIP file set, sizes, and digests passed the existing package checks; this is not a signature or security-audit conclusion.
- `capabilities_verified`: can be true only when the caller provides a real host capability set; the CLI does not fabricate a registry.
- `dependencies_verified: false`: a valid declaration format does not mean dependencies exist or are approved for installation.
- `authorized: false`, `runtime_verified: false`: offline tools cannot conclude that authorization or runtime checks passed.
- `sha256`: the identity of the complete ZIP checked this time. Before later installation, check the same bytes again; do not reuse a conclusion about a mutable directory.

Resource paths reject absolute paths, parent directories, drive letters, backslashes, ambiguous separators, Windows reserved names, and encoded paths. Descriptor and preview JSON reject duplicate keys, non-finite numbers, and oversized data. Checks do not fetch dependencies, write to the user's installation directory, or create runtime state.

<a id="桌面使用与授权"></a>
## Desktop Use and Authorization

In Skill settings, add a local ZIP and select “Check Plugin.” The report shows package identity, SHA-256, requested capabilities, and diagnostics. Preview uses sample data in the native conversation-card container and does not submit a business request. Only installation confirmation in the trusted main window consumes a candidate and installs its original bytes. Candidates expire after 15 minutes, with a maximum of 4; identical content reuses a candidate, and exceeding the limit evicts the oldest candidate. Old reports must be checked again. The regular Skill upload entry rejects plugin packages, and an existing plugin cannot bypass authorization through a regular overwrite installation.

For a first installation, the user may install without enabling; on a slot conflict, the component must not be reported as available. Enablement and updates first check the complete candidate registry. A conflict returns the slot and occupying plugin, without silently overwriting anything. If an update introduces a conflict, publication is rejected and the old installation and registration are retained. Installation confirmation, version switching, and enabled-state coordination are owned by [routes.py](api/routes.py); regular Skill upload cannot bypass plugin installation confirmation.

Public components are loaded according to their registration source: UI 1.0's `literature.selection` comes from a separate official resource package; the host still implements the other public components. Custom components load from a validated research-plugin package. A tool or business event creates a persistent interaction, and the host resolves its slot; code is not selected using a version or fingerprint supplied by the model. The literature gate still owns paper-scope and authorization rules. The component only proposes a selection; after validation, the original tool receives the result and continues the workflow. The Skill descriptor version identifies its task, while the UI content digest binds the component; neither substitutes for the other.

<a id="官方-ui-20-系统依赖"></a>
### Official UI 2.0 System Dependency

Desktop independently builds `ui.zip` from the [UI resource Owner](../../../../packages/ui/README.md), distributes it with Desktop, and verifies it at startup while coordinating the system dependency. It is not a Skill and has no regular disable, uninstall, or manual-update entry; regular plugin upload and confirmation reject UI resource packages. Component resources are not thereby recompiled into the host renderer. Manifest integrity does not authenticate publisher identity; an arbitrary local ZIP claiming to be official is not a trusted source.

A research package may declare `ui: {"compatibility":"2.0","exports":["React","mount","Button","Checkbox"]}`. The host resolves public-slot references to official implementations; exported base controls are available to custom code, but do not register cards or grant additional permissions. The compatibility version is separate from the resource `version`. The current resource major version is 2.0 and removes official UI for input, process, confirmation/clarification, and error recovery. Native business workflows are not removed; old 1.0 resources retain only their original immutable snapshots, and old bindings are not reinterpreted with the new major version.

Each new binding pins the research package and UI byte digest; resources load within the same isolation lease. Updates switch only the resources used by new bindings. Existing bindings, data, drafts, permissions, and action semantics are not overwritten. The current declarative host supports only `host-v3`; cards for unsupported older hosts appear unavailable while retaining their data. Old resource snapshots are conservatively retained and are not automatically reclaimed; this preserves runtime snapshots and is not a platform for choosing among multiple versions.

Preview also pins resources and reuses the same components, bridge, and action validation, with sample business responses. If dependencies of a checked research candidate have changed, installation is rejected and a new check is required. A UI update within the same compatible major version must not remove existing exports or change the public action contract; breaking changes require a new major version and updated consumers. A static manifest cannot prove JavaScript semantic compatibility; package-level regression and actual preview validation are still required.

<a id="对话槽位与数据"></a>
### Conversation Slots and Data

| Public slot | Complete interaction and boundary |
| --- | --- |
| `interaction.question` | Prerequisite questions, options, notes, confirmation, and submission state; continues the original waiting request |
| `display.literature-search` | Search summary and full-result viewing; preserves the original detail operations |
| `preview.literature-results` | Full results, filtering, pagination, sources, import, and categorization interactions; `preview` in the name does not grant permission for sample data to write to real business state |
| `literature.selection` | Paper selection and `selected_paper_ids`; subset authorization only when allowed by the original domain |
| `literature.authorization` | Authorization for the original full candidate set; approval or rejection is confirmed by the trusted host and does not expand into an arbitrary subset policy |

These eight slots are retained in the [host contract](service/descriptor.py). Any plugin may declare a reference to them, but may not provide replacement code. The four research Skills reference them as needed; the review Skill additionally retains two package-local custom slots, `literature.outline` and `display.literature-review`. Public implementations reuse the original complete components; simplified displays must not replace details, selection, or business operations.

Real metadata for `agentic-search` uses `literature result` with `checkpoint: metadata`, passing both `run` (a session-relative directory) and `skill` (the package name). It reuses existing metadata validation, artifact publication, and result projection; it does not enter full-text authorization. The standalone search page continues to consume results through its original caller and does not fabricate conversation confirmation.

<a id="固定绑定与恢复"></a>
### Pinned Bindings and Recovery

[The component registry](service/components.py) separates slot registration from interaction instances. A new instance pins the plugin, component, content digest, session, and turn identity, and saves its initial data, draft state/revision, and status. Subsequent loads obtain the original UI resources from the binding snapshot instead of looking up the latest slot owner. Regular closure affects only new bindings; old interactions continue after current permission checks pass. Updates apply only to new interactions and do not replace old cards with a new version or another plugin; the original selection is restored from the draft confirmed by the host.

Versions referenced by in-flight bindings are not deleted; the current implementation also does not immediately reclaim old resources at a terminal state. Resource-reclamation policy does not extend authorization: operations still validate the user, session, interaction state, action declaration, input, and actual business permissions. Repeated operations for the same request use an idempotent result; resending the text “confirm” cannot bypass checks. What is pinned here is the UI resource and interaction data, not the complete research task or Skill script execution environment; scripts still run under the original Agent permissions and task lifecycle.

Persistent data uses the paths Owner's `SERVICE_COMPONENTS_DATABASE`; capabilities owns the revision, slot, and binding tables. It reuses persistence transactions and path validation and does not derive paths from the renderer. HIL decisions and receipts remain in chat's original storage; no second business-confirmation ledger is created. If registration recovery fails, new bindings are blocked; existing pinned interactions still undergo separate permission checks.

The [installation journal](service/install.py) records candidate and old-directory identities, publication stage, and previous enabled state. Staging is placed beside, not under, the Skill root, so `candidate` or `previous` is not exposed to recursive discovery from the Skill root. Recovery first validates the complete record against actual contents. If anything is missing or inconsistent, it preserves the state and reports an error; “staging not found” is not grounds to delete an existing package. After rollback reaches `rolled_back`, an idempotent callback restores the old state. If the callback fails, the journal is retained for retry. Startup recovery then reconciles registration again; no new custom bindings are accepted before recovery. The registration database transaction and file rename are not one database transaction; cross-process exclusion and crash recovery on both platforms still require verification.

<a id="通用调用和预览"></a>
### General Calls and Preview

Use `component.catalog` through `scholarseed_bridge` to query available contracts, `component.request` to initiate a custom interaction that waits for the user, and `component.display` to publish a custom card that does not wait for an answer. See [bridge.py](../platform/bridge.py) for call structure. `request`/`display` carry `request_id`, slot, data, title, and optional prompt; retries with the same `request_id` in the same turn must use identical parameters. Adding a custom slot does not require a new core type branch; new host permissions still require formal implementation and are not automatically granted by a plugin declaration.

Public domain cards must be published through their corresponding domain entry point. The generic entry rejects attempts to use a public slot to fabricate literature authorization or import. User actions are returned to the business logic or waiting AI only after declaration, schema, binding, and permission validation; cancelled, failed, or unknown receipts must not be treated as success. Successful creation of a display card does not mean the related business operation is complete.

Preview and runtime reuse the public implementation or package entry point, selection state, and interaction mechanism; only the execution side is replaced with explicit sample responses. A scenario may declare initial data and state transitions, as well as success, failure, retry, and cancellation cases. A component without a real action must not gain a demo confirmation button. Preview must not perform business writes and cannot prove that the model will call tools correctly according to the Skill. Real runtime data and receipts must still come from actual domain artifacts and persistent requests.

In sample responses, `{"$input":"字段路径"}` references a field path in the current action parameters, `{"$state":"字段路径"}` references a field path in sample state, and `{"$data":"字段路径"}` references a field path in the current component's data. Paths read only their own fields; prototype-chain access and script execution are unsupported. `data.target` opens details for a declared component in the current sample, passing the current result data; returning leaves the user on the original component page. This differs from switching component samples at the top. `data.view` displays closable sample content through `title`, `body`, and an optional `identifier`; closing it retains the original component's selection and search state and does not access real papers, files, or directories. These define preview business responses only and add no runtime permissions or host-navigation capabilities.

Custom components load package-local JS in a sandbox iframe with `allow-scripts` only, without `allow-same-origin`, Node, or host preload. A random instance lease is bound to the main window, and resources are provided only from a pinned snapshot. The host checks `contentWindow`, lease, action, and message size, then revalidates the instance before accepting it. Regular closure does not revoke a valid old interaction or skip per-operation permission checks. CSP, request interception, and the guest Connection-Allowlist restrict resources, fetch, navigation, and WebRTC; native network policy and cross-platform boundaries still require separate security verification.

`window.plugin.onState(callback)` receives data/draft/status/language/slot/theme and returns an unsubscribe function. `window.plugin.save(values)` returns the host draft state and revision; show “saved” only after confirming success, and retain local input on failure. `window.plugin.submit(actionId, values)` submits a declared action and does not approve business operations itself. `window.plugin.request(actionId, values)` obtains a receipt for a controlled host operation that has been connected. Actual available actions depend on host capabilities and bindings; no arbitrary HTTP proxy or legacy `context`/`invoke` is exposed. Mount the component at #root; do not mistake draft saving for confirmation or AI continuation.

Configuration persistence, complete snapshots of task-execution code, automatic upgrades, and immediate revocation for external clients are outside this component contract. Paper-subset and authorization-scope checks remain owned by literature; a generic schema does not replace them. The Skill still runs within the Agent's own permission boundary; the UI sandbox must not be treated as a Skill-script sandbox. Dependencies are not installed automatically; package installation on disk and successful enablement are reported separately. A schema 1 standalone-page package is incompatible with schema 2 and must be regenerated, checked, and explicitly installed.

<a id="分层验证"></a>
## Layered Verification

<a id="原生能力发现与调用"></a>
### Native Capability Discovery and Calls

In an actual Agent turn, the Skill uses only the `scholarseed_bridge` model tool. For a missing or stale operation contract, call `contract/describe` with `{"target_capability":"literature","target_operation":"read"}`. The returned parameter schema, result, and confirmation requirements are authoritative; there is no fixed capability set in which “all plugins are authorized.” The compatibility CLI may still be used when the host already has an authenticated scope, but it provides no model callback identity and cannot replace operations that require that identity. Do not copy session credentials into a plugin or directly call internal HTTP routes.

Agent Skills use the `scholarseed_bridge` model tool. Describe only missing or stale
operation contracts. The compatibility CLI remains for host-authenticated scopes,
but supplies no model callback identity and cannot replace operations requiring it.
Neither contract discovery nor a CLI executable grants permission; never copy credentials.

| Capability group | Common operations and use | Boundary |
| --- | --- | --- |
| `component` | `catalog` lists available custom components; `preflight` checks slots; `request` waits for an answer; `display` shows a card | Do not use generic requests to fake public domain slots; saving a draft is not confirmation |
| `resource` | `list/read/search/stat/versions/diff` finds and reads project materials and existing versions | Read results may be paginated or truncated; reading does not authorize modification or restoration |
| `literature` | `list/search/detail/read/annotations` reads project literature, records, full-text pages, and annotations | `detail` does not grant full-text access; annotations are not evidence from the paper's original text |
| `pdf` | `list/prepare/status/read/search` handles currently authorized PDF references | Use the actual returned `ref_id`, physical page numbers, and citations; do not fabricate material identity |
| `literature` | `result/review/authorize/receipt` publishes domain checkpoints and checks authorization | Requires real artifacts and domain state; displaying a card does not mean authorization succeeded |
| `literature` | `acquire/ingest/delivery/import` acquires, ingests, saves, or imports | These have real side effects; obtain explicit user authorization first and consume confirmation, cancellation, or failure distinctly |
| `artifact` | `publish` registers an immutable snapshot of an already generated session file or directory | Directories are limited to Desktop sessions, with read-only manifests and members; one-off calls still support files only; registration is not generation or external publication |
| `plugin` | `install` presents generated-package checks, preview, and installation confirmation | Do not silently overwrite an existing package; use the installation receipt and actual directory as evidence |
| `plan` | `get/write` reads and updates the execution plan | Use the current revision, complete items, and lifecycle; do not blindly guess parameters after failure |

The table is an index of uses, not a replacement for the current capability registry. UI and AI have different call contexts: components use only `window.plugin` and are constrained by their declared actions, pinned bindings, and host handlers. The Agent commands above cannot all be directly converted into UI capabilities. The original domain handlers perform public-component operations such as directory selection, opening full text, and categorization menus. If a custom component has no public handler, state the gap clearly; do not fake a success button or introduce an arbitrary network/file proxy. Using official base controls grants no additional permissions.

In the current UI 1.0 manifest, base exports are React, mount, Button, Checkbox, and useTranslation. Controls not exported, such as text inputs, menus, and dialogs, must not be treated as public APIs. The host still owns the other public research cards; only paper-subset selection is an independent resource. Validate the complete public-card experience in the ScholarSeed preview; do not claim that standalone resource-demo HTML represents all host components.

Deterministic regression covers the descriptor, actual temporary ZIPs, public references in four packages, registration conflicts, version pinning, drafts, generic callbacks, and installation recovery; see the [Serve runner](../../tests/run_all.py). These tests do not call a model or start real Desktop, and cannot replace acceptance of actual generation, preview, installation, and use. Final delivery still requires card-driven real workflows for all four Skills, restart recovery, and evidence for isolation and security boundaries on both platforms. If real acceptance is paused, retain it as incomplete.
