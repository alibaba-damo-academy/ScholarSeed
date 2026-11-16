<a id="主导航基线构建依据"></a>
# Main Navigation Baseline: Build Evidence

<a id="全局范围参考图navigation8"></a>
## Global-scope reference images: navigation/8

The two images are byte-identical copies of full-window captures from an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance on 2026-11-13. Target disk ASAR SHA-256: `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The original run, including actions, screenshots, and page observations, is in the ignored directory `tmp/test_snapshot/desktop/navigation-selection-20261113/driver/`. The disk hash is not evidence about in-process memory.

| Reference Image | Original Evidence | SHA-256 |
| --- | --- | --- |
| `literature-20261113.png` | `literature.png` | `0ed25ae41755ff5c4192150df3e4f85a471d72b0127c3b246dc8b511d4cf800f` |
| `extensions-20261113.png` | `extensions-settled.png` | `21c6ee515527c0a59d1dec00777fef6f17a88a347c0089ec5b4c23abcb585d7a` |

Individual inspection confirmed that the images show the Literature Center empty state and the Extensions skills page, with the corresponding navigation item selected. Static images alone do not prove that switching works, that literature is non-empty, or that a skill is installed. See the original and supplemental reports from the same run for specialized results and later reference timing. This does not change the requirements version, criteria, or historical freeze.

<a id="20261112-完整窗口参考图navigation7"></a>
## 20261112 full-window reference: navigation/7

`window-20261112.png` is a copy of the complete original window capture from an isolated macOS arm64 `0.3.2 / 202611121823 / preview` installed instance. Source: `tmp/test_snapshot/desktop/baseline-1823-batch3/driver/evidence/navigation.png`. SHA-256: `7bc21a3275fab74211c664c2dfcfe62e31563dbcc0be05fba740444fa4875122`; target ASAR SHA-256: `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The project and documents shown are synthetic data. The image shows only the current workbench and does not prove other navigation states. Older partial images and historical records are retained but are no longer page references for current requirements.

<a id="202611121823-正常导航沿用依据navigation6"></a>
## 202611121823 basis for carrying forward normal navigation: navigation/6

For macOS arm64 `0.3.2 / 202611121823 / preview`, carry forward the adopted quick-review subpoints NAV-OBS-001 and 002–004 from navigation/4 under the user's unified adoption rule of 2026-10-30: the Project, Literature, and Extensions entries and selected state match the actual work scope. Review of the adoption and subsequent revisions in this page found no record confirming retirement or change of this sub-scope. This is a bounded review; it does not establish the complete requirements change history, source-to-artifact identity, or reachability of the real entry points. New runs must use task project registration and the current workspace as independent references; handle onboarding side effects and gaps according to the actual authorization. Unselected scopes such as closing settings and a complete cross-area round trip do not pass based on this record. Original IDs, v`0.3`, body criteria, and historical decisions remain unchanged.

<a id="历史修订202610301343包内静态复核"></a>
## Historical revision: static review of the 202610301343 package

Asset revision: `navigation/5`. This revision only adds the specified new-package source, input/independent reference, and quick-review boundary. Original stable IDs, v`0.3`, adoption rule, full text, reference-image version/date, and historical results are retained. The following older sources and revision records are historical; they do not establish package identity or the outcome of the current run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Source: the actual installed package extracted for this task and its loose renderer payload. The source commit is unknown; the current checkout/remote HEAD can assist location only and is not asserted to be the same source. The evidence inventory is `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json` in an ignored directory. Package paths below are relative to its `package/` root; the temporary extraction directory is not treated as a durable cross-worktree asset.

