import { cx } from './utils.ts'

export type ComponentSize = 'lg' | 'md' | 'sm'
export type ControlSize = ComponentSize | 'standard'
export type IconButtonSize = ComponentSize | 'xs'
export type ButtonControlSize = ControlSize | 'xs'
export type ButtonSize = ButtonControlSize | 'default' | 'icon' | 'content'
export type ButtonVariant =
  | 'danger'
  | 'default'
  | 'destructive'
  | 'dropzone'
  | 'ghost'
  | 'ghostIcon'
  | 'icon'
  | 'link'
  | 'outline'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'warning'
export type BadgeSize = 'md' | 'sm'
export type BadgeTone =
  | 'brand'
  | 'danger'
  | 'destructive'
  | 'error'
  | 'neutral'
  | 'primary'
  | 'secondary'
  | 'success'
  | 'warning'
export type TagSize = 'default' | 'small'
export type TagTone = BadgeTone
export const SEMANTIC_TAG_COLORS = [
  'brand',
  'error',
  'warning',
  'notice'
] as const
export type SemanticTagColor = (typeof SEMANTIC_TAG_COLORS)[number]

export function semanticTagColor(
  value: string | null | undefined
): SemanticTagColor | undefined {
  return SEMANTIC_TAG_COLORS.find((color) => color === value)
}

export function semanticTagColorFor(seed: string): SemanticTagColor {
  const hash = Array.from(seed).reduce(
    (value, character) =>
      ((value << 5) - value + character.codePointAt(0)!) | 0,
    0
  )
  return SEMANTIC_TAG_COLORS[Math.abs(hash) % SEMANTIC_TAG_COLORS.length]
}

export function semanticTagVariables(
  color: SemanticTagColor
): Record<string, string> {
  return {
    '--vds-tag-background': `var(--vds-${color}-light-bg-default)`,
    '--vds-tag-border': `var(--vds-${color}-light-border)`,
    '--vds-tag-color': `var(--vds-${color}-bg-active)`,
    '--vds-tag-accent': `var(--vds-${color}-bg-active)`,
    '--vds-tag-close-color': `var(--vds-${color}-bg-default)`,
    '--vds-tag-close-hover-color': `var(--vds-${color}-bg-hover)`
  }
}
export type TagVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | TagTone
export type CardPadding = 'lg' | 'md' | 'none' | 'sm'
export type CardVariant = 'bordered' | 'elevated' | 'flat' | 'tinted'
export type DividerOrientation = 'horizontal' | 'vertical'
export type AlertTone = 'error' | 'info' | 'success' | 'warning'
export type AvatarSize = ComponentSize
export type LoadingOverlayTone = 'default' | 'muted'
export type PaginationItem = number | 'ellipsis-left' | 'ellipsis-right'
export type RadioGroupOrientation = 'horizontal' | 'vertical'
export type TableDensity = 'comfortable' | 'compact'
export type TabsOrientation = 'horizontal' | 'vertical'
export type AccordionMode = 'multiple' | 'single'
export type ScrollAreaOrientation = 'both' | 'horizontal' | 'vertical'
export type ToggleSize = ComponentSize
export type ToggleVariant = 'ghost' | 'outline' | 'primary' | 'secondary'
export type ToggleGroupMode = 'multiple' | 'single'
export type ToggleGroupOrientation = 'horizontal' | 'vertical'
export type SliderOrientation = 'horizontal' | 'vertical'
export type ResizableDirection = 'horizontal' | 'vertical'
export type ToastTone = 'error' | 'info' | 'success' | 'warning'
export type SheetSide = 'bottom' | 'left' | 'right' | 'top'
export type TooltipSide = 'bottom' | 'left' | 'right' | 'top'

const PAGINATION_EDGE_ITEM_COUNT = 1
const PAGINATION_SIBLING_ITEM_COUNT = 1
const PAGINATION_FULL_PAGE_LIMIT = 7
const PAGINATION_ANCHOR_ITEM_COUNT = 3
const BUTTON_BASE_CLASS_NAME = [
  'inline-flex items-center justify-center gap-[var(--vds-space-2)]',
  '[border:var(--vds-border-width-1)_solid_transparent] rounded-[var(--vds-control-radius)]',
  '[font-family:var(--vds-font-main)] font-normal whitespace-nowrap select-none shadow-none',
  'cursor-pointer transition-[background-color,border-color,color,box-shadow]',
  'duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]',
  'disabled:!cursor-not-allowed data-[loading=true]:!cursor-not-allowed data-[loading=true]:pointer-events-none',
  '[&_svg]:shrink-0 [&_svg]:pointer-events-none [&_.iconfont]:shrink-0 [&_.iconfont]:pointer-events-none',
  // .vds-icon 的兜底色是无层级 CSS, 会压过按钮文字色的继承; 深色底按钮
  // (primary/destructive) 的图标必须与文字同色, 这里用 important 覆盖兜底。
  '[&_.vds-icon]:!text-current'
].join(' ')
const BUTTON_DISABLED_CLASS_NAME =
  'disabled:[border-color:transparent] disabled:bg-[var(--vds-other-overlay-1)] disabled:text-[var(--vds-text-disabled)] data-[loading=true]:[border-color:transparent] data-[loading=true]:bg-[var(--vds-other-overlay-1)] data-[loading=true]:text-[var(--vds-text-disabled)]'
const BUTTON_STYLE_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  standard:
    'h-[var(--vds-control-height-standard)] px-[var(--vds-space-6)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] [&_svg]:size-[var(--vds-icon-8)] [&_.iconfont]:text-[length:var(--vds-icon-8)]',
  default:
    'h-[var(--vds-control-height-md)] [padding:var(--vds-control-padding-md)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [&_svg]:size-[var(--vds-icon-8)] [&_.iconfont]:text-[length:var(--vds-icon-8)]',
  xs: 'h-[var(--vds-control-height-xs)] [padding:var(--vds-control-padding-xs)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [&_svg]:size-[var(--vds-icon-6)] [&_.iconfont]:text-[length:var(--vds-icon-6)]',
  sm: 'h-[var(--vds-control-height-sm)] [padding:var(--vds-control-padding-sm)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [&_svg]:size-[var(--vds-icon-7)] [&_.iconfont]:text-[length:var(--vds-icon-7)]',
  md: 'h-[var(--vds-control-height-md)] [padding:var(--vds-control-padding-md)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [&_svg]:size-[var(--vds-icon-8)] [&_.iconfont]:text-[length:var(--vds-icon-8)]',
  lg: 'h-[var(--vds-control-height-lg)] [padding:var(--vds-control-padding-lg)] text-[length:var(--vds-font-subhead)] leading-[var(--vds-lh-subhead)] [&_svg]:size-[var(--vds-icon-8)] [&_.iconfont]:text-[length:var(--vds-icon-8)]',
  icon: 'size-[var(--vds-control-height-md)] rounded-[var(--vds-radius-4)] p-0 text-[var(--vds-icon-outline-default)]',
  content:
    'h-auto shrink-0 [padding:var(--vds-control-padding-md)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] whitespace-normal'
}
const BUTTON_ICON_SIZE_CLASS_NAMES: Record<ButtonControlSize, string> = {
  standard: 'size-[var(--vds-control-height-standard)]',
  xs: 'size-[var(--vds-control-height-xs)]',
  sm: 'size-[var(--vds-control-height-sm)]',
  md: 'size-[var(--vds-control-height-md)]',
  lg: 'size-[var(--vds-control-height-lg)]'
}
const BUTTON_GHOST_ICON_SIZE_CLASS_NAMES: Record<ButtonControlSize, string> = {
  standard: BUTTON_ICON_SIZE_CLASS_NAMES.standard,
  xs: 'size-[var(--vds-control-height-xs)] min-w-[var(--vds-control-height-xs)] p-0 [&_svg]:size-[var(--vds-icon-6)] [&_.iconfont]:size-[var(--vds-icon-6)]',
  sm: 'size-[var(--vds-control-height-sm)] min-w-[var(--vds-control-height-sm)] p-0 [&_svg]:size-[var(--vds-icon-7)] [&_.iconfont]:size-[var(--vds-icon-7)]',
  md: BUTTON_ICON_SIZE_CLASS_NAMES.md,
  lg: BUTTON_ICON_SIZE_CLASS_NAMES.lg
}
const BUTTON_STYLE_VARIANT_CLASS_NAMES: Record<ButtonVariant, string> = {
  default:
    '[background:var(--vds-brand-bg-default)] text-[var(--vds-text-on-brand)] enabled:hover:[background:var(--vds-brand-bg-hover)] enabled:hover:text-[var(--vds-text-on-brand-hover)] enabled:active:[background:var(--vds-brand-bg-active)] enabled:active:text-[var(--vds-text-on-brand-active)]',
  primary:
    '[background:var(--vds-brand-bg-default)] text-[var(--vds-text-on-brand)] enabled:hover:[background:var(--vds-brand-bg-hover)] enabled:hover:text-[var(--vds-text-on-brand-hover)] enabled:active:[background:var(--vds-brand-bg-active)] enabled:active:text-[var(--vds-text-on-brand-active)]',
  destructive:
    '[background:var(--vds-error-bg-default)] text-[var(--vds-static-white)] hover:[background:var(--vds-error-bg-hover)] disabled:[background:color-mix(in_srgb,var(--vds-error-bg-default)_50%,transparent)] data-[loading=true]:[background:color-mix(in_srgb,var(--vds-error-bg-default)_50%,transparent)]',
  danger:
    '[background:var(--vds-error-bg-default)] text-[var(--vds-static-white)] hover:[background:var(--vds-error-bg-hover)] disabled:[background:color-mix(in_srgb,var(--vds-error-bg-default)_50%,transparent)] data-[loading=true]:[background:color-mix(in_srgb,var(--vds-error-bg-default)_50%,transparent)]',
  dropzone:
    '![border-color:var(--vds-border-default)] ![border-style:dashed] ![border-width:var(--vds-border-width-2)] [background:var(--vds-bg-white-default)] text-[var(--vds-text-primary)] hover:![border-color:var(--vds-brand-light-border)] hover:[background:var(--vds-bg-white-hover)] data-[drop-active=true]:![border-color:var(--vds-brand-light-border)] data-[drop-active=true]:[background:var(--vds-brand-light-bg-default)] data-[drop-active=true]:shadow-[var(--vds-focus-brand)] disabled:![border-color:var(--vds-border-default)] disabled:[background:var(--vds-bg-white-default)]',
  secondary:
    '![border-color:var(--vds-brand-light-border)] [background:var(--vds-brand-light-bg-default)] text-[var(--vds-brand-text-primary)] hover:[background:var(--vds-brand-light-bg-hover)] active:[background:var(--vds-brand-light-bg-active)]',
  outline:
    '![border-color:var(--vds-fill-6)] [background:var(--vds-bg-white-default)] text-[var(--vds-text-primary)] hover:[background:var(--vds-bg-white-hover)] active:[background:var(--vds-bg-gray-active)] disabled:![border-color:var(--vds-divider-default)] disabled:[background:var(--vds-bg-white-default)] data-[loading=true]:![border-color:var(--vds-divider-default)] data-[loading=true]:[background:var(--vds-bg-white-default)]',
  tertiary:
    '[background:var(--vds-other-overlay-1)] text-[var(--vds-text-primary)] hover:[background:var(--vds-other-overlay-2)] active:[background:var(--vds-other-overlay-3)]',
  ghost:
    '[background:transparent] text-[var(--vds-text-primary)] hover:[background:var(--vds-other-overlay-1)] active:[background:var(--vds-other-overlay-2)] aria-pressed:[background:var(--vds-other-overlay-2)] aria-pressed:text-[var(--vds-text-primary)] disabled:[background:transparent] data-[loading=true]:[background:transparent]',
  warning:
    '![border-color:var(--vds-warning-light-border)] [background:var(--vds-warning-light-bg-default)] text-[var(--vds-warning-text-primary)] hover:[background:var(--vds-warning-light-bg-hover)] active:[background:var(--vds-warning-light-bg-active)] disabled:![border-color:var(--vds-warning-light-bg-hover)] disabled:[background:var(--vds-warning-light-bg-default)] disabled:text-[var(--vds-warning-text-placeholder)] data-[loading=true]:![border-color:var(--vds-warning-light-bg-hover)] data-[loading=true]:[background:var(--vds-warning-light-bg-default)] data-[loading=true]:text-[var(--vds-warning-text-placeholder)]',
  link: 'h-auto [background:transparent] p-0 text-[var(--vds-brand-text-primary)] underline underline-offset-4 hover:[background:transparent] disabled:[background:transparent] data-[loading=true]:[background:transparent]',
  icon: '![border-color:var(--vds-fill-6)] [background:var(--vds-bg-white-default)] text-[var(--vds-text-7)] hover:[background:var(--vds-bg-white-hover)] hover:text-[var(--vds-text-8)] active:[background:var(--vds-bg-gray-active)] active:text-[var(--vds-text-primary)]',
  ghostIcon:
    '[background:transparent] text-[var(--vds-text-7)] hover:[background:var(--vds-other-overlay-1)] hover:text-[var(--vds-text-8)] active:[background:var(--vds-other-overlay-2)] active:text-[var(--vds-text-primary)] aria-pressed:[background:var(--vds-other-overlay-2)] aria-pressed:text-[var(--vds-text-primary)] disabled:[background:transparent] data-[loading=true]:[background:transparent]'
}
const BADGE_BASE_CLASS_NAME =
  'inline-flex max-w-full items-center whitespace-nowrap border border-solid border-transparent rounded-[var(--vds-radius-10)] [font-family:var(--vds-font-main)] font-normal'
const BADGE_SIZE_CLASS_NAMES: Record<BadgeSize, string> = {
  sm: 'h-[var(--vds-badge-height-sm)] px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]',
  md: 'h-[var(--vds-badge-height-md)] px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]'
}
const BADGE_TONE_CLASS_NAMES: Record<
  'brand' | 'danger' | 'neutral' | 'success' | 'warning',
  string
