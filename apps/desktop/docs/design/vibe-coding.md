<a id="vibe-coding-页面视觉契约"></a>

# Vibe Coding Page Visual Contract

## Scope / Non-goals

Applies to all Desktop pages, panels, forms, and lists, including new features without business-specific designs.
Default layouts are product design decisions and do not imply that MasterGo contains a corresponding artboard. Business data, routing, and submission logic belong to the business owner.

## Source of truth

[DESIGN.md](../../DESIGN.md) is the entry point; this page owns page-composition rules.
[Foundations](foundations.md) owns visual rules, [interaction](interaction.md) owns behavior rules, and [component assets](assets.md) plus the UI registry own the actual APIs. Values are defined only in [design](../../src/renderer/src/design/index.css) and generated into the [token inventory](../_generated/tokens.md); this document does not duplicate the full value table.
The [public design contract](foundations.md) records direct evidence by layer and state.
Detailed visual values remain with the design owner and are not copied into AGENTS/CLAUDE instructions or business-page templates.

## Current / Required / Gap / Advisory

- **current**: The `Page`, `PageHeader`, `PageBody`, and `PageSection` composition family provides shared layouts; Settings notifications, prompts, and About pages use it.
- **required**: With or without a business-specific design, select a page composition, scroll owner, semantic `--vds-*` tokens, and state policy. Use the composition table below by default. Record design evidence separately from inferred defaults; do not present inference as evidence from an individual design.
- **gap**: On 2026-09-15, the MasterGo CLI lacked `MASTERGO_TOKEN`, and MCP node reads returned `Network Error`. The repository's per-design evidence dates from 2026-09-09; new page types, reading width, and responsive behavior are inferred and must not be described as reproductions of the latest design.
- **advisory**: Prefer the same composition for similar pages. When a real new need arises, extend its owning component instead of adding template branches named after business areas.

<a id="业务无关的页面类型"></a>

## Business-Agnostic Page Types

These are information-architecture types, **not names of eight importable React components**.

| Type / when to use | Composition | Scrolling and width | Narrow-window strategy |
| --- | --- | --- | --- |
| Single column / content and actions center on one object | Page + PageHeader + PageBody | Host scrolls by default; use width=reading for long-form content | Let title/description and action groups wrap |
| List / bulk search and filtering | Single column + filters + Table/list + Pagination | Use scroll=content only when the list area needs persistent scrolling | Filters wrap; table scrolls horizontally within its own area without clipping key columns |
| Form / submit one task | Page + PageHeader + PageBody + PageSection | width=reading; show errors beside their fields and put actions at the end | Stack labels and controls; do not fix the form height |
| Master-detail / select a record and inspect it | Two Page compositions + existing Resizable or Sheet | Panes scroll independently and preserve the current selection | Move details into a Sheet or separate view and retain a clear way back |
| Side-by-side workspace / two areas edited at once | Workbench slots + Resizable + PageBody | Shell constrains height and pane minimum sizes | Let users explicitly switch panes; do not silently hide edited content |
| Overview / groups of metrics or cards | Page + PageHeader + PageBody + Card | Full-width content wraps naturally to available width | Cards become a single column; content determines height |
| Settings / edit preferences by category | Host navigation + Page padding=none + PageSection | Host owns navigation and scrolling; do not apply padding twice | Navigation must not squeeze the form until unusable; keep the switcher accessible |
| Full-screen workspace / editor or canvas | Existing shell + toolbar + PageBody | Scroll internally and keep the toolbar reachable | Reflow tools first; collapse optional panes through visible controls |

For an unfamiliar business area, choose the closest composition by asking whether it is a list, must preserve selection context, or supports side-by-side editing. Do not invent spacing, headings, or dialogs just because there is no artboard with a matching business name. Business determines state complexity; UI determines layout rules.

<a id="默认视觉决策"></a>

## Default Visual Decisions

- Use `--vds-layout-page-padding` around pages, `--vds-layout-section-gap` between sections, and `--vds-layout-control-gap` between related controls. Page has defaults; when the host already supplies padding, explicitly set `padding="none"`.
- Use `width="reading"` for reading-oriented forms. Its maximum, defined by `--vds-layout-reading-width`, is inferred; do not force that limit on tables or editors. Avoid copying artboard dimensions as fixed page sizes.
- Optional metadata in compact status rows (such as elapsed time or estimates) uses `--vds-layout-inline-metadata-max-width` for a width limit and `EllipsisText` for the full text, preserving space for the title, current status, and collapse control. This value is an inferred responsive rule where MasterGo has no corresponding state; do not replace it in business pages with fixed pixels or viewport expressions. Real sessions and narrow windows still need separate acceptance.
- Use PageHeader for titles and PageSection for sections. Pair body and supporting text according to font/lh/text semantics. Let titles and descriptions wrap naturally; do not truncate supporting copy by default. Use a code font for code/paths and do not shrink the font just because the text is long.
- **required**: In Settings subpages, use the `SettingsPage` title slot for breadcrumbs. Breadcrumbs inherit the top-level Settings title's font size and line height (`--vds-font-subhead` / `--vds-lh-subhead`).
  In settings, render breadcrumbs in the `SettingsPage` title slot so they inherit the top-level title’s font size and line height.
