<a id="多标签与分屏"></a>
# Tabs and Split View

Full-window reference before adjusting split view

Full-window reference after adjusting split view

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; shows before/after split-view adjustment with synthetic documents in an isolated project. The screenshots alone do not prove the drag operation, tab reordering, or success of any other specialty scenario.

Full-window split-view reference for the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; shows two panes with the same synthetic document. The screenshot alone does not prove switching, dragging, or edit propagation.

Split-view page reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; shows only synthetic documents in split view, not reordering, edit propagation, or close protection.

Verified normal tab, layout, shared-view, and close-protection behavior has been adopted as v`0.3` requirements. Editing propagation in 003 and 008 are write-operation specialties and require authorization for the current run. Invalid/over-limit drop destinations in 005 and save-failure branches in 008 remain unconfirmed.

Open multiple documents in the project workbench, switch tabs, and arrange panes. Semantic entries include normally opening a resource file, the New Tab button in the workbench, and the document tab menu. Actual reachability must be checked by observing the page under authorization.

<a id="打开与切换"></a>
## Open and Switch

<a id="标签入口与身份tabs-obs-001--v03"></a>
### Tab entry and identity (TABS-OBS-001 · v`0.3`)
Fixed and dynamic: After normally opening a file or creating a blank tab, the tab title and selected state correspond to the actual content. Reopening the same document view in the same pane focuses the existing tab rather than creating an unnecessary duplicate. Default tabs appear according to the current business view and workbench state; a hidden overview tab is not required to remain visible at all times.

<a id="切换与干净关闭tabs-obs-002--v03"></a>
### Switching and closing clean tabs (TABS-OBS-002 · v`0.3`)
Dynamic with lightweight interaction: Switching tabs displays the corresponding document. Close Current, Others, Left, Right, and All act on the actual tab group; fixed tabs that cannot be closed are not closed by mistake. After closing a clean document, the remaining tabs or empty work area are appropriate. Closing a tab does not delete its source file.

<a id="同文档多视图与共享tabs-obs-003--v03"></a>
### Multiple views of one document and sharing (TABS-OBS-003 · v`0.3`)
Dynamic and conditional: After splitting one document, both panes identify and initially display the same public document. Closing one does not mistakenly close the other. This does not prove shared editing has been verified. The edit-propagation specialty remains: after modifying an authorized editable synthetic copy in one pane, another view that supports displaying that content reflects the same change, without creating unrelated document copies.

<a id="安排文档窗格"></a>
## Arrange Document Panes

<a id="拆分与能力限制tabs-obs-004--v03"></a>
### Splitting and capability limits (TABS-OBS-004 · v`0.3`)
Conditional: A document that supports splitting can add a view of the same document by splitting right or down while retaining the original view. The limit is two rows, two columns, and four non-empty document panes; panes cannot be added indefinitely. If the actual viewer does not allow moving or splitting, an actionable entry is not required. A matching file extension does not guarantee every file can be split. Sidebars and AI panels do not count as document panes.

<a id="拖动排序与移动tabs-obs-005--v03"></a>
### Dragging, reordering, and moving (TABS-OBS-005 · v`0.3`)
Dynamic with lightweight interaction: Dragging within a tab group changes its order. Moving across panes and dropping at an edge or center matches the visible destination. Moving the original tab is not the same as copying a view of the same document. An invalid or over-limit destination does not create extra panes or lose a tab; when its source pane becomes empty, the layout contracts accordingly.

<a id="调整与可读性tabs-obs-006--v03"></a>
### Adjustment and readability (TABS-OBS-006 · v`0.3`)
Dynamic with lightweight interaction: Dragging a divider adjusts the corresponding panes. Each pane retains identifiable content and an active tab, and focus matches the pane actually operated. Within supported window sizes, long titles remain identifiable and tabs/key actions remain reachable. Do not hard-code pane width/height in screenshot pixels or require a phone-style layout below the native window minimum.

<a id="返回与保护内容"></a>
## Return and Protect Content

