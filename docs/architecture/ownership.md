<a id="跨系统职责与发行边界"></a>
# Cross-System Ownership and Distribution Boundaries

Read this page when determining ownership of cross-package changes, permitted dependency directions, or consumers of public protocols.
Once the Owner is clear, go to that package's entry point; do not read historical proposals just to fill in context.
This page maintains only cross-system boundaries; package ABIs, implementation details, and actual commands are not duplicated here.
The presence of source code does not mean a feature or distribution has been accepted; acceptance conclusions must be checked against evidence from the relevant product and artifacts.

<a id="按改动快速定位"></a>
## Quick Routing by Change

| Change / question | Read first | Boundary note |
| --- | --- | --- |
| Cross-package contracts, Provider discovery, dependency direction | [System map and dependency graph below](#当前仓库地图), [Runtime README](../../packages/runtime/README.md), the relevant Adapter README, and [Serve composition boundary](serve.md) | Identify the contract Owner and consumers first; do not move vendor protocols or product policy into the generic Runtime |
| Product APIs, sessions, identity, paths, or data | [Serve AGENTS](../../apps/serve/AGENTS.md), [Serve architecture](serve.md), [persistence boundaries](persistence.md) | Serve owns product composition and paths; add source and tests in the specific business domain |
| Trace recording, queries, or diagnostics | [DamoATrace AGENTS](../../packages/damoatrace/AGENTS.md), [Engineering guide](../../packages/damoatrace/README.md) | Trace is the read-only diagnostics Owner; product event projection remains with Serve |
| Desktop internal ownership, renderer / main / IPC | [Desktop documentation entry point](../../apps/desktop/docs/README.md), [Desktop ownership](../../apps/desktop/docs/architecture/ownership.md) | Follow local Owners for Desktop's internal divisions; do not duplicate them here |
| Distribution, installers, public preparation, or artifacts | [Build guide](../runbooks/build.md), [public preparation notes](repositories.md) | Source directories, distribution-package boundaries, and authorization for external publication are separate concerns |
| Development Skills, product Skills, or Prompts | [Skill boundaries](skills.md), [Product instructions](../../apps/serve/service/chat/prompts/baseInstructions.md) | Development Skills in the documentation source repository are the source of truth for development workflows; `skills/community/` contains product assets. They must not substitute for each other. |

Reading shortcut: this page covers cross-system ownership, dependencies, and decision boundaries. The links above lead to specific Owners, where mechanisms, configuration, verification commands, and product acceptance are documented. For an ordinary change owned by one area, go directly through the root index or a matching Skill; this page need not be read in full.

<a id="当前仓库地图"></a>
## Current Repository Map

| Location / Owner | Primary responsibilities and contracts | Not responsible for / boundaries not to cross | Further reading |
| --- | --- | --- | --- |
| `apps/desktop/` | Electron/React product frontend and local native host; consumes Serve over HTTP/SSE, with native capabilities exposed in a controlled way through main/preload | Does not own Serve business logic or Python package boundaries; the Renderer does not receive Node/Electron capabilities directly | [Desktop conventions](../../apps/desktop/AGENTS.md), [local ownership](../../apps/desktop/docs/architecture/ownership.md) |
| `apps/serve/` | `scholarseed` distribution and `service` namespace; product configuration, users/projects, credentials, persistence, business APIs/SSE, and composition root | Does not own vendor protocol implementations, generic Provider contracts, or Trace storage | [Serve README](../../apps/serve/README.md), [bootstrap](../../apps/serve/service/bootstrap.py) |
| `packages/runtime/` | `scholarseed-runtime` / `scholarseed_runtime`; vendor-neutral public contracts, Provider discovery, and generic Gateway | Does not implement an Agent loop, product policy, or any vendor protocol; does not resolve product user directories | [Runtime README](../../packages/runtime/README.md) |
| `packages/adapters/codex/` | `scholarseed-codex` / `scholarseed_codex`; native official App Server protocol, process execution, authentication discovery, and permission mapping | Depends only on Runtime's public contracts; does not depend on Serve/Desktop and does not own product authentication, session, or UI logic | [Codex README](../../packages/adapters/codex/README.md) |
| `packages/adapters/dsh/` | `scholarseed-dsh` / `scholarseed_dsh`; reserved independent boundary | Currently has no Provider/Session or runnable entry point; do not describe it as an integrated capability | [DSH README](../../packages/adapters/dsh/README.md) |
| `packages/damoatrace/` | `damoatrace`; independently owns Trace recording, storage, paths, queries, and diagnostics entry points | Does not depend on Runtime, Adapter, Serve, or Desktop; queries do not modify product sessions, tool state, or business records | [Trace conventions](../../packages/damoatrace/AGENTS.md) |
| `skills/` | Product Skill source and build inputs | Is not the source of truth for host workflow development Skills; development Skills are maintained only in the documentation source repository | [Product Skill adaptation](../../skills/ADAPTATION.md) |
| `packages/ui/` | OpenUI declarative registration/Schema/Renderer; also retains the resource SDK for isolated executable plugins | Declarative UI consumes only registered components and host-scoped ports; executable code uses only the isolated bridge and holds no business permissions | [Conversation UI and isolated resources](../../packages/ui/README.md) |
| `scripts/`, `tests/` | Development build tools and cross-package integration/distribution gates | Are not product-domain business Owners; passing checks cover only their explicitly defined contract scope | [Build guide](../runbooks/build.md), [development entry point](../runbooks/development.md) |

The root [pyproject](../../pyproject.toml) orchestrates a uv workspace with `package = false`; it is not an installable wheel. Each member's distribution name, namespace, dependencies, and package data are defined by its own pyproject. Desktop build artifacts do not become Python distribution contents merely because their directories are in the monorepo.
When versions or workspace membership change, update the actual declarations; do not maintain a mirrored set of version constants on this page.

Historical material referring to root-level `service/`, `ui/veda/`, `work/scholar/`, `account/`, or root submodule layouts does not describe current source Owners. Use the table above to locate the current `apps/`, `packages/`, `skills/`, and `tests/` Owners.
Ignored `build/`, `*.egg-info`, and bytecode may contain artifacts from the removed Harness and are not source. Verify distribution packages using the [build Owner's](../runbooks/build.md) `scripts/cd/wheel.py` and wheel-content gate; workspace residue is not evidence of distribution boundaries.

The Desktop design system owns only generic renderer UI and does not expose React/Electron concepts back to Serve.
The official UI package is distributed as a separately built browser-resource archive in the product backend's package data. Serve only validates, pins, and serves the archive bytes; it does not execute or import frontend source. The host renderer and official package runtime are built separately; shared build inputs do not replace independent resource updates. Detailed component and dependency constraints are maintained only in Desktop-local docs. Dynamic component/token/debt inventories are generated from source; do not copy counts or a second component list into cross-system documentation.

<a id="依赖与组合"></a>
## Dependencies and Composition

```text
Desktop ──产品 HTTP/SSE──> Serve
                            ├──公共契约/通用 Gateway──> Runtime
                            ├──证据能力──────────────> Trace
                            └──已发现 Provider ABI───> Adapter ──公开 contract──> Runtime
```

Adapters do not import Serve/Desktop; generic Runtime does not depend on vendor Adapters or product business logic; Trace does not depend on Runtime, Adapters, or Serve. Product policy must not be moved into the generic ABI for code reuse, and vendor protocols must not become Serve's internal call surface for convenience.

Provider discovery comes from the installed distribution's `scholarseed_runtime.providers` entry point.
The [Gateway catalog](../../packages/runtime/scholarseed_runtime/gateway/catalog.py) validates
factories, ID/alias conflicts, and the ABI; discovery does not use import side effects or a second registry.
[Serve selection](../../apps/serve/service/chat/runtime/selection.py) then applies the product manifest's
enabled/default policy. A Provider enabled in configuration but not installed is an explicit error; do not pass by creating a stub implementation.
Installing an Adapter, allowing the product to use it, and business acceptance are three separate conditions; none substitutes for another.
The reserved DSH package must not be treated as an integrated capability; unsupported features must be identified as unsupported.

The [binding validator](../../packages/runtime/scholarseed_runtime/gateway/binding.py) compares
an existing binding's vendor identity and declared protocol-version/schema identity; it does not interpret opaque vendor state. Successful validation does not imply that official private data can be migrated or downgraded. The [Driver](../../packages/runtime/scholarseed_runtime/gateway/driver.py)
maintains a single event consumer for each Runtime session, validates sequence numbers, and associates command acknowledgments with final results.
Serve handles multi-channel product projections; do not concurrently consume the same native event stream again to satisfy frontend subscriptions.

[RuntimeBinding](../../packages/runtime/scholarseed_runtime/contract/binding.py) records the product session, vendor identity, protocol, and opaque native references; it is not a frozen snapshot of model, permission, or credential configuration.
Do not infer that all configuration is immutable from a frozen dataclass, or treat configuration changes as authorization to migrate private vendor identity. Changes must still follow the controlled contracts of the actual configuration/permission Owner. Database migrations must upgrade idempotently from the current schema and preserve user assets; do not reuse historical DDL with different column names.

Public dependency boundaries are enforced by distribution packages and public protocols, regardless of whether names contain a brand.
User paths are resolved by the actual Owner; see [persistence boundaries](persistence.md). Runtime does not derive user directories.
A Provider's storage declaration, directory eligibility, resource lease, and admission/restart permission are distinct. Detailed restrictions are maintained only by Runtime/Adapter/Serve Owners; a storage inventory or idle-release acknowledgment alone cannot establish that restart is safe.

<a id="决策理由与扩展规则"></a>
## Rationale and Extension Rules

<a id="公共源码与发布就绪不能混同"></a>
### Public Source Must Not Be Confused with Publication Readiness

Enterprise control planes, deployment credentials, and internal topology are not part of the public product distribution and must not be copied into this repository for convenient integration testing.
Public engineering knowledge, development Skills, domain constraints, and gates are maintained with the source; independent checkouts and native worktrees do not depend on an internal parent repository. Internal system wiring, organizational/personal information, collaboration supplements, and work evidence do not belong in public content. Split mixed content according to [repository and knowledge boundaries](repositories.md); directory names do not determine what may be published.
Historical path projections are intermediate audit material only. Successful internal validation grants no publication permission and does not prove that history is safe to publish.

Export checks for required files, unknown binaries, and content rules prove only the scope of those checks. The presence of a LICENSE, matching hashes, or a clean scan does not mean redistribution rights for third-party code, fonts, images, Skills, models, and binaries have been reviewed. Unclear ownership or licensing remains a publication blocker; an engineering proposal cannot replace legal authorization.
Excluding user assets from the repository does not mean historical refs, LFS, caches, and existing clones have been audited. Cleaning the current tree does not prove historical secrets are gone; credential handling and history operations require separate authorization.

The [build contract](../runbooks/build.md) owns package, signing, and installer acceptance boundaries. Source scanning alone cannot replace evidence for the final artifact's dependency closure, licenses, provenance, and integrity. Apple signing/notarization proves only the relevant distribution identity, not provenance. Do not describe REUSE, an SBOM format, an SLSA level, or signing technology selected by an old proposal as an implemented gate without a decision from the current Owner. Disclose missing evidence; retiring an old proposal does not eliminate supply-chain risk. Public-source builds, real models/tools, and recovery flows still require their own product acceptance; successful repository synchronization does not prove they passed.

<a id="adapter-双向协议与产物观察"></a>
### Adapter Bidirectional Protocol and Artifact Observation

The product submits neutral model/permission intent, developer instructions, and opaque credential references. The Adapter maps these to the native protocol and emits Runtime events and callbacks. Product identity, approval persistence, SSE, and artifact registration remain owned by Serve; the Adapter does not emit product cards directly. See the credential-material contract in
[ModelCredential](../../packages/runtime/scholarseed_runtime/contract/model.py): credentials are used transiently and must not be persisted or included in runtime evidence. The exact admission/resolution point is defined by the Owner contract and must not be generalized as identical for every call.

Codex's [file observation](../../packages/adapters/codex/scholarseed_codex/files.py) excludes private,
cached, and temporary paths, as well as work-state directories prefixed with `_`. This directory rule lets Skills store logs and intermediate artifacts without changing the Adapter allowlist. Deliverables must not be placed in such work-state directories. A filename beginning with `_` alone
(for example, `_notes.md`) does not trigger the directory rule; actual filtering is defined by the Owner's constants and functions.
File observation, product registration, and UI presentation are separate boundaries. The role filter in current
[session activity presentation](../../apps/desktop/src/renderer/src/activity.ts) must not be generalized to mean every artifact list uses the same filter, nor does the directory rule grant authorization to access files.

Read the Codex README for official session recovery and authentication synchronization rules: do not read/copy private databases or rollouts, and do not modify official binaries. The Adapter owns compatibility scope; Desktop owns the exact packaged version/hash and updates.
Do not duplicate fixed-version or old implementation-stage statements here. Verify supported and unsupported capabilities separately; do not hide differences behind stub implementations or a lowest common denominator. A reserved DSH boundary does not mean session capabilities are provided.

- Separating public contracts/Gateway, vendor execution, product composition, and evidence infrastructure allows new Adapters without changing the generic discovery core, and prevents Codex or Serve business policies from becoming hard-coded requirements for every Provider.
- Removing the old custom Harness does not mean restoring forwarding packages: do not recreate `damoagent`, core/work/sdk/bench, or an old facade/second registry. Move real definitions to their Owners and update consumers; do not leave compatibility shells.
- Directories, distribution names, and import names are different contracts. A source migration does not automatically authorize user-data migration, private native-thread recovery, or public package publication; do not copy paths or publication permissions from historical implementation plans.
- Enterprise control planes, deployment assets, DamoCli, and Lattice are not product code in this repository. Maintain only the consumer contracts this product needs; do not bring in external service topology or implementations and launchers for other products.

<a id="验证与维护"></a>
## Verification and Maintenance

<a id="trace-消费与诊断正文"></a>
### Trace Consumption and Diagnostic Content

Recording, storage, queries, and paths for Trace belong to an independent package. Product action data is connected only through an explicit path or Port; queries must not modify sessions, tool state, or product records. Read internal rules and query entry points in the
[package guide](../../packages/damoatrace/AGENTS.md), and use the
[Engineering guide](../../packages/damoatrace/README.md) for diagnostic orchestration. Conclusions must link to real evidence/spans; do not bypass the query contract by parsing storage directly to obtain a favorable conclusion.

Collection authorization and query display are two separate controls for diagnostic content: the CLI's `--full` only adds fields; it does not authorize reading content. `--include-content` explicitly selects unexpired content, while the
[content projection](../../packages/damoatrace/damoatrace/recording/content.py) still hides expired blocks.
Do not infer that collection was authorized from an option name, and do not restore expired or originally missing data as acceptance evidence.
Whether historical brand environment variables remain is determined by the actual configuration Owner; do not rename them mechanically because the old Harness was removed.
Environment-variable contracts belong to the actual reader; do not unify prefixes based on the brand of the injector. Product startup defaults are projected by
[brand](../../apps/serve/service/brand.py) before path consumers are imported, using `setdefault`
to preserve explicit configuration. Trace and Codex interpret their own environment contracts through their respective Owners. The `DAMOAGENT` names in an old rename table do not justify restoring the old Harness or silently reading both names for compatibility; renaming does not authorize directory migration.

Product collection policy belongs to [RecordingService](../../apps/serve/service/chat/service/recording.py):
the default is detailed when unset, while an explicit opt-out takes precedence. Do not also change the metadata
freeze sentinel in `RecordingPolicy()` to detailed. [Capture](../../apps/serve/service/chat/runtime/capture.py)
also requires the policy frozen for this operation to match the current policy's active state and revision. A default policy does not authorize backfilling historical data.
Disabling collection, clearing local content, and handling exported packages are different lifecycle operations; a query switch does not replace collection policy.

[Detailed export](../../apps/serve/service/chat/service/diagnostics.py) requires preview and explicit confirmation first. It validates the signature, user/session, policy revision, expiration, and file watermark; changes to records or policy require confirmation again. The content Owner controls Trace block/turn/session/shared capacities and retention periods; do not copy them into product constants. Missing, truncated, expired, or evicted content must be shown accurately; do not restore content that was never collected.
Export snapshots are projected by `exported_at` only after passing [manifest integrity validation](../../packages/damoatrace/damoatrace/recording/diagnostics.py); ordinary JSONL does not bypass content expiration because it is "offline."
The detailed default is not authorization for external sharing, and redaction does not guarantee that all personal information has been removed.

Model-bridge observation belongs to [Serve streams](../../apps/serve/service/chat/service/streams.py),
not the Trace package's model-execution mechanism. Upstream SSE, ASGI send, and consumer parsing are separate observation surfaces;
a successful send, HTTP 200, EOF, or lower event count alone does not prove a successful model terminal state or end-to-end speedup.
See [model-bridge streams](../runbooks/streams.md#观察面与终态) for stream conversion, redaction, and terminal-state criteria.
Verify changes with that Owner; a successful Trace query does not substitute for product-protocol acceptance.

Product evidence is explicitly projected by [SessionTrace](../../apps/serve/service/chat/runtime/evidence.py);
the current integration writes files through the independent package's `EvidenceWriter`. Do not treat the Product Evidence
Journal, outbox, or asynchronous SQLite Ledger in old designs as implemented reliable delivery. The business Owner's commit,
the native executor's acknowledgment, Renderer presentation, and Trace persistence each prove different things; log presence does not substitute for business success.
Historical event names or missing observations also cannot prove that a business action never occurred.

In the current Trace batch recorder, a recording failure latches incomplete evidence; the checkpoint checks the failure count and calls the writer's file `fsync`. A failure must not be treated as a watermark at which resources can be safely released. Recovery means only that subsequent recording can resume; it does not fill in previously missing events or rerun business operations. Evidence completeness defaults to `partial` and lists gaps. Queryability, normal exit, or disappearance of a recovery alert does not establish complete end-to-end correlation. The file-sync source code alone does not prove cross-platform power-loss recovery, product transaction atomicity, or acceptance of presentation for all native operations.

<a id="runtime-gateway-与外部-llm-gateway"></a>
### Runtime Gateway and External LLM Gateway

Runtime Gateway is this repository's Provider discovery and command/event-driven layer, not an enterprise LLM gateway.
The external enterprise repository owns the enterprise LLM Gateway implementation, data migrations, and deployment assets. This repository maintains only product configuration, authentication, and model-protocol consumption. Similar names do not justify importing the enterprise implementation.

Product enablement and connection policy are declared in the actual [product manifest](../../product.json) and
[Desktop resource manifest](../../apps/desktop/resources/product.json); do not duplicate
endpoints, deployment topology, or credentials here. Serve's [upstream call boundary](../../apps/serve/service/chat/service/completions.py)
owns product-side connections and credentials used at call time, while Adapters own vendor execution protocols. The presence of a manifest does not prove model authorization or connectivity, and branch names or commands in old deployment documents are not current operational authorization.

Changes to internal enterprise implementations belong in their respective repositories; do not create `llm_gateway/`, `deploy/`, or compatibility copies here.
The managed account service's database, admin SPA, RBAC, and migrations are also outside this repository. Do not use the old `account/`
PostgreSQL/Alembic plan to replace Serve's local business persistence. This repository still consumes the account service's
login handoff and trust protocol: [AccountTrust](../../apps/serve/service/identity/service/account.py)
handles local signature verification and the revocation cache, while [handoff](../../apps/serve/service/identity/api/handoff.py)
handles the existing handoff API. Retirement of the external implementation does not mean these consumers can be deleted or user/admin token isolation loosened.
The [distribution-boundary gate](../../tests/release/contract_package_boundary.py) includes a Git-tracked-directory check;
that is different evidence from proving that a local directory is absent, verifying the actual wheel closure, or succeeding at a model call. These checks do not substitute for one another.
Update this boundary if product-side consumer contracts or external repository ownership changes; do not copy external operations procedures into this repository.

For changes to public contracts/discovery, select the [Gateway contract](../../tests/contract_runtime_gateway.py),
[Driver contract](../../tests/contract_runtime_driver.py), and affected Adapter/Serve consumers.
Distribution boundaries require checking the [actual wheel boundary](../../tests/release/contract_package_boundary.py) and
[distribution checks](../../tests/release/contract_distribution.py); grepping the source tree is insufficient.
Product-composition changes also require a real Desktop flow. Installation, healthz, or Provider readiness does not prove that a business turn completed.
These are verification entry points selected by change type; this knowledge-maintenance task has not performed product or wheel acceptance.

Update this page and the relevant package entry point when adding/removing members or changing a namespace, entry point, dependency direction, or cross-system Owner. Record mechanism details with the Owner and task evidence in `work-records/`.
When sources conflict, verify the code, specifications, later decisions, and validation evidence; do not interpret "code wins" as automatically canceling safety rules.
