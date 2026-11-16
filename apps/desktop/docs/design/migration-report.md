<a id="页面骨架迁移报告"></a>
# Page Shell Migration Report

## Scope / Non-goals

This report covers page shells, narrow-window usability, and screenshot evidence for migrated settings pages and replacement workspace surfaces. It does not replace design-by-design MasterGo reconstruction or mark unmigrated pages or untested platforms as complete.

## Source of truth

Page implementation is defined by `components/business/AccountPanel.tsx`, `components/business/WorkspaceFiles.tsx`, `components/ui/Page.tsx`, and `design/layout.css` / `design/zindex.css`; design evidence, state differences, and gaps are recorded in the [public design contract](foundations.md) and the MasterGo ledger (non-public execution/provenance record omitted).

<a id="范围与证据"></a>
## Scope and Evidence

This report records visible differences from migrating settings pages from the historical `SettingsPageHeader` layout to the shared `Page` composition.
Screenshots are stored in the development workspace at `tmp/test_snapshot/desktop/`; project convention excludes this directory from release packages, and the filenames in this report support local review.

## Current / Required / Gap / Advisory

- **current**: Notifications, AI prompts, About, File Versions, Model Configuration, Developer, and Skills pages use the Page composition family. Workspace Files reuses shared state and action components in a real, retryable failure state. The About page completed macOS wide/narrow-window rendering, keyboard focus order across link rows, and Escape return to the account entry.
- **required**: Migrated pages must reuse `components/ui` and `--vds-*` tokens and verify the host scroll boundary.
- **gap**: The account page is absent from current settings navigation; it can only be migrated and accepted after the product exposes its entry again. The Workspace Files backend failed to read in the current environment, so directory listing, file operations, context menu, preview, narrow-window, and keyboard regressions remain incomplete. Windows evidence and the latest MasterGo nodes are also missing. Write flows, complex policies, detail dialogs, and narrow-window regressions for File Versions, Model Configuration, Developer, and Skills have not been exercised in the real product.
- **advisory**: Screenshots compare rendered results; when no corresponding MasterGo node exists, mark visual decisions as inferred.

<a id="前后对比"></a>
## Before-and-After Comparison

| Page | Before Migration | After Migration | Screenshot Evidence |
| --- | --- | --- | --- |
| Notifications | Historical settings-page title bar and fixed padding | `Page` + `PageHeader`; host retains scrolling | `settings-notifications.png` → `notifications-page-light.png` / `notifications-page-dark.png` |
| AI prompts | Historical title bar and page-private group spacing | `Page` + `PageHeader` + `PageSection`, with natural wrapping in narrow windows | `prompts-page-narrow.png`, `prompts-saved.png` |
| About | Historical `SettingsPageHeader`; at 480px, long email, website text, and title area were cramped | `Page` + `PageHeader` + `PageBody`; embedded settings shell uses labeled icon navigation at the existing narrow-window threshold, and link values wrap vertically | `about-page-before.png` (before migration, 480px) → `about-page-after.png` (after migration, wide window) / `about-page-narrow-responsive.png` (after migration, 480px) |
| File Versions | Historical `SettingsPageHeader`, page-private 24/16/8px spacing, and fixed 140px control width | `Page` + `PageHeader` + `PageBody`, shared `Card` surface, and layout tokens for section spacing, control spacing, and compact control width; settings Dialog/navigation shell retains its existing scroll and narrow-window behavior | `file-version-before.png` (before migration) → `file-version-after.png` (after migration); real macOS Desktop `settings-files` scenario |
| Model Configuration | Historical `SettingsPageHeader`; the business page sized Tabs and two-column content itself | `Page` + `PageHeader` + `PageBody` + `Tabs`, preserving the service/configuration tabs and internal pane scroll owner | `model-configuration-before.png` (before migration) → `model-configuration-after.png` (after migration); real macOS Desktop `settings-models` scenario |
| Developer | Historical `SettingsPageHeader`, page-private section headings, and card margins | `Page` + `PageHeader` + `PageBody` + `PageSection`; shared `Card` surface preserves the API key row and generation action | `developer-before.png` (before migration) → `developer-after.png` (after migration); real macOS Desktop `settings-developer` scenario |
| Skills | Historical `SettingsPageHeader` and page margins; the skill-card list already had its own scrolling | `Page` + `PageHeader` + regular `PageBody`, preserving `Skills` as the list scroll owner and avoiding nested scrolling | Real macOS Desktop `settings-skills.png` scenario |
| Workspace Files | Full-screen business surface used page-private close/action controls and bare `z-[35]`; read failure showed only isolated text | Retain toolbar and breadcrumbs; use `Spinner` for loading, `EmptyState` for empty/error, and provide retry on failure; use `IconButton` / `Button` for close/actions and semantic tokens for layering | `workspace-files-before.png` (before migration, read failure) → `workspace-files-after.png` (after migration, read failure); real macOS Desktop `workspace-files` scenario |