> = {
  neutral:
    'border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default)] text-[var(--vds-text-secondary)]',
  brand:
    'border-[var(--vds-brand-light-border)] bg-[var(--vds-brand-light-bg-default)] text-[var(--vds-brand-text-primary)]',
  success:
    'border-[var(--vds-success-light-border)] bg-[var(--vds-success-light-bg-default)] text-[var(--vds-success-text-primary)]',
  warning:
    'border-[var(--vds-warning-light-border)] bg-[var(--vds-warning-light-bg-default)] text-[var(--vds-warning-text-primary)]',
  danger:
    'border-[var(--vds-error-light-border)] bg-[var(--vds-error-light-bg-default)] text-[var(--vds-error-text-primary)]'
}
const TAG_BASE_CLASS_NAME = [
  'vds-tag inline-flex max-w-full items-center justify-center gap-[4px] overflow-hidden',
  '[border:var(--vds-border-width-1)_solid_var(--vds-tag-border)]',
  '[background:var(--vds-tag-background)] [font-family:var(--vds-font-main)]',
  'text-[var(--vds-tag-color)]',
  'whitespace-nowrap'
].join(' ')
const TAG_SIZE_CLASS_NAMES: Record<TagSize, string> = {
  default:
    '[border-radius:6px] h-[24px] [padding:3px_8px] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]',
  small:
    '[border-radius:4px] h-[20px] [padding:2px_6px] text-[length:10px] leading-[16px] [&_.vds-tag__close]:size-[12px]'
}
const TAG_TONE_CLASS_NAMES: Record<
  'brand' | 'danger' | 'neutral' | 'success' | 'warning',
  string
> = {
  neutral:
    '[--vds-tag-background:var(--vds-bg-gray-default)] [--vds-tag-border:var(--vds-border-default)] [--vds-tag-color:var(--vds-text-secondary)] [--vds-tag-accent:var(--vds-text-secondary)] [--vds-tag-close-color:var(--vds-text-secondary)] [--vds-tag-close-hover-color:var(--vds-text-primary)]',
  brand:
    '[--vds-tag-background:var(--vds-brand-light-bg-default)] [--vds-tag-border:var(--vds-brand-light-border)] [--vds-tag-color:var(--vds-brand-text-primary)] [--vds-tag-accent:var(--vds-brand-text-placeholder)] [--vds-tag-close-color:var(--vds-brand-bg-default)] [--vds-tag-close-hover-color:var(--vds-brand-bg-hover)]',
  success:
    '[--vds-tag-background:var(--vds-success-light-bg-default)] [--vds-tag-border:var(--vds-success-light-border)] [--vds-tag-color:var(--vds-success-text-primary)] [--vds-tag-accent:var(--vds-success-text-placeholder)] [--vds-tag-close-color:var(--vds-success-bg-default)] [--vds-tag-close-hover-color:var(--vds-success-bg-hover)]',
  warning:
    '[--vds-tag-background:var(--vds-warning-light-bg-default)] [--vds-tag-border:var(--vds-warning-light-border)] [--vds-tag-color:var(--vds-warning-text-primary)] [--vds-tag-accent:var(--vds-warning-text-placeholder)] [--vds-tag-close-color:var(--vds-warning-bg-default)] [--vds-tag-close-hover-color:var(--vds-warning-bg-hover)]',
  danger:
    '[--vds-tag-background:var(--vds-error-light-bg-default)] [--vds-tag-border:var(--vds-error-light-border)] [--vds-tag-color:var(--vds-error-text-primary)] [--vds-tag-accent:var(--vds-error-text-placeholder)] [--vds-tag-close-color:var(--vds-error-bg-default)] [--vds-tag-close-hover-color:var(--vds-error-bg-hover)]'
}
/**
 * 选中态的状态钩子: 只挂 class, 自身不画任何视觉。
 *
 * 对比交给容器表达 —— 有标签被选中时, 未选中的 chip 整体降透明度。不在 chip 自身
 * 加描边或字重, 一是标签云换行排布, 任何尺寸变化都会让点击瞬间整片重排跳位; 二是在
 * 一堆彩色色块里, 「把没选的压下去」比「把选中的描出来」辨识度更高。
 *
 * class 仍必须由组件给出: 它是 aria-pressed 之外的机器可读状态, 容器规则靠它区分
 * 选中与未选中, 页面不该自己拼这个类名。
 */
const TAG_SELECTED_CLASS_NAME = 'vds-tag--selected'
const ALERT_BASE_CLASS_NAME =
  'flex min-w-0 items-start gap-[var(--vds-space-2)] rounded-[var(--vds-alert-radius)] border border-solid border-[var(--vds-alert-border)] bg-[var(--vds-alert-background)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[var(--vds-alert-color)] [font-family:var(--vds-font-main)]'
const ALERT_TONE_CLASS_NAMES: Record<AlertTone, string> = {
  info: '[--vds-alert-background:var(--vds-notice-light-bg-default)] [--vds-alert-border:var(--vds-notice-light-border)] [--vds-alert-color:var(--vds-notice-text-primary)] [--vds-alert-icon-color:var(--vds-notice-bg-default)]',
  success:
    '[--vds-alert-background:var(--vds-success-light-bg-default)] [--vds-alert-border:var(--vds-success-light-border)] [--vds-alert-color:var(--vds-success-text-primary)] [--vds-alert-icon-color:var(--vds-success-bg-default)]',
  warning:
    '[--vds-alert-background:var(--vds-warning-light-bg-default)] [--vds-alert-border:var(--vds-warning-light-border)] [--vds-alert-color:var(--vds-warning-text-primary)] [--vds-alert-icon-color:var(--vds-warning-bg-default)]',
  error:
    '[--vds-alert-background:var(--vds-error-light-bg-default)] [--vds-alert-border:var(--vds-error-light-border)] [--vds-alert-color:var(--vds-error-text-primary)] [--vds-alert-icon-color:var(--vds-error-bg-default)]'
}
const CARD_BASE_CLASS_NAME =
  'min-w-0 rounded-[var(--vds-card-radius)] text-[var(--vds-text-primary)]'
const CARD_VARIANT_CLASS_NAMES: Record<CardVariant, string> = {
  bordered:
    'border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] shadow-[var(--vds-shadow-1-center)]',
  elevated:
    'border border-solid border-transparent bg-[var(--vds-surface-raised)] shadow-[var(--vds-shadow-2-center)]',
  flat: 'border border-solid border-transparent bg-[var(--vds-surface-muted)]',
  tinted: 'bg-[var(--vds-bg-gray-default-transparent)]'
}
const CARD_PADDING_CLASS_NAMES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-[var(--vds-card-padding-sm)]',
  md: 'p-[var(--vds-card-padding-md)]',
  lg: 'p-[var(--vds-card-padding-lg)]'
}
const FLOATING_TOOLBAR_BASE_CLASS_NAME =
  'min-w-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-center)]'
const DIVIDER_BASE_CLASS_NAME =
  'shrink-0 grow-0 border-0 bg-[var(--vds-divider-color)]'
const DIVIDER_ORIENTATION_CLASS_NAMES: Record<DividerOrientation, string> = {
  horizontal:
    'h-[var(--vds-divider-size)] w-full [margin:var(--vds-divider-margin-horizontal)]',
  vertical:
    'w-[var(--vds-divider-size)] min-h-[var(--vds-divider-min-height)] self-stretch [margin:var(--vds-divider-margin-vertical)]'
}
const AVATAR_BASE_CLASS_NAME =
  'inline-grid shrink-0 place-items-center overflow-hidden rounded-[var(--vds-radius-circle)] bg-[var(--vds-avatar-background)] text-[var(--vds-avatar-color)] [font-family:var(--vds-font-main)] font-medium'
const AVATAR_SIZE_CLASS_NAMES: Record<AvatarSize, string> = {
  sm: 'size-[var(--vds-avatar-size-sm)] text-[length:var(--vds-font-caption)]',
  md: 'size-[var(--vds-avatar-size-md)] text-[length:var(--vds-font-body-lv1)]',
  lg: 'size-[var(--vds-avatar-size-lg)] text-[length:var(--vds-font-body-lv2)]'
}
const SPINNER_BASE_CLASS_NAME =
  '![display:inline-block] [border:var(--vds-border-width-2)_solid_var(--vds-other-overlay-2)] ![border-top-color:currentColor] [border-radius:var(--vds-radius-circle)] animate-[vds-spin_0.8s_linear_infinite]'
const SPINNER_SIZE_CLASS_NAMES: Record<ComponentSize, string> = {
  sm: '[width:var(--vds-icon-7)] [height:var(--vds-icon-7)]',
  md: '[width:var(--vds-icon-9)] [height:var(--vds-icon-9)]',
  lg: '[width:24px] [height:24px]'
}
const PROGRESS_BAR_BASE_CLASS_NAME =
  'grid min-w-0 gap-[var(--vds-progress-gap)] [&.vds-progress--sm_.vds-progress-bar__track]:h-1 [&.vds-progress--md_.vds-progress-bar__track]:h-2 [&.vds-progress--lg_.vds-progress-bar__track]:h-3'
const PROGRESS_CARD_CLASS_NAME =
  'grid min-w-0 gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-2)]'
const FIELD_CLASS_NAME = 'grid min-w-0 gap-[var(--vds-space-1)]'
const FIELD_LABEL_CLASS_NAME =
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'
const FIELD_MESSAGE_CLASS_NAME =
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-error-text-primary)]'
const INPUT_BASE_CLASS_NAME = [
  'w-full min-w-0 rounded-[var(--vds-control-radius)] border border-solid border-[var(--vds-control-border)]',
  'bg-[var(--vds-bg-white-default)] text-[var(--vds-text-primary)] [font-family:var(--vds-font-main)]',
  'transition-[background-color,border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'placeholder:text-[var(--vds-text-placeholder)] hover:border-[var(--vds-control-border-hover)]',
  'focus:outline-none focus-visible:border-[var(--vds-border-brand)] focus-visible:shadow-none',
  'disabled:cursor-default disabled:bg-[var(--vds-bg-white-disable)] disabled:text-[var(--vds-text-disabled)]'
].join(' ')
const INPUT_SIZE_CLASS_NAMES: Record<ControlSize, string> = {
  standard:
    'h-[var(--vds-control-height-standard)] px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)]',
  sm: 'h-[var(--vds-control-height-sm)] px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]',
  md: 'h-[var(--vds-control-height-md)] px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]',
  lg: 'h-[var(--vds-control-height-lg)] px-[var(--vds-space-4)] text-[length:var(--vds-font-subhead)] leading-[var(--vds-lh-subhead)]'
}
const TEXTAREA_BASE_CLASS_NAME = [
  'flex w-full min-w-0 min-h-[60px] resize-y rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-control-border)]',
  'bg-[var(--vds-bg-white-default)] text-[var(--vds-text-primary)] [font-family:var(--vds-font-main)]',
  'transition-[background-color,border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'placeholder:text-[var(--vds-text-placeholder)] enabled:hover:border-[var(--vds-control-border-hover)]',
  'focus:outline-none focus-visible:border-[var(--vds-border-brand)] focus-visible:shadow-none',
  'disabled:cursor-not-allowed disabled:opacity-50'
].join(' ')
const TEXTAREA_SIZE_CLASS_NAMES: Record<ComponentSize, string> = {
  sm: 'min-h-[60px] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]',
  md: 'min-h-[60px] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]',
  lg: 'min-h-[120px] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]'
}
const CONTROL_INVALID_CLASS_NAME = 'border-[var(--vds-error-bg-default)]'
const CHECKBOX_BASE_CLASS_NAME =
  'inline-flex min-w-0 min-h-[var(--vds-checkbox-size)] items-center gap-[var(--vds-space-2)] border-0 bg-transparent p-0 text-left [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] cursor-pointer disabled:!cursor-not-allowed disabled:text-[var(--vds-text-disabled)] disabled:opacity-50'
const CHECKBOX_BOX_CLASS_NAME =
  'relative inline-grid flex-none place-items-center size-[var(--vds-checkbox-size)] rounded-[var(--vds-checkbox-radius)] border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] text-[var(--vds-bg-white-default)] [border-width:var(--vds-border-width-2)] group-hover:border-[var(--vds-border-default)] group-focus-visible:shadow-none group-disabled:border-[var(--vds-control-border)] group-disabled:bg-[var(--vds-bg-white-default)] group-[.vds-checkbox--checked]:border-[var(--vds-brand-bg-default)] group-[.vds-checkbox--checked]:bg-[var(--vds-brand-bg-default)] group-[.vds-checkbox--mixed]:border-[var(--vds-brand-bg-default)] group-[.vds-checkbox--mixed]:bg-[var(--vds-brand-bg-default)] group-[.vds-checkbox--checked]:group-hover:border-[var(--vds-brand-bg-default)] group-[.vds-checkbox--checked]:group-focus-visible:border-[var(--vds-brand-bg-default)]'
const CHECKBOX_MARK_CLASS_NAME =
  'h-[5px] w-[9px] rotate-[-45deg] border-solid border-current border-t-0 border-r-0 border-b-[length:var(--vds-checkbox-mark-border)] border-l-[length:var(--vds-checkbox-mark-border)] opacity-0 translate-y-[var(--vds-checkbox-mark-offset-y)] group-[.vds-checkbox--checked]:opacity-100 group-[.vds-checkbox--mixed]:h-0 group-[.vds-checkbox--mixed]:w-[9px] group-[.vds-checkbox--mixed]:rotate-0 group-[.vds-checkbox--mixed]:translate-y-0 group-[.vds-checkbox--mixed]:border-b-[length:var(--vds-checkbox-mark-border)] group-[.vds-checkbox--mixed]:border-l-0 group-[.vds-checkbox--mixed]:opacity-100'
const RADIO_BASE_CLASS_NAME =
  'inline-flex min-w-0 min-h-[var(--vds-radio-size)] items-center gap-[var(--vds-space-2)] border-0 bg-transparent p-0 text-left [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] cursor-pointer disabled:cursor-not-allowed disabled:text-[var(--vds-text-disabled)] disabled:opacity-50 focus-visible:outline-none'
