# Skill ownership, product packaging and discovery

Development workflow Skills are maintained only in the private documentation repository.
They are not shipped in this checkout and are not prerequisites for public development, review,
CI or packaging. Read the applicable `AGENTS.md`, public Owner contracts and executable tool help.
Do not recreate a host-Skill link or require a private parent to run public engineering commands.

| Surface | Maintained owner | Verification |
| --- | --- | --- |
| Developer workflow Skills | Private supplements and their coding host | Private link checks and actual host invocation |
| Bundled product Skills | `skills/community/`, registry and Serve capabilities | Source and installed artifact contracts and the real product flow |
| User-installed Skills | Serve paths and capabilities | Isolated user lifecycle; never bundle user assets |
| Runtime discovery | Serve explicit roots and Codex adapter isolation | Runtime contracts; not coding-host discovery |

Public commands remain local to the source checkout:

```sh
pnpm ops ci check skills product --mode source
pnpm ops ci check docs workspace
node --experimental-transform-types apps/desktop/scripts/ci/find.mjs --list
```

<a id="中文边界"></a>
## Development workflow boundary

Development workflow Skills have moved to the private documentation repository. Their bodies,
discovery links, and host gates are not retained in the source repository. The source repository
continues to maintain its `AGENTS.md` files, public engineering tools, and product Skills
independently; internal helper workflows are not prerequisites for public development. Product
Skill source, user-installed Skills, and coding-host Skills must remain isolated. Moving development
Skills does not change product packaging or discovery rules.

<a id="产品源码与-pack"></a>
## Product source and pack

Before updating or integrating an external Skill, compare its capabilities and authorization scope
against the [adaptation guide](../../skills/ADAPTATION.md). The [registry](../../skills/registry.json)
owns product dependency policy. Review the Skill source, dependency declarations, and packaging rules.
Builds generate the per-file inventory; do not commit it to Git or edit generated packs by hand.
Versions, inventories, dependencies, and actual script capabilities must agree. Do not describe a
capability required by documentation as already implemented, or remove product-supported metadata
to satisfy a generic check.

The offline prebundle entry points are the [CLI](../../apps/serve/service/cli/prebundle.py) and the
[capabilities implementation](../../apps/serve/service/capabilities/service/prebundle.py). The
build-time Python closure is maintained by the [build guide](../runbooks/build.md) and the actual
lock file. Product installation state and runtime resources do not belong in the source package.
Pack validation, distribution contents, and real product invocation provide separate evidence; a
successful installation alone does not prove discovery, loading, and model decisions all work.

The source-code compilation Owner is [source.py](../../apps/serve/service/capabilities/service/source.py):
`prebundle --build` compiles offline into `SERVICE_BUNDLED_SKILLS_DIR` and generates
`.scholarseed-package.json` from the copied payload and dependency declarations. Desktop uses
`--lock` to emit the acceptance inventory included in the package; it no longer generates a source
snapshot. Independent installation-state checks use the packaged inventory as their expected
value, not a digest reported by the target pack itself. Archive fallback, runtime downloads,
copying user Skills, incomplete scans, and empty packs are prohibited. See [BUILD](../runbooks/build.md)
for build and installation acceptance boundaries. A failed or incomplete scan must not be reported
as SAFE.

<a id="原生依赖三种声明与随包工具链"></a>
### Three native dependency declarations and the bundled toolchain

[`dependencies.py`](../../apps/serve/service/capabilities/service/dependencies.py)
It distinguishes three declarations: `executables` checks required items on the execution
environment's PATH and fails if one is missing; `optional_executables` reports host capabilities
without promising that a tool is supplied or usable; `bundled_executables` resolves only target
files under an explicit `toolchain_root` and fails if the root or a tool is missing. It must not
claim that a developer-machine PATH tool is bundled. The current registry declares bundled LaTeX
tools; do not repeat the obsolete conclusion that there are only two categories.

