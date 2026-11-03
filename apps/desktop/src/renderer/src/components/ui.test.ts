import assert from 'node:assert/strict'
import test from 'node:test'

import {
  alertClassName,
  accordionClassName,
  aspectRatioClassName,
  avatarClassName,
  badgeClassName,
  breadcrumbClassName,
  buttonClassName,
  buttonStyleClassName,
  cardClassName,
  checkboxClassName,
  collapsibleClassName,
  commandClassName,
  controlDisabled,
  copyButtonClassName,
  dividerClassName,
  emptyStateClassName,
  floatingToolbarClassName,
  getPaginationItems,
  iconButtonClassName,
  iconButtonStyleClassName,
  inputClassName,
  inputStyleClassName,
  selectStyleClassName,
  loadingOverlayClassName,
  menuContentClassName,
  menuItemClassName,
  menuItemDestructiveClassName,
  paginationClassName,
  paginationItemActiveClassName,
  paginationItemClassName,
  progressBarClassName,
  radioClassName,
  radioGroupClassName,
  resizableClassName,
  drawerClassName,
  selectClassName,
  sheetClassName,
  scrollAreaClassName,
  scrollAreaViewportClassName,
  semanticTagColor,
  semanticTagColorFor,
  semanticTagVariables,
  sliderClassName,
  spinnerClassName,
  switchClassName,
  tableClassName,
  tagVariants,
  tabsClassName,
  textareaClassName,
  tooltipClassName,
  toastClassName,
  toastStyleClassName,
  toggleClassName,
  toggleGroupClassName,
  inputOtpClassName,
} from './ui/classes.ts'
import { cxWithOverrides } from './ui/utils.ts'

test('tooltip class contract exposes side and state', () => {
  assert.equal(
    tooltipClassName({ className: 'hint', open: true, side: 'right' }),
    'vds-tooltip vds-tooltip--right vds-tooltip--open hint'
  )
  assert.equal(
    tooltipClassName({ disabled: true, open: false, side: 'bottom' }),
    'vds-tooltip vds-tooltip--bottom vds-tooltip--disabled'
  )
})

test('sheet and drawer class contracts expose side state', () => {
  assert.equal(
    sheetClassName({ className: 'panel', side: 'right' }),
    'vds-sheet vds-sheet--right panel'
  )
  assert.equal(sheetClassName({ side: 'bottom' }), 'vds-sheet vds-sheet--bottom')
  assert.equal(
    drawerClassName({ className: 'mobile', side: 'left' }),
    'vds-drawer vds-drawer--left mobile'
  )
  assert.equal(drawerClassName({ side: 'bottom' }), 'vds-drawer vds-drawer--bottom')
})

test('toast class contract exposes tone state and top-aligns its content', () => {
  assert.equal(
    toastClassName({ className: 'notice', tone: 'success' }),
    'vds-toast vds-toast--success notice'
  )
  assert.equal(toastClassName({ tone: 'error' }), 'vds-toast vds-toast--error')
  assert.match(toastStyleClassName(), /items-start/)
  assert.doesNotMatch(toastStyleClassName(), /items-center/)
})

test('caller utility classes override matching default layout groups', () => {
  assert.equal(
    cxWithOverrides('grid w-max max-w-[320px] gap-[var(--vds-space-2)] p-1', 'w-[188px] gap-0'),
    'grid max-w-[320px] p-1 w-[188px] gap-0'
  )
})

test('scroll viewport preserves inherited height constraints without overrides', () => {
  const classes = scrollAreaViewportClassName({}).split(/\s+/)
  assert.ok(classes.includes('max-h-[inherit]'))
  assert.ok(classes.includes('min-h-[inherit]'))
})

test('scroll viewport explicit maximum height replaces only the inherited maximum', () => {
  const classes = scrollAreaViewportClassName({ className: 'max-h-[40dvh] flex-1' }).split(/\s+/)
  assert.ok(classes.includes('max-h-[40dvh]'))
  assert.ok(classes.includes('min-h-[inherit]'))
  assert.ok(classes.includes('flex-1'))
  assert.ok(!classes.includes('max-h-[inherit]'))
})

