<a id="ui-组件规范"></a>
# UI Component Guidelines

## Scope / Non-goals

This document covers selection, exports, ownership, addition workflows, and consumption constraints for `components/ui`. It does not maintain component names or export counts; see the dynamic inventory in [`../_generated/components.md`](../_generated/components.md).

Only component selection, business semantics, and consumption boundaries are specified here. Visual details already provided by component defaults are not repeated.

## Source of truth

`components/ui/registry.ts` is the source of truth for intents and family metadata, and `components/ui/index.ts` is the sole consumption entry point. Refer to implementation source for specific props and behavior; `ComponentsPage.tsx` provides the coverage preview.

## Current / Required / Gap / Advisory

- **current**: The registry, barrel, preview, and reuse gate now form a component discovery and coverage chain.
- **required**: Before writing a page, MUST search with `npm run ui-find Q="<意图>"` or the `ui-component-reuse` skill. Consumer domains MUST import from the `components/ui` barrel.
- **required**: Do not add native `button/input/select/textarea/table` elements, hand-written SVG icons, or feature-level look-alikes. If a foundational design-system component is genuinely missing, MUST implement it in `components/ui/` and update the barrel, `components/ui/registry.ts`, `components/examples/ComponentsPage.tsx`, and tests. Both registry and preview registration are enforced by the gate.
- **gap**: Existing native controls remain managed by the ratchet. See the generated debt inventory; available budget does not authorize adding more.
- **required**: A single-domain business view belongs in its `features/<domain>/` owner. Cross-domain reusable business components MUST live in `components/business/`; reusable primitives outside the design system MUST live in `components/primitive/`. Business ownership does not justify imitating a design-system component inside a feature, nor moving a business component into the UI layer.

<a id="resizable-独立拖拽"></a>
## Resizable Independent Dragging

An explicit `onOffsetChange` on `ResizableHandle` selects independent pixel-offset mode. Even inside a panel group, it does not resize an ancestor panel; the ancestor group's disabled constraint still applies. Without this callback, the handle continues to resize its owning group. Independent mode reuses pointer capture, cancellation cleanup, and arrow-key entry points; consumers maintain the geometry.

An explicit `ResizableHandle.onOffsetChange` selects independent pixel offsets, even inside a panel group. It does not resize the ancestor group and still respects its disabled state. Without that callback, the handle resizes its group. Consumers own geometry; pointer capture, cancellation cleanup and arrow keys remain shared.

<a id="label-与字段间距"></a>
## Label and Field Spacing

Use `form` (the default) for required fields or complex forms, and `display` for simple forms or field-value display.
Prefer `FormField` / `FormLabel` or built-in control labels to reuse default styles and spacing.

<a id="alert-图标关闭与会话提示"></a>
## Alert Icons, Dismissal, and Persistent Session Notices

For persistent in-session notices, choose `layout="stacked"`. Use `warning` for recoverable or non-blocking issues and `error` for blocking errors.
Business logic determines whether dismissal is allowed, the recovery action, and submission state; the shared component handles presentation.

<a id="link-语义链接"></a>
## Link Semantics

`Link` is exported from `components/ui`. It requires `href`, accepts optional `icon` / `disabled` and native anchor attributes, and supports refs and standard events. By default it uses the theme link color and its hover, pressed, and disabled states; it has no underline and retains keyboard focus styling. Long URLs may wrap.

Links that open a new window preserve other caller-provided `rel` values, add `noopener noreferrer`, and remove conflicting `opener`. The disabled state removes `href`, removes the link from the Tab order, and prevents activation by the primary or auxiliary mouse buttons. The component does not interpret or rewrite URLs and does not call Desktop capabilities; business callers such as messaging still provide the system-browser policy.

Registration, preview, and render regressions are in place. Light/dark themes and keyboard focus were inspected in the real component preview, as was a real macOS messaging-consumer screenshot. Native Windows acceptance was not performed in this round.

<a id="文件确认与恢复"></a>
## File Confirmation and Recovery

E09 file-read failures, E10 insufficient save permissions, and E11 native file approvals use custom content composed within `ConfirmationCard`. They retain the shared white shell, two right-side actions, and warning icon; do not redraw the old HTML's red authorization skin or gray file-notice strip. Recovery requests for E09/E10 and native decisions for E11 are still provided by the business owner; the component does not grant permissions or recreate requests. E11 `details` show the native path, actual change type, and scope of this change. `multiline` allows long paths and wrapped patches; scrolling the details area does not move the top actions. Ordinary command approvals do not infer file authorization scope from command strings.