- Select bg/surface/text/border semantics separately for page backgrounds, card surfaces, primary/secondary text, and borders. Prefer hierarchy through sections and whitespace; use shadows only for genuinely raised surfaces. Have at most one primary action per action group.
- Keep using Card's padding/variant and existing radius tokens; PageSection does not duplicate card styling. Prefer the control's size/variant props; use `size=standard` for Button/Input/Select when standard form-control height is needed.
- New fixed visual values must be added to the design owner's semantic definitions, checked for duplicates, and verified in explicit light/dark and system themes. `0` (except for z-index), `auto`, `full`, and fractional ratios are structural expressions. Document the actual source of values such as coordinates, drag positions, and progress.

<a id="滚动响应式和状态"></a>

## Scrolling, Responsiveness, and State

Page has no independent scrolling by default. `scroll="content"` on PageBody is only for a flex parent with a constrained height.
Assign only one scroll owner to each area on each axis; headings and actions must not become permanently unreachable because of `overflow:hidden`.
Content should shrink by default. Test long paths and both Chinese and English descriptions. Do not use blank filler to force a fixed height.

Visible Settings tabs (except Skills) compose `Page`, `PageHeader`, and `PageBody` through the business `SettingsPage`: the host constrains height without scrolling, the title and description do not scroll with the body, and ordinary pages scroll only their body.
The model-services page uses `scroll="none"`, leaving scrolling to the existing model list and details areas to avoid nested scrolling.
The Skills page keeps its existing layout and scroll ownership. Hidden account, preference, and permission pages are not in current navigation.

For responsive behavior, first use flex-wrap, min-width: 0, content sizing, and existing Resizable components. When conditional switching is needed, the owning component maintains a named breakpoint. Narrow-window acceptance must include the actual minimum supported window, text zoom, and long content; do not treat an arbitrary mobile breakpoint as a Desktop product requirement.

<a id="desktop-窗口布局边界"></a>

### Desktop Window Layout Boundaries

The sole source of main workbench window dimensions is `src/window.ts`: `WORKSPACE_WINDOW_SIZE` is currently 1280 × 840, and `WORKSPACE_WINDOW_MINIMUM` is currently 1040 × 660. These are Electron logical pixels (DIP), not physical screenshot pixels. On macOS and Windows, the main window applies the same minimum through `BrowserWindow`'s `minWidth` / `minHeight`; the login window has its own size contract.

Routine layout acceptance for Desktop pages and Settings dialogs covers the default window and actual minimum supported window. It does not require mobile-style 480px or 600px viewports below the main-window minimum. Tests should reference window constants and, where possible, gather evidence by resizing the real window. `page.setViewportSize()` can bypass native window constraints and must not be used to expand the product's supported range. High-DPI screenshots, text zoom, and long content still need verification within the supported window range.

Internal panes and dialogs may have less available width than the whole window; handle wrapping and scrolling within their own containers.
The Settings shell's existing `760px` navigation-collapse rule is a container-layout policy, not the main-window minimum width.
Historical 480px screenshots are additional stress tests, not Desktop supported sizes or required acceptance cases.

The business owner explicitly composes Spinner/EmptyState/Alert/Toast: loading preserves a stable frame, empty provides a next step, error provides a cause and available retry, and pending prevents duplicate submission. Shared Page does not fabricate loading results or errors.
Forms preserve labels, descriptions, and error associations. Keep Save and Cancel in stable positions and define what happens to unsaved content when navigating away.

Full-screen replacement workspaces (for example, opening a file browser over a conversation) retain their toolbar and breadcrumbs in the business surface; do not duplicate the title or change the host landmark merely to reuse `PageHeader`. They must still reuse existing UI capabilities such as `Spinner`, `EmptyState`, `Button`, and `IconButton`. Use semantic `zindex.css` tokens for layering these surfaces; never use bare numbers. Provide a retry button when the failure can actually be retried. A screenshot of an unreadable-data failure proves only that state; it does not replace acceptance of a successful list, context menu, file preview, or narrow window.

<a id="浮层与z-index"></a>

<a id="浮层与-z-index"></a>
## Overlays and z-index