test('scroll viewport explicit minimum height replaces only the inherited minimum', () => {
  const classes = scrollAreaViewportClassName({ className: 'min-h-0' }).split(/\s+/)
  assert.ok(classes.includes('max-h-[inherit]'))
  assert.ok(classes.includes('min-h-0'))
  assert.ok(!classes.includes('min-h-[inherit]'))
})

test('scroll viewport supports important height overrides and preserves orientation', () => {
  for (const className of ['!max-h-none !min-h-0', 'max-h-none! min-h-0!']) {
    const classes = scrollAreaViewportClassName({ className, orientation: 'horizontal' }).split(
      /\s+/
    )
    assert.ok(!classes.includes('max-h-[inherit]'))
    assert.ok(!classes.includes('min-h-[inherit]'))
    assert.ok(classes.includes('[overflow-x:auto]'))
    assert.ok(classes.includes('[overflow-y:hidden]'))
    for (const override of className.split(' ')) assert.ok(classes.includes(override))
  }
})

test('scroll viewport conditional height utilities do not remove unconditional defaults', () => {
  const classes = scrollAreaViewportClassName({ className: 'md:max-h-64 hover:min-h-0' }).split(
    /\s+/
  )
  assert.ok(classes.includes('max-h-[inherit]'))
  assert.ok(classes.includes('min-h-[inherit]'))
  assert.ok(classes.includes('md:max-h-64'))
  assert.ok(classes.includes('hover:min-h-0'))
})