Command approvals reuse the custom confirmation card's compact configuration and orange triangular warning icon. The title, pause explanation, and details field all use the component's default single-line truncation and overflow hint; do not enable `multiline` or add forced-wrapping styles. “命令详情” (“Command details”) directly displays the native command without a collapse control; when it overflows, use the shared hint to view the full content. Show a path only when the request includes a structured path; do not parse shell text to create a file-access promise. Allow-once, deny, and other native authorization options follow the original request decision.

<a id="alert-中性结果"></a>
## Alert Neutral Results

`Alert`'s `tone="neutral"` is for empty results that do not indicate an error, and retains the information icon and `status` semantics. The background, border, text, and icon respectively use the existing neutral surface, border, and text tokens, following the theme. Other tones retain their existing semantics; do not map a neutral state to warning or error.

The answer-empty state reuses this variant and the existing action slot. Consumers must not redeclare a CSS custom property with the same name and compete with the info tone in the cascade. The registry and preview cover neutral; actual regressions must still check computed styles and real consumers. A passing preview does not prove acceptance across all product themes or native platforms.

<a id="导航标签分隔间距"></a>
## Navigation Tab Separator Spacing

**required**: Keep equal spacing between the `NavigationTabs` hover background and the separators on both sides, defined by design's
`--vds-navigation-tab-separator-gap`. Account for line width and transparent borders when positioning tab slots and separators.
Do not compensate by changing the tabs' internal padding. This is based on the user's screenshot and the spacing confirmed in this round, and does not constitute new MasterGo evidence.

**required (latest user interaction adjustment)**: Document tabs adapt to their name length by default, retain the existing maximum width and long-title truncation, and keep the right-side close button visible with space reserved for it.
When space is insufficient, tabs shrink to fit the container. In the compact state, only the active tab shows a close button, while retaining at least the icon. On an extremely narrow active tab, the close button replaces the icon hit area; the full title remains available through a hint and the tab list. Tighten the active tab's left and right padding by 4px each without changing its allocated width. Keep displaying the title until the tab reaches its minimum icon width; on narrower active tabs, give title space priority over the icon. Text before the close button fades naturally through a gradient mask that follows the tab surface and theme. Preserve the unsaved marker; closing must not trigger selection or dragging.
When activating a clipped tab, the horizontal scroll range includes the complete curved borders on both sides and reserves border space at the end. Under reduced-motion preference, scroll directly to the tab.

**current**: Pressing a tab with the primary mouse button activates it immediately; the subsequent `click` does not activate it again. Native dragging must not lose this selection even if it suppresses `click`. Activate the source tab before dragging; sorting and placement across split panes continue to use native dragging.
Touch, keyboard, and assistive technology retain their respective click or key activation paths. The close button and auxiliary mouse buttons do not trigger primary-button press activation.

`onOverflowChange` reports when even the icon cannot fit. The host may place `NavigationTabsMenu` in its own toolbar slot; when no callback is provided, the component displays the entry point. The workbench places it to the left of the fullscreen button. Its list uses the existing order, icons, and actual activation behavior of all visible tabs; it does not create separate tab state. The same entry point aggregates split-pane overflow.
Align the curved selected state's visual spacing with the tab body's side and the adjacent hover background; do not add spacing based on the bounding box of the bottom-extending rounded corners. The underline appearance does not use this curve compensation. The hidden measurement slot uses the compensated spacing but does not publish a selected state, so it cannot interfere with real-tab scroll positioning. Verify the visual result with an actual hover screenshot.

**required**: When tabs overflow, the entire row, including the gaps between tabs, is part of the horizontal scrolling interaction area and must not swallow input as a native-window drag region. Both the mouse wheel and trackpad can scroll it. Blank areas without overflow retain window-drag semantics; tab clicking, closing, context menus, and document dragging do not change because of scrolling.

<a id="dialog-标题头"></a>
## Dialog Header

`DialogContent` can use `headerLayout="aligned"` to select a header matching the detail dialog: it reuses the subhead font size, regular weight, md control height, and existing padding tokens so a single-line title and close button share a horizontal centerline, with safe spacing for the close action. This option does not change default dialogs or dangerous-action confirmations. Long titles may wrap; form content and dismissal/focus behavior retain their original semantics.

<a id="tooltip-边界定位"></a>
## Tooltip Boundary Positioning

