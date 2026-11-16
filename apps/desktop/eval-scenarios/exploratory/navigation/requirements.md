<a id="主导航与工作范围"></a>
# Main Navigation and Work Scope

Switch among project work, global literature, and extensions, and return from settings to the work area. Entry points: the main navigation in the main window's sidebar; settings are available from the avatar menu.

Full-window reference: project workspace and main navigation

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; the full window showing an isolated project workspace and main navigation. Project and recently visited state can change; the image is not a fixed expected state.

Reference: literature-center navigation state

Reference: extensions navigation state

Reference: the same target version, 2026-11-13; full-window views of the empty literature center and extensions skills page. Counts and directory contents vary by environment; screenshots alone do not prove the navigation action or complete business functionality. See [build evidence](./build.md) for the source.

<a id="切换工作范围"></a>
## Switching Work Scopes

<a id="主导航定位nav-obs-001--v03"></a>
### Main navigation location (NAV-OBS-001 · v`0.3`)
Fixed: The Project Center, Literature Center, and Extensions entry names are clear, and the current entry has a visible selected state. The selected entry matches the actual workspace; a hidden panel cannot stand in for the current page.

<a id="项目入口与返回nav-obs-002--v03"></a>
### Project entry and return (NAV-OBS-002 · v`0.3`)
Conditional: If a recently visited project still exists, the Project Center entry returns to that project's workspace; if no valid recent project exists, it opens the project overview. After leaving the project entry for a global area and returning, the prior project workspace or project overview remains. If returning to a project, its title matches the one previously visible. Opening the resources panel or creating a task is not required.

<a id="全局文献范围nav-obs-003--v03"></a>
### Global literature scope (NAV-OBS-003 · v`0.3`)
Fixed: The Literature Center in the main navigation enters the global literature scope and displays the corresponding literature-center/overview interface, rather than the previous project's resources or conversation. A remembered project must not keep the user in that project's literature scope. Literature entry contents and cross-project data isolation belong to separate business baselines.

<a id="全局扩展范围nav-obs-004--v03"></a>
### Global extensions scope (NAV-OBS-004 · v`0.3`)
Fixed: The Extensions entry opens the global skills and connectors area. Both tab entries are clear, and the selected tab shows its corresponding content. Detailed criteria for the skills directory and connectors reuse their respective baselines.

<a id="返回工作界面"></a>
## Returning to the Work Area

<a id="关闭设置nav-obs-005--v03"></a>
### Closing settings (NAV-OBS-005 · v`0.3`)
Fixed: Closing settings returns to the work scope that was open before settings. The settings overlay disappears, and closing settings does not navigate to another business scope.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are NAV-OBS-001 and 002–004. This covers only the scope below; it does not mean every detail of these IDs passes.

The Project Center, Literature Center, and Extensions entries in the main navigation, and the current selected state, must match the actual workspace. Use the task's project registration as the reference for the identity of the current project.

Required reference: verified task project registration and current workspace; no additional input is needed.

<a id="专项层"></a>
## Specialized Layer

Not selected in this layer: the complete cross-area round trip, fallback to a recent project, and close-settings flows. The original full criteria, stable IDs, versions, and historical results remain. Unconfirmed branches are not approved merely by this layering.