const RADIO_DOT_CLASS_NAME =
  'relative inline-grid flex-none place-items-center size-[var(--vds-radio-size)] rounded-[var(--vds-radius-circle)] border-solid border-[var(--vds-control-border)] bg-[var(--vds-bg-white-default)] [border-width:var(--vds-border-width-2)] transition-[background-color,border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] after:size-[6px] after:rounded-[var(--vds-radius-circle)] after:bg-[var(--vds-bg-white-default)] after:content-[""] after:opacity-0 after:transition-opacity after:duration-[var(--vds-duration-fast)] after:ease-[var(--vds-ease-standard)] group-hover:border-[var(--vds-control-border)] group-focus-visible:shadow-none group-disabled:border-[var(--vds-control-border)] group-disabled:bg-[var(--vds-bg-white-default)] group-[.vds-radio--checked]:border-[var(--vds-brand-bg-default)] group-[.vds-radio--checked]:bg-[var(--vds-bg-white-default)] group-[.vds-radio--checked]:shadow-[inset_0_0_0_2px_var(--vds-brand-bg-default)] group-[.vds-radio--checked]:after:opacity-100 group-[.vds-radio--checked]:group-hover:border-[var(--vds-brand-bg-default)] group-[.vds-radio--checked]:group-focus-visible:border-[var(--vds-brand-bg-default)]'
const RADIO_GROUP_BASE_CLASS_NAME =
  'flex min-w-0 gap-[var(--vds-space-3)] aria-disabled:cursor-default'
const RADIO_GROUP_ORIENTATION_CLASS_NAMES: Record<
  RadioGroupOrientation,
  string
> = {
  horizontal: 'flex-row flex-wrap items-center',
  vertical: 'flex-col items-start'
}
const SWITCH_BASE_CLASS_NAME =
  'group relative inline-flex flex-none items-center [width:32px] [height:18px] [padding:2px] [border:0] [border-radius:var(--vds-radius-10)] [background:var(--vds-bg-gray-active)] cursor-pointer transition-[background-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] focus-visible:outline-none focus-visible:[box-shadow:var(--vds-focus-brand)] disabled:cursor-not-allowed disabled:opacity-50'
const SWITCH_TEXT_VARIANT = 'text'
const SWITCH_VARIANT_CLASS_NAMES: Record<'default' | 'icon' | 'text', string> =
{
  default: 'aria-checked:![background:var(--vds-brand-bg-default)]',
  icon: '![background:var(--vds-bg-component)] aria-checked:![background:var(--vds-brand-bg-default)]',
  [SWITCH_TEXT_VARIANT]:
    '![background:var(--vds-bg-component)] aria-checked:![background:var(--vds-brand-bg-default)]'
}
const SWITCH_DECOR_CLASS_NAME =
  'pointer-events-none absolute [top:50%] inline-flex items-center justify-center [min-width:12px] [font-size:8px] [line-height:1] [color:var(--vds-text-tertiary)] [transform:translateY(-50%)] transition-opacity duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] group-[.vds-switch--icon]:[min-width:10px] group-[.vds-switch--icon]:[font-size:8px] group-[.vds-switch--icon]:[&_.iconfont]:[font-size:8px] group-[.vds-switch--icon]:[&_.iconfont]:[line-height:1]'
const SWITCH_THUMB_CLASS_NAME =
  'pointer-events-none z-[var(--vds-z-local-raised)] block [width:14px] [height:14px] [border-radius:var(--vds-radius-circle)] [background:var(--vds-static-white)] [box-shadow:var(--vds-shadow-1-center)] [transform:translateX(0)] transition-transform duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] group-[.vds-switch--checked]:![transform:translateX(14px)]'
const SELECT_BASE_CLASS_NAME = [
  'flex items-center justify-between [gap:var(--vds-space-2)] [width:100%] min-w-[96px] appearance-none',
  '![border:var(--vds-border-width-1)_solid_var(--vds-control-border)] ![background:var(--vds-bg-white-default)]',
  '![color:var(--vds-text-primary)] cursor-pointer [font-family:var(--vds-font-main)] ![font-weight:400] text-left',
  'transition-[background-color,border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'enabled:hover:![border-color:var(--vds-control-border-hover)] focus:outline-none focus-visible:![border-color:var(--vds-border-brand)] focus-visible:[box-shadow:var(--vds-focus-brand)]',
  'disabled:cursor-default disabled:![background:var(--vds-bg-white-disable)] disabled:![color:var(--vds-text-disabled)]'
].join(' ')
const SELECT_SIZE_CLASS_NAMES: Record<ControlSize, string> = {
  standard:
    '[height:var(--vds-control-height-standard)] ![padding:0_var(--vds-space-3)] ![font-size:var(--vds-font-body-lv2)] ![line-height:var(--vds-control-label-line-height)]',
  sm: '[height:var(--vds-control-height-sm)] ![padding:var(--vds-select-padding-sm)] ![font-size:var(--vds-font-body-lv1)] ![line-height:var(--vds-lh-body-lv1)]',
  md: '[height:var(--vds-control-height-standard)] ![padding:0_var(--vds-space-3)] ![font-size:var(--vds-font-body-lv2)] ![line-height:var(--vds-lh-body-lv2)]',
  lg: '![height:var(--vds-control-height-lg)] ![padding:var(--vds-select-padding-lg)] ![font-size:var(--vds-font-subhead)] ![line-height:var(--vds-lh-subhead)]'
}
const SLIDER_BASE_CLASS_NAME =
  'group grid gap-[var(--vds-slider-gap)] text-[var(--vds-text-primary)]'
const SLIDER_ORIENTATION_CLASS_NAMES: Record<SliderOrientation, string> = {
  horizontal: '',
  vertical: 'justify-items-start'
}
const SLIDER_DISABLED_CLASS_NAME =
  'text-[var(--vds-text-disabled)] opacity-[var(--vds-opacity-disabled)]'
const INPUT_OTP_BASE_CLASS_NAME =
  'grid gap-[var(--vds-input-otp-gap)] text-[var(--vds-text-primary)]'
const INPUT_OTP_DISABLED_CLASS_NAME = 'text-[var(--vds-text-disabled)]'
const FORM_FIELD_CLASS_NAME = 'grid min-w-0 gap-[var(--vds-form-field-gap)]'
const FORM_TEXT_CLASS_NAME =
  'm-0 [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]'
const ICON_BUTTON_SIZE_CLASS_NAMES: Record<IconButtonSize, string> = {
  xs: 'size-[var(--vds-control-height-xs)] min-w-[var(--vds-control-height-xs)] [--vds-icon-button-glyph:var(--vds-icon-6)]',
  sm: 'size-[var(--vds-control-height-sm)] min-w-[var(--vds-control-height-sm)] [--vds-icon-button-glyph:var(--vds-icon-7)]',
  md: 'size-[var(--vds-control-height-md)] min-w-[var(--vds-control-height-md)] [--vds-icon-button-glyph:var(--vds-icon-8)]',
  lg: 'size-[var(--vds-control-height-lg)] min-w-[var(--vds-control-height-lg)] [--vds-icon-button-glyph:var(--vds-icon-8)]'
}
const ICON_BUTTON_CONTENT_CLASS_NAME =
  'inline-flex size-[var(--vds-icon-button-glyph)] items-center justify-center'
const COPY_BUTTON_STATUS_CLASS_NAME =
  'absolute size-[var(--vds-sr-size)] overflow-hidden border-0 p-0 [clip:rect(0,0,0,0)] [margin:calc(var(--vds-sr-size)*-1)] whitespace-nowrap'
const COPY_BUTTON_STATUS_CLASS_NAMES: Record<
  'error' | 'idle' | 'success',
  string | undefined
> = {
  idle: undefined,
  success:
    'border-[var(--vds-success-light-border)] bg-[var(--vds-success-light-bg-default)] text-[var(--vds-success-text-primary)]',
  error:
    'border-[var(--vds-error-light-border)] bg-[var(--vds-error-light-bg-default)] text-[var(--vds-error-text-primary)]'
}
// 栅格子项的自动最小尺寸是 min-content：弹窗里出现路径 / URL 这类无断行机会的长
// 文本时，轨道会被撑到比弹窗还宽，内容直接溢出圆角外。子项显式 min-w-0 让轨道回到
// 弹窗宽度，长文本才有机会按各自的换行规则折行。
const DIALOG_CLASS_NAME =
  'fixed [top:50%] [left:50%] z-[var(--vds-z-dialog)] grid w-[min(520px,calc(100vw-48px))] [gap:var(--vds-space-4)] [padding:var(--vds-space-5)] [border:var(--vds-border-width-1)_solid_var(--vds-border-default)] [border-radius:var(--vds-radius-8)] [background:var(--vds-bg-white-default)] [box-shadow:var(--vds-shadow-2-center)] text-[var(--vds-text-primary)] [transform:translate(-50%,-50%)] [&>*]:min-w-0'
const SHEET_BASE_CLASS_NAME =
  'fixed z-[var(--vds-sheet-z-index)] flex max-h-full max-w-full flex-col gap-[var(--vds-sheet-gap)] overflow-auto border border-solid border-[var(--vds-control-border)] bg-[var(--vds-surface-raised)] p-[var(--vds-sheet-padding)] text-[var(--vds-text-primary)] shadow-[var(--vds-sheet-shadow)] focus:shadow-[var(--vds-focus-ring)]'
const SHEET_SIDE_CLASS_NAMES: Record<SheetSide, string> = {
  right:
    '[top:0] [right:0] [bottom:0] w-[min(var(--vds-sheet-side-width),100%)] border-r-0',
  left: '[top:0] [bottom:0] [left:0] w-[min(var(--vds-sheet-side-width),100%)] border-l-0',
  top: '[top:0] [right:0] [left:0] min-h-[var(--vds-sheet-edge-height)] max-h-[var(--vds-sheet-edge-max-height)] border-t-0',
  bottom:
    '[right:0] [bottom:0] [left:0] min-h-[var(--vds-sheet-edge-height)] max-h-[var(--vds-sheet-edge-max-height)] border-b-0'
}
const DRAWER_SIDE_CLASS_NAMES: Record<SheetSide, string> = {
  left: 'w-[min(var(--vds-drawer-side-width),100%)] rounded-none',
  right: 'w-[min(var(--vds-drawer-side-width),100%)] rounded-none',
  top: 'rounded-b-[var(--vds-drawer-radius)] rounded-t-none',
  bottom: 'rounded-t-[var(--vds-drawer-radius)] rounded-b-none'
}
const POPOVER_CLASS_NAME =
  'z-[var(--vds-z-popover)] grid w-max max-w-[min(320px,calc(100vw-48px))] gap-[var(--vds-space-2)] rounded-[12px] bg-[var(--vds-bg-white-default)] p-1 text-[var(--vds-text-primary)] shadow-[2px_4px_12px_0_rgba(0,0,0,0.1)]'
const HOVER_CARD_CLASS_NAME =
  'absolute z-[var(--vds-z-inline-flyout)] pointer-events-auto data-[state=open]:animate-[vds-hover-card-in_120ms_ease-out_80ms_both] data-[state=closed]:pointer-events-none data-[state=closed]:animate-[vds-hover-card-out_120ms_ease-in_both]'
const LOADING_OVERLAY_BASE_CLASS_NAME =
  'absolute [inset:0] z-[var(--vds-loading-overlay-z-index)] grid place-items-center bg-[rgb(245_245_245_/_72%)] p-[var(--vds-space-4)] text-[var(--vds-text-secondary)]'
const LOADING_OVERLAY_TONE_CLASS_NAMES: Record<LoadingOverlayTone, string> = {
  default: '',
  muted: 'bg-[rgb(238_238_238_/_78%)]'
}
const PAGINATION_BASE_CLASS_NAME =
  'inline-flex items-center gap-[var(--vds-pagination-gap)]'
const PAGINATION_ITEM_CLASS_NAME =
  'inline-grid h-[var(--vds-pagination-item-size)] min-w-[var(--vds-pagination-item-size)] place-items-center rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-control-border)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-2)] [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] hover:border-[var(--vds-control-border-hover)] hover:bg-[var(--vds-surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)] aria-[current=page]:border-[var(--vds-brand-bg-default)] aria-[current=page]:bg-[var(--vds-brand-bg-default)] aria-[current=page]:[font-weight:var(--vds-fw-medium)] aria-[current=page]:text-[var(--vds-static-white)] aria-[current=page]:shadow-none aria-[current=page]:hover:border-[var(--vds-brand-bg-hover)] aria-[current=page]:hover:bg-[var(--vds-brand-bg-hover)] disabled:cursor-default disabled:border-[var(--vds-control-border)] disabled:bg-[var(--vds-other-overlay-1)] disabled:text-[var(--vds-text-disabled)]'
const PAGINATION_ITEM_ACTIVE_CLASS_NAME =
  'border-[var(--vds-brand-bg-default)] bg-[var(--vds-brand-bg-default)] [font-weight:var(--vds-fw-medium)] text-[var(--vds-static-white)] shadow-none'
const PAGINATION_ELLIPSIS_CLASS_NAME =
  'inline-grid h-[var(--vds-pagination-item-size)] min-w-[var(--vds-pagination-item-size)] select-none place-items-center text-[var(--vds-text-tertiary)]'
/* 单列轨道必须 minmax(0,1fr)：隐式 auto 轨道取最宽子项 max-content，
   会让 w-fit 触发按钮等内容把 Collapsible 撑出父容器（对话区横向滚动条）。 */
const COLLAPSIBLE_BASE_CLASS_NAME = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[var(--vds-space-2)]'
const COLLAPSIBLE_TRIGGER_CLASS_NAME =
  'inline-flex items-center justify-between gap-[var(--vds-space-2)] [font:inherit] cursor-pointer focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] [&:not(.vds-button)]:min-h-[var(--vds-control-height-md)] [&:not(.vds-button)]:rounded-[var(--vds-control-radius)] [&:not(.vds-button)]:border [&:not(.vds-button)]:border-solid [&:not(.vds-button)]:border-[var(--vds-control-border)] [&:not(.vds-button)]:bg-[var(--vds-surface-raised)] [&:not(.vds-button)]:[padding:var(--vds-control-padding-md)] [&:not(.vds-button)]:text-[var(--vds-text-primary)] [&:not(.vds-button):hover:not(:disabled)]:border-[var(--vds-control-border-hover)] [&:not(.vds-button):hover:not(:disabled)]:bg-[var(--vds-surface-hover)]'