Before-migration screenshots are for layout comparison only; their styles are not the target specification. After-migration screenshots prove only the actual rendered and interaction states, not precise MasterGo reconstruction.

<a id="本轮层级治理观察不纳入前后截图对比"></a>
### Layering Governance Observations This Round (Not Included in Before/After Screenshot Comparison)

| Surface | Changes This Round | Real State Inspected | Migration Report Status |
| --- | --- | --- | --- |
| Project switcher menu | `ProjectMenu` portal content changed from bare `z-[80]` to `--vds-z-inline-flyout` | With the real Desktop menu open, project overview, literature overview, project entries, and the create entry are visible; Escape closes it and returns focus to the trigger | No local before/after screenshots, so it cannot be listed as a completed page above; long project names, scrolling, narrow windows, and Windows remain gaps |
| Pre-conversation runtime check | ConversationSurface drag hit area, sticky header, and runtime gate now use semantic layering tokens | The current real conversation did not trigger a readiness block | No before/after screenshots of the blocked state, so this is not visual acceptance; blocked state, settings entry, narrow windows, keyboard, and Windows remain gaps |
| Project form confirmation | Project removal now uses `AlertDialog`; nested overlay/content use dialog-family tokens | In the real Desktop, opening the create form focuses the input; cancel returns focus to the create button | No before/after screenshots for edit/removal confirmation, so it cannot be listed as a completed page above; the full confirmation flow remains a gap |
| Session tasks and attachment layers | TaskMonitor, scroll-to-bottom, HIL dock, back confirmation, and attachment actions no longer use bare layers; they use `zindex.css` semantic tokens | Source order matches the existing session DOM; back confirmation and narrow-window scenarios were not triggered | No corresponding MasterGo nodes or local before/after screenshots; completion/failure, confirmation focus restoration, narrow windows, and Windows remain gaps |
| PDF reading annotation layers | Text, end, annotation-mark, and annotation Popover layers no longer use local bare values; they use `--vds-z-base` / `--vds-z-content` / `--vds-z-local-control` / `--vds-z-inline-flyout`, respectively | Only the PDF.js source layer order and existing Popover composition were checked; no real Desktop screenshot with an annotation open | MasterGo provides only a PDF file icon, not evidence of reader interaction; annotation editing, long text, narrow windows, keyboard, and Windows remain gaps |
| Account-menu feedback | Feedback Dialog overlay/content moved from business-specific `96/97` to shared `--vds-z-dialog-overlay` / `--vds-z-dialog` | In real macOS Desktop, the feedback form opened, the description field received focus automatically, and diagnostic options and close action were visible in an empty session | No matching MasterGo form node or local before/after screenshots; upload, submission, errors, narrow windows, keyboard, and Windows remain gaps |
| Session background-task menu | StatusStrip background-task menu changed from bare `z-[30]` to `--vds-z-inline-flyout` | Only source anchor relationships and real store data sources were checked; the current session did not produce an archivable screenshot of the background-task menu | No corresponding MasterGo node; long task names, keyboard, narrow windows, and completion/failure states remain gaps |

This section records only completed layering governance and real observations; it does not replace the entry requirement to save before/after screenshots together. Add a page to the formal comparison table only after obtaining baseline and final screenshots of the same scenario, inspecting the migrated rendering, and completing interaction regression.

<a id="截图校验指纹"></a>
### Screenshot Verification Fingerprints

The following SHA-256 values help confirm that local comparison images have not been silently replaced:

| File | SHA-256 |
| --- | --- |
| `settings-notifications.png` | `f8b3b6d444e9092ab0b3676fb64f3d009722f80f8f4d4d8c6b3cf9cf5d4be56a` |
| `notifications-page-light.png` | `ff1b600f6a805d11137ec0b796b0a89eb3938891644ba48e765b2cafa8d4f4c5` |
| `notifications-page-dark.png` | `90bef0d58c22cd206279eb7f26f804e175ebc98f284856e79e6a78d5a6d96da8` |
| `prompts-page-narrow.png` | `b295365a11abbdf658c75d03575a32e82a8b505a4ebc833bcfa959d3faee4034` |
| `prompts-saved.png` | `b0610127aa2b6c6be4777294fd63a044def63e0b31cb508aec207e054805266c` |
| `about-page-before.png` | `bf1e2637a925b828b29a756f90c53cce5356ed520b76820e0c2917fe27befcbd` |
| `about-page-after.png` | `7efaa5216975e4c8e048e9b65bf50049c63f348720a0a260c3acd8798551a3bb` |
| `about-page-narrow-responsive.png` | `657c765e445ddd0a0c4d7be8ef26cf6de1c6ad2906852eca47dbb0f2d974e70e` |
| `file-version-before.png` | `5fc5bce7fa6fe96e21cbac1eb6bdd075cdc1bd4301c12910845808a73b2c9539` |
| `file-version-after.png` | `0a86adc6acd01c4d15013de66745d0f4f35b2a6a26fe4d484930dd185a19676a` |
| `model-configuration-before.png` | `43aa39e512519568275fca52e2312427d41f7315e821f70a1a5f6a3776c55740` |
| `model-configuration-after.png` | `e175a101ef21350150cd0f90381aae228d3b4c2bea9512ec9b47dd9b11a993c3` |
| `developer-before.png` | `0372509976549aea448e5e39e401ddcc12010aff3318dbc830b34e21ba55b664` |
| `developer-after.png` | `72166a21328fbdd005616f58bff80e44fe8f653d7234e7a8d8b6169b21aaab44` |
| `settings-skills.png` | `632b16bddf97346ba75476d613bbb7619ffc8f36c03c77327abdacf08228d987` |
| `workspace-files-before.png` | `51fdf579bf3308dad10e566bb6fa7b3472659b6619995718d666d450a5e536c6` |
| `workspace-files-after.png` | `bd5e65afb9fd0e0af26a23f33015a6deca01dd62a3c902ffdab7ae502f371608` |