Read TeX versions, assets, build recipes, and platform paths directly from the
[vendor README](../../scripts/vendor/texlive/README.md) and its neighboring manifest. This page
does not duplicate inventories or cache paths. Development caches differ from production
installation resources, and path length remains limited by upstream font filenames. Source or
dependency checks do not prove that a user's machine without TeX can produce a PDF. Dependencies
expressible in Python belong in the Python closure; native tools belong to the vendor artifact
Owner. Do not build a separate downloader for one Skill. Verify versions and licenses, asset
integrity, runtime PATH, and real compilation separately; optional probes and prior test runs are
not evidence of distribution capability.

<a id="surfaceenablement-与-inventory-不是一件事"></a>
## Surface, enablement, and inventory are separate

Skill display names and descriptions may be declared in `SKILL.md` frontmatter as
`display_name_<locale>` and `description_<locale>`. Serve projects them as `display_names` and
`descriptions`; Desktop falls back in order from the full locale to the base language and then
the original default text. The canonical `name`, path, and invocation identity are not translated.
New marketplace installs and ordinary version updates write the Chinese and English display data
for the same registry / namespace / slug to the local source record. The installed-Skills list
passes the current UI locale. Serve reuses the existing metadata request for the same source and
merges server names and descriptions into the current-language entries of `display_names` and
`descriptions` in that response. The input picker reloads when the language changes and discards
stale results. If there is no trusted marketplace source, the remote request fails, or a field is
missing, retain the local translation and fall back to the original text. Completing display data
does not write to disk, automatically migrate or rewrite existing user Skill data, or change the
title snapshot or invocation identity of an already selected reference.

The [capabilities catalog](../../apps/serve/service/capabilities/catalog.json) defines the product
surface, while [SkillCatalog](../../apps/serve/service/capabilities/service/skills.py) projects
and coordinates state owned by ScholarSeed. `display_names` in `catalog.json` holds the Chinese
and English product names for system-preinstalled Skills. Lists project these as `display_name`
according to `locale`, shared by the management page and conversation picker. Do not change
Runtime registration names, paths, or sending identity, and do not override a same-named user
Skill; if a language is absent or unsupported, retain the runtime display name. The actual
whitelist, user-source passthrough, and required/login policies are defined by this configuration;
do not maintain a second list in a knowledge page. UI visibility does not change Runtime inventory
or override disabled state; conversely, backend discovery does not prove UI display.

Product lists and document browsing use capabilities' `installed.py` to read installation
metadata under the two product roots above. They do not obtain model credentials or warm up the
execution Host. Reads use platform-fixed directories and no-follow file handles, preserving errors
for corrupt packages, existing product preferences, dependency declarations, and trusted-login
conditions. A `runtime_enabled` value of null in a browse result means native state has not been checked;
`active` only represents current product selection conditions and is not execution authorization.
Native inventory remains authoritative for execution admission, session enablement, and install/
enablement synchronization. Read-only lists and documents may be shown while execution is draining;
the global HTTP response barrier and admission for all writes remain in force.

The product catalog allows only the product bundled root and the `$SCHOLARSEED_HOME/skills` user
root. The fixed groups are `scholarseed` / “ScholarSeed Skills” and `user` / “User-installed”.
Project, Codex, test, and other runtime roots must not masquerade as user-installed Skills;
discovery and presentation must still be checked separately, and this knowledge handoff does not
change the existing Skill UI. The current [catalog implementation](../../apps/serve/service/capabilities/service/skills.py)
filters by owning root and emits these two group IDs, but the [Chinese labels](../../apps/desktop/src/localization/locales/zh/skills.json)
are currently “System preinstalled” / “Mine”, which do not match the required root labels above.
This is a required/current gap pending confirmation by the product presentation Owner. Do not
cancel the requirement based on the source's current state or change the UI without authorization.

For “installed on disk but unavailable for selection,” check runtime-root registration, inventory,
product surface, and UI request generation separately; do not work around it by broadening discovery
directories. The current surface selects entries through named Skills or permitted sources; it does
not use the old wildcard-display design. User-source passthrough still occurs only after the product
owning root has been decided. When [Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx) settings open, the picker request is invalidated and
the list is fetched again when reopened; a late response cannot overwrite the new list.

