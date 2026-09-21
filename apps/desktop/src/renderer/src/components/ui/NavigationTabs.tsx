import { useTranslation } from 'react-i18next'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode
} from 'react'

import { BadgeDot } from './Badge'
import { ContextMenu, ContextMenuTrigger } from './ContextMenu'
import { EllipsisText } from './EllipsisText'
import { cx } from './utils'

export interface NavigationTabItem {
  /** 有未保存修改时在页签上显示小红点。 */
  dirty?: boolean
  /** 是否允许关闭；未指定时默认允许。 */
  closable?: boolean
  icon?: ReactNode
  /** 拖拽排序时显示的插入位置。 */
  dropIndicator?: 'before' | 'after'
  id: string
  label: string
}

export type NavigationTabElementProps = HTMLAttributes<HTMLDivElement> &
  Partial<Record<`data-${string}`, string | undefined>>

export interface NavigationTabsProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange'
> {
  defaultIcon?: ReactNode
  getTabProps?: (tab: NavigationTabItem) => NavigationTabElementProps
  overviewIcon?: ReactNode
  overviewLabel?: string
  overviewValue?: string
  showOverview?: boolean
  onClose?: (id: string) => void
  onContextMenuOpen?: (id: string) => void
  onValueChange?: (value: string) => void
  renderContextMenu?: (tab: NavigationTabItem) => ReactNode
  tabs?: readonly NavigationTabItem[]
  value?: string
}

export interface NavigationTabCloseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string
}

const DEFAULT_OVERVIEW_VALUE = 'overview'
const DOCUMENT_TAB_MIN_WIDTH = 118
const DOCUMENT_TAB_MAX_WIDTH = 190

const navigationTabsRootClassName =
  'vds-navigation-tabs relative flex h-[var(--vds-workbench-header-height)] w-full min-w-0 items-end overflow-x-auto overflow-y-hidden pt-[6px] [background:linear-gradient(to_bottom,transparent_calc(100%_-_1px),var(--vds-border-default)_0),var(--vds-bg-gray-default)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

const navigationTabsTrackClassName =
  'relative z-[var(--vds-z-local-raised)] flex w-full shrink-0 items-end pr-[var(--vds-navigation-tab-foot-size)]'

const navigationTabsMeasureClassName =
  'pointer-events-none invisible fixed left-[-10000px] top-[-10000px] flex h-12 w-max items-end overflow-hidden pt-[6px]'

const navigationTabClassName =
  'no-drag group relative mb-[6px] inline-flex h-9 items-center gap-2 border border-transparent px-2 py-2 text-[14px] font-normal leading-5 tracking-normal text-[var(--vds-icon-fill-default)] outline-none transition-colors data-[state=inactive]:hover:rounded-[var(--vds-navigation-tab-radius)] data-[state=inactive]:hover:bg-[var(--vds-bg-gray-hover)] data-[state=inactive]:hover:text-[var(--vds-text-secondary)] focus-visible:z-[var(--vds-z-elevated)] focus-visible:shadow-[var(--vds-focus-brand)] data-[state=active]:z-[var(--vds-z-elevated)] data-[state=active]:mb-0 data-[state=active]:h-[42px] data-[state=active]:rounded-t-[var(--vds-navigation-tab-radius)] data-[state=active]:bg-[var(--vds-bg-gray-default)] data-[state=active]:text-[var(--vds-text-primary)]'

const navigationTabOutlineClassName =
  'pointer-events-none absolute -inset-x-[var(--vds-navigation-tab-outline-width)] -top-[var(--vds-navigation-tab-outline-width)] bottom-[var(--vds-navigation-tab-radius)] rounded-t-[var(--vds-navigation-tab-radius)] border-[length:var(--vds-navigation-tab-outline-width)] border-b-0 border-[var(--vds-border-default)]'

