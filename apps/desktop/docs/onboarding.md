<a id="新手引导-react-工程适配说明"></a>

# React Project Adaptation for Onboarding

Baseline: `guide_subu`, `6ecf3e928`. Implemented only the Getting Started, Projects, Global Literature Library, and Literature Reading groups, plus the onboarding center. The prototype's login, API Key, sample library, editor, and AI reply flows were not migrated.

<a id="架构适配与入口"></a>

## Architecture Adaptation and Entry Points

This branch is an Electron + React + TypeScript project. It has no `docs/CODE_STRUCTURE.md`, `onboard.js`, `shell.js`, `project.js`, `import-menu.js`, `app.js`, or `scripts/check-demo.mjs`. The feature was integrated according to the confirmed React adaptation after reviewing the existing architecture/ownership documentation and source.

- New logic is concentrated in `src/renderer/src/features/onboarding/`. No runtime dependency was added. The implementation reuses the existing React, Dialog, Button, Badge, Toast, and design tokens; it adds no global plain-script engine or parallel CSS system.
- All custom class names use the `ob-` prefix. Targeting uses only `data-ob`; it does not depend on existing classes, DOM hierarchy, or copy.
- The previously commented-out onboarding button in the account menu is enabled. The avatar menu in the activity rail, the legacy Chrome account menu, and the entry in Settings > About now all open the onboarding center. The former behavior of opening the project picker from these entries was replaced.
- This branch has no `onboard.js` or ⌘K “Preview first login” command, so no legacy file was deleted and no such command was added. The existing signed-out landing page and login flow remain; the Getting Started dialog appears only after entering the product home page.
- The four groups' state uses the existing `RendererPreferences`/`PreferenceWriter`, under `onboarding.seen`, rather than a separate localStorage. `recentProjectId` records only the most recently entered project; reset clears only `seen`.
- The supplied Chinese onboarding copy is preserved in the new `localization/locales/zh/onboarding.json`. `OB_COPY` is the centralized copy-key catalog, with comments for pending items. English resources were added without rewriting existing English copy.

<a id="复用的现有能力"></a>

## Reused Existing Capabilities

| Capability | Call site |
| --- | --- |
| Switch home/resource library/literature library views and expand module panels | `act.openWorkbenchView` |
| Enter an existing project | `act.selectProject` |
| Create a project | Existing `projectForm: { mode: 'create' }` and `ProjectFormHost` |
| Open the import menu | Click the existing `DropdownMenuTrigger` with its stable anchor, reusing the original menu state and import handling |
| Expand the discovery or collections area | Click the original collapse control and reuse its `onOpenChange` |
| Close/open AI | `act.toggleAiPanel` / `act.openPanel('user_request')`; the latter already handles current-literature context |
| Open a PDF in the library | `act.openLiteratureAttachment` |
| Open the local built-in PDF | `documentWorkspaces.forProject(null).open` + the separate read-only builtin loader |
| Select text in a real PDF | Existing PDF.js text layer, DOM Range, reader's existing `keyup` selection-capture callback, and real `SelectionActionHost` |
| Keep the selection while showing an onboarding card | Existing reader `documentSelectionInteractionProps`; selection cleanup rules were not changed |

<a id="引导行为"></a>

## Onboarding Behavior

The engine maintains a queue. Before starting, it rechecks the current view, project, or PDF identity; if the prerequisites do not match, it abandons the request without marking the group as seen. Manually opening the center clears other queued requests and replays only the selected group. Steps support before/setup/after hooks. Cancel aborts asynchronous steps and clears any selection created by the current run. Skip and Escape both mark the group as seen.

The SVG mask can cut out multiple areas at once and draw a green outline around an additional activity-rail anchor. Cards are positioned using the real target and their own dimensions, up to 600px wide, and respond to resize and scroll changes. Step count is on the left; Skip and the primary button are on the right. The implementation reuses modal focus management.

After the first project is created, project onboarding is triggered explicitly. Entering a project view that has not been seen also triggers it, including for existing projects and after a reset. Home and the global literature library trigger on view changes; PDF onboarding triggers when the real reader mounts or its document identity changes. There is no first-open onboarding for resource files or AI.

<a id="界面差异与内置示例"></a>