[Adapter inventory](../../packages/adapters/codex/scholarseed_codex/provider.py) borrows the
shared Host through explicit product roots, then decides per request whether to force-refresh the
Skill list. Provider and in-session Skill refreshes and enablement writes do not require global
task idleness and do not silently inspect configuration through the shared Host; they preserve
caller identity, roots, process generation, and ordinary control admission checks. Skills may be
installed, deleted, enabled, or disabled while a task is running. If the Agent later reads a deleted
file, interpret the actual result; do not provide an implicit old-version snapshot or block deletion.
The [process Owner](../../packages/adapters/codex/scholarseed_codex/process.py) avoids redeclaring
an unchanged set during ordinary `ensure`, while `reassert` merges the existing set and explicitly
resends it. Do not describe this as removing other roots or automatically discovering arbitrary
directories. The [Adapter contract](../../tests/contract_codex_adapter.py) uses a control fixture;
evidence from actual product roots and runtime discovery is still required to establish real behavior.

`skill_roots` in Runtime open/resume are frozen path data and contain neither product-directory
resolution nor a Serve dependency. Serve owns the product path set; the Adapter owns native
declaration and inventory. Temporary plain-text actions use Serve's plain model transport and do
not enter Skill discovery or the Agent Host; tool-based Invocations still require explicit checks
of Skills and permissions. Product base instructions require loading the exact `SKILL.md` locator
from current inventory. Root aliases are expanded only through the current root table; do not infer
a user or bundled directory from a Skill name. Distinguish invalid paths, missing files, and
unavailable Skills on read failure, preserving the actual error; stop dependent operations and do
not search blindly across roots or copy files into a user directory. This constrains the model's
loading choice; it is not a file-access sandbox and does not prove that a historical pack is intact.
The old proposal to allow development version 0.0.0 is not default compatibility permission: the
current executable check has an explicit switch. A successful probe does not prove session Skill
discovery, real startup, or data recovery, and user environment must not be changed for acceptance.

The managed Adapter isolates the discovery Home and disables project instructions/root discovery
and inherited MCP/plugin/hook configuration, while retaining explicitly supplied product Skill
roots. Changing only `CODEX_HOME` must not be described as isolating all host discovery, and the
derived shell's user Home must not be conflated with the Agent discovery Home. Detailed isolation
and host-model connection mechanisms are maintained in the [Codex README](../../packages/adapters/codex/README.md);
do not duplicate a table of flag constants here.

<a id="产品-skill-的受控桥调用"></a>
## Controlled Bridge Calls for Product Skills

<a id="启用偏好登录条件与执行准入"></a>
### Enablement Preferences, Login Conditions, and Execution Admission

“Enable in tasks” in marketplace details has two states: a pre-install draft and the local installed
state. It defaults to on before installation; toggles are staged only in the current detail, and
turning it off does not write anything. The install request's boolean `enabled` follows the existing
native synchronization path in capabilities; when omitted it remains enabled by default. A disabled
install must not show an “Enabled” success message. Installed details match local Skills by the full
registry/slug identity and persist through the existing enable/disable interface, never by marketplace
name. Direct installation from a card still uses the default enabled state and does not inherit an
unsubmitted draft from another detail.

Serve normalizes marketplace counts: list results read `stats.downloads`; if a detail result lacks
the count, read native detail `downloadCount` for the same namespace/slug and verify identity. Accept
only non-negative integers. Do not guess zero when missing; Desktop displays “No data yet”. Counts do
not participate in Skill identity, scanning, security admission, or invocation authorization.

Local `enabled` preference is separate from current `active` availability: the catalog projects
product preference, native availability, trusted-login conditions, and dependency state. A Renderer
login flag or `auth-mode=off` is not a substitute for identity. Login requirements come from the
product catalog and currently apply only to the declared bundled Skills; they do not extend to all
user Skills. `session_enablement` creates session-level configuration, and each independent
Invocation refreshes inventory and checks `active` again. A discovered entry does not authorize
future invocations. State changes must not rewrite local preference or authorize automatic sending,
retrieval, or cancellation of an already-running invocation after login. Refresh and binding recovery
for old sessions require separate verification; a list projection does not prove they took effect.