const navigationTabFootClassName =
  'pointer-events-none absolute -bottom-[var(--vds-navigation-tab-outline-width)] size-[var(--vds-navigation-tab-foot-size)] border-b-[length:var(--vds-navigation-tab-outline-width)] border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default)] [clip-path:inset(0)]'

const navigationTabLeftFootClassName =
  '-left-[var(--vds-navigation-tab-foot-size)] rounded-br-[var(--vds-navigation-tab-radius)] border-r-[length:var(--vds-navigation-tab-outline-width)] [box-shadow:var(--vds-navigation-tab-radius)_var(--vds-navigation-tab-radius)_0_var(--vds-navigation-tab-radius)_var(--vds-bg-gray-default)]'

const navigationTabRightFootClassName =
  '-right-[var(--vds-navigation-tab-foot-size)] rounded-bl-[var(--vds-navigation-tab-radius)] border-l-[length:var(--vds-navigation-tab-outline-width)] [box-shadow:calc(-1_*_var(--vds-navigation-tab-radius))_var(--vds-navigation-tab-radius)_0_var(--vds-navigation-tab-radius)_var(--vds-bg-gray-default)]'

const overviewTabClassName = 'shrink-0 justify-start'

const documentTabClassName = 'justify-start'

const navigationTabIconClassName =
  'flex h-4 w-4 shrink-0 items-center justify-center text-base leading-none text-current group-data-[state=active]:-translate-y-[3px]'

const navigationTabLabelClassName =
  'block min-w-0 truncate group-data-[state=active]:-translate-y-[3px]'

const navigationTabDirtyClassName =
  'group-data-[state=active]:-translate-y-[3px]'

const navigationTabCloseClassName =
  'no-drag flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--vds-radius-1)] border-0 bg-transparent p-0 text-[14px] leading-none text-current opacity-80 outline-none group-data-[state=active]:-translate-y-[3px] hover:bg-[var(--vds-bg-white-hover)] hover:opacity-100 focus-visible:shadow-[var(--vds-focus-brand)]'

const navigationTabDividerClassName =
  'pointer-events-none absolute right-0 top-1/2 h-5 w-px -translate-y-1/2 bg-[var(--vds-border-default)]'

const navigationTabActiveMaskClassName =
  'pointer-events-none absolute -bottom-[var(--vds-navigation-tab-outline-width)] -inset-x-[var(--vds-navigation-tab-outline-width)] h-[var(--vds-navigation-tab-outline-width)] bg-[var(--vds-bg-gray-default)]'