const COLLAPSIBLE_CONTENT_CLASS_NAME =
  'min-w-0 rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] [padding:var(--vds-collapsible-content-padding)] text-[var(--vds-text-secondary)] animate-[vds-collapsible-down_160ms_ease-out] data-[state=closed]:hidden'
const TABS_BASE_CLASS_NAMES: Record<TabsOrientation, string> = {
  horizontal: 'grid min-w-0 gap-[var(--vds-tabs-gap)]',
  vertical:
    'grid min-w-0 gap-[var(--vds-tabs-gap)] grid-cols-[max-content_minmax(0,1fr)] items-start'
}
const TABS_LIST_CLASS_NAME =
  'group/tabs-list relative !inline-flex h-8 min-w-0 items-center justify-center gap-0 rounded-[var(--vds-radius-3)] border-0 bg-[var(--vds-other-overlay-1)] p-[3px] text-[var(--vds-text-tertiary)] aria-[orientation=vertical]:h-auto aria-[orientation=vertical]:flex-col aria-[orientation=vertical]:items-stretch aria-[orientation=vertical]:gap-[var(--vds-space-1)]'
const TABS_TRIGGER_CLASS_NAME =
  'relative z-[var(--vds-z-local-raised)] inline-flex min-h-[26px] items-center justify-center rounded-[var(--vds-radius-3)] border-0 bg-transparent px-[var(--vds-space-3)] py-1 [font-family:inherit] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)] cursor-pointer transition-[color,box-shadow] duration-150 ease-[ease] hover:not-disabled:text-[var(--vds-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] data-[state=active]:text-[var(--vds-text-primary)] group-aria-[orientation=vertical]/tabs-list:data-[state=active]:bg-[var(--vds-bg-white-default)] group-aria-[orientation=vertical]/tabs-list:data-[state=active]:shadow-[var(--vds-shadow-1-center)]'
const TABS_CONTENT_CLASS_NAME =
  'min-w-0 rounded-none border-0 bg-transparent p-0 text-[var(--vds-text-secondary)]'
const TABS_INDICATOR_CLASS_NAME =
  'pointer-events-none !absolute !left-0 !top-[3px] z-[var(--vds-z-base)] block h-[calc(100%-6px)] rounded-[var(--vds-radius-3)] bg-[var(--vds-bg-white-default)] opacity-0 shadow-[var(--vds-shadow-1-center)] transition-[transform,width,opacity] duration-300 ease-[ease]'
const ACCORDION_BASE_CLASS_NAME = 'grid min-w-0 gap-[var(--vds-accordion-gap)]'
const ACCORDION_ITEM_CLASS_NAME =
  'overflow-hidden rounded-[var(--vds-accordion-radius)] [border:var(--vds-border-width-1)_solid_var(--vds-border-default)] bg-[var(--vds-surface-raised)]'
const ACCORDION_TRIGGER_CLASS_NAME =
  'flex min-h-[var(--vds-control-height-md)] w-full items-center justify-between border-0 bg-transparent [padding:var(--vds-accordion-trigger-padding)] text-left [font:inherit] [font-weight:500] text-[var(--vds-text-primary)] cursor-pointer hover:not-disabled:bg-[var(--vds-surface-hover)] focus-visible:outline-none focus-visible:shadow-[inset_var(--vds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] after:size-[var(--vds-accordion-chevron-size)] after:rotate-45 after:[border-right:var(--vds-border-width-2)_solid_currentColor] after:[border-bottom:var(--vds-border-width-2)_solid_currentColor] after:content-[\"\"] after:transition-transform after:duration-[320ms] after:ease-[cubic-bezier(0.22,1,0.36,1)] data-[state=open]:after:rotate-[225deg]'
const ACCORDION_CONTENT_CLASS_NAME =
  'group/accordion-content grid [grid-template-rows:1fr] overflow-hidden [border-top:var(--vds-border-width-1)_solid_var(--vds-border-default)] [padding:var(--vds-accordion-content-padding)] text-[var(--vds-text-secondary)] opacity-100 transition-[grid-template-rows,opacity,padding-block] duration-[320ms,260ms,320ms] ease-[cubic-bezier(0.22,1,0.36,1),ease,cubic-bezier(0.22,1,0.36,1)] data-[state=closed]:[grid-template-rows:0fr] data-[state=closed]:[border-top-color:transparent] data-[state=closed]:[padding-block:0] data-[state=closed]:opacity-0 data-[state=closed]:pointer-events-none'
const ACCORDION_CONTENT_INNER_CLASS_NAME =
  'min-h-0 overflow-hidden translate-y-0 transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=closed]/accordion-content:-translate-y-1.5'
const TOGGLE_BASE_CLASS_NAME =
  'inline-flex items-center justify-center [gap:var(--vds-space-2)] [min-width:var(--vds-toggle-min-width)] [border:var(--vds-border-width-1)_solid_transparent] [border-radius:var(--vds-control-radius)] [font:inherit] [font-weight:500] [line-height:1] whitespace-nowrap cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] hover:not-disabled:[border-color:var(--vds-control-border-hover)] hover:not-disabled:[background:var(--vds-surface-hover)] hover:not-disabled:[color:var(--vds-text-primary)] focus-visible:outline-none focus-visible:[box-shadow:var(--vds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] [&_.vds-icon]:!text-current'
const TOGGLE_SIZE_CLASS_NAMES: Record<ToggleSize, string> = {
  sm: '[min-height:var(--vds-control-height-sm)] [padding:var(--vds-control-padding-sm)]',
  md: '[min-height:var(--vds-control-height-md)] [padding:var(--vds-control-padding-md)]',
  lg: '[min-height:var(--vds-control-height-lg)] [padding:var(--vds-control-padding-lg)]'
}
const TOGGLE_VARIANT_CLASS_NAMES: Record<ToggleVariant, string> = {
  primary:
    '[background:var(--vds-brand-bg-default)] [color:var(--vds-text-on-brand)] hover:not-disabled:[background:var(--vds-brand-bg-hover)] hover:not-disabled:[color:var(--vds-text-on-brand-hover)]',
  secondary:
    '![border-color:var(--vds-control-border)] [background:var(--vds-surface-raised)] [color:var(--vds-text-primary)]',
  outline:
    '![border-color:var(--vds-control-border)] [background:transparent] [color:var(--vds-text-primary)]',
  ghost: '[background:transparent] [color:var(--vds-text-secondary)]'
}
const TOGGLE_PRESSED_CLASS_NAME =
  '![border-color:var(--vds-brand-light-border)] ![background:var(--vds-brand-light-bg-default)] ![color:var(--vds-brand-text-primary)]'
const TOGGLE_PRIMARY_PRESSED_CLASS_NAME =
  '![border-color:transparent] ![background:var(--vds-brand-bg-active)] ![color:var(--vds-text-on-brand-active)] hover:not-disabled:![background:var(--vds-brand-bg-hover)] hover:not-disabled:![color:var(--vds-text-on-brand-hover)]'
const TOGGLE_GROUP_BASE_CLASS_NAME =
  'inline-flex items-center [gap:var(--vds-toggle-group-gap)] [border:var(--vds-border-width-1)_solid_var(--vds-border-default)] [border-radius:var(--vds-control-radius)] [background:var(--vds-surface-muted)] [padding:var(--vds-toggle-group-padding)] [&_.vds-toggle]:![border-color:transparent]'
const TOGGLE_GROUP_ORIENTATION_CLASS_NAMES: Record<
  ToggleGroupOrientation,
  string
> = {
  horizontal: '',
  vertical: 'flex-col items-stretch'
}
const MENU_TRIGGER_CLASS_NAME =
  'inline-flex min-h-8 items-center justify-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[var(--vds-text-primary)] [font:inherit] cursor-pointer'
const MENUBAR_TRIGGER_CLASS_NAME =
  'min-h-8 border-transparent bg-transparent px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-medium shadow-none hover:bg-[var(--vds-bg-white-hover)] focus-visible:bg-[var(--vds-bg-white-hover)] aria-expanded:bg-[var(--vds-bg-white-hover)]'
const MENU_CONTENT_CLASS_NAME =
  'absolute z-[var(--vds-z-inline-flyout)] grid w-max min-w-48 rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-1)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-center)]'
const MENU_ITEM_CLASS_NAME =
  'flex h-[36px] w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border-0 bg-transparent px-[var(--vds-space-2)] py-[6px] text-left text-[var(--vds-text-primary)] [font:inherit] cursor-pointer hover:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] [&>svg:first-child]:size-4 [&>svg:first-child]:text-[var(--vds-text-tertiary)] [&>.vds-icon:first-child]:size-4 [&>.vds-icon:first-child]:text-[var(--vds-text-tertiary)] [&>.iconfont:first-child]:inline-flex [&>.iconfont:first-child]:size-4 [&>.iconfont:first-child]:items-center [&>.iconfont:first-child]:justify-center [&>.iconfont:first-child]:text-[length:16px] [&>.iconfont:first-child]:text-[var(--vds-text-tertiary)]'
// 破坏性动作 (删除、归档这类会收走/移除用户可见对象的操作) 用错误色整行警示:
// 与常规项同几何, 只换色, 避免「点错才发现是危险操作」。整类替换而非追加,
// 防止与常规项的 hover 背景在 Tailwind 同优先级下互相覆盖。
const MENU_ITEM_DESTRUCTIVE_CLASS_NAME =
  'flex h-[36px] w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-error-light-bg-default)] px-[var(--vds-space-2)] py-[6px] text-left text-[var(--vds-error-text-primary)] [font:inherit] cursor-pointer hover:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:bg-[var(--vds-bg-white-hover-transparent)] active:bg-[var(--vds-error-light-bg-active)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] [&>svg:first-child]:size-4 [&>svg:first-child]:text-[var(--vds-error-text-primary)] [&>.vds-icon:first-child]:size-4 [&>.vds-icon:first-child]:text-[var(--vds-error-text-primary)] [&>.iconfont:first-child]:inline-flex [&>.iconfont:first-child]:size-4 [&>.iconfont:first-child]:items-center [&>.iconfont:first-child]:justify-center [&>.iconfont:first-child]:text-[length:16px] [&>.iconfont:first-child]:text-[var(--vds-error-text-primary)]'
const MENU_CHEVRON_CLASS_NAME =
  'ml-auto text-lg leading-none text-[var(--vds-text-tertiary)]'
const NAVIGATION_MENU_TRIGGER_CLASS_NAME =
  'inline-flex min-h-8 items-center justify-center gap-[var(--vds-space-2)] whitespace-nowrap rounded-[var(--vds-radius-3)] border-0 bg-transparent px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-medium text-[var(--vds-text-primary)] no-underline [font:inherit] cursor-pointer hover:bg-[var(--vds-bg-white-hover)] focus-visible:bg-[var(--vds-bg-white-hover)] focus-visible:outline-none aria-expanded:bg-[var(--vds-bg-white-hover)]'
const SCROLL_AREA_VIEWPORT_BASE_CLASS_NAME =
  'max-w-full max-h-[inherit] min-h-[inherit] [overflow:auto] [scrollbar-color:var(--vds-scrollbar-thumb)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[var(--vds-scrollbar-size)] [&::-webkit-scrollbar]:h-[var(--vds-scrollbar-size)] [&::-webkit-scrollbar-thumb]:rounded-[var(--vds-scrollbar-radius)] [&::-webkit-scrollbar-thumb]:bg-[var(--vds-scrollbar-thumb)] [&::-webkit-scrollbar-track]:bg-transparent'
const SCROLL_AREA_VIEWPORT_ORIENTATION_CLASS_NAMES: Record<
  ScrollAreaOrientation,
  string
> = {
  both: '[overflow:auto]',
  horizontal: '[overflow-x:auto] [overflow-y:hidden]',
  vertical: '[overflow-x:hidden] [overflow-y:auto]'
}
const SCROLL_AREA_BAR_BASE_CLASS_NAME =
  'absolute flex rounded-[var(--vds-scrollbar-radius)] bg-transparent touch-none select-none'
const SCROLL_AREA_BAR_ORIENTATION_CLASS_NAMES: Record<
  Exclude<ScrollAreaOrientation, 'both'>,
  string
> = {
  horizontal:
    'bottom-0 left-0 h-[var(--vds-scrollbar-size)] w-full flex-col after:h-full after:w-full after:rounded-[var(--vds-scrollbar-radius)] after:bg-[var(--vds-scrollbar-thumb)] after:content-[""] hover:after:bg-[var(--vds-text-tertiary)]',
  vertical:
    'top-0 right-0 h-full w-[var(--vds-scrollbar-size)] after:h-full after:w-full after:rounded-[var(--vds-scrollbar-radius)] after:bg-[var(--vds-scrollbar-thumb)] after:content-[""] hover:after:bg-[var(--vds-text-tertiary)]'
}
const RESIZABLE_BASE_CLASS_NAME =
  'flex w-full min-w-0 min-h-[var(--vds-resizable-min-height)] overflow-hidden rounded-[var(--vds-resizable-radius)] border border-solid border-[var(--vds-control-border)] bg-[var(--vds-surface-raised)] text-[var(--vds-text-primary)]'
const RESIZABLE_DIRECTION_CLASS_NAMES: Record<ResizableDirection, string> = {
  horizontal: 'flex-row',
  vertical: 'flex-col'
}
const RESIZABLE_DISABLED_CLASS_NAME = 'opacity-[var(--vds-opacity-disabled)]'

export function buttonClassName({
  className,
  size = 'md',
  variant = 'primary'
}: {
  className?: string
  size?: ButtonSize
  variant?: ButtonVariant
}): string {
  const visualVariant =
    variant === 'default'
      ? 'primary'
      : variant === 'destructive'
        ? 'danger'
        : variant
  const visualSize = size === 'default' ? 'md' : size
  return cx(
    'vds-button',
    `vds-button--${visualVariant}`,
    `vds-button--${visualSize}`,
    className
  )
}

