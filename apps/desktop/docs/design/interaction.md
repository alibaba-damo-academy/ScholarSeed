<a id="交互与可访问性规范"></a>
# Interaction and Accessibility Guidelines

## Scope / Non-goals

This document covers focus, keyboard interaction, overlays, feedback, loading, disabled states, dangerous actions, and accessible names. Do not include component appearance inventories or business workflows here.

## Source of truth

Refer to `components/ui/<Family>.tsx`, adjacent CSS/render tests, and real Electron behavior for specific capabilities. The registry helps with selection but does not prove that complex interactions are mature.

## Current / Required / Gap / Advisory

- **current**: Basic controls provide capabilities such as focus-visible, disabled, and label/description; maturity varies across complex components.
- **required**: Interactive controls MUST be keyboard-reachable, have an accessible name, and provide clear focus-visible styling. Asynchronous actions MUST provide pending/success/failure feedback and prevent duplicate submissions.
- **required**: Overlays such as Dialog/Menu/Popover MUST define initial focus after opening, Tab containment, Escape, outside clicks, focus restoration after closing, backdrop behavior, and z-index. Dangerous actions MUST use confirmation semantics.
- **required**: If a focused control inside a modal is disabled, removed, or otherwise becomes unfocusable, the shared focus scope MUST restore focus to a valid control or container in the topmost visible modal. Do not let focus fall to BODY and thereby make Escape ineffective. This does not impose focus containment on non-modal surfaces; the original owner retains policies for closing child layers and preventing dismissal during submission.
- **required**: When an input control handles Enter itself and calls blur or another action that changes focus, it MUST first prevent the key's default behavior, so the same key cannot activate navigation or another button after focus restoration. The field owner handling that command is responsible; do not fix this by removing shared focus containment. Verify in real DOM and Electron separately that the original field, validation, and submission semantics are preserved.
- **gap**: Existing complex overlays such as Dialog, AlertDialog, Popover, and Menu remain preview-grade. Do not assume they provide complete focus trapping, portal, nested-overlay, or screen-reader guarantees.
- **advisory**: Prefer strengthening the design-system family. Complex focus designs SHOULD be tested in real DOM/Electron, not only with static snapshots.

## Ownership / Dependency

Toast is the shared mechanism for temporary operation-result feedback. It closes automatically after 6 seconds by default and provides a manual dismissal control.
The timer pauses when the pointer hovers over it or keyboard focus enters it, then resumes with the remaining time after both leave.
Plain-text errors are deduplicated by content. For rich-text feedback, callers pass a stable `dedupeKey`; an explicit `id` updates the same notice. Updating does not remount the notice and restarts its timer without changing the remaining time of other notices.
A Notification requiring explicit user action may use the same host with `duration: false` and an action entry. Error severity alone does not make a notice persistent; optional actions such as viewing or opening still use temporary Toasts.

The UI family owns the generic interaction state machine; the feature owns business intent and submission actions. Features do not duplicate overlay mechanisms, and UI components do not call business APIs.

<a id="popover-focus-restoration--popover-焦点恢复"></a>
## Popover Focus Restoration

Closing a Popover restores focus to its trigger when focus is still inside the
closing scope or on the document body. This applies to both same-document and
hosted portals, including controlled content that focuses itself before floating
positioning completes. A deliberate move to an outside control must keep that
outside focus; closing a child must not dismiss its parent selection surface.

When a Popover closes, restore focus to its trigger if focus is still within the closing scope or on the document body.
The same rule applies in the same document, in a hosted cross-document portal, and to controlled content that focuses itself before positioning completes.
Keep focus on an outside control when the user deliberately moved it there; closing a child layer must not accidentally close its parent selection surface.

Covered by the early-focus and outside-focus regressions in
`components/ui.render.test.ts`, hosted portals in `components/portal.render.test.ts`,
and the real PDF text-selection model-switch flow. This is covered by the early-focus,
outside-focus, and hosted-portal render regressions in those files, together with
acceptance of the real PDF text-selection model-switch flow.