## UI Differences and Built-in Example

- This project has a product home page, a global literature library, projects, and collections; all are reused. The collections step highlights both actual collection areas at once.
- The plus icon in the literature-library sidebar is the existing import entry point; no second import button was added.
- Example file: `src/renderer/src/features/onboarding/assets/sample.pdf`. It is bundled with the frontend, contains selectable local text, and uses the separate `builtin:onboarding-v1` identity. It does not call the import API or write to the user's library.
- **Important difference: in the original reader, chart explanations, the right-side reading assistant, and literature AI context are available only for literature already in the library. The unregistered example therefore demonstrates only real text selection and copying, displays 1/1, and clearly states this limitation. It does not fabricate a literature identity or add example-only features. PDFs already in the library retain the complete four-step flow.**
- If the first page of a scanned PDF has no selectable text, or an actual control is missing, skip the step that cannot be shown. If the group has no visible target, show a notice without consuming the first-run state.
- Keep the new-literature discovery copy in the supplied〔待定〕(pending) version. This task did not implement or change the project's existing search capability.

<a id="共享文件逐处变更"></a>

## Shared File Changes by Location

The paths below are relative to `apps/desktop/`. The four shared JS files named in the original request do not exist; the table lists the shared entry points and infrastructure actually involved in this project.

| File | Changes |
| --- | --- |
| `src/renderer/src/App.tsx` | (1) Import the Onboarding event interface and host; (2) mount the host once in AppRoot and pass landing-page/login-blocked state; (3) after successful project creation and navigation, add `Onboarding.trigger('project', created.id)`. |
| `src/renderer/src/shell/ActivityRail.tsx` | (1) Import the event interface; (2) add `data-ob` to the existing activity-rail control; (3) change the existing onGuide action to call `Onboarding.openCenter()` after closing the menu. |
| `src/renderer/src/shell/TopBar.tsx` | (1) Add `data-ob="project-switcher"` to the project switcher; (2) add `data-ob="ai-entry"` to the AI entry point. |
| `src/renderer/src/components/business/AccountMenu.tsx` | Restore the previously commented-out onboarding button while preserving its existing copy, icon, and onGuide callback. |
| `src/renderer/src/components/business/Chrome.tsx` | (1) Import the event interface; (2) open the onboarding center from the existing onGuide action after closing the menu. |
| `src/renderer/src/components/business/AccountPanel.tsx` | (1) Import the event interface; (2) make `AboutPage.startGuide` close Settings and open the center instead of opening the project picker; update the entry-point comment. |
| `src/preferences.ts` | (1) Import the separate preference model; (2) add an optional onboarding field; (3) include it in preference comparisons; (4) clean this field only when present, without changing the shape of legacy default data. |
| `src/renderer/src/store.tsx` | (1) Import the model; (2) add onboarding to AppState; (3) restore it from existing preferences in INITIAL; (4) compare it during external preference sync; (5) restore it during synchronization; (6) include the field in the existing `PreferenceWriter.submit`; (7) add the field to the existing write effect's dependencies. |
| `src/renderer/src/features/workbench/api.ts` | (1) Import the builtin loader/type; (2) add builtin to the `DocumentSource` union; (3) add a builtin identity branch to `documentIdFor`; (4) dispatch builtin sources at the start of `loadDocument`. Existing source branches retain their behavior. |
| `src/renderer/src/design/layout.css` | Add onboarding-specific max-width/max-height tokens to the existing root token block without changing existing tokens or selectors. |
| `tsconfig.web.json` | Add shared `src/onboarding.ts` to include. |
| `src/localization/resources.ts`, `types.d.ts` | Register the new onboarding namespace through the existing i18n generator. |

Business-module mounts add only targeting attributes:

| File | Target |
| --- | --- |
| `features/resources/ResourcePanel.tsx` | Resource-library sidebar, discovery area, and discovery-area collapse button. |
| `features/literature/LiteraturePanel.tsx` | Literature sidebar, discovery area and collapse button, My Literature collapse button, original import plus icon, project area, and collections area. |
| `features/workbench/PdfDocument.tsx` | Reader and document identity, original viewport, and original right-side toolbar. |
| `features/workbench/Selection.tsx` | Real FloatingToolbar. |
| `features/workbench/pdf/Reading.tsx` | Original chart-explanation button. |
| `features/workbench/pdf/Page.tsx` | Add `data-ob` to the actual first-page `TextLayerBuilder.div` without changing text rendering. |