`consumeEscape` defaults to `true`, preserving tooltip-first dismissal. A persistent tool's hint may explicitly set it to `false`: dismiss the hint without consuming Escape, allowing the host to cancel the operation according to its own input and overlay boundaries. This does not change the dismissal priority of Popover, Menu, or Dialog.

`consumeEscape` defaults to `true`, preserving tooltip-first dismissal. A continuous tool may set it to `false` to dismiss the hint without consuming Escape, leaving cancellation and editable/overlay boundaries to the host. Popover, Menu and Dialog priorities remain unchanged.

**current**: Tooltip content is mounted in a Portal under body by default, positioned in the direction specified by the caller and constrained to the viewport to avoid panel clipping. Explicit `portalled={false}` retains inline mode; Portal content styles are passed through `contentClassName`, without relying on trigger descendant selectors. Escape closes only a tooltip whose current trigger or content is hovered or focused, and does not consume dismissal events for other overlays.

**gap**: Component regressions for viewport boundaries and clipping containers do not replace real Desktop acceptance of each panel's final version.

## Ownership / Dependency

The restricted OpenUI Lang composition for conversations is registered in `packages/ui/library.tsx` and reuses upstream official components, Renderer, and CSS; the theme is mapped only in Desktop's `design/conversation.ts`. It is a reuse entry point for declarative conversations, not an exemption allowing business pages to copy native controls. Creating equivalent foundational components or placing executable code in the host remains prohibited.
Domain views remain with their existing owners and provide references and artifacts through session/turn-bound ports; ordinary pages continue to consume `components/ui`. Referencing official resources does not change executable-plugin sandboxing or native permission gates.

The dependency direction is `feature/shell/business → components/ui → design`; UI MAY depend on primitives without business semantics. UI MUST NOT depend on app, shell, feature, business, API, or store.

<a id="引用详情触发范围"></a>
## Reference Detail Trigger Area

**current**: In the outer `HoverCard`, the primitive `ReferenceAttachment`'s `previewTrigger` makes the entire reference card the hover trigger for details, uses a pointer cursor, and allows the count button to receive keyboard focus.
The icon and source row share the hover details; removal remains the caller's responsibility, and the source row no longer has a native title hint. Annotation summaries, text selections, and PDF annotation drafts use the same trigger implementation; the two-line detail reference in `SentReferenceAttachment` uses it as well.
The popup aligns to the left of the reference card with an 8px gap. `HoverCardTrigger.positionAnchorRef` provides a separate positioning anchor, and `sideOffset` configures the gap. The shared overlay continues to follow scrolling and size changes and remain within viewport boundaries.
Open, edit, and remove actions in the details remain the responsibility of each business owner; reference data and authorization are unchanged.

**required**: The sole scroll container for long annotation details is constrained by both the design maximum and `--floating-available-height`, published by shared overlay geometry. An explicit side does not flip, and viewport clamping must not obscure reference-card actions.
This variable is measured against the current anchor and viewport, with the overlay's own vertical padding and border deducted; it represents the content-area budget and is not a new fixed visual token. Without an overlay context, retain the design maximum and do not add a second scroll container.

<a id="原生控件复用棘轮"></a>
## Native Control Reuse Ratchet

**current**: `scripts/ci/reuse.policy.json` defines scan roots, extensions, prohibited tags, and exact exemptions. `scripts/ci/reuse.mjs` compares each file with `scripts/ci/reuse.baseline.json`; files not listed have a budget of zero.
`scripts/ci/__tests__/reuse.test.mjs` checks newly added debt, baselines not tightened after debt reduction, and stale file entries. It is wired into the deterministic gate through `pnpm ops ci test --scope desktop`. The inventory is generated from source; do not manually copy counts into this document.

**required**: Per-file counts may only decrease. Do not broaden the policy or increase budgets to pass; do not hand-edit the baseline to turn the gate green or move page code into an exempt directory to evade checks.
After debt actually decreases, tighten the baseline with the existing tool only in a separate, explicitly reviewed change; the tool's write prompt does not constitute authorization for that change. A green ratchet proves only its actual scan scope and does not replace acceptance of component behavior, themes, keyboard use, or real Desktop consumer flows.

<a id="resizable-禁用边界"></a>
## Resizable Disabled Boundary

`ResizableHandle` can receive horizontal pixel movement, measured from the current press position, through `onOffsetChange` when outside a panel group; consumers constrain the edge and width. `onResizeStart` / `onResizeEnd` provide size snapshots and a cleanup point.
Independent mode supports left/right arrow keys and retains pointer capture, blur, and cancellation cleanup; it does not move business panels itself. `appearance="invisible"` provides only a hit area and resize cursor, rendering no divider, background, or grip; use it on the edge of a floating surface.