export function NavigationTabs({
  className,
  defaultIcon,
  getTabProps,
  overviewIcon,
  overviewLabel: providedOverviewLabel,
  overviewValue = DEFAULT_OVERVIEW_VALUE,
  showOverview = true,
  onClose,
  onContextMenuOpen,
  onValueChange,
  renderContextMenu,
  style,
  tabs = [],
  value = overviewValue,
  ...props
}: NavigationTabsProps): JSX.Element {
  const { t } = useTranslation('ui')
  const overviewLabel = providedOverviewLabel ?? t('navigation.overview')
  const rootRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const lastRevealedTabRef = useRef<HTMLDivElement | null>(null)
  const [compressed, setCompressed] = useState(false)
  const [contextMenuOpenTabId, setContextMenuOpenTabId] = useState<string | null>(null)

  const rootStyle = {
    '--vds-navigation-tab-max-width': `${DOCUMENT_TAB_MAX_WIDTH}px`,
    '--vds-navigation-tab-min-width': `${DOCUMENT_TAB_MIN_WIDTH}px`,
    ...style
  } as CSSProperties

  useLayoutEffect(() => {
    const root = rootRef.current
    const measure = measureRef.current

    if (!root || !measure) {
      return
    }

    const updateCompressedState = (): void => {
      setCompressed(measure.scrollWidth > root.clientWidth)
    }

    updateCompressedState()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(updateCompressedState)
    resizeObserver.observe(root)
    resizeObserver.observe(measure)

    return () => {
      resizeObserver.disconnect()
    }
  }, [overviewLabel, tabs])

  useLayoutEffect(() => {
    const activeTab = rootRef.current
      ?.querySelector<HTMLDivElement>('[role="tab"][aria-selected="true"]') ?? null
    if (activeTab === lastRevealedTabRef.current) return
    lastRevealedTabRef.current = activeTab
    activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  })

  useEffect(() => {
    if (contextMenuOpenTabId && !tabs.some((tab) => tab.id === contextMenuOpenTabId)) {
      setContextMenuOpenTabId(null)
    }
  }, [contextMenuOpenTabId, tabs])

  return (
    <div
      ref={rootRef}
      className={cx(navigationTabsRootClassName, contextMenuOpenTabId ? 'no-drag' : 'drag', className)}
      role="tablist"
      style={rootStyle}
      {...props}
    >
      <div
        ref={measureRef}
        aria-hidden="true"
        className={navigationTabsMeasureClassName}
      >
        {showOverview ? (
          <NavigationTabButton
            active={false}
            hideDivider
            icon={overviewIcon}
            label={overviewLabel}
            onClick={() => undefined}
            value={overviewValue}
            variant="overview"
            first
          />
        ) : null}
        {tabs.map((tab) => (
          <NavigationTabButton
            active={false}
            compressed={false}
            closable={tab.closable}
            dirty={tab.dirty}
            hideDivider
            icon={tab.icon ?? defaultIcon}
            key={tab.id}
            label={tab.label}
            onClick={() => undefined}
            onClose={onClose}
            value={tab.id}
            variant="document"
          />
        ))}
      </div>
      <div className={navigationTabsTrackClassName}>
        {showOverview ? (
          <NavigationTabButton
            active={value === overviewValue}
            hideDivider={
              tabs.length === 0 ||
              value === overviewValue ||
              value === tabs[0]?.id
            }
            icon={overviewIcon}
            label={overviewLabel}
            onClick={() => onValueChange?.(overviewValue)}
            value={overviewValue}
            variant="overview"
            first
          />
        ) : null}
        {tabs.map((tab, index) => (
          <NavigationTabButton
            active={value === tab.id}
            compressed={compressed}
            closable={tab.closable}
            dirty={tab.dirty}
            hideDivider={
              index === tabs.length - 1 ||
              value === tab.id ||
              value === tabs[index + 1]?.id
            }
            icon={tab.icon ?? defaultIcon}
            key={tab.id}
            label={tab.label}
            onClick={() => onValueChange?.(tab.id)}
            onClose={onClose}
            onContextMenuOpen={onContextMenuOpen}
            contextMenuOpen={contextMenuOpenTabId === tab.id}
            onContextMenuOpenChange={(open) => setContextMenuOpenTabId((current) => (
              open ? tab.id : current === tab.id ? null : current
            ))}
            contextMenu={renderContextMenu?.(tab)}
            elementProps={getTabProps?.(tab)}
            dropIndicator={tab.dropIndicator}
            value={tab.id}
            variant="document"
            first={!showOverview && index === 0}
          />
        ))}
      </div>
    </div>
  )
}

interface NavigationTabButtonProps {
  active: boolean
  compressed?: boolean
  closable?: boolean
  contextMenu?: ReactNode
  contextMenuOpen?: boolean
  dropIndicator?: NavigationTabItem['dropIndicator']
  elementProps?: NavigationTabElementProps
  dirty?: boolean
  first?: boolean
  hideDivider?: boolean
  icon?: ReactNode
  label: string
  onClick: () => void
  onClose?: (id: string) => void
  onContextMenuOpen?: (id: string) => void
  onContextMenuOpenChange?: (open: boolean) => void
  value: string
  variant: 'document' | 'overview'
}