export function buttonStyleClassName({
  size = 'md',
  variant = 'primary'
}: {
  size?: ButtonSize
  variant?: ButtonVariant
}): string {
  const iconSize =
    variant === 'ghostIcon' && size !== 'default' && size !== 'icon'
      ? BUTTON_GHOST_ICON_SIZE_CLASS_NAMES[
      size as keyof typeof BUTTON_GHOST_ICON_SIZE_CLASS_NAMES
      ]
      : variant === 'icon' && size !== 'default' && size !== 'icon'
        ? BUTTON_ICON_SIZE_CLASS_NAMES[
        size as keyof typeof BUTTON_ICON_SIZE_CLASS_NAMES
        ]
        : undefined
  return cx(
    BUTTON_BASE_CLASS_NAME,
    BUTTON_STYLE_SIZE_CLASS_NAMES[size],
    BUTTON_DISABLED_CLASS_NAME,
    BUTTON_STYLE_VARIANT_CLASS_NAMES[variant],
    iconSize
  )
}

export function iconButtonClassName({
  className,
  size = 'md'
}: {
  className?: string
  size?: IconButtonSize
}): string {
  return cx('vds-icon-button', `vds-icon-button--${size}`, className)
}

export function iconButtonStyleClassName({
  size = 'md',
  variant = 'primary'
}: {
  size?: IconButtonSize
  variant?: ButtonVariant
}): string {
  const appearance =
    variant === 'ghost'
      ? '[background:transparent] text-[var(--vds-text-primary)] enabled:hover:[background:var(--vds-surface-hover)] enabled:active:[background:var(--vds-surface-active)] enabled:aria-pressed:[background:var(--vds-surface-active)] disabled:[background:transparent] data-[loading=true]:[background:transparent]'
      : BUTTON_STYLE_VARIANT_CLASS_NAMES[variant]
  return cx(
    BUTTON_BASE_CLASS_NAME,
    BUTTON_DISABLED_CLASS_NAME,
    appearance,
    'shrink-0 p-0 [&_.vds-spinner]:ms-0 [&_.vds-icon-button__content]:shrink-0 [&_svg]:size-[var(--vds-icon-button-glyph)] [&_.iconfont]:text-[length:var(--vds-icon-button-glyph)] [&_.vds-icon]:!text-current',
    ICON_BUTTON_SIZE_CLASS_NAMES[size]
  )
}

export function inputClassName({
  className,
  invalid = false,
  size = 'md'
}: {
  className?: string
  invalid?: boolean
  size?: ControlSize
}): string {
  return cx(
    'vds-input',
    `vds-input--${size}`,
    invalid && 'vds-input--invalid',
    className
  )
}

export function inputStyleClassName({
  invalid = false,
  size = 'md'
}: {
  invalid?: boolean
  size?: ControlSize
}): string {
  return cx(
    INPUT_BASE_CLASS_NAME,
    INPUT_SIZE_CLASS_NAMES[size],
    invalid && CONTROL_INVALID_CLASS_NAME
  )
}

export function textareaClassName({
  className,
  invalid = false,
  size = 'md'
}: {
  className?: string
  invalid?: boolean
  size?: ComponentSize
}): string {
  return cx(
    'vds-textarea',
    `vds-textarea--${size}`,
    invalid && 'vds-textarea--invalid',
    className
  )
}

export function textareaStyleClassName({
  invalid = false,
  size = 'md'
}: {
  invalid?: boolean
  size?: ComponentSize
}): string {
  return cx(
    TEXTAREA_BASE_CLASS_NAME,
    TEXTAREA_SIZE_CLASS_NAMES[size],
    invalid && CONTROL_INVALID_CLASS_NAME
  )
}

export function checkboxClassName({
  checked,
  className
}: {
  checked: boolean | 'mixed'
  className?: string
}): string {
  return cx(
    'vds-checkbox',
    checked === true && 'vds-checkbox--checked',
    checked === 'mixed' && 'vds-checkbox--mixed',
    className
  )
}

export function checkboxStyleClassName(): string {
  return cx('group', CHECKBOX_BASE_CLASS_NAME)
}

export function radioClassName({
  checked,
  className
}: {
  checked: boolean
  className?: string
}): string {
  return cx('vds-radio', checked && 'vds-radio--checked', className)
}

export function radioStyleClassName(): string {
  return cx('group', RADIO_BASE_CLASS_NAME)
}

export function selectClassName({
  className,
  invalid = false,
  size = 'md'
}: {
  className?: string
  invalid?: boolean
  size?: ControlSize
}): string {
  return cx(
    'vds-select',
    `vds-select--${size}`,
    invalid && 'vds-select--invalid',
    className
  )
}

export function selectStyleClassName({
  invalid = false,
  size = 'md'
}: {
  invalid?: boolean
  size?: ControlSize
}): string {
  return cx(
    SELECT_BASE_CLASS_NAME,
    SELECT_SIZE_CLASS_NAMES[size],
    '![border-radius:var(--vds-radius-4)]',
    invalid &&
    '![border-color:var(--vds-error-bg-default)] enabled:hover:![border-color:var(--vds-error-bg-default)] focus-visible:![border-color:var(--vds-error-bg-default)]'
  )
}

export function cardClassName({
  className,
  padding = 'md',
  variant = 'bordered'
}: {
  className?: string
  padding?: CardPadding
  variant?: CardVariant
}): string {
  return cx(
    'vds-card',
    `vds-card--${variant}`,
    `vds-card--padding-${padding}`,
    className
  )
}

export function cardStyleClassName({
  padding = 'md',
  variant = 'bordered'
}: {
  padding?: CardPadding
  variant?: CardVariant
}): string {
  return cx(
    CARD_BASE_CLASS_NAME,
    CARD_VARIANT_CLASS_NAMES[variant],
    CARD_PADDING_CLASS_NAMES[padding]
  )
}

export function floatingToolbarClassName({
  className,
  expanded = false
}: {
  className?: string
  expanded?: boolean
} = {}): string {
  return cx(
    'vds-floating-toolbar',
    expanded && 'vds-floating-toolbar--expanded',
    FLOATING_TOOLBAR_BASE_CLASS_NAME,
    className
  )
}

export const floatingToolbarActionsClassName =
  'vds-floating-toolbar__actions flex items-center gap-[var(--vds-space-1)] p-[var(--vds-space-2)] [&>:last-child]:ml-auto'

export function dividerClassName({
  className,
  orientation = 'horizontal'
}: {
  className?: string
  orientation?: DividerOrientation
}): string {
  return cx('vds-divider', `vds-divider--${orientation}`, className)
}

export function dividerStyleClassName({
  orientation = 'horizontal'
}: {
  orientation?: DividerOrientation
}): string {
  return cx(
    DIVIDER_BASE_CLASS_NAME,
    DIVIDER_ORIENTATION_CLASS_NAMES[orientation]
  )
}

export function badgeClassName({
  className,
  size = 'md',
  tone = 'neutral'
}: {
  className?: string
  size?: BadgeSize
  tone?: BadgeTone
}): string {
  const visualTone =
    tone === 'primary'
      ? 'brand'
      : tone === 'secondary'
        ? 'neutral'
        : tone === 'destructive' || tone === 'error'
          ? 'danger'
          : tone
  return cx(
    'vds-badge',
    `vds-badge--${visualTone}`,
    `vds-badge--${size}`,
    className
  )
}

export function badgeStyleClassName({
  size = 'md',
  tone = 'neutral'
}: {
  size?: BadgeSize
  tone?: BadgeTone
}): string {
  const visualTone =
    tone === 'primary'
      ? 'brand'
      : tone === 'secondary'
        ? 'neutral'
        : tone === 'destructive' || tone === 'error'
          ? 'danger'
          : tone
  return cx(
    BADGE_BASE_CLASS_NAME,
    BADGE_SIZE_CLASS_NAMES[size],
    BADGE_TONE_CLASS_NAMES[visualTone]
  )
}

export interface TagClassOptions {
  className?: string
  selected?: boolean
  size?: TagSize
  tone?: TagTone
  variant?: TagVariant
}

export function tagVariants({
  className,
  selected = false,
  size = 'default',
  tone,
  variant
}: TagClassOptions = {}): string {
  const resolvedTone =
    tone ??
    (variant === 'default'
      ? 'brand'
      : variant === 'outline'
        ? 'neutral'
        : variant === 'destructive'
          ? 'danger'
          : variant) ??
    'brand'
  const visualTone =
    resolvedTone === 'primary'
      ? 'brand'
      : resolvedTone === 'secondary'
        ? 'neutral'
        : resolvedTone === 'destructive' || resolvedTone === 'error'
          ? 'danger'
          : resolvedTone
  return cx(
    TAG_BASE_CLASS_NAME,
    TAG_SIZE_CLASS_NAMES[size],
    TAG_TONE_CLASS_NAMES[visualTone],
    selected && TAG_SELECTED_CLASS_NAME,
    className
  )
}

export function spinnerClassName({
  className,
  size = 'md'
}: {
  className?: string
  size?: ComponentSize
}): string {
  return cx('vds-spinner', `vds-spinner--${size}`, className)
}

export function spinnerStyleClassName({
  image = false,
  size = 'md'
}: {
  image?: boolean
  size?: ComponentSize
}): string {
  return cx(image ? 'inline-block shrink-0 align-middle' : SPINNER_BASE_CLASS_NAME, SPINNER_SIZE_CLASS_NAMES[size])
}

export function switchClassName({
  checked,
  className,
  variant = 'default'
}: {
  checked: boolean
  className?: string
  variant?: 'default' | 'icon' | 'text'
}): string {
  return cx(
    'vds-switch',
    variant !== 'default' && `vds-switch--${variant}`,
    checked && 'vds-switch--checked',
    className
  )
}

export function switchStyleClassName({
  variant = 'default'
}: {
  variant?: 'default' | 'icon' | 'text'
}): string {
  return cx(SWITCH_BASE_CLASS_NAME, SWITCH_VARIANT_CLASS_NAMES[variant])
}

export function alertClassName({
  className,
  tone = 'info'
}: {
  className?: string
  tone?: AlertTone
}): string {
  return cx('vds-alert', `vds-alert--${tone}`, className)
}

export function alertStyleClassName({
  tone = 'info'
}: {
  tone?: AlertTone
}): string {
  return cx(ALERT_BASE_CLASS_NAME, ALERT_TONE_CLASS_NAMES[tone])
}

export function avatarClassName({
  className,
  size = 'md'
}: {
  className?: string
  size?: AvatarSize
}): string {
  return cx('vds-ui-avatar', `vds-ui-avatar--${size}`, className)
}

export function avatarStyleClassName({
  size = 'md'
}: {
  size?: AvatarSize
}): string {
  return cx(AVATAR_BASE_CLASS_NAME, AVATAR_SIZE_CLASS_NAMES[size])
}

export function progressBarClassName({
  className,
  indeterminate = false
}: {
  className?: string
  indeterminate?: boolean
}): string {
  return cx(
    'vds-progress-bar',
    indeterminate && 'vds-progress-bar--indeterminate',
    className
  )
}

export function progressBarStyleClassName(): string {
  return PROGRESS_BAR_BASE_CLASS_NAME
}

export function progressCardClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-progress-card', className)
}

export function progressCardStyleClassName(): string {
  return PROGRESS_CARD_CLASS_NAME
}

export function emptyStateClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-empty-state', className)
}

export function copyButtonClassName({
  className,
  status = 'idle'
}: {
  className?: string
  status?: 'error' | 'idle' | 'success'
}): string {
  return cx(
    'vds-copy-button',
    status !== 'idle' && `vds-copy-button--${status}`,
    className
  )
}

export function copyButtonStyleClassName({
  status = 'idle'
}: {
  status?: 'error' | 'idle' | 'success'
}): string {
  return cx('relative', COPY_BUTTON_STATUS_CLASS_NAMES[status])
}

export function loadingOverlayClassName({
  className,
  tone = 'default',
  visible
}: {
  className?: string
  tone?: LoadingOverlayTone
  visible: boolean
}): string {
  return cx(
    'vds-loading-overlay',
    `vds-loading-overlay--${tone}`,
    visible && 'vds-loading-overlay--visible',
    className
  )
}

export function loadingOverlayStyleClassName({
  tone = 'default'
}: {
  tone?: LoadingOverlayTone
}): string {
  return cx(
    LOADING_OVERLAY_BASE_CLASS_NAME,
    LOADING_OVERLAY_TONE_CLASS_NAMES[tone]
  )
}

export function tableClassName({
  className,
  density = 'comfortable'
}: {
  className?: string
  density?: TableDensity
}): string {
  return cx('vds-table', `vds-table--${density}`, className)
}

export function tableStyleClassName(): string {
  return 'group w-full [border-collapse:collapse] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
}

export function paginationClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-pagination', className)
}

export function paginationStyleClassName(): string {
  return PAGINATION_BASE_CLASS_NAME
}

export function aspectRatioClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-aspect-ratio', className)
}

export function breadcrumbClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-breadcrumb', className)
}

export function breadcrumbStyleClassName(): string {
  return 'min-w-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]'
}

export function collapsibleClassName({
  className,
  open
}: {
  className?: string
  open: boolean
}): string {
  return cx('vds-collapsible', open && 'vds-collapsible--open', className)
}

export function collapsibleStyleClassName(): string {
  return COLLAPSIBLE_BASE_CLASS_NAME
}

export function tabsClassName({
  className,
  orientation = 'horizontal'
}: {
  className?: string
  orientation?: TabsOrientation
}): string {
  return cx('vds-tabs', `vds-tabs--${orientation}`, className)
}

export function tabsStyleClassName({
  orientation = 'horizontal'
}: {
  orientation?: TabsOrientation
}): string {
  return TABS_BASE_CLASS_NAMES[orientation]
}

