<a id="项目中心创建查找与重命名"></a>
# Project Center: Create, Find, and Rename

Help users create a project, find it in the list, and change its display name and description.

**Semantic entries**: Project Center → “新建项目”; an existing project card's action menu → “编辑项目”. “返回项目中心” at the top of the project workbench returns to the list.

Full-window reference for Project Center

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-12; shows the isolated Project Center list and New Project entry. Project names, descriptions, paths, and list state are the data from that time. The image does not prove project creation, archiving, restoring, or switching between projects.

New-project form in the target package

Reference: same target version, 2026-11-13; the new-project form in an isolated instance, with a synthetic name and description entered. The path is truncated in the image; creation was not submitted and no folder was selected. This is a display reference only, not proof of the project-creation outcome. See [build evidence](./build.md).

![Project Center reference](./reference.png)

<details>
<summary>New-project form reference</summary>

![New-project form reference](./form.png)

</details>

Reference image source: macOS arm64 `0.3.0 / 202610271421`, 2026-10-28; contains only isolated synthetic projects. Names, descriptions, directories, and list counts are dynamic examples. The truncated path is not a full-value criterion. This is not a pixel standard or evidence of acceptance in the current run.

<a id="创建项目"></a>
## Create a Project

<a id="列表与入口project-obs-001--v03"></a>
### List and entry (PROJECT-OBS-001 · v`0.3`)

Project Center has a New Project entry; when projects already exist, they can be searched. Project-card names, descriptions, and directories match project registration. When no description exists, show placeholder copy. Long content may be truncated; the full path need not always be expanded.

<a id="新建表单project-obs-002--v03"></a>
### New-project form (PROJECT-OBS-002 · v`0.3`)

The new-project form has a required name, optional description, read-only directory, and Create/Cancel entries. The name and description each show the current character count and a 100-character limit. If no existing folder is selected, the directory preview is derived from the name and matches the preview under the current default workspace; it is not fixed to a historical path.

<a id="空名称校验project-obs-003--v03"></a>
### Empty-name validation (PROJECT-OBS-003 · v`0.3`)

Submitting an empty name keeps the form open and prompts for a project name; no project registration or project directory is added. After entering a valid name, the validation prompt disappears. The Create button is not required to be disabled for an empty name.

<a id="创建结果project-obs-004--v03"></a>
### Creation result (PROJECT-OBS-004 · v`0.3`)

After successful creation using the default directory, the form closes and the new project's workbench opens; the current project matches the creation result. “新任务” may be shown by default; opening the resources panel automatically is not required. The project is actually located at the preview directory shown in the form before creation, and both registration and the directory exist. The description matches the submitted value. The project name uses the directory name from the creation result; do not assume arbitrary input is preserved verbatim as a directory name.

<a id="查找与编辑"></a>
## Find and Edit

<a id="搜索与恢复project-obs-005--v03"></a>
### Search and restore the list (PROJECT-OBS-005 · v`0.3`)

Project search filters by substring match in name or description, ignoring leading/trailing query whitespace and letter case. Results match registered project information. If no project matches, show a no-results notice; clearing the query restores the list.

<a id="编辑回填与取消project-obs-006--v03"></a>
### Edit form and cancel (PROJECT-OBS-006 · v`0.3`)

The card's action menu opens the edit form and populates the project's name, description, and read-only directory. After changing the name and canceling, the original registration and list name remain unchanged.

<a id="保存重命名project-obs-007--v03"></a>
### Save a rename (PROJECT-OBS-007 · v`0.3`)

After saving a valid new name in the edit form, it closes. The list shows the new name, still associated with the same project. If only the name changed, the description retains its original value; searching the new name finds the project.

<a id="返回后保持project-obs-008--v03"></a>
### Persist after return (PROJECT-OBS-008 · v`0.3`)

After leaving and returning to Project Center, the new name still matches project registration. The project ID, directory, and creation time are unchanged from before the rename; the original directory still exists, and no additional project was created.

<a id="验证归属"></a>
## Verification Ownership

001–008 are automated checks for this workflow; one newly created project covers creation, search, editing, and return states. Folder selection, migration, archiving, recovery from faults, tasks, and other Project Center features are outside this baseline.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoint from v`0.3` is PROJECT-OBS-001. This covers only the scope below and does not mean every criterion under these IDs passes.

Project Center should show the project list/cards and New Project entry. Visible names, descriptions, and directories match authorized task project registration; do not treat an empty list as proof that a project was created.

Required reference: minimal registration for the authorized task project—name, description, and directory. Do not read other project contents.

<a id="专项层"></a>
## Specialized Layer

Not selected in this layer: new-project validation/creation, search, editing, and persistence after return. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved merely by this layering.

<a id="项目使用与生命周期候选专项"></a>
## Candidate Specialties: Project Use and Lifecycle

The following candidates were organized from historical requirement assets. They do not change adopted PROJECT-OBS-001–008 or the quick-review denominator. The `@` numbers in historical IDs are revisions of historical assets, not product requirements versions. Requirements version, entry points, and applicability for target `0.3.2 / 202611121823 / preview` remain to be confirmed. See [build evidence](./build.md) for sources and boundaries.

