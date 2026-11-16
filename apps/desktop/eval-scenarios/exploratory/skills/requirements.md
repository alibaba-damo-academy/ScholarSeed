<a id="技能发现与详情"></a>
# Skill Discovery and Details

Find skills, distinguish their sources, and inspect their descriptions. Entry: main screen “扩展” → “技能”. The default page is “技能广场”; “系统预置” and “我添加的” are also available.

Search-results reference for skills in the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; shows search results in the Skill Marketplace. Names, sources, and count vary with the catalog. The image alone does not prove details, installation, or invocation. See [build evidence](./build.md).

Skill-detail reference for the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; shows marketplace search results and the corresponding detail dialog only. Names, versions, sources, and states vary with the actual catalog; it does not prove installation or invocation.

System-provided skill list reference for the target version

User-uploaded skill empty-state reference for the target version

Reference: same target version, 2026-11-12; shows the system-provided list and empty state for user uploads at that time. The mapping between old source groups and the target version remains to be confirmed. Lists, switches, and empty states vary by environment; neither image proves installation, enablement, or acceptance of the whole page.

![Skill Marketplace reference](./reference.png)

Additional references: [system list](./system.png), [local detail](./detail.png). Source: macOS arm64, 0.3.0 / 202610281438, 2026-10-29. Cards, categories, names, counts, versions, and states vary with the current catalog; image values are not fixed.

<a id="发现技能"></a>
## Discover Skills

<a id="页面与来源分区skill-obs-001--v03"></a>
### Page and source groups (SKILL-OBS-001 · v`0.3`)
Fixed: Skills/connectors navigation, source tabs, search, and add entries are clear, and the selected tab matches its content. Conditional: Loading, read failure, and a genuinely empty list show distinguishable feedback; a failure must not appear as no skills.

<a id="列表与卡片skill-obs-002--v03"></a>
### Lists and cards (SKILL-OBS-002 · v`0.3`)
Dynamic: “系统预置” and “我添加的” lists separately match system and user skills in the current settings-page catalog response. Card name, current-language description, and source label match catalog metadata; count is not fixed. Marketplace cards match the current market query result; do not treat all bundled skills as settings-page list entries.

<a id="搜索与清空skill-obs-003--v03"></a>
### Search and clear (SKILL-OBS-003 · v`0.3`)
Dynamic: Local skills can be searched by visible-name or description keywords. Marketplace results are checked against the service response for the same keyword. No matches show a no-results notice; clearing restores that source's list. Conditional: Each source retains its own query; do not apply a filter from another tab to the current list.

<a id="市场分类与列表状态skill-obs-004--v03"></a>
### Marketplace categories and list state (SKILL-OBS-004 · v`0.3`)
Dynamic: Skill Marketplace categories include “全部” and recommended categories supplied by the current category service. The selected category matches the result query, and overflow categories can expand/collapse. Conditional: Category loading/failure has feedback; already loaded cards are not duplicated; Load More feedback matches service pagination. Do not label partial results as fully loaded.

<a id="查看技能"></a>
## View Skills

<a id="本机技能详情skill-obs-005--v03"></a>
### Local skill details (SKILL-OBS-005 · v`0.3`)
Dynamic: After opening a system or user card, the detail title, description, source, and author/version when present match the selected skill metadata; when no version exists, say so clearly. The body corresponds to that skill's description file, with metadata removed and normal formatting; long text can scroll. Closing returns to the original list. A document-read failure has feedback; do not display fabricated content or another skill's body.

<a id="市场技能详情skill-obs-006--v03"></a>
### Marketplace skill details (SKILL-OBS-006 · v`0.3`)
Dynamic: Details match the selected marketplace skill and version. Compare name, description, source, optional author/version, and body against detail material for the same skill identity/version. Conditional: Body loading, failure, and absence each have feedback. If a risk block naturally appears, explain it; do not present the skill as installable normally.