`ResizablePanelGroup.disabled` only prevents resizing panels; it does not disable business controls inside a panel.
The group marks this state with `data-resize-disabled`. Do not set `aria-disabled` on an ancestor where it would be inherited by all descendants; the drag handle retains its own `aria-disabled`, keyboard focus, and interaction guard.
Real navigation regressions must show both that dragging is disabled when archive is closed and that task and project entry points remain operable.

<a id="resizable-交换契约"></a>
## Resizable Swap Contract

- **current**: For a two-panel `ResizablePanel`, `reversed` controls both horizontal order and drag-offset direction. `leftPanel` / `rightPanel` and their widths continue to refer to logical panels; they are not renamed or reset based on screen position. This property does not affect the vertical mobile layout.
- **required**: Consumers MUST pass `reversed` when swapping two panels; they MUST NOT flip only the visual order with `flex-row-reverse`. The divider always follows the pointer within the boundary; width constraints and write-back at drag end still belong to the original logical panel.
- **required**: For a horizontal two-panel layout with no explicit right-panel width, the right panel fills the remaining space beyond the left panel's actual constrained width and the divider using flex; do not subtract from an unconstrained requested width. Explicit right-panel widths and the vertical mobile layout retain their respective existing size contracts.

<a id="scrollarea-高度契约"></a>
## ScrollArea Height Contract

**current**: The optional `overlay` mode hides the native scrollbar and draws an absolutely positioned scrollbar at the viewport edge without taking content width. It retains native wheel and trackpad scrolling and supports dragging, track clicks, arrow keys, PageUp/PageDown, and Home/End.
ResizeObserver synchronizes size and content changes; the default mode retains the native scrollbar. Callers provide an accessible name for the viewport.
The overlay viewport's content wrapper uses a grid with minimum full height: direct children can stretch to fill a short-content viewport, while long lists grow naturally. Avoid relying only on nested `min-height: 100%` to propagate height, which can make loading or empty states jump to the top.

**current**: By default, the viewport inherits the root node's `max-height` and `min-height`. When callers explicitly pass `max-h-*` or `min-h-*`, only the corresponding default group is replaced; this does not depend on Tailwind output order.
Responsive or state variants retain the unconditional defaults.

**required**: In a flex dialog with a fixed header and footer, the root node owns the maximum height, shrinking, and clipping; the viewport scrolls in the remaining space through `flex-1 min-h-0`. The list height limit consumes `--vds-dialog-list-max-height`; `max-height` alone does not ensure that the viewport shrinks with the root.
Do not change ScrollArea's global layout or clipping defaults, to preserve compatibility with ordinary content flow and horizontal scrolling.

`shadow="auto"` uses the viewport, content size, and scroll position to show a gradient only on sides where content remains above or below. It fades at the boundary and switches immediately when reduced motion is preferred. The gradient uses semantic surface colors: white in light mode and the overlay surface in dark mode. The mask does not receive pointer events. `shadow=true` retains the existing two-sided mask semantics.

<a id="正反例"></a>
## Examples and anti-patterns

```tsx
// 正例
import { Button, ToggleGroup } from '../../components/ui'
// 反例：深导入和自造控件
import { Button } from '../../components/ui/Button'
const Save = () => <button>保存</button>
```

## Enforced by

`reuse.test.mjs` covers native controls and registry/preview coverage; `standards.test.mjs` covers barrel imports and reverse dependencies.

## Update triggers

Update when a component family, barrel, registry field, reuse strategy, ownership, or component maturity changes.

## Stop condition

Once an existing family is identified, read its implementation and types directly. If no match exists, stop at the owner determination; do not first write a replacement inside a feature.

<a id="mastergo-组件对齐入口"></a>
## MasterGo Component Alignment Entry Point

**required**: Read the [public design contract](foundations.md) to confirm the specific page, state, and real integration, then search registry intents and read component props. A `ui-component` name in a design file is not this project's component API. Menus, empty states, and model settings with the same name may represent different states; verify by layer ID.

**gap**: This source analysis found that Input has no generic leading-icon prop and that Checkbox's string label and button body cannot directly contain a policy link. These are candidate capability limitations; they do not authorize hand-writing replacement components in a feature. The component size name L-36 is not equivalent to the existing `size=lg`.

**advisory**: For repeated menus, project cards, trees, tables, and editor toolbars, prefer compositions of existing families or business owners. List supporting assets and their states separately in the [design entry point](mastergo.md); do not copy the full component inventory into page documentation.

