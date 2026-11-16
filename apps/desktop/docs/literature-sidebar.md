<a id="文献侧栏名称顺序与筛选"></a>

# Literature Sidebar Names, Order, and Filtering

Status: current, 2026-09-18, branch `guide_subu`.

<a id="最终范围"></a>
## Final Scope

Restore the sidebar layout from before the changes, within the scope last confirmed by the user. Keep only the name, order, and related filtering changes.

- All-library view: My Literature → All / Recently Added / Unorganized → Collections → Linked to Projects → Tags. Do not render the project group when there are no projects.
- Project view: Literature in This Project → the three views → Collections → Tags. Do not show a project group.
- The three views have no leading icons or hover descriptions. Collection and project headings have no horizontal rules, and project nodes have no leading square icons.
- Keep the existing group and node indentation, child spacing, collapse buttons, folder icons, font sizes, and line heights. `literature.css` and `design/theme.css` were not changed; no 15px indentation token was added.
- Restore the tag area to its original complete layout, including the search button and its internal create entry. Do not add a plus icon to the heading.
- `sidebarState.ts` stores the collapsed state of groups and nodes separately.
- Use consistent terminology such as “未整理” and “分类” across the related UI. In the add-to-library menu, collections appear before projects. Sidebar collection creation uses the existing single-name dialog, with the destination determined by the clicked entry; the add-to-library menu keeps its parent-selection dialog. See `join-library.md`.

<a id="未整理口径"></a>
## Definition of Unorganized

In the all-library view, Unorganized excludes items linked to any collection or any project. The list API passes `without_project`, and the repository and counts use the same condition. Preserve the existing semantics when other callers use `without_collection` alone.

Within a project, follow the definition shown in the project screenshot provided by the user: “not placed in a collection in this project.” The literature item remains part of the project. Deleting a collection removes only the collection link; the toast explains that the item remains in the library.

<a id="验证与边界"></a>
## Verification and Boundaries

- After restoring the original layout, the build and Electron sidebar acceptance passed (24.1 seconds). Reviewed screenshots of both the all-library and project windows; coverage included the no-project state, collapsed groups, and the Unorganized filter and count. Screenshots are in `tmp/test_snapshot/desktop/literature-sidebar/` as ignored local artifacts.
- Backend `contract_literature_store.py`: all 43 tests and 7 subtests passed, covering global collections, project-only collections, collections within a project, and combinations of collection and project links.
- `literature.css` and `design/theme.css` match the pre-change HEAD; tag rendering also matches the pre-change version in a section-by-section comparison.
- This project has no `scripts/check-demo.mjs`. See `join-library.md` for existing type-check failures and other verification limits. No assertions were weakened and no baseline was adjusted.

2026-09-19 Terminology unification: the group name in the all-library and project sidebars, detail heading, list column, add/manage menus, and onboarding heading was standardized to “我的分类”. Only this group name changed; the generic actions “新建分类 / 新建子分类” and Zotero collection terminology retain their original meanings.