<a id="安装与可用状态展示skill-obs-007--v03"></a>
### Installation and availability display (SKILL-OBS-007 · v`0.3`)
Dynamic/conditional: A marketplace “installed” marker corresponds to the same marketplace source, identity, and namespace in the local catalog, not merely a name match. A local switch matches the enable preference; runtime unavailability is not the same as disabled, and operability matches catalog permissions. If signed out and login is required, show a login prompt. If enabled but unavailable for a non-login reason, show the reason. An update marker matches update availability. Install/use entries in details match installed state; the visible entry alone does not prove an action succeeded.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are SKILL-OBS-001–003, 005/006, and 007. This covers only the scope below and does not mean every detail of these IDs passes.

Source groups and visible card name/description in the skill catalog should match the natural availability state. Fix one genuinely visible name, search once, and open its details. The details must belong to that same skill, and the body must match an independent read-only catalog/document reference. Share this with F2; do not switch to internal IDs or another source to bypass a failed search.

Required reference: this run's actually visible name and minimal catalog/document fields from the same source, language, query, identity, and version; do not install or authorize. The [historical artifact-reading record](build.md#当前制品复核) is a location clue only. Verify the target artifact's read contract before execution; do not assume the old package interface still applies.

Separately compare the natural installed entry/marker against the minimal local-catalog projection for the same source, identity, and namespace. If this reference fails, retain the 007 evidence gap; successful search/details do not imply the whole page state passes. Do not retry or switch source to force a pass.

<a id="专项层"></a>
## Specialized Layer

Not selected in this layer: pagination across all categories, all source combinations, installation/enablement/authorization/update. Retain the historical visible-name search concern. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved merely by this layering.

<a id="技能使用主链候选专项"></a>
## Candidate Specialty: Main Skill-Use Chain

Natural state of the skill-add menu

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; full viewport of the skill page and add menu in an isolated instance. No menu item was executed, so this does not prove creation or upload succeeded.

**Create a skill through ScholarSeed (`SKILL-CREATE-CAND-001`; requirements version to be confirmed):** Historical design records show that the Add menu can enter a creation task; another record says an unsupported entry was temporarily hidden. Actual availability and scope in the target package remain to be checked. If applicable, distinguish the creation entry, project and description, real task, and skill artifact. Ordinary skill use or local upload is not a substitute. Model calls, generation, and writes each require separate authorization; do not prefill product results.

**Review and install a conversation-generated skill (`SKILL-GENERATED-INSTALL-CAND-001`; requirements version to be confirmed):** Historical user screenshots record initiating installation from a conversation install card, the host rechecking the same generated package, showing a read-only install preview, then requiring explicit confirmation. This needs a real generated package, independent identity/digest, and authorized environment. Assess preview, confirmation, and actual installation outcome separately; local-upload preview or a simulated card is not a substitute. Import evaluation is excluded this run and generated-package installation is not selected. Target-package applicability and real screenshots remain to be checked.

**Source display to be confirmed:** Keep existing `SKILL-OBS-002` text. Verify the mapping between later design distinctions for source-group labels and owner/repo links and the target package; do not remove existing requirements based directly on source code or this reorganization.

**Marketplace skill-source display (`SKILL-MARKET-SOURCE-CAND-001`; requirements version to be confirmed):** Historical user requirements say marketplace skills and installed marketplace-sourced skill details display GitHub, and the bottom label on marketplace-sourced cards in “我添加的” matches. Do not generalize this to official, user-uploaded, or local sources. Use independent installed-source data and list/detail identity for the same skill to verify both displays separately; display copy does not change backend installation source. Target-package applicability, requirements version, and complete-window images remain to be checked. A menu, single card, or old-version run does not prove acceptance.