<a id="项目返回与布局tabs-obs-007--v03"></a>
### Returning to a project and its layout (TABS-OBS-007 · v`0.3`)
Dynamic and conditional: After leaving a project and returning in the same process, compare with the visible record from before leaving; restore that project's document tabs, active document, and pane layout without mixing in another project's state. Judge the in-process memory for document split view separately from the persistent layout of the project workbench/conversation shell. Successful switching does not promise that all documents and panes restore after restart.

<a id="未保存关闭保护tabs-obs-008--v03"></a>
### Unsaved-close protection (TABS-OBS-008 · v`0.3`)
Conditional specialty: Use a disposable, authorized editable document and assess close protection according to the number of shared references and automatic-save conditions. Closing the last unsaved reference must not silently lose edits; Cancel retains the edits, and the tab closes only after a successful save. A save failure must not appear successful. Do not require the same confirmation dialog when a shared view remains or automatic saving has already succeeded. Discard only with explicit authorization; visibility of a dirty marker is not a substitute for determining whether changes remain unsaved.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

The quick-review scope is adopted display and clean-document actions for 001–007; unconfirmed abnormal branches are not included on that basis. The edit-propagation branch in 003 and 008 are authorized specialties requiring a disposable copy and the corresponding edit/save/discard permissions. Select the branches and counting rules before execution. Identical initial text in two panes cannot mark 003 edit propagation as passed; an initial read-only run does not retire 008 or reclassify an unexecuted specialty as complete.

The basic scenario requires at least two openable synthetic documents. Returning across projects requires two distinguishable projects. If these prerequisites are unavailable, record the scenario as uncovered. 008 owns the close-protection criteria; later document-saving baselines reuse them rather than duplicating them. This page does not cover complete saving, viewer content, models, or file-management behavior.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Carry forward the originally adopted normal display and clean-document actions for TABS-OBS-001–007 in v`0.3`; do not narrow them because of evidence gaps in a previous run. Check opening/re-focusing an already open document, tab switching, and clean closing (001/002); split supported documents and compare initial views of the same document (003/004); check that normal reordering/moving and divider adjustment correspond to the tabs, content, and layout (005/006); and check restoration of tabs, active document, and panes after leaving and returning to a project in the same process (007). Freeze specific directions and capability conditions from the original text; exhaustive testing of every destination and layout combination is not required.

Required references: authorized isolated copies of shared example-project [overview.md](../../../../../examples/projects/evaluation/files/overview.md) and [detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt), project/path mapping, and the visible tabs/layout before each action. Cross-project return still requires two distinguishable projects. Preparing data is not an import test; a human confirms import. If data, capability, or action evidence is missing, record the gap; do not switch to internal state or claim edit propagation from identical initial content in both panes.

<a id="专项层"></a>
## Specialized Layer

<a id="页签溢出列表tabs-overflow-cand-001需求版本待确认"></a>
### Tab overflow list (`TABS-OVERFLOW-CAND-001`; requirements version to be confirmed)

Historical user screenshots and follow-up feedback require a list of all tabs to the left of the full-screen button when tabs can no longer fit even after collapsing to icons. Use distinguishable real tab identities and the selected item in the same authorized window as references; check the overflow entry, list, and destination after selection. This candidate does not imply that the entry must appear when the tabs fit as icons. Applicability to the target package, selection target, and requirements version remain to be verified. Verify narrow windows, themes, cross-platform behavior, and window-layout changes separately; do not present results from historical development instances as a pass for this package.

Natural tab-overflow-list state

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; the real list after narrowing split view in an isolated project. No menu item was selected, so the image does not prove target switching, reordering, or formal evaluation acceptance.

A single normal action does not cover all close-menu cases, four-pane limits, or every drop target/narrow-window combination in 001–007. Shared editing in 003 and unsaved-close protection in 008 still require write-specialty authorization. Normal moving, adjustment, and project return remain in quick review. This layer does not prove that every detail of every ID passes or change automated eligibility or unconfirmed abnormal states.