[Configuration coordination](../../apps/serve/service/chat/runtime/composition.py) refreshes
inventory under the Skill-configuration lock and compares the target enablement state for the owning
path. If native writing is needed, it configures through the Provider and saves product state only
after receiving an APPLIED receipt and verifying a matching readback. If no write is needed, it uses
the refreshed state. Writing only local JSON is not evidence of successful native synchronization.
The [HTTP API](../../apps/serve/service/capabilities/api/routes.py) and session bridge reuse the
[Skill management Owner](../../apps/serve/service/capabilities/service/management.py). Each native
synchronization passes the trusted user identity to obtain the matching Host context; it must not
replace a reused shared process with an empty identity or environment. Busy state, configuration
conflicts/uncertain results, and missing context preserve the Runtime reason and are rejected
directly, without compensation or retry. Ordinary synchronization failures and loss of session
authorization after a write attempt to restore the prior state using the same identity. This is a
compensation attempt, not proof that multi-Skill writes are atomic or that compensation always
succeeds. The [Adapter](../../packages/adapters/codex/scholarseed_codex/provider.py) invokes native
Skill control per configuration and then refreshes the list; failure acceptance must separately
check partial application, mismatched readback, and failed compensation. Disablement and deletion
remain governed by catalog required/owning-root rules. Do not treat the historical statement that
“all locally installed Skills cannot be disabled” or old root labels as current implementation facts
for every bundled entry; route requirement differences to the product Owner.

The standard Python launcher's [script admission](../../apps/serve/service/cli/skill.py) accepts only
files whose resolved paths are inside a Skill directory under the bundled root. If a bridge session
exists, session admission is still checked. Users may modify preinstalled Skills or add script entry
points; the shipped inventory is for acceptance and troubleshooting and does not block execution
when files change. A missing session skips only the bridge check; it does not widen the path scope or
provide a general sandbox.

When authorization includes the current session record, an official Desktop feedback bundle may
include `backend/skills.lock.json` as the shipped baseline for preinstalled Skills. Do not include
each Skill's `.scholarseed-package.json`, body, or scripts. Omit the inventory if it is missing or
invalid. The shipped baseline does not prove that files on disk are unchanged.

The product requirements remain in force: do not restore pending send actions after login, and
preserve user drafts, attachments, and selections. Real verification is required for every client
entry point, new invocations after login/pause/exit in the same old session, and the actual model
configuration. This knowledge handoff did not perform that acceptance.

When product Skills need history, artifacts, business cards, or task-identity capabilities, they send
`capability`, `operation`, and `request` through the model tool `scholarseed_bridge`. The registered
[contract](../../apps/serve/service/platform/bridge.py) and [tool Owner](../../apps/serve/service/chat/runtime/tools.py)
define payloads and return shapes; do not duplicate the full command table in this document.