<a id="会话输入位接管"></a>
## Session Input Slot Takeover

- **required**: When the current session has a pending permission request (such as literature authorization, tool authorization, or file access) or a clarification card, hide the input only in the tab's floating-input entry mode. Keep the input visible in other layouts, allow draft editing, and disable ordinary message sending while confirmation is pending. If submitting a request fails, retain its card for retry. If other requests are pending, continue showing one of them; after all are handled, resume ordinary sending and preserve the existing draft.
- **required**: When the session and tab are side by side, keep the card at the bottom of the session area. Only when the tab is in full view and floating conversation is enabled does the current request take over the floating input slot at the workspace's bottom right. Show only one card there, using the floating conversation width and adapting to available space.
- **required**: Unauthenticated, insufficient-credit, and other status notices retain their usual notice position, and the input remains visible. Historical receipts and completed requests remain in the session history.
- **required**: When the card is shown next to the input, retain the spacing used between the execution plan and the input.
- **required**: An ordinary unanswered clarification card cannot be collapsed, and its height is capped by the conversation display area. Show one question per page and allow navigation only forward. Skip skips only the current question; after the last question, submit the answered content. The title is “明确研究需求” (“Clarify research needs”), using the same 12px regular weight as the progress indicator on the right; the left icon is 14px, the title is 16px from the top, and the gap between the title row and question is 12px. Ordinary clarification has no timer. For literature-review outline confirmation with automatic timeout enabled, show the remaining time after entering the waiting state.
- **required**: The gap between an option title and description is 4px; place the recommended Tag to the right of the title; use the theme's default light background for selected items; and use regular weight for supplemental-input placeholder text. After asynchronous option loading, expand smoothly upward. Mark unanswered historical receipts with a small gray Tag to the right of the question title. The queued-message area sits directly above the input and retains its top and side borders.

<a id="正反例"></a>
## Examples and anti-patterns

```tsx
// 正例：语义由组件承担，业务只传动作
<AlertDialog open={open} onOpenChange={setOpen}>...</AlertDialog>
// 反例：绝对定位 div 模拟弹窗且无焦点恢复
<div style={{ position: 'fixed' }} onClick={close}>...</div>
```

## Enforced by

UI render tests cover the basic structure; verify keyboard interaction, focus restoration, portal/z-index, and cross-window behavior with Playwright/Electron. Until preview-grade gaps are resolved, passing gates must not be interpreted as proof of complete behavior.

<a id="嵌套表面的浮层归属"></a>
## Overlay Ownership in Nested Surfaces

`DialogContent.portalClassName` can create a separate overlay container under body for internal interactions.
Dialog, AlertDialog, Menu, Popover, Select, Tooltip, and HoverCard use this container through React context; when it is unspecified, they still use body. Do not place the container inside a content node with transforms or scroll clipping, and an empty container must not intercept pointer events.
Menus join the parent focus scope through `aria-controls`; subsequent modals continue to use shared focus containment and restoration.
Settings previews and installation-candidate previews use `--vds-z-modal-interaction`, above their nested content. Isolated components continue to handle overlays within their own document and do not cross iframe boundaries.
The globally displayed public literature-delivery slot is hosted by a Desktop-registered `hosted` contribution. It reuses the literature owner's save form and the main-document DialogPortal, including historical cards bound to old resources.
Select only host-compiled components; do not execute plugin source. Other slots remain isolated. Requests retain their original component declaration, permission, and lease checks; save/cancel retain session and project ownership checks. Revoking access or switching scope closes the dialog.
New consumers must verify real hit-testing, deep menus, and return focus; DOM-presence assertions alone do not prove operability.

## Update triggers

Update when overlay implementation, focus strategy, keyboard contract, feedback semantics, or maturity status changes.

## Stop condition

Once a family is identified, read its implementation and tests. If corresponding focus/keyboard evidence is unavailable, record a gap and propose verification; do not infer behavior from the component name.

<a id="mastergo-状态与未知项"></a>
## MasterGo States and Unknowns