`file-version-before.png` and `file-version-after.png`, `model-configuration-before.png` and `model-configuration-after.png`, and `developer-before.png` and `developer-after.png` are screenshots from real macOS Desktop/dev backend on the current branch (2560×1680). The File Versions before-state screenshot records the loading state when the scenario started; CUA then opened the same File Versions page and read real Serve data. Model Configuration before/after states cover the settings entry, service tab, connection list, search field, empty state, and add-connection entry; Developer before/after states cover an existing managed key, generation input, and action entry. Migration changed only the page shell and visual tokens; no operation that writes user configuration was performed, including saving, adding a connection, selecting a model, generating a key, or rotating one.

Screenshot dimensions: `settings-notifications` is 1280×840; light Notifications is 1280×720; dark Notifications and wide About are both 1800×1125; narrow Prompts and saved state, and About before-migration and after-migration narrow-window states are all 480×900; File Versions, Model Configuration, and Developer before/after states, `settings-skills`, and Workspace Files before/after states are all 2560×1680.
Record capture commands and runtime environment together with each new page migration. The About before-migration screenshot comes from the real macOS Desktop flow at baseline commit `c8c42309098099645a246742c1d4a004ffe99b2f`; all other current screenshots come from the current branch's real macOS Desktop/dev:web flow.

<a id="统一规则"></a>
## Shared Rules

- Page margins and section spacing come from `--vds-layout-*` tokens; pages must not add fixed visual values.
- `PageBody` inherits host scrolling by default; `scroll="content"` is allowed only in flex containers with constrained height.
- When an existing business component owns constrained list scrolling, keep `PageBody` as a regular container; do not create a second content scroll area.
- Replacement full-screen workspaces retain the business toolbar, breadcrumbs, and list scroll owner; use `Spinner` / `EmptyState` for states, `Button` / `IconButton` for actions, and `zindex.css` tokens for layering.
- Use `PageHeader` for titles, descriptions, and actions; long text may wrap naturally, and action groups may wrap.
- Business components continue to reuse the `components/ui` barrel; Page does not read stores, APIs, or persisted state.
- At the existing `760px` narrow-window threshold, the settings dialog collapses its sidebar to an icon rail while retaining each item's `aria-label` and keyboard focus. Information-link rows become vertically wrapping content so long URLs or email addresses do not crowd the title. This is an inference for product usability, not precise MasterGo dimension evidence.

## Ownership / Dependency

The dependency direction remains `components/business → components/ui → design`: settings pages own business state and real operations, `Page` provides only layout composition, and design provides only semantic tokens. This report adds no runtime code or standalone styles.

<a id="正反例"></a>
## Examples and anti-patterns

Good example: In a narrow settings window, keep navigation entries focusable and named, and let long email addresses wrap within their link rows. Bad example: Make a 480px screenshot look usable by clipping text, hiding navigation, or using page-private z-index values.

## Enforced by

`pnpm ops ci check docs desktop` checks report structure and links; `scripts/ci/visual.mjs` rejects new fixed visual values; migrated pages must also have real Desktop/dev:web screenshots and interaction records.

## Update triggers

Update this report, design-map, ledger, and screenshot fingerprints when the Page API, settings-shell responsive behavior, migrated pages, screenshots, or MasterGo evidence change.

## Stop condition

Move a page from the migration queue into this report only after saving before/after screenshots together, inspecting the real post-migration screenshot, and recording interaction results and unresolved gaps.

<a id="未解决项"></a>
## Unresolved Items

- The account page still uses the historical title component but is absent from `NAV_ITEMS`; `visiblePage` falls back, so it cannot be accepted as a current user path. Workspace Files currently fails to read; that failure state cannot substitute for acceptance of listing, file operations, context menu, preview, narrow windows, and keyboard use. Write flows, complex policies, detail dialogs, narrow-window behavior, and keyboard regressions for File Versions, Model Configuration, Developer, and Skills remain unaccepted.
- Latest MasterGo nodes, Windows screenshots, and complex overlay compositions remain gaps.