The built-in `find-skill` adapts the deployed SkillHub Registry guide into product bridge calls; its
source and adaptation scope are recorded in its package registration and NOTICE. Marketplace HTTP
and model-side local management share the [capabilities management service](../../apps/serve/service/capabilities/service/management.py);
they do not implement separate installers. The model-management entry point is bound to a real turn
and invocation identity. Writes go through a product confirmation card, a permission recheck before
execution, and a same-turn operation-ID receipt. Model-reported confirmation and arbitrary registries
or install paths are not accepted. Preinstalled deletion restrictions, fixed versions, and upgrade
source validation remain unchanged. Installation, enablement, availability, and loading in the current
model context must still be checked separately. Supported surfaces and interface boundaries are in
the [Serve Owner](../../apps/serve/README.md#匿名技能广场).

The [composition root](../../apps/serve/service/chat/runtime/composition.py) filters session-level
bridge identity. The [secrets contract](../../apps/serve/service/chat/runtime/secrets.py) declares
that these environment keys are removed: a shared App Server cannot carry per-session credentials.
The normal product sandbox has no bridge context. Do not require the model to run `scholarseed-bridge`
in a shell or declare it as a Skill executable; when identity is missing, the [internal CLI](../../apps/serve/service/cli/bridge.py)
explicitly rejects the request. Do not copy credentials just to make a Skill work. If a Skill script
consumes a bridge response saved verbatim by the model, it must still validate it as untrusted input
and only narrow the scope. Serve provides the actual authorization; script validation, `ok: true`,
content quality, and business acceptance are distinct guarantees.

A historical title or search hit is not evidence of document content. Artifact registration is not
the same as display in a business card, and display does not authorize ingestion. The task-activation
[service Owner](../../apps/serve/service/chat/service/tasks.py) checks the active turn, Skill
identity/version, workspace binding, and runtime identity, rejecting stale context. A lease does not
carry over to a new turn just because the previous turn succeeded, and model self-reported identity
is not accepted. Business-specific binding files and full-text authorization remain with the relevant
Skill and domain contract. Deep continuation of research ideas is bound to a result directory created
by the Skill script, then the same task-activation interface confirms the current-turn identity. A new
turn without a task-type label does not automatically restore this binding. It still uses per-turn
full-text authorization rather than persistent runtime authorization; task-identity activation does
not replace user authorization for the candidate set. Do not store session credentials in Skills or
ask users to configure the internal bridge. Validate the real model tool, script handoff, and business
recovery separately; passing a CLI or fixture does not replace a normal product tool invocation.

<a id="skillhub-目录分类与标签"></a>
## SkillHub Categories and Tags

Marketplace categories and tags are read anonymously by Serve capabilities through the public
SkillHub interface, without an administrator session or local category dictionary. Preserve the
platform's category order and display names in the requested language. Research categories use only
the RECOMMENDED tag from the public filter list; Skill details retain their public tags and types.

Combine marketplace keywords, categories, and pagination in native SkillHub search; do not filter
only the first page already loaded. If the deployment omits tags in list results, complete tags and
providers from current-page Skill details with bounded concurrency. Installation and download retain
the existing fixed-version, review, and redirect trust boundaries.

Fetch remote tags for a local Skill only from its recorded namespace / slug when it matches the
current registry; do not infer the source from the local name. If there is no matching source, mark
it unlinked. If the remote request fails, mark tags unavailable rather than showing an empty tag set.
Do not fall back to old `category` metadata for this category bar. Reuse categories and tags only
within the current page-request lifecycle; reload them on refresh and language change.

Desktop source tabs and research categories are separate dimensions: tabs preserve installation
ownership, while the category bar consumes platform tags. Changing category, query, language, or tab
invalidates old marketplace requests. If the selected category has been removed by the platform,
return all results and show a notice. Real Desktop and API acceptance must still be performed
separately; deterministic fixtures do not establish product acceptance.

<a id="综述提取内核依赖"></a>
## Literature Review Extraction Engine Dependency

`literature-review` declares an import of `knowledge_layer.comprehend` and consumes `deep-rnd-l1`
delivered as a product dependency; the Skill itself does not download or install the engine. The
framework's literature domain provides `service.literature.service.atomic` for PDF parsing and
minimal card/mapping asset interfaces, reusing the same extraction engine while skipping full-text
reading and summary presentation. Literature review adapts model calls and does not maintain a
separate parsing or provenance system. Successful assets are cached by the framework; the cache
does not create library records. They are associated and reused only after the user explicitly
imports matching bibliographic metadata/PDF. Writing context consumes only plain content and
citation keys. This dependency, together with the candidate input for `agentic-search`, is delivered
through source metadata, the frozen lockfile, and the compiled inventory; business authorization
belongs to the literature domain.

<a id="验证和回写"></a>
## Verification and Write-back

- Workflow instructions: use applicable structure/script tests plus a real coding-host invocation;
  check read-only behavior, authorized writes, and failure semantics.
- Product Skills: run the adaptation guide's prebundle/distribution checks, affected script tests,
  and actual Serve/Electron discovery, loading, and behavior verification. Use user data/credentials
  only within this task's authorization.
- Discovery isolation: verify against the [real Codex isolation contract](../../tests/contract_codex_isolation.py)
  and a real product flow; source code or a configuration manifest does not prove isolation is active.

When discovery, presentation, dependencies, or physical roots change, update the corresponding
Owner; update this page when the mechanism changes. Leave versions and Skill counts to the actual
configuration and generated inventory; do not turn old test statistics or one run's state into a
current guarantee. Literature-review workspace and full-text authorization boundaries remain with
their business Skill and service contract; do not place them in the generic Skill system.
