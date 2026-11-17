<a id="基础组件设计对齐矩阵"></a>
# Foundational Component Design Alignment Matrix

## Scope / Non-goals

This table preserves the alignment snapshot of 19 component families (Badge/Tag counted as one family) from the 2026-09-10 infrastructure remediation, linking the evidence, implementation, and previews available at that time by design role. It does not replace current source code, design nodes, or dynamic assets, nor does it declare business pages migrated.

## Source of truth

Design file 203335358980331, page 5:43395; use the [public design contract](foundations.md) to locate target states. The 2026-09-09 screenshots of supporting assets (non-public execution/provenance record omitted) and the 2026-09-10 HTTP properties below are historical evidence; recheck the actual design nodes before making changes. Component APIs are defined by the current source linked from the [generated inventory](../_generated/components.md).

“Inferred” means no precise standalone design was available for the control, so its behavior was inferred from shared semantics and accessibility. Do not treat component showcase boards or composite business-card dimensions as foundational component defaults. Dark mode and unspecified interaction states are inferred semantically; no corresponding standalone designs were available.

## Current / Required / Gap / Advisory

- **current**: An index now links the design roles of 19 component families to source semantics and real-runtime evidence; row-by-row results follow.
- **required**: Gather evidence for the corresponding states when precise design nodes exist; explicitly mark inferred states when designs are missing, and verify real light/dark themes, keyboard use, and narrow windows.
- **gap**: Some components lack standalone dark-mode or interaction designs. Those states were inferred from shared semantics and accessibility and verified in real previews; gather more specific evidence when subsequent page migrations provide it.
- **advisory**: When developing a page, read only the relevant rows and follow their links to actual props; do not traverse every historical design document.

Runtime screenshots are stored in the repository-ignored directory `tmp/test_snapshot/design-infrastructure/`; light/dark labels identify screenshots of components opened separately in real dev:web. A default screenshot does not prove that an overlay was opened or that every state passed. Obtain fresh evidence for affected states after each subsequent change.