export function radioGroupClassName({
  className,
  orientation = 'vertical'
}: {
  className?: string
  orientation?: RadioGroupOrientation
}): string {
  return cx('vds-radio-group', `vds-radio-group--${orientation}`, className)
}

export function radioGroupStyleClassName({
  orientation = 'vertical'
}: {
  orientation?: RadioGroupOrientation
}): string {
  return cx(
    RADIO_GROUP_BASE_CLASS_NAME,
    RADIO_GROUP_ORIENTATION_CLASS_NAMES[orientation]
  )
}

export function accordionClassName({
  className,
  mode = 'single'
}: {
  className?: string
  mode?: AccordionMode
}): string {
  return cx('vds-accordion', `vds-accordion--${mode}`, className)
}

export function accordionStyleClassName(): string {
  return ACCORDION_BASE_CLASS_NAME
}

export function scrollAreaClassName({
  className,
  orientation = 'vertical',
  shadow = false
}: {
  className?: string
  orientation?: ScrollAreaOrientation
  shadow?: boolean
}): string {
  return cx(
    'vds-scroll-area',
    `vds-scroll-area--${orientation}`,
    shadow && 'vds-scroll-area--shadow',
    className
  )
}

export function scrollAreaStyleClassName({
  shadow = false
}: {
  shadow?: boolean
}): string {
  return cx(
    'relative min-w-0 min-h-0 rounded-[var(--vds-scroll-area-radius)]',
    shadow &&
    'before:absolute before:right-0 before:left-0 before:top-0 before:z-[var(--vds-z-local-raised)] before:h-[var(--vds-scroll-area-shadow-size)] before:pointer-events-none before:bg-[linear-gradient(to_bottom,var(--vds-surface-raised),transparent)] before:content-[""] after:absolute after:right-0 after:left-0 after:bottom-0 after:z-[var(--vds-z-local-raised)] after:h-[var(--vds-scroll-area-shadow-size)] after:pointer-events-none after:bg-[linear-gradient(to_top,var(--vds-surface-raised),transparent)] after:content-[""]'
  )
}

export function scrollAreaViewportClassName({
  className,
  orientation = 'vertical'
}: {
  className?: string
  orientation?: ScrollAreaOrientation
}): string {
  return cx(
    'vds-scroll-area__viewport',
    SCROLL_AREA_VIEWPORT_BASE_CLASS_NAME,
    SCROLL_AREA_VIEWPORT_ORIENTATION_CLASS_NAMES[orientation],
    className
  )
}

export function scrollAreaBarClassName({
  className,
  orientation = 'vertical'
}: {
  className?: string
  orientation?: Exclude<ScrollAreaOrientation, 'both'>
}): string {
  return cx(
    'vds-scroll-area__bar',
    `vds-scroll-area__bar--${orientation}`,
    SCROLL_AREA_BAR_BASE_CLASS_NAME,
    SCROLL_AREA_BAR_ORIENTATION_CLASS_NAMES[orientation],
    className
  )
}

export function toggleClassName({
  className,
  pressed = false,
  size = 'md',
  variant = 'secondary'
}: {
  className?: string
  pressed?: boolean
  size?: ToggleSize
  variant?: ToggleVariant
}): string {
  return cx(
    'vds-toggle',
    `vds-toggle--${variant}`,
    `vds-toggle--${size}`,
    pressed && 'vds-toggle--pressed',
    className
  )
}

export function toggleStyleClassName({
  pressed = false,
  size = 'md',
  variant = 'secondary'
}: {
  pressed?: boolean
  size?: ToggleSize
  variant?: ToggleVariant
}): string {
  return cx(
    TOGGLE_BASE_CLASS_NAME,
    TOGGLE_SIZE_CLASS_NAMES[size],
    TOGGLE_VARIANT_CLASS_NAMES[variant],
    pressed &&
    (variant === 'primary'
      ? TOGGLE_PRIMARY_PRESSED_CLASS_NAME
      : TOGGLE_PRESSED_CLASS_NAME)
  )
}

export function toggleGroupClassName({
  className,
  orientation = 'horizontal'
}: {
  className?: string
  orientation?: ToggleGroupOrientation
}): string {
  return cx('vds-toggle-group', `vds-toggle-group--${orientation}`, className)
}

export function toggleGroupStyleClassName({
  orientation = 'horizontal'
}: {
  orientation?: ToggleGroupOrientation
}): string {
  return cx(
    TOGGLE_GROUP_BASE_CLASS_NAME,
    TOGGLE_GROUP_ORIENTATION_CLASS_NAMES[orientation]
  )
}

export function sliderClassName({
  className,
  disabled = false,
  orientation = 'horizontal'
}: {
  className?: string
  disabled?: boolean
  orientation?: SliderOrientation
}): string {
  return cx(
    'vds-slider',
    `vds-slider--${orientation}`,
    disabled && 'vds-slider--disabled',
    className
  )
}

export function sliderStyleClassName({
  disabled = false,
  orientation = 'horizontal'
}: {
  disabled?: boolean
  orientation?: SliderOrientation
}): string {
  return cx(
    'group',
    SLIDER_BASE_CLASS_NAME,
    SLIDER_ORIENTATION_CLASS_NAMES[orientation],
    disabled && SLIDER_DISABLED_CLASS_NAME
  )
}

export function inputOtpClassName({
  className,
  disabled = false,
  invalid = false
}: {
  className?: string
  disabled?: boolean
  invalid?: boolean
}): string {
  return cx(
    'vds-input-otp',
    invalid && 'vds-input-otp--invalid',
    disabled && 'vds-input-otp--disabled',
    className
  )
}

export function inputOtpStyleClassName({
  disabled = false
}: {
  disabled?: boolean
}): string {
  return cx(
    'group',
    INPUT_OTP_BASE_CLASS_NAME,
    disabled && INPUT_OTP_DISABLED_CLASS_NAME
  )
}

export function fieldClassName({ className }: { className?: string }): string {
  return cx('vds-field', FIELD_CLASS_NAME, className)
}

export function fieldLabelClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-field__label', FIELD_LABEL_CLASS_NAME, className)
}

export function fieldMessageClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-field__message', FIELD_MESSAGE_CLASS_NAME, className)
}

export function formFieldClassName({
  className
}: {
  className?: string
}): string {
  return cx('vds-form-field', FORM_FIELD_CLASS_NAME, className)
}

export function formDescriptionClassName({
  className
}: {
  className?: string
}): string {
  return cx(
    'vds-form-field__description',
    FORM_TEXT_CLASS_NAME,
    'text-[var(--vds-text-secondary)]',
    className
  )
}

export function formMessageClassName({
  className
}: {
  className?: string
}): string {
  return cx(
    'vds-form-field__message',
    FORM_TEXT_CLASS_NAME,
    'text-[var(--vds-error-text-primary)]',
    className
  )
}

export const checkboxBoxClassName = cx(
  'vds-checkbox__box',
  CHECKBOX_BOX_CLASS_NAME
)
export const checkboxMarkClassName = cx(
  'vds-checkbox__mark',
  CHECKBOX_MARK_CLASS_NAME
)
export const iconButtonContentClassName = cx(
  'vds-icon-button__content',
  ICON_BUTTON_CONTENT_CLASS_NAME
)
export const copyButtonStatusClassName = cx(
  'vds-copy-button__status',
  COPY_BUTTON_STATUS_CLASS_NAME
)
export const paginationItemClassName = cx(
  'vds-pagination__item',
  PAGINATION_ITEM_CLASS_NAME
)
export const paginationItemActiveClassName = cx(
  'vds-pagination__item--active',
  PAGINATION_ITEM_ACTIVE_CLASS_NAME
)
export const paginationEllipsisClassName = cx(
  'vds-pagination__ellipsis',
  PAGINATION_ELLIPSIS_CLASS_NAME
)
export const collapsibleTriggerClassName = cx(
  'vds-collapsible__trigger',
  COLLAPSIBLE_TRIGGER_CLASS_NAME
)
export const collapsibleContentClassName = cx(
  'vds-collapsible__content',
  COLLAPSIBLE_CONTENT_CLASS_NAME
)
export const tabsListClassName = cx('vds-tabs__list', TABS_LIST_CLASS_NAME)
export const tabsTriggerClassName = cx(
  'vds-tabs__trigger',
  TABS_TRIGGER_CLASS_NAME
)
export const tabsContentClassName = cx(
  'vds-tabs__content',
  TABS_CONTENT_CLASS_NAME
)
export const tabsIndicatorClassName = cx(
  'vds-tabs__indicator',
  TABS_INDICATOR_CLASS_NAME
)
export const accordionItemClassName = cx(
  'vds-accordion__item',
  ACCORDION_ITEM_CLASS_NAME
)
export const accordionTriggerClassName = cx(
  'vds-accordion__trigger',
  ACCORDION_TRIGGER_CLASS_NAME
)
export const accordionContentClassName = cx(
  'vds-accordion__content',
  ACCORDION_CONTENT_CLASS_NAME
)
export const accordionContentInnerClassName = cx(
  'vds-accordion__content-inner',
  ACCORDION_CONTENT_INNER_CLASS_NAME
)
export const controlLabelClassName = 'min-w-0 text-inherit'
export const radioDotClassName = cx('vds-radio__dot', RADIO_DOT_CLASS_NAME)
export const switchCheckedDecorClassName = cx(
  'vds-switch__decor vds-switch__decor--checked',
  SWITCH_DECOR_CLASS_NAME,
  '[left:3px] ![color:var(--vds-static-white)] opacity-0 group-[.vds-switch--checked]:opacity-100'
)
export const switchUncheckedDecorClassName = cx(
  'vds-switch__decor vds-switch__decor--unchecked',
  SWITCH_DECOR_CLASS_NAME,
  '[right:3px] opacity-100 group-[.vds-switch--checked]:opacity-0'
)
export const switchThumbClassName = cx(
  'vds-switch__thumb',
  SWITCH_THUMB_CLASS_NAME
)
export const selectShellClassName = 'vds-select__shell relative block min-w-0'
export const selectChevronClassName =
  'vds-select__chevron pointer-events-none absolute [top:50%] [right:var(--vds-select-chevron-right)] [width:var(--vds-select-chevron-size)] [height:var(--vds-select-chevron-size)] [border-right:var(--vds-border-width-1)_solid_var(--vds-text-tertiary)] [border-bottom:var(--vds-border-width-1)_solid_var(--vds-text-tertiary)] [transform:translateY(var(--vds-select-chevron-offset-y))_rotate(45deg)] peer-disabled:[border-color:var(--vds-text-disabled)]'
export const selectCompatClassName = 'vds-select__compat relative grid min-w-0'
export const selectContentClassName =
  'vds-select__content absolute [top:calc(100%+4px)] [left:0] z-[var(--vds-z-select-content)] grid [gap:var(--vds-space-1)] [width:100%] [min-width:128px] [max-height:14rem] [padding:var(--vds-space-1)] overflow-x-hidden overflow-y-auto [border:var(--vds-border-width-1)_solid_var(--vds-divider-default)] [border-radius:var(--vds-radius-4)] [background:var(--vds-bg-white-default)] [box-shadow:var(--vds-shadow-2-center)] [&[hidden]]:![display:none]'
export const selectGroupClassName =
  'vds-select__group grid [gap:var(--vds-space-1)]'
export const selectLabelClassName =
  'vds-select__label [padding:0_var(--vds-space-2)] [color:var(--vds-text-secondary)] [font-size:var(--vds-font-body-lv1)]'
export const selectItemBaseClassName =
  'vds-select__item relative flex items-center justify-between [gap:var(--vds-space-2)] [min-height:32px] [padding:5px_32px_5px_12px] [border-radius:var(--vds-radius-4)] [color:var(--vds-text-primary)] [font-size:var(--vds-font-body-lv2)] [font-weight:400] [line-height:var(--vds-lh-body-lv2)] cursor-pointer hover:[background:var(--vds-bg-gray-default-transparent)] focus-visible:outline-none focus-visible:[background:var(--vds-bg-gray-default-transparent)]'
export const selectItemSelectedClassName =
  'vds-select__item--selected [background:var(--vds-bg-gray-default-transparent)] [color:var(--vds-brand-text-primary)]'
export const selectItemLabelClassName = 'vds-select__item-label min-w-0'
export const selectItemIndicatorClassName =
  'vds-select__item-indicator absolute [top:50%] [right:var(--vds-space-2)] [color:var(--vds-brand-bg-default)] [font-size:16px] [line-height:1] [transform:translateY(-50%)]'
export const selectTriggerValueClassName =
  'vds-select__trigger-value min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
export const selectTriggerIconClassName =
  'vds-select__trigger-icon inline-flex items-center justify-center flex-none [color:var(--vds-icon-outline-muted)] [font-size:14px] [line-height:1] transition-transform duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] group-data-[state=open]:![transform:rotate(180deg)]'
export const selectSeparatorClassName =
  'vds-select__separator [height:var(--vds-border-width-1)] [margin:var(--vds-space-1)_0] [background:var(--vds-border-default)]'
export const selectScrollButtonClassName =
  'vds-select__scroll-button flex items-center justify-center [min-height:var(--vds-control-height-sm)] [color:var(--vds-text-tertiary)]'
export const sliderLabelClassName =
  'vds-slider__label text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [font-weight:var(--vds-fw-medium)] text-[var(--vds-text-primary)]'
export const sliderControlClassName =
  'vds-slider__control relative [height:var(--vds-slider-hit-size)] w-full min-w-0'
export const sliderTrackClassName =
  'vds-slider__track absolute [top:50%] [right:0] [left:0] [height:6px] [border-radius:999px] [transform:translateY(-50%)] bg-[var(--vds-brand-light-bg-default)]'
export const sliderRangeClassName =
  'vds-slider__range absolute [top:50%] [right:calc(100%_-_var(--vds-slider-range-end,0%))] [left:var(--vds-slider-range-start,0%)] [height:6px] [border-radius:999px] [transform:translateY(-50%)] bg-[var(--vds-brand-bg-default)]'