**required**: Sample copy, control states, and navigation intent in a design file do not prove business implementation. The [public design contract](foundations.md) records real entry points and gaps. In particular, permission menus must continue to be verified with real HIL/permission flows; do not shorten the confirmation flow based on three pieces of copy.

**current** (design evidence): Two nodes both named “暂无资料” (“No materials”) depict steps 1/4 and 2/4 of a guide; search includes recent items and results with a query; literature includes inline actions, multi-select, and a detail drawer. Record each state separately; do not substitute a representative screenshot for them all.

**gap**: Do not invent steps 3/4 and 4/4 of the unknown guide from the numbering. The Claude-Code and GPT model-provider examples, unauthenticated names versus authenticated navigation props, and Token/credit terminology conflict. Several menu snapshots show only the shell; infer the semantics of individual items from screenshot evidence.

**advisory**: Detail content exceeding drawer height, search `max-height: 700`, and chat `overflow: hidden` express only the boundaries of this design draft. Design and verify real scrolling, keyboard/focus behavior, and narrow-window behavior later; do not directly adopt clipping behavior.

<a id="弹窗焦点整改2026-09-10"></a>
## Dialog Focus Remediation (2026-09-10)

**current**: Dialog defaults to `modal=true`, focuses the first available control on open, cycles Tab/Shift+Tab within the scope, and restores the pre-open focus after Escape closes it. `modal=false` adds no blocking backdrop and does not constrain Tab. AlertDialog and modal Sheet reuse the same focus scope; outside clicks cannot directly confirm or cancel an AlertDialog. DialogContent now receives `contentRef`; shared dismissal ignores invisible content so hidden previews do not consume Escape. Escape closes the inner nested Dialog first and leaves the parent open. Expanded portal regions linked by `aria-controls` are included in the scope.

**current**: In real dev:web, Dialog opening, five forward/backward Tab cycles, Escape dismissal, and focus restoration all passed at 1440px in light mode and 480px in dark mode. Dialog widths were 520/432px respectively, with 24px on each side in the narrow window. Deterministic render tests cover closing only the inner nested Dialog, focus return, unrestricted Tab in non-modal mode, and existing Sheet/Drawer behavior; the full `npm run desktop:test` passed.

**gap**: This does not establish completion for every portalled submenu, cross-family nesting, screen-reader behavior, or scroll locking; each requires individual real acceptance. If a parent dynamically hides a persistently open modal by switching `display`, the effect does not reinitialize focus; callers should control `open` based on visibility.

<a id="嵌套危险确认层级2026-09-15"></a>
### Nested Dangerous-Action Confirmation Layers (2026-09-15)

**current**: The project-edit form retains `Dialog` for its edit fields; “移除项目” (“Remove project”) now uses the shared `AlertDialog`, giving the second confirmation the semantics that it cannot be dismissed by clicking outside the backdrop. `AlertDialogContent` can now receive an optional `overlayClassName`, allowing nested confirmations within the same Dialog family to use the design owner's `--vds-z-dialog-nested-overlay` and `--vds-z-dialog-nested`. This does not create a page-private overlay or elevate the confirmation to a cross-portal layer above Dropdown/Popover.

**current**: On 2026-09-15, CUA opened “新建项目” (“New project”) in the real Desktop and verified that the input received initial focus. Clicking Cancel returned to the project overview and restored focus to “新建项目”. The session screenshot was inspected, but CUA did not save it as a local archiveable file.

**gap**: The MasterGo project overview has no nodes for the create, edit, or remove project dialogs; the semantics and layering above are inferred from existing real business flows. Creation submission, editing, removal confirmation, Escape, inner-layer focus return, narrow windows, and Windows have not completed full regression in real Desktop. Type checks and component examples do not count as acceptance.

<a id="popover焦点整改2026-09-10"></a>
## Popover Focus Remediation (2026-09-10)

**current**: After positioning completes and its content becomes visible, Popover focuses the first available control, or the content container if there is no control. It is non-modal, so Tab can leave. Escape closes it and restores the pre-open focus; if an outside click has already moved focus to another control, Popover does not steal focus back. A real dev:web settings example verified initial focus, toggling a Checkbox with Space, and Escape restoration; `popover-after.png` was inspected. Targeted render regressions also cover repeated opening and retaining focus after an outside click.