test('menu content does not add item gap by default', () => {
  assert.doesNotMatch(menuContentClassName, /\bgap(?:-|\[|x-|y-)/)
})

test('menu items tint leading icons by item tone', () => {
  assert.match(menuItemClassName, /\[&>svg:first-child\]:size-\[var\(--vds-icon-8\)\]/)
  assert.match(menuItemClassName, /\[&>svg:first-child\]:text-\[var\(--vds-text-tertiary\)\]/)
  assert.match(menuItemClassName, /\[&>\.vds-icon:first-child\]:size-\[var\(--vds-icon-8\)\]/)
  assert.match(
    menuItemClassName,
    /\[&>\.vds-icon:first-child\]:text-\[var\(--vds-text-tertiary\)\]/
  )
  assert.match(menuItemClassName, /\[&>\.iconfont:first-child\]:size-\[var\(--vds-icon-8\)\]/)
  assert.match(
    menuItemClassName,
    /\[&>\.iconfont:first-child\]:text-\[length:var\(--vds-icon-8\)\]/
  )
  assert.match(
    menuItemClassName,
    /\[&>\.iconfont:first-child\]:text-\[var\(--vds-text-tertiary\)\]/
  )
  assert.match(menuItemDestructiveClassName, /\[&>svg:first-child\]:size-\[var\(--vds-icon-8\)\]/)
  assert.match(
    menuItemDestructiveClassName,
    /\[&>svg:first-child\]:text-\[var\(--vds-error-text-primary\)\]/
  )
})

test('command and resizable class contracts expose shell states', () => {
  assert.equal(
    commandClassName({ className: 'palette', disabled: true }),
    'vds-command vds-command--disabled palette'
  )
  assert.equal(commandClassName({}), 'vds-command')
  assert.equal(
    resizableClassName({ className: 'workspace', direction: 'vertical', disabled: true }),
    'vds-resizable vds-resizable--vertical vds-resizable--disabled workspace'
  )
  assert.equal(
    resizableClassName({ direction: 'horizontal' }),
    'vds-resizable vds-resizable--horizontal'
  )
})

test('slider and input otp class contracts expose interaction states', () => {
  assert.equal(
    sliderClassName({ className: 'volume', disabled: true, orientation: 'vertical' }),
    'vds-slider vds-slider--vertical vds-slider--disabled volume'
  )
  assert.equal(sliderClassName({ orientation: 'horizontal' }), 'vds-slider vds-slider--horizontal')
  assert.equal(
    inputOtpClassName({ className: 'code', invalid: true }),
    'vds-input-otp vds-input-otp--invalid code'
  )
  assert.equal(
    inputOtpClassName({ disabled: true, invalid: true }),
    'vds-input-otp vds-input-otp--invalid vds-input-otp--disabled'
  )
})

test('accordion, scroll area and toggle class contracts expose their states', () => {
  assert.equal(
    accordionClassName({ className: 'faq', mode: 'multiple' }),
    'vds-accordion vds-accordion--multiple faq'
  )
  assert.equal(
    scrollAreaClassName({ className: 'pane', orientation: 'both', shadow: true }),
    'vds-scroll-area vds-scroll-area--both vds-scroll-area--shadow pane'
  )
  assert.equal(
    toggleClassName({ className: 'filter', pressed: true, size: 'sm', variant: 'outline' }),
    'vds-toggle vds-toggle--outline vds-toggle--sm vds-toggle--pressed filter'
  )
  assert.equal(
    toggleGroupClassName({ className: 'segments', orientation: 'vertical' }),
    'vds-toggle-group vds-toggle-group--vertical segments'
  )
})

test('aspect, breadcrumb, collapsible and tabs class contracts expose their states', () => {
  assert.equal(aspectRatioClassName({ className: 'media' }), 'vds-aspect-ratio media')
  assert.equal(breadcrumbClassName({ className: 'trail' }), 'vds-breadcrumb trail')
  assert.equal(
    collapsibleClassName({ className: 'fold', open: true }),
    'vds-collapsible vds-collapsible--open fold'
  )
  assert.equal(collapsibleClassName({ open: false }), 'vds-collapsible')
  assert.equal(
    tabsClassName({ className: 'workspace', orientation: 'vertical' }),
    'vds-tabs vds-tabs--vertical workspace'
  )
})

test('empty, copy, overlay, table and pagination class contracts expose their states', () => {
  assert.equal(emptyStateClassName({ className: 'blank' }), 'vds-empty-state blank')
  assert.equal(
    copyButtonClassName({ status: 'success' }),
    'vds-copy-button vds-copy-button--success'
  )
  assert.equal(
    loadingOverlayClassName({ className: 'panel', tone: 'muted', visible: true }),
    'vds-loading-overlay vds-loading-overlay--muted vds-loading-overlay--visible panel'
  )
  assert.equal(
    tableClassName({ className: 'data', density: 'compact' }),
    'vds-table vds-table--compact data'
  )
  assert.equal(paginationClassName({ className: 'pager' }), 'vds-pagination pager')
  assert.match(
    paginationItemClassName,
    /aria-\[current=page\]:bg-\[var\(--vds-brand-bg-default\)\]/
  )
  assert.match(paginationItemActiveClassName, /text-\[var\(--vds-static-white\)\]/)
})

test('pagination item builder keeps edges, current siblings and ellipsis', () => {
  assert.deepEqual(getPaginationItems(1, 4, 4), [1, 2, 3, 4])
  assert.deepEqual(getPaginationItems(1, 5, 4), [1, 2, 'ellipsis-right', 5])
  assert.deepEqual(getPaginationItems(3, 5, 4), [1, 'ellipsis-left', 3, 'ellipsis-right', 5])
  assert.deepEqual(getPaginationItems(5, 5, 4), [1, 'ellipsis-left', 4, 5])
  assert.deepEqual(getPaginationItems(1, 5), [1, 2, 3, 4, 5])
  assert.deepEqual(getPaginationItems(6, 12), [1, 'ellipsis-left', 5, 6, 7, 'ellipsis-right', 12])
  assert.deepEqual(getPaginationItems(11, 12), [1, 'ellipsis-left', 10, 11, 12])
})

test('alert, avatar and progress class contracts expose their visual states', () => {
  assert.equal(
    alertClassName({ className: 'notice', tone: 'warning' }),
    'vds-alert vds-alert--warning notice'
  )
  assert.equal(avatarClassName({ size: 'lg' }), 'vds-ui-avatar vds-ui-avatar--lg')
  assert.equal(
    progressBarClassName({ className: 'task', indeterminate: true }),
    'vds-progress-bar vds-progress-bar--indeterminate task'
  )
})

test('button class contract includes variant, size and caller class', () => {
  assert.equal(
    buttonClassName({ className: 'extra', size: 'lg', variant: 'secondary' }),
    'vds-button vds-button--secondary vds-button--lg extra'
  )
  assert.equal(
    buttonClassName({ size: 'default', variant: 'default' }),
    'vds-button vds-button--primary vds-button--md'
  )
  assert.equal(
    buttonClassName({ variant: 'destructive' }),
    'vds-button vds-button--danger vds-button--md'
  )
  assert.equal(
    buttonClassName({ variant: 'dropzone' }),
    'vds-button vds-button--dropzone vds-button--md'
  )
  assert.equal(
    buttonClassName({ variant: 'outline' }),
    'vds-button vds-button--outline vds-button--md'
  )
  assert.equal(
    buttonClassName({ size: 'icon', variant: 'ghostIcon' }),
    'vds-button vds-button--ghostIcon vds-button--icon'
  )
  assert.equal(
    buttonClassName({ variant: 'warning' }),
    'vds-button vds-button--warning vds-button--md'
  )
  assert.match(buttonStyleClassName({}), /font-\[var\(--vds-fw-regular\)\]/)
  assert.match(buttonStyleClassName({ variant: 'dropzone' }), /\[border-style:dashed\]/)
  assert.match(buttonStyleClassName({ variant: 'dropzone' }), /data-\[drop-active=true\]/)
  assert.match(buttonStyleClassName({ size: 'md' }), /text-\[length:var\(--vds-font-body-lv2\)\]/)
  assert.match(buttonStyleClassName({ size: 'md' }), /\[&_svg\]:size-\[var\(--vds-icon-8\)\]/)
  assert.match(buttonStyleClassName({ size: 'sm' }), /text-\[length:var\(--vds-font-body-lv2\)\]/)
  assert.match(buttonStyleClassName({ size: 'sm' }), /\[&_svg\]:size-\[var\(--vds-icon-7\)\]/)
  assert.match(buttonStyleClassName({ size: 'xs' }), /h-\[var\(--vds-control-height-xs\)\]/)
  assert.match(buttonStyleClassName({ size: 'xs' }), /text-\[length:var\(--vds-font-body-lv1\)\]/)
  assert.match(buttonStyleClassName({ size: 'xs' }), /\[&_svg\]:size-\[var\(--vds-icon-6\)\]/)
})

test('loading controls are disabled through the shared contract', () => {
  assert.equal(controlDisabled(false, true), true)
  assert.equal(controlDisabled(true, false), true)
  assert.equal(controlDisabled(false, false), false)
  assert.equal(controlDisabled(undefined, false), false)
})

test('icon button class contract keeps stable square size class', () => {
  assert.equal(
    iconButtonClassName({ className: 'quiet', size: 'sm' }),
    'vds-icon-button vds-icon-button--sm quiet'
  )
  const className = iconButtonStyleClassName({ size: 'sm' })
  assert.match(className, /size-\[var\(--vds-control-height-sm\)\]/)
  assert.match(className, /p-0/)
  assert.match(className, /--vds-icon-button-glyph:var\(--vds-icon-7\)/)
  const extraSmallClassName = iconButtonStyleClassName({ size: 'xs' })
  assert.match(extraSmallClassName, /size-\[var\(--vds-control-height-xs\)\]/)
  assert.match(extraSmallClassName, /--vds-icon-button-glyph:var\(--vds-icon-6\)/)
})

test('small ghost icon buttons keep compact icon geometry', () => {
  const className = buttonStyleClassName({ size: 'sm', variant: 'ghostIcon' })
  assert.match(className, /size-\[var\(--vds-control-height-sm\)\]/)
  assert.match(className, /\[&_svg\]:size-\[var\(--vds-icon-7\)\]/)
  const extraSmallClassName = buttonStyleClassName({ size: 'xs', variant: 'ghostIcon' })
  assert.match(extraSmallClassName, /size-\[var\(--vds-control-height-xs\)\]/)
  assert.match(extraSmallClassName, /\[&_svg\]:size-\[var\(--vds-icon-6\)\]/)
  assert.match(className, /aria-pressed:\[background:var\(--vds-other-overlay-2\)\]/)
  assert.match(className, /aria-pressed:text-\[var\(--vds-text-primary\)\]/)
})

test('input class contract marks invalid state only when requested', () => {
  assert.equal(
    inputClassName({ className: 'field', invalid: true, size: 'md' }),
    'vds-input vds-input--md vds-input--invalid field'
  )
  assert.equal(inputClassName({ size: 'sm' }), 'vds-input vds-input--sm')
})

test('textarea class contract mirrors field invalid and size states', () => {
  assert.equal(
    textareaClassName({ className: 'field', invalid: true, size: 'lg' }),
    'vds-textarea vds-textarea--lg vds-textarea--invalid field'
  )
  assert.equal(textareaClassName({ size: 'sm' }), 'vds-textarea vds-textarea--sm')
})

test('badge and spinner class contracts expose tone and size', () => {
  assert.equal(
    badgeClassName({ className: 'state', size: 'sm', tone: 'success' }),
    'vds-badge vds-badge--success vds-badge--sm state'
  )
  assert.equal(badgeClassName({ tone: 'primary' }), 'vds-badge vds-badge--brand vds-badge--md')
  assert.equal(badgeClassName({ tone: 'error' }), 'vds-badge vds-badge--danger vds-badge--md')
  assert.equal(badgeClassName({ tone: 'destructive' }), 'vds-badge vds-badge--danger vds-badge--md')
  assert.equal(spinnerClassName({ size: 'lg' }), 'vds-spinner vds-spinner--lg')
})

test('tag variant contract maps badge-style tones to semantic colors', () => {
  assert.match(tagVariants(), /--vds-tag-background:var\(--vds-brand-light-bg-default\)/)
  assert.match(tagVariants(), /\[border-radius:6px\]/)
  assert.match(tagVariants(), /h-\[24px\]/)
  assert.match(tagVariants({ size: 'small' }), /\[border-radius:4px\]/)
  assert.match(tagVariants({ size: 'small' }), /h-\[20px\]/)
  assert.match(tagVariants({ size: 'small' }), /text-\[length:10px\]/)
  assert.match(tagVariants({ size: 'small' }), /leading-\[16px\]/)
  assert.match(tagVariants({ size: 'small' }), /\[padding:2px_6px\]/)
  assert.match(
    tagVariants({ variant: 'secondary' }),
    /--vds-tag-background:var\(--vds-bg-gray-default\)/
  )
  assert.match(tagVariants({ variant: 'outline' }), /--vds-tag-border:var\(--vds-border-default\)/)
  assert.match(
    tagVariants({ variant: 'destructive' }),
    /--vds-tag-background:var\(--vds-error-light-bg-default\)/
  )
  assert.match(
    tagVariants({ tone: 'success' }),
    /--vds-tag-background:var\(--vds-success-light-bg-default\)/
  )
  assert.match(
    tagVariants({ tone: 'warning' }),
    /--vds-tag-background:var\(--vds-warning-light-bg-default\)/
  )
  assert.match(
    tagVariants({ tone: 'danger' }),
    /--vds-tag-background:var\(--vds-error-light-bg-default\)/
  )
  // 选中态只挂状态钩子, 自身不画视觉: 对比由容器把未选中的 chip 压淡来表达。
  // chip 上任何尺寸/字重/描边变化都会让换行排布的标签云在点击瞬间重排跳位。
  assert.equal(tagVariants({ selected: true }), `${tagVariants()} vds-tag--selected`)
  assert.doesNotMatch(tagVariants({ selected: true }), /box-shadow|font-weight|border-width-2/)
  assert.doesNotMatch(tagVariants(), /vds-tag--selected/)
})

test('semantic tag colors validate persisted values and select from the shared palette', () => {
  assert.equal(semanticTagColor('notice'), 'notice')
  assert.equal(semanticTagColor('custom'), undefined)
  assert.equal(semanticTagColorFor('stable-id'), semanticTagColorFor('stable-id'))
  assert.ok(['brand', 'error', 'warning', 'notice'].includes(semanticTagColorFor('new-id')))
  assert.deepEqual(semanticTagVariables('notice'), {
    '--vds-tag-background': 'var(--vds-notice-light-bg-default)',
    '--vds-tag-border': 'var(--vds-notice-light-border)',
    '--vds-tag-color': 'var(--vds-notice-bg-active)',
    '--vds-tag-accent': 'var(--vds-notice-bg-active)',
    '--vds-tag-close-color': 'var(--vds-notice-bg-default)',
    '--vds-tag-close-hover-color': 'var(--vds-notice-bg-hover)',
  })
})

test('card and divider class contracts expose presentation variants', () => {
  assert.equal(
    cardClassName({ className: 'panel', padding: 'lg', variant: 'flat' }),
    'vds-card vds-card--flat vds-card--padding-lg panel'
  )
  assert.equal(
    dividerClassName({ className: 'split', orientation: 'vertical' }),
    'vds-divider vds-divider--vertical split'
  )
})

test('floating toolbar owns an opaque raised surface', () => {
  const className = floatingToolbarClassName({ className: 'selection-actions', expanded: true })

  assert.match(className, /vds-floating-toolbar--expanded/)
  assert.match(className, /bg-\[var\(--vds-surface-raised\)\]/)
  assert.match(className, /shadow-\[var\(--vds-shadow-2-center\)\]/)
  assert.match(className, /selection-actions/)
})

test('switch class contract reflects checked state', () => {
  assert.equal(switchClassName({ checked: false }), 'vds-switch')
  assert.equal(
    switchClassName({ checked: true, className: 'extra' }),
    'vds-switch vds-switch--checked extra'
  )
})

test('checkbox class contract reflects checked state', () => {
  assert.equal(checkboxClassName({ checked: false }), 'vds-checkbox')
  assert.equal(
    checkboxClassName({ checked: true, className: 'extra' }),
    'vds-checkbox vds-checkbox--checked extra'
  )
  assert.equal(checkboxClassName({ checked: 'mixed' }), 'vds-checkbox vds-checkbox--mixed')
})

test('radio class contract reflects checked state', () => {
  assert.equal(radioClassName({ checked: false }), 'vds-radio')
  assert.equal(
    radioClassName({ checked: true, className: 'extra' }),
    'vds-radio vds-radio--checked extra'
  )
  assert.equal(
    radioGroupClassName({ className: 'group', orientation: 'horizontal' }),
    'vds-radio-group vds-radio-group--horizontal group'
  )
})

test('select class contract mirrors field invalid and size states', () => {
  assert.equal(
    selectClassName({ className: 'field', invalid: true, size: 'lg' }),
    'vds-select vds-select--lg vds-select--invalid field'
  )
  assert.equal(selectClassName({ size: 'sm' }), 'vds-select vds-select--sm')
})

test('standard form sizing is opt-in and retains existing medium size contracts', () => {
  for (const styles of [
    buttonStyleClassName({ size: 'standard' }),
    inputStyleClassName({ size: 'standard' }),
    selectStyleClassName({ size: 'standard' }),
  ]) {
    assert.ok(styles.includes('--vds-control-height-standard'))
    assert.ok(styles.includes('--vds-control-label-line-height'))
  }
  assert.ok(buttonStyleClassName({ size: 'md' }).includes('--vds-control-height-md'))
  assert.ok(inputStyleClassName({ size: 'md' }).includes('--vds-control-height-md'))
  assert.ok(selectStyleClassName({ size: 'md' }).includes('--vds-control-height-standard'))
})