| Role / State | Design Evidence and Type | Foundational Implementation / Semantic Entry | Preview and Current Verification / Remaining Items |
| --- | --- | --- | --- |
| Button primary/secondary actions, disabled/loading | Current HTTP 25:36297/25:36301: height 36, radius 8; primary background #2C5545; 25:36310 is height 32, so not all buttons should become 36 | Button standard; three states for brand-bg and text-on-brand; warning variant uses warning semantics | Button, 00; deterministic branded-text contrast check across three themes; standard measured at 36; previews exist for sm/md/lg, disabled, and long text |
| IconButton compact actions, hover/selected | Current screenshot and HTTP 5:81200 children 5:81197/5:81206/5:81210: 40 square, radius 8, icon 16, padding 12; historical 8:8919 also shows 28 square | IconButton inherits Button; sm/md/lg square sizes are independent of text Button; ghost uses surface-hover/active | IconButton, 01; measured 26/32/40 squares, icons 14/16/16; lg is 40/radius 8/icon 16; light/dark hover/selected screenshots inspected; the historical 28px size remains available for specific callers to choose |
| Input single-line/password, focus/invalid | Current HTTP 25:36288: 340×36, radius 8, padding 8/12, white background | Input/PasswordInput standard; control-border, text, semantic background | Input, 02; 36-size capability added; width 340 is the width of the design composition |
| Textarea multiline input, disabled | Historical 9:02274 is a 420×228 composite input area with input padding 12/radius 12; no standalone Textarea design | Textarea; control-border/hover, semantic background/text | Textarea, 03; dark border fixed and screenshot inspected; composite input-area layout belongs to the business owner |
| Select default/expanded/disabled | Current HTTP 25:36281: 340×36, radius 8, padding 8/12 | Select standard; composite Trigger inherits size; control-border | Select, 04; standard measured at height 36/radius 8; composite light/dark expanded screenshots, End/Enter selection, and Escape restoration verified; opens without horizontal overflow at 360px; disabled render is skipped successfully |
| Checkbox checked/disabled | Historical authentication design 14:10465 shows the consent checkbox role; no complete standalone state values obtained | Checkbox, checkbox-size/radius, brand-bg | Checkbox, 05; stable light/dark screenshots inspected; Space toggling and preserving disabled state verified |
| Radio selection/disabled | No current standalone precise design; inferred semantically | Radio/RadioGroup, radio semantics and branded selected state | Radio, 06; stable light/dark screenshots inspected; real arrow-key switching, skipping disabled options, wrapping, and natural wrapping of long labels verified |
| Switch on/disabled | Historical model-support asset 14:50537 includes ordinary/enabled switch appearances; no standalone state geometry obtained | Switch; shared track and brand semantics | Switch, 07; stable light/dark screenshots inspected; dark track fixed; Space toggling and disabled state verified |
| Tabs selected/disabled | Historical authentication tab 14:10465; document tabs at 5:003411 belong to NavigationTabs and are not interchangeable | Tabs and NavigationTabs have separate owners; background/text/border semantics | Tabs, 08; stable light/dark screenshots inspected; after click sets initial value, ArrowRight switching and skipping disabled tabs with wraparound verified; NavigationTabs dangling-token fix is covered by contract |
| Badge/Tag states and attachment marker | Historical attachment chip 9:13940 is 208×28, padding 4/8/gap 8; it is a business composition, not a width for every Tag | Badge/Tag; tone semantics; Tag branded foreground now uses text-on-brand | Badge/Tag, 09/10; light/dark tone colors, small size, removal, and long-text truncation tested; business attachment-chip composition belongs to its business owner |
| Card container/emphasis | Historical first project card 25:59495/25:58306: 430×148, padding 16, gap 12, radius 12 | Card bordered/elevated/flat, card-radius/padding and surface | Card, 11; content layout and business actions belong to the project owner; local card-radius + padding=md + gap utility classes measured at 12/16/12; card-detail-480-light/dark inspected with no horizontal overflow; default radius 8 retained |
| Divider horizontal/vertical | Compared across designs; 11:12961 is a draggable splitter and belongs to Resizable | Divider/Separator; divider-color/size | Divider, 12; horizontal 1px and vertical 1px×32 measured; do not conflate a drag handle with Divider |
| Dialog modal/non-modal | Overlay appearance comes from design-by-design review; no precise focus/keyboard design, inferred from interaction guidelines | Dialog + focus scope; supports modal and non-modal | Dialog, 13; Tab/Escape restoration tested at dialog-1440/480; nested render passed |
| Popover interactive overlay | Observed in menu/settings compositions; standalone complete state values missing, inferred semantically | Popover + floating/focus; focus after non-modal positioning | Popover, 14; expanded popover-after screenshot inspected; initial focus/Space/Escape/outside-click regression passed |
| DropdownMenu action menu/submenu | Some menu snapshots show only the shell; do not present them as complete item properties | Menu owner; semantic menu surface/items; aria-controls/focus scope | DropdownMenu, 15; expanded menu-after screenshot inspected; arrow keys, Home/End, disabled-item skipping, and nested Escape verified; left/right keys and character search gaps are documented in the interaction guidelines |
| Tooltip short description | No complete standalone state design; inferred from balloon semantics | Tooltip uses balloon rather than a dangling tooltip token | Tooltip, 16; light/dark hover expansion, 480px narrow-window expansion, and Escape verified and inspected; retaining focus passed render; extreme edge positioning remains constrained by shared floating logic |
| Sheet detail side panel | Historical literature detail drawer is documented in literature designs; content height/width are constraints of that composition | Sheet/Drawer; drawer semantics; shares modal focus scope; Trigger registers restoration target | Sheet/Drawer, 17; 480px light/dark expanded screenshots inspected; real Tab loop, Escape close, and trigger restoration verified; Drawer bottom-expanded screenshot inspected |
| Alert persistent feedback | No complete standalone state design; inferred from info/success/warning/error semantics | Alert semantic background/border/text/icon; warning disabled background fixed | Alert, 18; light/dark tone semantics and long descriptions tested; four-tone mapping covered by class contract; complete standalone designs for all four tones are still missing |
| Toast temporary feedback | No complete standalone state design; inferred from feedback semantics | Toast/Toaster; toast geometry and state semantics; dangling close-hover token fixed | Toast, 19; light/dark feedback trigger/close verified at 480px, 360×66px, right 16; multiple tones and queued stacking tested; actionable toast is 360×102 |

## Ownership / Dependency

design owns semantics and foundational values; ui owns shared states and styles; examples host runnable compositions. The original owners migrate specific project-card, authentication, literature-detail, and other pages within the relevant UI scope during later development. Do not change business pages just to clear this table.

<a id="正反例"></a>
## Examples and anti-patterns

Good example: Use standard Input in an API Key form and compare it with 25:36288 and the actual 36px height; the form owner handles layout width.

Bad example: Set 430px project-card width as the default for every Card, or record a screenshot of a collapsed Tooltip as a passing hover state.

## Enforced by

Asset references, token usage, and CSS rules are checked by docs:check/desktop-test. Visuals and interactions in each row still require current real-preview and shared-consumer evidence. Record states without standalone designs as semantic inferences; do not reuse old runtime logs to declare them currently passing.

## Update triggers

Update the corresponding rows and evidence dates when design nodes, tokens, component props/states, or examples change; when new standalone design evidence appears, add its evidence type to the corresponding row.

## Stop condition

Accept this matrix only when every row has traceable design evidence or an explicit inference, a real implementation, runtime-state evidence, and compatibility results. A default screenshot or green gate cannot replace validation of all states. The matrix currently meets the evidence required for infrastructure delivery; states without standalone designs are recorded as inferences, with more specific design evidence to be added during later business-page migrations.