The new `features/workbench/builtin.ts` accepts only explicitly registered built-in documents, not arbitrary file paths. All other new code is in the onboarding module, the separate contracts/onboarding event interface, the shared onboarding preference model, and the new localization resources.

The repository generator refreshed `docs/_generated/{components,debt,tokens}.md`, including entries already present on the original branch but not yet synchronized in generated docs. No check baseline or existing assertion was changed.

<a id="验证记录2026-09-18"></a>

## Verification Record (2026-09-18)

Used the repository-declared Node 24.16.0, npm 11.13.0, and uv 0.12.11. The real Electron app and local Serve were used; test HOME, profile, and workspace were all under `/tmp/shushen-ob-*`, without using the user's production literature library. During full-reader testing, a test PDF from this repository was manually imported through the original import menu and written only to the isolated acceptance library. This was separate from the product's built-in sample path for an empty library.

The following were exercised: first-run home selection dialog; opening the original import menu from the Literature start point; the account-menu center; all four groups; opening the original create flow with no projects and playing onboarding after creation; replaying Home and restoring the most recent project; five project steps, automatic sidebar switching, and opening AI at the end; all five global-library steps; empty-library sample with the library count remaining 0; fallback to the first PDF in the library and its complete four-step flow; real text selection and toolbar, clearing the selection in step four, and opening AI at the end; replaying a previously seen group; persistence across restart; skipping with Escape; and reset without immediate playback, followed by the expected automatic trigger on re-entering the page.

- Build `npm run build`: passed.
- The 12 onboarding-specific assertions and 122 existing preference/persistence/workspace regression tests passed.
- Existing PDF toolbar assertions passed. Assertions were not changed; only the original attribute order was preserved for compatibility with a source assertion.
- `git diff --check`: passed.
- `npm test`: of 27 pretest checks, 25 passed and 2 failed (the TeX Live Windows-path assertion and the uv wrong-version fixture); both failures were reproduced on a snapshot of the original branch.
- The complete lower-level test suite was run separately: 1,337 tests, 1,276 passed, 60 failed, and 1 skipped. Baseline: 1,325 tests, 1,263 passed, 61 failed, and 1 skipped. The same 59 failures occurred in both runs. The additional current review-bar failure came from a legacy test treating a file URL containing Chinese characters as a path; it was reproduced on an original-branch snapshot under a Chinese directory. The baseline's other two failures involved missing Git metadata/LFS pointers in the archive. No legacy tests or assertions were changed.
- `typecheck`: 32 errors, matching the baseline one by one; no new type errors.
- `i18n:check -- --base HEAD`: failed because unchanged `input.ts` references the missing `components:request.*` message keys. No unknown-key diagnostics were reported for the new onboarding copy.
- `docs:check`: existing ownership/style/architecture debt and baseline inconsistencies remain blocking; the new onboarding/builtin files produced no new diagnostics. Generated docs were refreshed.
- **Therefore, the full check suite cannot be reported as passing.** Detailed logs are retained in `tmp/test_snapshot/desktop/onboarding/checks/` and are not committed to Git.
- `check-demo.mjs` does not exist; no empty check script was created to claim a pass.
- No real AI generation or model-response validation was performed; this task checked only invocation of the existing AI panel and context entry point.

Screenshots are in the ignored repository directory `tmp/test_snapshot/desktop/onboarding/`. All are from the real Electron window and were visually inspected: `center-reset.png` (four rows and reset), `pdf-figure.png` (real chart-explanation button), `pdf-selection.png` (text selection and real toolbar), and `sample-selection.png` (unregistered example and its capability limit). `start.png` (final two-card Getting Started layout) and `project-resources.png` (restored recent project, resource library, and dual activity-rail targets) are in the same directory.

Style review: Getting Started option cards use the existing outline button variant (white background, light-gray border, dark title); links remain green. “先随便看看” and “跳过” use the tertiary text color. Build passed; the screenshot from the real Electron window is `start-neutral.png`.