export const sliderThumbClassName =
  'vds-slider__thumb pointer-events-none absolute z-[var(--vds-z-local-raised)] [top:50%] [left:var(--vds-slider-thumb-position,0%)] [width:16px] [height:16px] [border:var(--vds-border-width-1)_solid_var(--vds-brand-bg-default)] [border-radius:999px] [background:var(--vds-bg-white-default)] [box-shadow:var(--vds-shadow-1-center)] [transform:translate(-50%,-50%)] transition-[border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] group-[.vds-slider--vertical]:[top:auto] group-[.vds-slider--vertical]:[bottom:var(--vds-slider-thumb-position,0%)] group-[.vds-slider--vertical]:[left:50%] group-[.vds-slider--vertical]:[transform:translate(-50%,50%)]'
export const sliderInputClassName =
  'vds-slider__input pointer-events-none absolute [inset:0] z-[var(--vds-z-local-control)] m-0 [height:var(--vds-slider-hit-size)] w-full cursor-pointer [appearance:none] bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed group-[.vds-slider--vertical]:[height:var(--vds-slider-vertical-height)] group-[.vds-slider--vertical]:[width:var(--vds-slider-hit-size)] group-[.vds-slider--vertical]:[direction:rtl] group-[.vds-slider--vertical]:[writing-mode:vertical-lr]'
export const inputOtpLabelClassName =
  'vds-input-otp__label text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]'
export const inputOtpDescriptionClassName =
  'vds-input-otp__description text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]'
export const inputOtpErrorClassName =
  'vds-input-otp__error text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-error-text-primary)]'
export const inputOtpSlotsClassName =
  'vds-input-otp__slots flex flex-wrap items-center gap-[var(--vds-input-otp-slot-gap)]'
export const inputOtpSlotWrapClassName =
  'vds-input-otp__slot-wrap inline-flex items-center gap-[var(--vds-input-otp-slot-gap)]'
export const inputOtpSlotClassName =
  'vds-input-otp__slot size-[var(--vds-input-otp-slot-size)] rounded-[var(--vds-control-radius)] border border-solid border-[var(--vds-control-border)] bg-[var(--vds-surface-raised)] p-0 text-center text-[var(--vds-text-primary)] [font:inherit] transition-[border-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] hover:not-disabled:border-[var(--vds-control-border-hover)] focus-visible:border-[var(--vds-brand-bg-default)] focus-visible:outline-none focus-visible:shadow-none disabled:cursor-not-allowed disabled:opacity-[var(--vds-opacity-disabled)] group-[.vds-input-otp--invalid]:border-[var(--vds-error-text-primary)]'
export const inputOtpSeparatorClassName =
  'vds-input-otp__separator text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]'
export const breadcrumbListClassName =
  'vds-breadcrumb__list m-0 flex min-w-0 list-none flex-wrap items-center gap-[var(--vds-breadcrumb-gap)] p-0'
export const breadcrumbItemClassName =
  'vds-breadcrumb__item inline-flex min-w-0 items-center gap-[var(--vds-breadcrumb-gap)]'
export const breadcrumbLinkClassName =
  'vds-breadcrumb__link min-w-0 text-inherit no-underline outline-none hover:text-[var(--vds-brand-text-primary)] focus-visible:rounded-[var(--vds-radius-2)] focus-visible:shadow-[var(--vds-focus-ring)]'
export const breadcrumbPageClassName =
  'vds-breadcrumb__page min-w-0 font-medium text-[var(--vds-text-primary)]'
export const breadcrumbSeparatorClassName =
  'vds-breadcrumb__separator inline-flex items-center justify-center text-[var(--vds-text-tertiary)]'
export const breadcrumbEllipsisClassName =
  'vds-breadcrumb__ellipsis inline-flex items-center justify-center text-[var(--vds-text-tertiary)]'
export const menuTriggerClassName = cx(
  'vds-menu__trigger',
  MENU_TRIGGER_CLASS_NAME
)
export const menuContextTriggerClassName = cx(
  'vds-menu__context-trigger',
  MENU_TRIGGER_CLASS_NAME
)
export const menuContentClassName = cx(
  'vds-menu__content',
  MENU_CONTENT_CLASS_NAME
)
export const menuItemClassName = cx('vds-menu__item', MENU_ITEM_CLASS_NAME)
export const menuItemDestructiveClassName = cx(
  'vds-menu__item vds-menu__item--destructive',
  MENU_ITEM_DESTRUCTIVE_CLASS_NAME
)
export const menuItemInsetClassName =
  'vds-menu__item--inset pl-[var(--vds-space-8)]'
export const menuItemCheckableClassName =
  'vds-menu__item--checkable relative pl-[var(--vds-space-8)]'
export const menuSubTriggerClassName = cx(
  'vds-menu__sub-trigger',
  'aria-expanded:bg-[var(--vds-bg-white-hover-transparent)]'
)
export const menuChevronClassName = cx(
  'vds-menu__chevron',
  MENU_CHEVRON_CLASS_NAME
)
export const menuGroupClassName = 'vds-menu__group'
export const menuSeparatorClassName =
  'vds-menu__separator h-[var(--vds-border-width-1)] border-0 bg-[var(--vds-border-default)] [margin:var(--vds-space-2)_var(--vds-space-2)]'
export const menuLabelClassName =
  'vds-menu__label px-[var(--vds-space-2)] py-[6px] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-medium text-[var(--vds-text-primary)]'
export const menuLabelInsetClassName =
  'vds-menu__label--inset pl-[var(--vds-space-8)]'
export const menuShortcutClassName =
  'vds-menu__shortcut ml-auto text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] tracking-normal text-[var(--vds-text-secondary)]'
export const menuIndicatorClassName =
  'vds-menu__indicator absolute left-[var(--vds-space-2)] inline-flex size-[14px] items-center justify-center text-sm leading-none text-[var(--vds-text-primary)]'
export const menubarClassName =
  'vds-menubar flex min-h-11 w-full items-center gap-[var(--vds-space-4)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-3)] py-[var(--vds-space-1)] shadow-[var(--vds-shadow-1-center)]'
export const menubarTriggerClassName = cx(
  menuTriggerClassName,
  MENUBAR_TRIGGER_CLASS_NAME
)
export const navigationMenuClassName =
  'vds-navigation-menu relative z-[var(--vds-z-navigation-menu)] flex max-w-max items-center justify-center'
export const navigationMenuListClassName =
  'vds-navigation-menu__list m-0 flex list-none flex-nowrap items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-1)] shadow-[var(--vds-shadow-1-center)]'
export const navigationMenuItemClassName = 'vds-navigation-menu__item relative'
export const navigationMenuTriggerClassName = cx(
  'vds-navigation-menu__trigger',
  'group',
  NAVIGATION_MENU_TRIGGER_CLASS_NAME
)
export const navigationMenuLinkClassName = cx(
  'vds-navigation-menu__link',
  NAVIGATION_MENU_TRIGGER_CLASS_NAME
)
export const navigationMenuChevronClassName =
  'vds-navigation-menu__chevron text-sm leading-none text-[var(--vds-text-tertiary)] transition-transform duration-150 ease-[ease] group-aria-expanded:rotate-180'
export const navigationMenuContentClassName =
  'vds-navigation-menu__content absolute top-[calc(100%+var(--vds-space-2))] left-0 z-[var(--vds-z-navigation-menu-content)] min-w-[420px] overflow-hidden rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] shadow-[var(--vds-shadow-2-center)] animate-[vds-navigation-menu-in_140ms_ease-out_both]'
export const navigationMenuContentHiddenClassName =
  'vds-navigation-menu__content--hidden hidden'
export const navigationMenuIndicatorClassName = 'vds-navigation-menu__indicator'
export const navigationMenuViewportClassName = 'vds-navigation-menu__viewport'
export const resizablePanelClassName =
  'vds-resizable__panel min-w-0 min-h-0 overflow-auto p-[var(--vds-resizable-panel-padding)]'
export const resizableHandleClassName =
  'vds-resizable__handle relative flex-[0_0_var(--vds-resizable-handle-size)] bg-[var(--vds-divider-color)] cursor-col-resize outline-none transition-[background-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] before:pointer-events-none before:absolute before:left-1/2 before:top-0 before:block before:h-full before:w-[var(--vds-resizable-handle-active-guide-size)] before:-translate-x-1/2 before:[background:linear-gradient(180deg,var(--vds-resizable-handle-current-guide-edge-color)_0%,var(--vds-resizable-handle-current-guide-color)_var(--vds-resizable-handle-active-guide-fade-length),var(--vds-resizable-handle-current-guide-color)_calc(100%_-_var(--vds-resizable-handle-active-guide-fade-length)),var(--vds-resizable-handle-current-guide-edge-color)_100%)] before:content-[""] after:pointer-events-none after:absolute after:left-1/2 after:top-1/2 after:hidden after:h-[var(--vds-resizable-handle-active-length)] after:w-[var(--vds-resizable-handle-active-size)] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-[var(--vds-resizable-handle-active-radius)] after:bg-[var(--vds-resizable-handle-current-background)] after:[background-image:radial-gradient(circle_at_50%_calc(50%_-_var(--vds-resizable-handle-active-dot-outer-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_-_var(--vds-resizable-handle-active-dot-inner-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_+_var(--vds-resizable-handle-active-dot-inner-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_+_var(--vds-resizable-handle-active-dot-outer-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px))] after:shadow-[inset_0_0_0_var(--vds-border-width-1)_var(--vds-resizable-handle-current-border)] after:content-[""] hover:bg-transparent hover:before:block hover:after:block focus-visible:bg-transparent focus-visible:shadow-[var(--vds-focus-ring)] focus-visible:before:block focus-visible:after:block data-[resizing=true]:bg-transparent data-[resizing=true]:before:block data-[resizing=true]:after:block data-[resizing=true]:[--vds-resizable-handle-current-background:var(--vds-resizable-handle-drag-background)] data-[resizing=true]:[--vds-resizable-handle-current-border:var(--vds-resizable-handle-drag-border)] data-[resizing=true]:[--vds-resizable-handle-current-dot-color:var(--vds-resizable-handle-drag-dot-color)] data-[resizing=true]:[--vds-resizable-handle-current-guide-color:var(--vds-resizable-handle-drag-guide-color)] data-[resizing=true]:[--vds-resizable-handle-current-guide-edge-color:var(--vds-resizable-handle-drag-guide-edge-color)] aria-disabled:cursor-not-allowed aria-disabled:hover:bg-[var(--vds-divider-color)] aria-disabled:hover:before:hidden aria-disabled:hover:after:hidden group-[.vds-resizable--vertical]:cursor-row-resize group-[.vds-resizable--vertical]:before:left-0 group-[.vds-resizable--vertical]:before:top-1/2 group-[.vds-resizable--vertical]:before:h-[var(--vds-resizable-handle-active-guide-size)] group-[.vds-resizable--vertical]:before:w-full group-[.vds-resizable--vertical]:before:-translate-y-1/2 group-[.vds-resizable--vertical]:before:translate-x-0 group-[.vds-resizable--vertical]:before:[background:linear-gradient(90deg,var(--vds-resizable-handle-current-guide-edge-color)_0%,var(--vds-resizable-handle-current-guide-color)_var(--vds-resizable-handle-active-guide-fade-length),var(--vds-resizable-handle-current-guide-color)_calc(100%_-_var(--vds-resizable-handle-active-guide-fade-length)),var(--vds-resizable-handle-current-guide-edge-color)_100%)] group-[.vds-resizable--vertical]:after:h-[var(--vds-resizable-handle-active-size)] group-[.vds-resizable--vertical]:after:w-[var(--vds-resizable-handle-active-length)] group-[.vds-resizable--vertical]:after:[background-image:radial-gradient(circle_at_calc(50%_-_var(--vds-resizable-handle-active-dot-outer-offset))_50%,var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_calc(50%_-_var(--vds-resizable-handle-active-dot-inner-offset))_50%,var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_calc(50%_+_var(--vds-resizable-handle-active-dot-inner-offset))_50%,var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_calc(50%_+_var(--vds-resizable-handle-active-dot-outer-offset))_50%,var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px))]'
export const resizableSplitClassName =
  'vds-resizable-split group/resizable-split flex h-full w-full min-w-0 min-h-[var(--vds-resizable-min-height)] overflow-hidden'
export const resizableSplitMobileClassName =
  'vds-resizable-split--mobile flex-col'
export const resizableSplitPanelClassName =
  'vds-resizable-split__panel min-w-0 min-h-0 overflow-auto group-data-[resizing=true]/resizable-split:pointer-events-none group-data-[resizing=true]/resizable-split:select-none'
export const resizableSplitMobilePanelClassName =
  'group-[.vds-resizable-split--mobile]:!w-full'