<a id="表单尺寸兼容"></a>
## Form Size Compatibility

**current**: Composed `SelectContent` is left-aligned by default; `align="end"` aligns it with the trigger's right edge. The overlay's width and horizontal position are constrained to the viewport. The Markdown view-mode selector uses right alignment without changing the mode value or keyboard selection behavior.

Cancel actions default to `outline`: `DialogClose` and `AlertDialogCancel` retain a neutral surface instead of using the brand-light `secondary`. When Input has `required` and a label, it also displays the required-field asterisk.
The selected Select item and its hover/focus states use `--vds-brand-light-bg-default`, distinct from the hover background of an unselected item.

**current**: Button, Input (including PasswordInput), and Select support `size="standard"`, with a height of 36px and a label line height of 20px. The design basis is the current HTTP properties of file 203335358980331, nodes 25:36281/25:36288/25:36297. Button sizes `md/sm/xs` correspond to design sizes M/S/XS: heights 32/28/24px, body text 14/14/12px, and icons 16/14/12px. Select's existing md size was already 36px; md on the other form controls remains 32px. The composed Select Trigger inherits its size from the root.

**required**: Select the size tier for the specific design; do not mechanically interpret the design's L-36 as code `lg`. See the [ledger](../work/plan/infrastructure.md) for runtime verification status.

Evidence, implementation, and runtime status for the 19 foundational component families in this round are in the [design alignment matrix](alignment.md). Do not infer that pending items are complete just because assets are registered.

<a id="iconbutton几何与状态"></a>
## IconButton Geometry and States

**required (user-confirmed, 2026-11-10)**: Disabled and loading `danger` / `destructive` variants of `Button` continue to use the `--vds-static-white` foreground and retain the existing disabled danger background. Generic disabled text colors must not override danger buttons; other variants retain their existing disabled rules.

**Required (user-confirmed, 2026-11-10)**: Disabled and loading `danger` / `destructive` buttons retain the `--vds-static-white` foreground and their existing disabled danger background. Generic disabled text colors must not override these variants; other variants keep their existing disabled styling.

IconButton supports the mini/xs/sm/md/lg API, with actual square side lengths of 26/24/28/32/40px and icon sizes of 12/12/14/16/16px. mini corresponds to the user's supplemental Tertiary/Mini screenshot (12px icon, 7px padding on each side). Do not add text Button padding on top of these sizes. Explicitly override the icon font's unlayered vendor default size and retain normal weight so it does not inherit the text button's weight and thicken the strokes. md/sm/xs match the M/S/XS button contract at content-action node 5:027657; the 40px ghost still corresponds to node 5:81200. Use an 8px radius. In light mode, hover/selected use surface-hover/active (#F4F1EB/#EAE6DD); derive dark mode from the same semantics. Loading replaces the icon instead of squeezing in two pieces of content at once.


<a id="emptystate面板变体"></a>
## EmptyState Panel Variant

`EmptyState variant="panel"` uses a rounded-square icon background, primary-color title, and secondary-color description, and suits empty states in file and other panels.
Callers provide the icon, title, and description; styling reuses component defaults.
This is based on the user's “Open File” screenshot provided on 2026-10-26. The attached MasterGo node currently returns “暂无技能 / 系统预置” (“No skills / Built-in”) and is not the source of exact properties for that screenshot. Dark mode is derived from existing theme semantics; do not claim that a corresponding dark-mode design exists.

<a id="copybutton反馈"></a>
## CopyButton Feedback

CopyButton's `copiedIcon` applies in both text and `iconOnly` modes; consumers can use `feedbackDuration` to configure how long success/failure feedback remains visible. Replace the icon with the success icon only after an actual successful copy; on failure or reset, return to the original icon, preserving the existing hit area and accessible feedback.

<a id="card按设计组合"></a>
## Card Composition by Design

**current**: Card's default 8px radius remains for compatibility. The existing API can express the container geometry of 25:58306: use `padding="md"` with `className="grid gap-[var(--vds-space-3)] [--vds-card-radius:var(--vds-radius-6)]"`, which yields 16px padding, 12px gap, and a 12px radius. ComponentsPage's “Design Container” provides a copyable example; light and dark checks at 480px showed no horizontal overflow.

**required**: 430×148 is the size of a project-card composition, not the default size for every Card; determine width and height from the page layout. Override only Card's existing custom property locally; do not add CSS selectors or duplicate card components. Whether business interactions and hover apply depends on the specific design role.