<a id="项目置顶与排序候选project-pin-cand-001"></a>
### Candidate: pinning and project order (PROJECT-PIN-CAND-001)

Historical requirements: in the Project Center home list, pinned projects appear first, with each group sorted by creation time descending. Unpinning restores creation-time order. Task activity does not change the home project order; this rule does not extend to the switcher menu. In the project switcher menu, pinned projects show a pin icon. Current selection and pin status are independent. After unpinning, the project disappears from the pinned grouping and its menu indicator is removed. Use at least two authorized isolated projects with distinguishable creation times, independent registration, and before/after state. Check pinning, both unpinning orders, ordering after activity, and the menu indicator separately. Search and restart behavior require their own authorization and references.

Current source sorts projects within a home group using task activity time, which conflicts with the historical requirement. The target package's requirements version, applicability, and conflict resolution require Owner confirmation; do not infer the correct requirement from implementation or old acceptance. This candidate is not in adopted quick review. Pin-state writes, model tasks, and restart each require separate authorization. Complete-window images of the target package before/after pinning and an independent state reference are still missing.

<a id="首页最近任务候选home-task-cand-001"></a>
### Candidate: recent tasks on Home (HOME-TASK-CAND-001)

Historical work records require Home to show recent tasks belonging to its project without a seven-day cutoff, sorted by activity time. Show ten first, then append ten more per action; hide More at the end. Retain task search and, after clicking a task, enter its associated project and conversation. Even with more than 500 tasks, the authorized scope should remain fully browsable. Use an authorized isolated project and independent task registration (IDs, titles, project, activity time) as references. Check list, order, and project/conversation identity after opening one task. Incremental loading, end-of-list, search, and more than 500 items are specialty scenarios requiring corresponding data.

Natural recent-tasks state on Home

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; the full product viewport on Home with three synthetic tasks in an isolated project. The image includes the local username and isolated workspace path; verify applicability before external distribution. No task was clicked and pagination/search were not verified. The static image does not prove ordering rules or formal evaluation acceptance. See [build evidence](./build.md) for sources and independent directory references.

Current source uses eight-item pages with previous/next pagination; Home's query filters projects but is not passed to recent tasks. This conflicts with the historical incremental-loading and search descriptions. Target-package behavior, requirements version, applicability, and conflict resolution need Owner confirmation. This candidate is not part of adopted quick review. Preparing isolated projects/tasks, opening conversations, and possible model calls each require separate authorization; do not read real-user task content. Target-package pagination-state images, independent task registration across all projects, and trusted source-to-artifact binding are still missing.

<a id="跨项目切换历史-proj-switch-012"></a>
### Cross-project switching (historical `PROJ-SWITCH-01@2`)

Prepare two authorized isolated projects with distinguishable resource contents. From Project Center, enter projects A and B, then return to A. Each workbench identity and resource scope must match the selected project's independent registration and synthetic-resource markers; do not treat another project's resources as current. A title change alone, card click, or empty resource list cannot prove data isolation. Do not infer external project changes, running-task behavior, or restoration of all conversations.

<a id="接入已有文件夹历史-proj-adopt-012"></a>
### Adopt an existing folder (historical `PROJ-ADOPT-01@2`)

Use the real entry in the new-project form to manually select and confirm an authorized synthetic directory for this run. The terminal state is a project linked to the selected directory, with existing synthetic resources identifiable. If the entire adoption flow is canceled, compare independent project registration before and after to ensure no candidate project was added; merely closing the picker while leaving the form open is not canceling the entire flow. Folder selection and import require human confirmation; do not substitute a prefilled API or default directory for real selection.

<a id="归档与恢复历史-proj-archive-012proj-restore-012"></a>
### Archive and restore (historical `PROJ-ARCHIVE-01@2`, `PROJ-RESTORE-01@2`)

For an authorized non-default isolated project, first record stable identity, root directory, and distinguishable resources and tasks. After archiving, the project no longer appears in the default list but remains as the same restorable object in archive management; archiving is not permanent deletion. After restoring, re-enter the same project and verify its original identity, root, and existing resources/tasks. A notice or same-named card is not a substitute for reading back the terminal state. Archive and restore are separate units. Running-task handling, permanent deletion, and recovery from failures are separate specialties.

<a id="数据授权及截图缺口"></a>
### Data, authorization, and screenshot gaps

Reuse [the examples manifest](../../../../../examples/projects/evaluation/project.json) for synthetic source files, recording each selected file's digest and authorized isolated copy. For cross-project scenarios, optionally use the [two-scope recipe](../../../../../examples/workspaces/scope-pair.json); independently verify each project's identity/path and its own synthetic-resource markers. Archive/restore also requires a real readable isolated task. Preparation does not substitute for the tested switching or importing action. Project preparation, switching, adoption, archiving, and restoring each require corresponding authorization. A human confirms native folder selection and import; do not read or modify real-user projects. Full-window captures for target-package switching between two projects, folder selection, archiving, and restoration have not been verified. Older Project Center images do not prove these terminal states. If data, version confirmation, or operation permissions are missing, retain the gap and keep it out of the adopted smoke denominator.