The product-requirements version, applicability to the current target package, and adoption of the following historical requirement clues remain unconfirmed. The historical `@` suffix is a business-point asset revision, not the product requirements version. See [build evidence](./build.md#技能使用主链候选skills9) for historical IDs, sources, and mappings. This section does not add them to adopted smoke or the execution denominator.

<a id="本地技能预览与安装历史-skill-install-local-011"></a>
### Local skill preview and installation (historical `SKILL-INSTALL-LOCAL-01@1`)

Select an authorized synthetic skill through the local-upload entry on the skill page, inspect its corresponding name/version/description, and explicitly confirm installation. Terminal state: independently read the same object's source and version from the local catalog, matching the selected original material. A local marker or card alone does not prove installation. A human confirms file/directory selection and installation, with explicit authorization; conflicts, scan failures, and uninstall are separate specialties.

<a id="市场技能安装skill-market-cand-001"></a>
### Marketplace skill installation (`SKILL-MARKET-CAND-001`)

For a marketplace skill whose source, identity, and version can be verified, initiate an authorized installation from the list or details, then verify the result in the local catalog under the same marketplace source, identity, namespace, and version. See build evidence for the historically user-confirmed marketplace flow; applicability to the target version and default enablement after installation remain to be checked. Network access, third-party content, installation, and possible dependency handling need corresponding authorization. A matching name, checkmark, or button feedback cannot substitute for an independent catalog result.

<a id="停用与恢复历史-skill-enable-012"></a>
### Disable and restore (historical `SKILL-ENABLE-01@2`)

In an authorized isolated state, separately observe disabling and restoring the same operable skill: after disable, the new-task skill picker does not falsely report it selectable; after restore, the same skill is selectable again. Compare each with that skill's enabled state in the local catalog. System skills and user-created skills in this run are different sources and cannot substitute for one another. A visible detail button does not prove actual invocability. Rollback after failure, concurrency, and persistence across restart are separate specialties.

<a id="选择技能并完成任务历史-skill-invoke-012"></a>
### Select a skill and complete a task (historical `SKILL-INVOKE-01@2`)

From the skill center, select an invocable skill and target project, enter a synthetic task description, and verify that the new task contains the same skill identity and original description. If real sending is in scope, verify the skill identity and execution association in the same real turn and its corresponding final result. When a version exists, bind and verify it; do not treat the optional version field in current source as a requirement. Confirm how a missing/unbound version affects judgment for the selected skill and requirements. Composer references, send request, actual skill execution, and answer outcome are separate observations. Draft text, a visible entry, or model self-report does not prove task completion. This path may submit automatically; selecting a disabled skill may also prompt to enable it. Before acting, confirm isolated project, state change, model/cost, and send permissions. Without authorization, do not confirm enablement or click an entry that may send.

**Candidate subpoint: display names and registered identity across entries:** For one marketplace-source skill, independently verify Chinese and English display names in Skill Marketplace, “我添加的”, and conversation `/` and plus skill pickers, using same-language/source/identity catalog references. For system-provided skills, also compare Chinese/English names in the management page and picker. If sending is selected, verify the actual registered name sent to Codex (not the localized display name), and separately assess execution association and final result. A matching name alone does not prove identity; a draft or UI display does not prove a real send. This subpoint supplements the invocation candidate above and is not counted as a separate flow. Target-package applicability, requirements version, and adoption remain to be confirmed. Language-preference changes, marketplace access, real sending, and model cost each require separate authorization. Use isolated state and minimal necessary identity references; do not read/save the user's real skill directory or credentials. Complete-window evidence for cross-language pickers and real sending in the target package is missing; historical screenshots/source are not substitutes.

These specialties require complete-window screenshots of the real target page and necessary intermediate states. Existing list/detail references show only discovery and cannot prove installation, enablement, picker selection, or a real turn. The [synthetic skill input](../../../../../examples/projects/skill-import/files/SKILL.md) and its manifest are for checks before human-confirmed import; do not install automatically. Do not use a user skill directory or pre-seeded installation state as a substitute. If a real run lacks screenshots, permissions, or independent references, retain the gap.