In the package, `out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: at 1338, `applicationRenderer` selects the renderer under `applicationResources` when packaged; at 41203, the branch without a development URL delegates to `serveAssets`. This chain is tied to the actual loose payload analyzed here. It does not prove that runtime development overrides are unset, and a static entry point is not a product observation.

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。

In the packaged index, `ActivityRail` at 87727 and `TopBarLeft` at 88261 define the entries and current state; `openProjectCenter` at 10797 still prefers a valid `rememberedProjectId`, otherwise `home`. Fixed entry semantics and dynamic project identity/remembered-state conditions still correspond to NAV-OBS-001–005. Project references must come from authorized task project registration and the visible identity before leaving in the same run; the return screen alone cannot establish that remembered state was correct. Quick review retains its existing static scope; cross-area round trips and closing settings remain specialized. Do not bypass onboarding overlays.

Samples in the requirements refer to authorized isolated copies of repository originals. Before execution, record the mapping from each original's digest to the task project ID and actual post-import path; historical `eval-*-20261030` names are aliases for old runs and are not assumed to exist in a new installation. Independent evidence for projects/resources, column preferences, and the minimal API projection still requires authorization for this run. Static compatibility does not prove that normal UI is reachable or that behavior passed testing. This revision did not start, connect to, or operate the product; read no user state or credentials; and called no external API. It does not change runtime state or reduce any unready specialized scope.

<a id="历史构建与分层记录"></a>
## Historical build and layering record


Revision: navigation/4. The five requirements received independent review. In the first run on 202610281438, four passed and 002 lacked evidence. After explicit authorization to advance onboarding, the Literature Center onboarding was completed in a new isolated process on the same build, followed by a real return to the project through Extensions; 002 then passed. The same build totaled 5/5, not a full run in one session or a pass for every project branch. The original 4/5 report and evidence-deficient image remain; neither the original criteria nor the v0.3 marker was changed, and 002 was not removed from the automatic denominator. This covers only work scope and visible location, not project creation, cross-project data isolation, literature content, skills, or task behavior baselines.

Target: macOS arm64, 0.3.0 / 202610281438 / preview; `app.asar` SHA-256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`, renderer `index-C4-PYlXk.js` SHA-256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`. `ActivityRail:86031`, `HOME_SPACE_KEYS:86015`, `TopBarLeft:86485`, `openProjectCenter:10026`, and `SkillCenter:67678` were checked within bounds in the package; this does not establish identity of the entire repository.

| Requirement | Fixed/dynamic/conditional behavior and independent criterion source |
| --- | --- |
| 001 | [ActivityRail](../../../src/renderer/src/shell/ActivityRail.tsx):32/120–147 has only the global `home`/`literature`/`skills` entries, expressing location through `label`, `aria-current`, and selected styling. In [Chinese layout](../../../src/localization/locales/zh/layout.json), `projects`/`literature`/`extensions` correspond to Project Center/Literature Center/Extensions. Project current state includes `home` or a selected project; the `home` route is not required to count as being in a project. |
| 002 | [store](../../../src/renderer/src/store.tsx):1698/1707/2758; `rememberedProjectId` only records a previously selected project. `openProjectCenter` selects the project and `resource`/`preserveProject` when a valid remembered ID exists; otherwise it uses `home`. Do not misstate the “项目中心” button as always opening the project overview. In the same run, record the actual project title/work scope at the first destination as the reference for a later return; that observation does not establish the correctness of an unknown historical remembered value. |
| 003 | store:2940–2990; normal main-navigation entry to `literature`/`skills` does not pass `preserveProject`, clears `homeSelectedProjectId`, and updates scope. [TopBar](../../../src/renderer/src/shell/TopBar.tsx):44 onward distinguishes global literature. When the module panel is open, `topbar-literature-title` is used; when collapsed, the same title node need not remain present. [Literature feature](../../../src/renderer/src/features/literature/feature.tsx) changes `LiteratureScope` with `projectId`; do not generalize to item isolation unless that is established. |
| 004 | [Extensions feature](../../../src/renderer/src/features/skills/feature.tsx):15–90; the top-level entry label is `layout.extensions`, not `layout.skills`. `SkillCenter` has `skills`/`connectors` tabs and mounts `skills` by default. Check only that current-tab content corresponds; reuse existing skills/connectors requirements for the detailed catalog and do not duplicate their criteria. |
| 005 | [App](../../../src/renderer/src/App.tsx):1109 calls `openSettings(null)` from `onClose`; store:2910 projects only the settings panel and does not change `mainView` or the current project. A run needs evidence of the actual work scope before opening settings; a single image after closing cannot establish the previous state. |

Do not read internal store or replace clicks with internal dispatch. Fixed navigation semantics and the authorized action order are expected; for project return, use the title/scope visible before leaving in the same run as the independent temporal reference. If the prior scope or project identity is missing, retain the evidence gap; do not invent an expected value.

Navigation may normally load a directory, literature, or project list and save navigation position. It does not create business data, install/enable extensions, or send tasks. Do not proactively read historical snapshots automatically generated by settings. Whether the current isolated state remembers a project must be based on real page records; do not prepare a navigation destination in advance. Keep run authorization, budget, calls, and detailed reports only in ignored directories.

First-run onboarding may affect operability: the Spotlight at [Onboarding](../../../src/renderer/src/features/onboarding/Onboarding.tsx):78–191 includes an overlay and Dialog. The first real hit test confirmed that the overlay blocked the Extensions entry. This explains the evidence gap at the time; source code does not replace a navigation result, and onboarding must not be cleared through internal state. Later, with explicit authorization, normal Literature onboarding was completed and real navigation supplied evidence for 002; do not rewrite the first-run record.

“Skip” does more than close a temporary overlay: Onboarding:384–389 marks `home`/`project` as seen, `engine.finish` also marks the currently ready onboarding group, and then navigates to `home`; store:2449 submits onboarding preferences through `preferenceWriter`. Corresponding logic exists in target-package renderer at 72439, 72107, and 9739. Treating this action as ordinary navigation would miss the persistent write and page transition. Before retesting, the required operation permission or a naturally unblocked state must be available; do not present Skip's automatic return to Home as the main-navigation return result for 002.

The entry has been verified as the three main-navigation items in the main window's sidebar. The reference image is an unedited copy of the first-run `06-project-work.png` from 2026-10-29, SHA-256 `2569a3effa168570daef412688b06e11b41e2632ca0881090ef7fa2d04aeb3a6`. It shows an isolated default project and empty task state and contains no real user content. It helps illustrate the project overview when there is no valid remembered project; actual directory/project values are not fixed. Keep the screenshot source and run trace in the original evidence directory. Judge return behavior from actual before/after states in each run, not from the reference image.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset is revision `navigation/4`. Under the user's pre-release quick-review objective and unified adoption rule, this revision added quick-review and specialty layers to the same requirements file, reusing the source binding, exact artifact, and existing review on this page; the old v`0.3` business version and full criteria are unchanged. Selected sources are the explicit subpoints in NAV-OBS-001 and 002–004. Required reference: verified task project registration and current workspace; no additional input is needed. Not selected: complete cross-area round trips, fallback to a recent project, and closing settings. Parts without supporting evidence remain unconfirmed.

This revision only layers criteria before execution; it does not establish product acceptance or replace historical full runs. Later runs consume subpoints frozen after independent review; quick-review results must not be presented as covering all criteria under the original IDs. This build adds no product-operation or data-write permission.