function NavigationTabButton({
  active,
  compressed = false,
  closable = true,
  contextMenu,
  contextMenuOpen = false,
  dropIndicator,
  elementProps,
  dirty = false,
  first = false,
  hideDivider = false,
  icon,
  label,
  onClick,
  onClose,
  onContextMenuOpen,
  onContextMenuOpenChange,
  value,
  variant
}: NavigationTabButtonProps): JSX.Element {
  const { t } = useTranslation('ui')
  const handleClose = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onClose?.(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    onClick()
  }

  const tabStyle =
    compressed && !active
        ? ({
            flex: '1 1 var(--vds-navigation-tab-min-width)',
            maxWidth: 'var(--vds-navigation-tab-max-width)',
            minWidth: 'var(--vds-navigation-tab-min-width)',
            marginInlineStart: first ? 'var(--vds-space-2)' : undefined
          } as CSSProperties)
        : ({
            flex: '0 1 auto',
            maxWidth: 'var(--vds-navigation-tab-max-width)',
            marginInlineStart: first ? 'var(--vds-space-2)' : undefined
          } as CSSProperties)

  const tabContent = (
    <div
      {...elementProps}
      aria-selected={active}
      className={cx(
        navigationTabClassName,
        variant === 'overview' ? overviewTabClassName : documentTabClassName,
        'w-full',
        elementProps?.className
      )}
      data-state={active ? 'active' : 'inactive'}
      data-first={first ? 'true' : undefined}
      onKeyDown={handleKeyDown}
      onClick={onClick}
      role="tab"
      tabIndex={active ? 0 : -1}
    >
      {icon ? <span className={navigationTabIconClassName}>{icon}</span> : null}
      <EllipsisText
        className={navigationTabLabelClassName}
        tooltipAlign="start"
        tooltipOffset={10}
        tooltipPortalled
        tooltipSide="bottom"
      >
        {label}
      </EllipsisText>
      {dirty ? (
        <BadgeDot
          aria-label={t('navigationTabs.unsaved')}
          className={navigationTabDirtyClassName}
          data-slot="navigation-tab-dirty"
          role="img"
          title={t('navigationTabs.unsaved')}
        />
      ) : null}
      {variant === 'document' && onClose && closable ? (
        <NavigationTabClose label={label} onClick={handleClose} />
      ) : null}
      {!hideDivider && !active ? (
        <span
          aria-hidden
          className={navigationTabDividerClassName}
          data-slot="navigation-tab-divider"
        />
      ) : null}
      {active ? (
        <>
          <span aria-hidden className={navigationTabActiveMaskClassName} />
          <span aria-hidden className={navigationTabOutlineClassName} />
          <span aria-hidden className={cx(navigationTabFootClassName, navigationTabLeftFootClassName)} />
          <span aria-hidden className={cx(navigationTabFootClassName, navigationTabRightFootClassName)} />
        </>
      ) : null}
      {dropIndicator ? (
        <span
          aria-hidden
          className={cx(
            'pointer-events-none absolute bottom-1 top-1 z-20 w-0.5 rounded-full bg-[var(--vds-brand-bg-default)]',
            dropIndicator === 'before' ? 'left-0' : 'right-0'
          )}
          data-slot="navigation-tab-drop-indicator"
        />
      ) : null}
    </div>
  )
  const tab = (
    <div style={tabStyle}>
      {tabContent}
    </div>
  )

  if (!contextMenu) return tab
  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={onContextMenuOpenChange}>
      <ContextMenuTrigger
        asChild
        onPointerDown={(event) => {
          if (event.button === 2) onContextMenuOpen?.(value)
        }}
      >
        {tab}
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  )
}

export function NavigationTabClose({
  className,
  label,
  ...props
}: NavigationTabCloseProps): JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <button
      aria-label={label ? t('navigation.closeNamed', { label }) : t('navigation.close')}
      className={cx(navigationTabCloseClassName, className)}
      type="button"
      {...props}
    >
      ×
    </button>
  )
}