export const resizableSplitHandleClassName =
  'vds-resizable-split__handle relative z-[var(--vds-resizable-handle-z-index)] flex-[0_0_var(--vds-resizable-handle-active-size)] mx-[calc((var(--vds-resizable-handle-size)-var(--vds-resizable-handle-active-size))/2)] touch-none select-none border-0 !bg-transparent !cursor-col-resize outline-none transition-[background-color,box-shadow] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] before:pointer-events-none before:absolute before:left-1/2 before:top-0 before:block before:h-full before:w-px before:-translate-x-1/2 before:bg-[var(--vds-resizable-handle-current-guide-color)] before:content-[""] after:pointer-events-none after:absolute after:left-1/2 after:top-1/2 after:hidden after:h-[var(--vds-resizable-handle-active-length)] after:w-[var(--vds-resizable-handle-active-size)] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-[var(--vds-resizable-handle-active-radius)] after:bg-[var(--vds-resizable-handle-current-background)] after:[background-image:radial-gradient(circle_at_50%_calc(50%_-_var(--vds-resizable-handle-active-dot-outer-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_-_var(--vds-resizable-handle-active-dot-inner-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_+_var(--vds-resizable-handle-active-dot-inner-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px)),radial-gradient(circle_at_50%_calc(50%_+_var(--vds-resizable-handle-active-dot-outer-offset)),var(--vds-resizable-handle-current-dot-color)_0_calc(var(--vds-resizable-handle-active-dot-size)/2),transparent_calc(var(--vds-resizable-handle-active-dot-size)/2+0.5px))] after:shadow-[inset_0_0_0_var(--vds-border-width-1)_var(--vds-resizable-handle-current-border)] after:content-[""] hover:before:w-[var(--vds-resizable-handle-active-guide-size)] hover:before:[background:linear-gradient(180deg,var(--vds-resizable-handle-current-guide-edge-color)_0%,var(--vds-resizable-handle-current-guide-color)_var(--vds-resizable-handle-active-guide-fade-length),var(--vds-resizable-handle-current-guide-color)_calc(100%_-_var(--vds-resizable-handle-active-guide-fade-length)),var(--vds-resizable-handle-current-guide-edge-color)_100%)] hover:after:block focus-visible:shadow-[var(--vds-focus-ring)] focus-visible:before:w-[var(--vds-resizable-handle-active-guide-size)] focus-visible:before:[background:linear-gradient(180deg,var(--vds-resizable-handle-current-guide-edge-color)_0%,var(--vds-resizable-handle-current-guide-color)_var(--vds-resizable-handle-active-guide-fade-length),var(--vds-resizable-handle-current-guide-color)_calc(100%_-_var(--vds-resizable-handle-active-guide-fade-length)),var(--vds-resizable-handle-current-guide-edge-color)_100%)] focus-visible:after:block data-[resizing=true]:before:w-[var(--vds-resizable-handle-active-guide-size)] data-[resizing=true]:before:[background:linear-gradient(180deg,var(--vds-resizable-handle-current-guide-edge-color)_0%,var(--vds-resizable-handle-current-guide-color)_var(--vds-resizable-handle-active-guide-fade-length),var(--vds-resizable-handle-current-guide-color)_calc(100%_-_var(--vds-resizable-handle-active-guide-fade-length)),var(--vds-resizable-handle-current-guide-edge-color)_100%)] data-[resizing=true]:after:block before:left-[calc(50%_-_0.5px)] before:translate-x-0 data-[resizing=true]:[--vds-resizable-handle-current-background:var(--vds-resizable-handle-drag-background)] data-[resizing=true]:[--vds-resizable-handle-current-border:var(--vds-resizable-handle-drag-border)] data-[resizing=true]:[--vds-resizable-handle-current-dot-color:var(--vds-resizable-handle-drag-dot-color)] data-[resizing=true]:[--vds-resizable-handle-current-guide-color:var(--vds-resizable-handle-drag-guide-color)] data-[resizing=true]:[--vds-resizable-handle-current-guide-edge-color:var(--vds-resizable-handle-drag-guide-edge-color)]'
export function commandClassName({
  className,
  disabled = false
}: {
  className?: string
  disabled?: boolean
}): string {
  return cx('vds-command', disabled && 'vds-command--disabled', className)
}

export function commandStyleClassName(): string {
  return 'flex min-w-0 flex-col overflow-hidden [border-radius:var(--vds-command-radius)] [background:var(--vds-bg-white-default)] text-[var(--vds-text-primary)] aria-disabled:opacity-[var(--vds-opacity-disabled)]'
}

export function resizableClassName({
  className,
  direction = 'horizontal',
  disabled = false
}: {
  className?: string
  direction?: ResizableDirection
  disabled?: boolean
}): string {
  return cx(
    'vds-resizable',
    `vds-resizable--${direction}`,
    disabled && 'vds-resizable--disabled',
    className
  )
}

export function resizableStyleClassName({
  direction = 'horizontal',
  disabled = false
}: {
  direction?: ResizableDirection
  disabled?: boolean
}): string {
  return cx(
    'group',
    RESIZABLE_BASE_CLASS_NAME,
    RESIZABLE_DIRECTION_CLASS_NAMES[direction],
    disabled && RESIZABLE_DISABLED_CLASS_NAME
  )
}

export function toastClassName({
  className,
  tone = 'info'
}: {
  className?: string
  tone?: ToastTone
}): string {
  return cx('vds-toast', `vds-toast--${tone}`, className)
}

export function toastStyleClassName(): string {
  return [
    // 流式排列(非绝对堆叠): 多条提示由 Toaster 的 flex gap 统一上下间距。
    'relative grid [grid-template-columns:auto_minmax(0,1fr)_auto] items-start [gap:10px]',
    // 不设 min-height: 单行提示高度随内容收缩, 上下 padding 保持对称。
    '[padding:var(--vds-space-3)_var(--vds-space-4)] overflow-hidden',
    '[border:var(--vds-border-width-1)_solid_var(--vds-border-default)] [border-radius:var(--vds-toast-radius)]',
    '[background:var(--vds-surface-raised)] [box-shadow:var(--vds-toast-shadow)] [color:var(--vds-text-primary)] pointer-events-auto',
    'transition-[opacity,transform] duration-[180ms] ease-[ease] z-[var(--vds-z-local-raised)]'
  ].join(' ')
}

export function sheetClassName({
  className,
  side = 'right'
}: {
  className?: string
  side?: SheetSide
}): string {
  return cx('vds-sheet', `vds-sheet--${side}`, className)
}

export function sheetStyleClassName({
  side = 'right'
}: {
  side?: SheetSide
}): string {
  return cx(SHEET_BASE_CLASS_NAME, SHEET_SIDE_CLASS_NAMES[side])
}

export function drawerClassName({
  className,
  side = 'bottom'
}: {
  className?: string
  side?: SheetSide
}): string {
  return cx('vds-drawer', `vds-drawer--${side}`, className)
}

export function drawerStyleClassName({
  side = 'bottom'
}: {
  side?: SheetSide
}): string {
  return DRAWER_SIDE_CLASS_NAMES[side]
}

export function tooltipClassName({
  className,
  disabled = false,
  open = false,
  side = 'top'
}: {
  className?: string
  disabled?: boolean
  open?: boolean
  side?: TooltipSide
}): string {
  return cx(
    'vds-tooltip',
    `vds-tooltip--${side}`,
    open && 'vds-tooltip--open',
    disabled && 'vds-tooltip--disabled',
    className
  )
}

export function tooltipStyleClassName(): string {
  return 'relative inline-flex w-max max-w-full'
}

export const alertIconClassName =
  'vds-alert__icon mt-px inline-flex size-[var(--vds-alert-icon-size)] flex-none items-center justify-center text-[length:var(--vds-alert-icon-size)] leading-none text-[var(--vds-alert-icon-color)]'
export const alertContentClassName =
  'vds-alert__content grid min-w-0 flex-1 auto-rows-min gap-0.5'
export const alertTitleClassName =
  'vds-alert__title m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
export const alertDescriptionClassName =
  'vds-alert__description m-0 line-clamp-2 overflow-hidden text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'
export const alertAsideClassName =
  'vds-alert__aside inline-flex flex-none items-center gap-[var(--vds-space-2)]'
export const alertActionClassName = 'vds-alert__action inline-flex items-center'
export const alertCloseClassName =
  'vds-alert__close inline-flex size-5 items-center justify-center rounded-[var(--vds-radius-2)] border-0 bg-transparent p-0 [font:inherit] text-[var(--vds-text-placeholder)] cursor-pointer hover:text-[var(--vds-text-secondary)] focus-visible:text-[var(--vds-text-secondary)] focus-visible:outline-none'
export const dialogOverlayClassName =
  'vds-dialog__overlay fixed [inset:0] z-[var(--vds-z-dialog-overlay)] bg-[rgb(0_0_0_/_32%)]'
export const dialogContentClassName = cx('vds-dialog', DIALOG_CLASS_NAME)
export const dialogHeaderClassName =
  'vds-dialog__header grid [gap:var(--vds-space-2)] [&>*]:min-w-0'
export const dialogFooterClassName =
  'vds-dialog__footer flex flex-wrap justify-end [gap:var(--vds-space-2)]'
export const dialogTitleClassName =
  'vds-dialog__title [margin:0] text-[length:var(--vds-font-title)] leading-[var(--vds-lh-title)] [font-weight:var(--vds-fw-medium)] break-words'
export const dialogDescriptionClassName =
  'vds-dialog__description [margin:0] text-[var(--vds-text-secondary)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] break-words'
export const dialogCloseClassName =
  'vds-dialog__close absolute [top:var(--vds-space-2)] [right:var(--vds-space-2)]'
export const sheetOverlayClassName =
  'vds-sheet__overlay fixed [inset:0] z-[var(--vds-sheet-overlay-z-index)] bg-[var(--vds-sheet-overlay-bg)]'
export const sheetPortalClassName = 'vds-sheet__portal'
export const sheetHeaderClassName =
  'vds-sheet__header flex flex-col gap-[var(--vds-sheet-action-gap)]'
export const sheetFooterClassName =
  'vds-sheet__footer flex justify-end gap-[var(--vds-sheet-action-gap)]'
export const sheetTitleClassName =
  'vds-sheet__title m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]'
export const sheetDescriptionClassName =
  'vds-sheet__description m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'
export const sheetCloseClassName =
  'vds-sheet__close inline-flex min-h-[var(--vds-control-height-md)] items-center justify-center rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-control-border)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-3)] py-0 text-[var(--vds-text-primary)] cursor-pointer hover:bg-[var(--vds-surface-hover)] focus-visible:shadow-[var(--vds-focus-ring)]'
export const popoverContentClassName = cx('vds-popover', POPOVER_CLASS_NAME)
export const hoverCardContentClassName = cx(
  'vds-hover-card',
  HOVER_CARD_CLASS_NAME
)
export const tooltipTriggerClassName =
  'vds-tooltip__trigger border-0 bg-transparent p-0 [font:inherit] text-inherit'
export const tooltipContentClassName =
  'vds-tooltip__content absolute z-[var(--vds-tooltip-z-index)] grid [width:max-content] [max-width:min(var(--vds-tooltip-max-width),calc(100vw_-_var(--vds-space-6)))] [max-height:var(--vds-tooltip-max-height)] overflow-y-auto overscroll-contain [gap:var(--vds-space-1)] [padding:6px_10px] [border-radius:var(--vds-tooltip-radius)] [background:var(--vds-tooltip-bg)] ![color:var(--vds-tooltip-color)] [box-shadow:var(--vds-tooltip-shadow)] [font-size:var(--vds-font-body-lv1)] [line-height:var(--vds-lh-body-lv1)] [overflow-wrap:anywhere] animate-[vds-tooltip-in_120ms_ease-out_both] [&_p]:m-0 [&_p]:![color:inherit]'
export const tooltipContentSideClassNames: Record<TooltipSide, string> = {
  top: 'vds-tooltip__content--top [inset-block-end:calc(100%+var(--vds-tooltip-offset))] [inset-inline-start:50%] -translate-x-1/2',
  right:
    'vds-tooltip__content--right [inset-block-start:50%] [inset-inline-start:calc(100%+var(--vds-tooltip-offset))] -translate-y-1/2',
  bottom:
    'vds-tooltip__content--bottom [inset-block-start:calc(100%+var(--vds-tooltip-offset))] [inset-inline-start:50%] -translate-x-1/2',
  left: 'vds-tooltip__content--left [inset-block-start:50%] [inset-inline-end:calc(100%+var(--vds-tooltip-offset))] -translate-y-1/2'
}
export const loadingOverlayContentClassName =
  'vds-loading-overlay__content inline-flex min-h-[var(--vds-control-height-lg)] items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] shadow-[var(--vds-shadow-1-center)]'
export const loadingOverlayLabelClassName =
  'vds-loading-overlay__label text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]'

function range(start: number, end: number): number[] {
  if (end < start) {
    return []
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

export function getPaginationItems(
  page: number,
  pageCount: number,
  fullPageLimit = PAGINATION_FULL_PAGE_LIMIT
): PaginationItem[] {
  const safePage = Math.min(Math.max(page, 1), Math.max(pageCount, 1))
  if (pageCount <= fullPageLimit) {
    return range(1, pageCount)
  }

  if (fullPageLimit < PAGINATION_FULL_PAGE_LIMIT) {
    const siblingCount = Math.max(0, Math.min(PAGINATION_SIBLING_ITEM_COUNT, Math.floor((fullPageLimit - PAGINATION_ANCHOR_ITEM_COUNT) / 2)))
    const firstInteriorPage = PAGINATION_EDGE_ITEM_COUNT + 1
    const lastInteriorPage = pageCount - PAGINATION_EDGE_ITEM_COUNT
    const interiorPage = Math.min(Math.max(safePage, firstInteriorPage), lastInteriorPage)
    const firstVisiblePage = Math.max(firstInteriorPage, interiorPage - siblingCount)
    const lastVisiblePage = Math.min(lastInteriorPage, interiorPage + siblingCount)
    return [
      1,
      ...(firstVisiblePage > firstInteriorPage ? ['ellipsis-left' as const] : []),
      ...range(firstVisiblePage, lastVisiblePage),
      ...(lastVisiblePage < lastInteriorPage ? ['ellipsis-right' as const] : []),
      pageCount
    ]
  }

  const leftSibling = Math.max(
    safePage - PAGINATION_SIBLING_ITEM_COUNT,
    PAGINATION_EDGE_ITEM_COUNT + 2
  )
  const rightSibling = Math.min(
    safePage + PAGINATION_SIBLING_ITEM_COUNT,
    pageCount - PAGINATION_EDGE_ITEM_COUNT - 1
  )
  const showLeftEllipsis = leftSibling > PAGINATION_EDGE_ITEM_COUNT + 2
  const showRightEllipsis =
    rightSibling < pageCount - PAGINATION_EDGE_ITEM_COUNT - 1

  return [
    ...range(1, PAGINATION_EDGE_ITEM_COUNT),
    showLeftEllipsis ? 'ellipsis-left' : PAGINATION_EDGE_ITEM_COUNT + 1,
    ...range(leftSibling, rightSibling),
    showRightEllipsis
      ? 'ellipsis-right'
      : pageCount - PAGINATION_EDGE_ITEM_COUNT,
    ...range(pageCount - PAGINATION_EDGE_ITEM_COUNT + 1, pageCount)
  ]
}

export function controlDisabled(
  disabled: boolean | undefined,
  loading: boolean
): boolean {
  return disabled === true || loading
}