**current (persistent task-overview policy)**: Shared overlays default `dismissOnEscape` and `dismissOnOutsidePointerDown` to enabled. Consumers may explicitly disable them but cannot loosen the family's existing outside-click restrictions. The session-toolbar task overview disables both automatic dismissal behaviors: the button remains pressed, the popup is positioned along the existing toolbar's right edge, and it remains open after a file or reference is opened. Only clicking the button again dismisses it; switching sessions resets it. Overview submenus inside menus and other overlays retain the default dismissal behavior. See the deterministic regression in `features/assistant/actions.render.test.ts`; real-platform coverage is determined by this product acceptance.

**gap**: This evidence does not cover all cross-family nesting; complex menus require separate verification. “深色模式” (“Dark mode”) inside the Popover is only a Checkbox interaction example; the actual preview theme remains controlled by the theme selector at the top.

<a id="菜单键盘整改2026-09-10"></a>
## Menu Keyboard Remediation (2026-09-10)

**current**: DropdownMenu and ContextMenu share the Menu owner. After positioning, they initially focus an available control; the up/down arrow keys skip disabled items and wrap, while Home/End moves to the first/last item. The trigger links to the portal through `aria-controls`. Escape acts only on the menu containing current focus; closing a submenu returns focus to its trigger and leaves the parent menu open. Outside-click detection includes expanded submenu regions. A real dev:web run verified focus on open, ArrowDown selecting Account settings, Escape dismissal and trigger restoration; `menu-after.png` was inspected. Component regressions verify disabled-item skipping, wrapping, and nested Escape behavior.

**gap**: This round has no acceptance evidence for typeahead search, opening/closing submenus with left/right arrow keys, or the complete screen-reader flow; do not claim full ARIA menu-pattern support. Product-consumer regression results are tracked in this round's ledger.

<a id="tooltip与反馈状态2026-09-10"></a>
## Tooltip and Feedback States (2026-09-10)

**current**: Tooltip's rendered styles consume tooltip-bg/color; expanded light/dark screenshots show the balloon-semantic background and white foreground. Escape closes the currently visible tooltip under hover or focus while retaining focus on the trigger. The listener runs in the capture phase, and a parent overlay can avoid closing as well by checking `defaultPrevented`. Multiple static examples with `defaultOpen` do not steal Escape from the currently interactive tooltip. Focus/hover dismissal regressions passed.

**current**: In real dev:web, under both light and dark themes, RadioGroup arrow keys moved from Manual to Automatic, then skipped the disabled item and wrapped back. Switch toggled successfully with Space. In a 480px window, the Toast success notice measured 360×66px with a 16px right margin. Light/dark screenshots were inspected, and each close button successfully dismissed its notice.

**gap**: This evidence does not cover every Toast tone/queue or every Tooltip viewport-edge placement; continue to verify long text and complex nesting against the design matrix.

<a id="select组合式键盘2026-09-10"></a>
## Composed Select Keyboard Interaction (2026-09-10)

**current**: The composed Select links to its listbox with `aria-controls` and, when opened, focuses the selected item or the first available item. ArrowUp/Down and Home/End move through items; Enter/Space commits; Escape closes and restores focus without committing an unconfirmed focused item. SelectItem now supports `disabled`, and pointer and keyboard navigation skip disabled items. The browser still handles the native option/optgroup branch; a DOM listbox assertion cannot verify its system popup.

**current**: In real dev:web, initial focus succeeded for “开发框架” (“Development framework”) in both light and dark themes. End/Enter selected Nuxt.js; reopening and pressing Escape closed the Select and restored focus to the trigger. The expanded-state screenshot was inspected. Deterministic regressions cover skipping disabled items, restoration after commit, Escape leaving the selected value unchanged, and reopening with focus on the selected item.

**gap**: These cases do not establish typeahead search, the complete screen-reader flow, or complex nested listboxes.