Use Select for value selection and DropdownMenu for actions; Tooltip for brief hints and Popover for interactive explanations; Dialog for modal flows, Sheet for side details, and AlertDialog for dangerous actions. Follow the [interaction rules](interaction.md) to verify Escape, initial focus, Tab navigation, and focus restoration after dismissal. Pages must not duplicate overlay mechanisms.

**required**: Choose layers by semantic role in `design/zindex.css`; do not guess the overlay order with bare numbers or by adding one to a token. Local decorative layers and global portals use different coordinate systems; before adding an isolation context, inspect ancestor transform/isolation/overflow.
Within a relatively positioned clickable card, local hit targets such as a More action that overlays the card-wide trigger use `--vds-z-local-control`. Menu content is still managed by the `DropdownMenu` portal; do not raise the trigger into a global overlay layer.
For an irreversible confirmation opened from a form Dialog, the confirmation content must use `AlertDialog`. Its overlay and content consume `--vds-z-dialog-nested-overlay` and `--vds-z-dialog-nested`, respectively, and cover only the parent Dialog; do not use Dropdown, Popover, or the global modal band. Ordinary forms and multistep flows continue to use `Dialog`.
Navigation-switching `PopoverContent` for projects and views is a portal overlay but remains a non-modal navigation flyout. Use `--vds-z-inline-flyout` so it covers workbench chrome while staying below Dialog, global search, and Settings surfaces.
Use `--vds-z-sticky-header` for sticky headers in a workspace and `--vds-z-surface-gate` for local runtime-state gates. A gate blocks only its own surface; it must not cover global search, Settings, or Dialog.
Use `--vds-z-surface-panel` for persistent sibling panels in a workspace, `--vds-z-scroll-control` for in-session scroll controls, and `--vds-z-session-confirm` for session rewind confirmation. These tokens express relative ordering within the current surface; they do not replace cross-portal Dialog, Popover, or global modal families.
**gap**: Some existing families (such as Dialog, Sheet, and Toast) still have local numeric values or separate layer aliases. The global z-token table does not prove that all consumers have migrated. Gather evidence for complex nesting by scenario before consolidating it.

## Ownership / Dependency

`feature/shell/business → components/ui → design`. Page does not read API/store, create a second main landmark, or wrap business copy. The existing application shell owns navigation, assistant, and document slots; login, standalone Settings, and full-screen editors are not forced into one WorkbenchShell.

<a id="正反例"></a>

## Examples and anti-patterns

```tsx
import { Page, PageHeader, PageBody, PageSection, Input, Button } from '../../components/ui'

// labels 和动作由业务 owner 提供；默认布局不依赖具体业务画板。
<Page width="reading">
  <PageHeader title={labels.title} description={labels.description} />
  <PageBody>
    <PageSection title={labels.section}>
      <Input label={labels.name} value={name} onChange={onNameChange} size="standard" />
    </PageSection>
    <div className="flex flex-wrap justify-end gap-[var(--vds-layout-control-gap)]">
      <Button size="standard" loading={saving} onClick={onSave}>{labels.save}</Button>
    </div>
  </PageBody>
</Page>
```

Counterexamples: importing a nonexistent FormPage; copying SettingsPageHeader and adding a fixed gap; imposing the same fixed dimensions on every page; or using an empty screenshot to claim acceptance of the product flow for empty data.

## Enforced by

[The new-visual-value gate](visual-gate.md) is wired into docs:check and npm test. It rejects new fixed styles by owner, full value, and count; the registry, barrel, preview, and type checks constrain discoverable APIs. These checks do not prove component choice or visual quality.
**required**: New fixed visual values and numeric layers must pass the Desktop standards gate. Passing the gate does not replace real-theme, narrow-window, keyboard, and interaction verification.
Before delivery, run docs:write, docs:check, npm test, typecheck, and relevant real-product flows, and inspect the screenshots.

For each acceptance run, record the page entry point, composition type, components used, theme/window/long-content/keyboard states, screenshots, and interaction results.
Mark missing design artifacts as inferred and unavailable runtime cases as gaps. Compare existing failures with an unchanged baseline using the same command; do not weaken gates to hide them.

## Update triggers

When visual decisions, Page APIs, tokens, component states, or design evidence change, update the owning standards, registry/examples, derived inventory, and design mappings. AGENTS/CLAUDE maintain only execution entry points; this page does not duplicate business-specific design reports.

## Stop condition

Record a page as complete only after a default composition can be selected from this page and compiled against the real API, ordinary gates block new violations, and actual interaction and screenshots show no unexplained layout issues. Track visual consistency page by page; passing a representative page does not mean that all business areas, operating systems, or overlay states have been accepted.
