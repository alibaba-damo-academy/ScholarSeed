import { useTranslation } from 'react-i18next'
import { ChevronDown, File, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  DragEvent,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react'

import { BadgeDot } from './Badge'
import { ContextMenu, ContextMenuTrigger } from './ContextMenu'
import { EllipsisText } from './EllipsisText'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu'
import { IconButton } from './IconButton'
import { Tooltip } from './Tooltip'
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

export interface NavigationTabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  appearance?: 'document' | 'underline'
  defaultIcon?: ReactNode
  getTabProps?: (tab: NavigationTabItem) => NavigationTabElementProps
  overviewIcon?: ReactNode
  overviewLabel?: string
  overviewValue?: string
  showOverview?: boolean
  onClose?: (id: string) => void
  onOverflowChange?: (overflowing: boolean) => void
  onContextMenuOpen?: (id: string) => void
  onReorder?: (ids: string[], movedId: string) => void
  onValueChange?: (value: string) => void
  renderContextMenu?: (tab: NavigationTabItem) => ReactNode
  tabs?: readonly NavigationTabItem[]
  trailing?: ReactNode
  value?: string
}

export interface NavigationTabCloseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string
}

const DEFAULT_OVERVIEW_VALUE = 'overview'
const DOCUMENT_TAB_LABEL_MIN_WIDTH = 80
const NAVIGATION_TAB_MIME = 'application/x-scholarseed-navigation-tab'

const navigationTabsRootClassName =
  'vds-navigation-tabs relative flex h-[var(--vds-workbench-header-height)] w-full min-w-0 items-end overflow-x-auto overflow-y-hidden pt-[6px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

const navigationTabsSeamClassName =
  '[background:linear-gradient(to_bottom,transparent_calc(100%_-_var(--vds-navigation-tab-outline-width)),var(--vds-divider-default)_0),var(--vds-bg-gray-default)]'

const navigationTabsTrackClassName =
  'relative z-[var(--vds-z-local-raised)] flex w-full shrink-0 items-end pr-[calc(var(--vds-navigation-tab-foot-size)+var(--vds-navigation-tab-separator-gap)+var(--vds-navigation-tab-outline-width)*2)]'

const navigationTabsMeasureClassName =
  'pointer-events-none invisible fixed left-[-10000px] top-[-10000px] flex h-12 w-max items-end overflow-hidden pt-[6px]'

const navigationTabClassName =
  'no-drag group relative mb-[6px] inline-flex h-9 items-center gap-[var(--vds-space-2)] border border-transparent px-[var(--vds-space-2)] py-2 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-5 tracking-normal text-[var(--vds-icon-fill-default)] outline-none transition-colors data-[state=inactive]:hover:rounded-[var(--vds-navigation-tab-radius)] data-[state=inactive]:hover:bg-[var(--vds-bg-gray-hover)] data-[state=inactive]:hover:text-[var(--vds-text-secondary)] focus-visible:z-[var(--vds-z-elevated)] focus-visible:shadow-[var(--vds-focus-brand)] data-[state=active]:z-[var(--vds-z-elevated)] data-[state=active]:mb-0 data-[state=active]:h-[42px] data-[state=active]:rounded-t-[var(--vds-navigation-tab-radius)] data-[state=active]:bg-[var(--vds-bg-gray-default)] data-[state=active]:text-[var(--vds-text-primary)]'

const navigationTabOutlineClassName =
  'pointer-events-none absolute -inset-x-[var(--vds-navigation-tab-outline-width)] -top-[var(--vds-navigation-tab-outline-width)] bottom-[var(--vds-navigation-tab-radius)] rounded-t-[var(--vds-navigation-tab-radius)] border-[length:var(--vds-navigation-tab-outline-width)] border-b-0 border-[var(--vds-divider-default)]'

const navigationTabFootClassName =
  'pointer-events-none absolute -bottom-[var(--vds-navigation-tab-outline-width)] size-[var(--vds-navigation-tab-foot-size)] border-b-[length:var(--vds-navigation-tab-outline-width)] border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] [clip-path:inset(0)]'

const navigationTabLeftFootClassName =
  '-left-[var(--vds-navigation-tab-foot-size)] rounded-br-[var(--vds-navigation-tab-radius)] border-r-[length:var(--vds-navigation-tab-outline-width)] [box-shadow:var(--vds-navigation-tab-radius)_var(--vds-navigation-tab-radius)_0_var(--vds-navigation-tab-radius)_var(--vds-bg-gray-default)]'

const navigationTabRightFootClassName =
  '-right-[var(--vds-navigation-tab-foot-size)] rounded-bl-[var(--vds-navigation-tab-radius)] border-l-[length:var(--vds-navigation-tab-outline-width)] [box-shadow:calc(-1_*_var(--vds-navigation-tab-radius))_var(--vds-navigation-tab-radius)_0_var(--vds-navigation-tab-radius)_var(--vds-bg-gray-default)]'

const overviewTabClassName = 'shrink-0 justify-start'

const documentTabClassName = 'justify-start'

const navigationTabIconClassName =
  'relative flex h-4 w-4 shrink-0 items-center justify-center text-base leading-none text-current [&_svg]:!text-current group-data-[state=active]:-translate-y-[3px]'

const navigationTabLabelClassName =
  'relative block min-w-0 truncate group-data-[state=active]:-translate-y-[3px]'

const navigationTabDirtyClassName = 'relative group-data-[state=active]:-translate-y-[3px]'

const navigationTabCloseClassName =
  'no-drag flex size-[var(--vds-navigation-tab-close-size)] shrink-0 items-center justify-center rounded-[var(--vds-radius-4)] border-0 bg-transparent p-0 text-[14px] leading-none text-current opacity-80 outline-none group-data-[state=active]:-translate-y-[3px] hover:bg-[var(--vds-bg-white-hover-transparent)] hover:opacity-100 focus-visible:shadow-[var(--vds-focus-brand)]'

const navigationTabDividerClassName =
  'pointer-events-none absolute right-[calc(-1*(var(--vds-navigation-tab-separator-gap)+var(--vds-navigation-tab-outline-width)*2))] top-1/2 h-5 w-[var(--vds-navigation-tab-outline-width)] -translate-y-1/2 bg-[var(--vds-divider-default)]'

const navigationTabActiveMaskClassName =
  'pointer-events-none absolute -bottom-[var(--vds-navigation-tab-outline-width)] -inset-x-[var(--vds-navigation-tab-outline-width)] h-[var(--vds-navigation-tab-outline-width)] bg-[var(--vds-bg-gray-default)]'

export function NavigationTabs({
  appearance = 'document',
  className,
  defaultIcon,
  getTabProps,
  overviewIcon,
  overviewLabel: providedOverviewLabel,
  overviewValue = DEFAULT_OVERVIEW_VALUE,
  showOverview = true,
  onClose,
  onOverflowChange,
  onContextMenuOpen,
  onReorder,
  onValueChange,
  renderContextMenu,
  style,
  tabs = [],
  trailing,
  value = overviewValue,
  ...props
}: NavigationTabsProps): JSX.Element {
  const { t } = useTranslation('ui')
  const overviewLabel = providedOverviewLabel ?? t('navigation.overview')
  const hasTrailing = Boolean(trailing)
  const rootRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const lastRevealedTabRef = useRef<HTMLDivElement | null>(null)
  const [compressed, setCompressed] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [iconOnly, setIconOnly] = useState(false)
  const [compact, setCompact] = useState(false)
  const [contextMenuOpenTabId, setContextMenuOpenTabId] = useState<string | null>(null)
  const draggingTabRef = useRef<string | null>(null)
  const [insertionTarget, setInsertionTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)

  const finishDrag = (): void => {
    draggingTabRef.current = null
    setInsertionTarget(null)
  }

  useEffect(() => {
    if (
      !onReorder ||
      (draggingTabRef.current && !tabs.some((tab) => tab.id === draggingTabRef.current))
    ) {
      finishDrag()
    }
  }, [onReorder, tabs])

  const reorderTabProps = (tab: NavigationTabItem): NavigationTabElementProps => {
    const supplied = getTabProps?.(tab)
    if (!onReorder) return supplied ?? {}
    const disabled =
      supplied?.draggable === false ||
      supplied?.['aria-disabled'] === true ||
      supplied?.['aria-disabled'] === 'true'
    const positionAt = (event: DragEvent<HTMLDivElement>): 'before' | 'after' => {
      const bounds = event.currentTarget.getBoundingClientRect()
      return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    }
    return {
      ...supplied,
      draggable: !disabled,
      onDragStart: (event) => {
        if (disabled || (event.target as HTMLElement).closest('button')) {
          event.preventDefault()
          return
        }
        supplied?.onDragStart?.(event)
        if (event.defaultPrevented) return
        draggingTabRef.current = tab.id
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(NAVIGATION_TAB_MIME, tab.id)
      },
      onDragEnd: (event) => {
        supplied?.onDragEnd?.(event)
        finishDrag()
      },
      onDragOver: (event) => {
        supplied?.onDragOver?.(event)
        if (disabled || !draggingTabRef.current || draggingTabRef.current === tab.id) {
          setInsertionTarget(null)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setInsertionTarget({ id: tab.id, position: positionAt(event) })
      },
      onDragLeave: (event) => {
        supplied?.onDragLeave?.(event)
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setInsertionTarget((current) => (current?.id === tab.id ? null : current))
      },
      onDrop: (event) => {
        const sourceId = draggingTabRef.current
        supplied?.onDrop?.(event)
        if (
          disabled ||
          !sourceId ||
          sourceId === tab.id ||
          !tabs.some((item) => item.id === sourceId)
        ) {
          finishDrag()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const ids = tabs.map((item) => item.id).filter((id) => id !== sourceId)
        ids.splice(ids.indexOf(tab.id) + (positionAt(event) === 'after' ? 1 : 0), 0, sourceId)
        finishDrag()
        if (ids.some((id, index) => id !== tabs[index]?.id)) onReorder(ids, sourceId)
      },
    }
  }

  const rootStyle = style

  useLayoutEffect(() => {
    const root = rootRef.current
    const measure = measureRef.current

    if (!root || !measure) {
      return
    }

    const updateCompressedState = (): void => {
      setCompressed(measure.scrollWidth > root.clientWidth)
      const minimumTabsWidth = [...measure.querySelectorAll('[role="tab"]')].reduce(
        (width, tab, index) => {
          const slot = tab.closest<HTMLElement>('[data-slot="navigation-tab-slot"]')!
          const slotStyle = getComputedStyle(slot)
          const minimum =
            showOverview && index === 0
              ? slot.getBoundingClientRect().width
              : Number.parseFloat(slotStyle.minWidth)
          return (
            width +
            minimum +
            Number.parseFloat(slotStyle.marginLeft) +
            Number.parseFloat(slotStyle.marginRight)
          )
        },
        0
      )
      const rootPadding = getComputedStyle(root)
      const track = getComputedStyle(root.lastElementChild!)
      const available =
        root.clientWidth -
        Number.parseFloat(rootPadding.paddingLeft) -
        Number.parseFloat(rootPadding.paddingRight)
      setOverflowing(
        tabs.length > 0 && minimumTabsWidth + Number.parseFloat(track.paddingRight) > available
      )
      setIconOnly(
        tabs.length > 0 && minimumTabsWidth + Number.parseFloat(track.paddingRight) >= available
      )
      setCompact(tabs.length > 0 && root.clientWidth / tabs.length < DOCUMENT_TAB_LABEL_MIN_WIDTH)
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
  }, [compressed, hasTrailing, overflowing, overviewLabel, showOverview, tabs])

  useEffect(() => {
    onOverflowChange?.(overflowing)
    return () => onOverflowChange?.(false)
  }, [onOverflowChange, overflowing])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const wheel = (event: WheelEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || root.scrollWidth <= root.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? root.clientWidth
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? Number.parseFloat(getComputedStyle(root).lineHeight) || root.clientHeight
            : 1
      const previous = root.scrollLeft
      root.scrollLeft += delta * scale
      if (root.scrollLeft !== previous) event.preventDefault()
    }
    root.addEventListener('wheel', wheel, { passive: false })
    return () => {
      root.removeEventListener('wheel', wheel)
    }
  }, [hasTrailing, overflowing])

  useLayoutEffect(() => {
    const root = rootRef.current
    const activeTab =
      root?.querySelector<HTMLDivElement>('[role="tab"][aria-selected="true"]') ?? null
    if (activeTab === lastRevealedTabRef.current) return
    lastRevealedTabRef.current = activeTab
    if (!root || !activeTab) return
    // The curved outline extends beyond the tab's hit box and must be revealed too.
    const bounds = [
      activeTab,
      ...activeTab.querySelectorAll<HTMLElement>(
        '[data-slot="navigation-tab-surface"], [data-slot="navigation-tab-left-foot"], [data-slot="navigation-tab-right-foot"]'
      ),
    ].map((element) => element.getBoundingClientRect())
    const viewport = root.getBoundingClientRect()
    const left = Math.min(...bounds.map((box) => box.left))
    const right = Math.max(...bounds.map((box) => box.right))
    const delta =
      right > viewport.right
        ? right - viewport.right
        : left < viewport.left
          ? left - viewport.left
          : 0
    if (delta) {
      root.scrollBy({
        left: delta,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
    }
  })

  useEffect(() => {
    if (contextMenuOpenTabId && !tabs.some((tab) => tab.id === contextMenuOpenTabId)) {
      setContextMenuOpenTabId(null)
    }
  }, [contextMenuOpenTabId, tabs])

  const tablist = (
    <div
      ref={rootRef}
      className={cx(
        navigationTabsRootClassName,
        navigationTabsSeamClassName,
        appearance === 'underline' &&
          'bg-[var(--vds-surface-muted)] [&_[role=tab]]:!mb-0 [&_[role=tab]]:!h-[var(--vds-workbench-header-height)] [&_[role=tab]]:!rounded-b-none [&_[role=tab]>span[aria-hidden=true]]:hidden [&_[role=tab][data-state=active]]:!bg-[var(--vds-surface-active)] [&_[role=tab][data-state=active]]:shadow-[var(--vds-library-tab-shadow)] [&_[role=tab]>*]:!translate-y-0',
        trailing && !compressed ? '!w-fit' : null,
        contextMenuOpenTabId || overflowing ? 'no-drag' : 'drag',
        className
      )}
      role="tablist"
      style={rootStyle}
      {...props}
    >
      <div ref={measureRef} aria-hidden="true" className={navigationTabsMeasureClassName}>
        {showOverview ? (
          <NavigationTabButton
            active={false}
            curvedActive={appearance === 'document' && value === overviewValue}
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
            curvedActive={appearance === 'document' && value === tab.id}
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
            curvedActive={appearance === 'document' && value === overviewValue}
            hideDivider={tabs.length === 0 || value === overviewValue || value === tabs[0]?.id}
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
            curvedActive={appearance === 'document' && value === tab.id}
            compressed={compressed}
            compact={compact}
            iconOnly={iconOnly}
            closable={tab.closable}
            dirty={tab.dirty}
            hideDivider={
              index === tabs.length - 1 || value === tab.id || value === tabs[index + 1]?.id
            }
            icon={tab.icon ?? defaultIcon}
            key={tab.id}
            label={tab.label}
            onClick={() => onValueChange?.(tab.id)}
            onClose={onClose}
            onContextMenuOpen={onContextMenuOpen}
            contextMenuOpen={contextMenuOpenTabId === tab.id}
            onContextMenuOpenChange={(open) =>
              setContextMenuOpenTabId((current) =>
                open ? tab.id : current === tab.id ? null : current
              )
            }
            contextMenu={renderContextMenu?.(tab)}
            elementProps={reorderTabProps(tab)}
            dropIndicator={
              insertionTarget?.id === tab.id ? insertionTarget.position : tab.dropIndicator
            }
            value={tab.id}
            variant="document"
            first={!showOverview && index === 0}
          />
        ))}
      </div>
    </div>
  )
  const overflowMenu =
    overflowing && !onOverflowChange ? (
      <NavigationTabsMenu tabs={tabs} value={value} onValueChange={onValueChange} />
    ) : null
  return (
    <div
      className={cx(
        'vds-navigation-tabs__bar flex w-full min-w-0 items-end',
        navigationTabsSeamClassName
      )}
    >
      {tablist}
      <div className="flex shrink-0 items-center self-stretch">{trailing}</div>
      {overflowMenu}
    </div>
  )
}

interface NavigationTabButtonProps {
  active: boolean
  curvedActive: boolean
  compressed?: boolean
  compact?: boolean
  iconOnly?: boolean
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
  curvedActive,
  compressed = false,
  compact = false,
  iconOnly = false,
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
  variant,
}: NavigationTabButtonProps): JSX.Element {
  const { t } = useTranslation('ui')
  const activatedOnPress = useRef(false)
  const showClose = variant === 'document' && onClose && closable && (!compressed || active)
  const handleClose = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onClose?.(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    onClick()
  }

  const tabStyle =
    compressed && variant === 'document'
      ? ({
          flex: '1 1 var(--vds-navigation-tab-min-width)',
          maxWidth: 'var(--vds-navigation-tab-max-width)',
          minWidth: 'var(--vds-navigation-tab-min-width)',
        } as CSSProperties)
      : ({
          flex: variant === 'document' ? '0 1 var(--vds-navigation-tab-max-width)' : '0 1 auto',
          width: variant === 'document' ? 'var(--vds-navigation-tab-max-width)' : undefined,
          minWidth: variant === 'document' ? 'var(--vds-navigation-tab-min-width)' : undefined,
          maxWidth: 'var(--vds-navigation-tab-max-width)',
        } as CSSProperties)

  const tabContent = (
    <div
      {...elementProps}
      aria-selected={active}
      aria-label={label}
      className={cx(
        navigationTabClassName,
        'group/navigation-tab',
        active && variant === 'document' && '!px-[var(--vds-space-1)]',
        variant === 'overview' ? overviewTabClassName : documentTabClassName,
        'w-full',
        elementProps?.className
      )}
      data-state={active ? 'active' : 'inactive'}
      data-first={first ? 'true' : undefined}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        activatedOnPress.current = false
        elementProps?.onPointerDown?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          !event.isPrimary ||
          event.pointerType !== 'mouse' ||
          (event.target as HTMLElement).closest('button') ||
          elementProps?.['aria-disabled'] === true ||
          elementProps?.['aria-disabled'] === 'true'
        )
          return
        activatedOnPress.current = true
        onClick()
      }}
      onClick={(event) => {
        if (!activatedOnPress.current || event.detail === 0) onClick()
        activatedOnPress.current = false
      }}
      role="tab"
      tabIndex={active ? 0 : -1}
    >
      {active ? (
        <span
          aria-hidden
          className={cx(
            'pointer-events-none absolute inset-y-0 rounded-t-[var(--vds-navigation-tab-radius)] bg-[var(--vds-bg-gray-default)]',
            curvedActive
              ? '-inset-x-[calc(var(--vds-navigation-tab-separator-gap)+var(--vds-navigation-tab-outline-width)*2)]'
              : 'inset-x-0'
          )}
          data-slot="navigation-tab-surface"
        >
          <span className={navigationTabActiveMaskClassName} />
          <span className={navigationTabOutlineClassName} />
          <span
            className={cx(navigationTabFootClassName, navigationTabLeftFootClassName)}
            data-slot="navigation-tab-left-foot"
          />
          <span
            className={cx(navigationTabFootClassName, navigationTabRightFootClassName)}
            data-slot="navigation-tab-right-foot"
          />
        </span>
      ) : null}
      {variant === 'document' && ((onClose && closable) || iconOnly) ? (
        <span
          className={cx(
            navigationTabIconClassName,
            iconOnly && showClose && 'invisible',
            compact && showClose && !iconOnly && '!hidden'
          )}
        >
          {icon ?? <File aria-hidden className="size-full" />}
        </span>
      ) : icon ? (
        <span className={navigationTabIconClassName}>{icon}</span>
      ) : null}
      <EllipsisText
        className={cx(
          navigationTabLabelClassName,
          'w-full',
          showClose &&
            !iconOnly &&
            '!text-clip [mask-image:linear-gradient(to_right,var(--vds-text-primary)_calc(100%_-_var(--vds-navigation-tab-close-size)_-_var(--vds-space-4)_+_var(--vds-space-half)),transparent_calc(100%_-_var(--vds-navigation-tab-close-size)_+_var(--vds-space-half)))]'
        )}
        wrapperClassName={iconOnly ? '!hidden' : 'min-w-0 flex-1'}
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
          className={cx(
            navigationTabDirtyClassName,
            iconOnly && '!absolute right-0 top-[var(--vds-space-1)]',
            showClose &&
              !iconOnly &&
              '-translate-x-[calc(var(--vds-navigation-tab-close-size)+var(--vds-space-2))]'
          )}
          data-slot="navigation-tab-dirty"
          role="img"
          title={t('navigationTabs.unsaved')}
        />
      ) : null}
      {showClose && (
        <span
          className={cx(
            'absolute top-1/2 -translate-y-1/2',
            active
              ? 'right-[var(--vds-space-half)]'
              : 'right-[calc(var(--vds-space-2)-var(--vds-space-half))]'
          )}
        >
          <NavigationTabClose label={label} onClick={handleClose} />
        </span>
      )}
      {!hideDivider && !active ? (
        <span
          aria-hidden
          className={navigationTabDividerClassName}
          data-slot="navigation-tab-divider"
        />
      ) : null}
      {dropIndicator ? (
        <span
          aria-hidden
          className={cx(
            'pointer-events-none absolute bottom-[var(--vds-space-1)] top-[var(--vds-space-1)] z-[var(--vds-z-local-top)] w-[var(--vds-border-width-2)] rounded-full bg-[var(--vds-brand-bg-default)]',
            dropIndicator === 'before' ? 'left-0' : 'right-0'
          )}
          data-slot="navigation-tab-drop-indicator"
        />
      ) : null}
    </div>
  )
  const tab = (
    <div
      data-slot="navigation-tab-slot"
      className="mx-[calc(var(--vds-navigation-tab-separator-gap)+var(--vds-navigation-tab-outline-width)/2)]"
      style={tabStyle}
    >
      <Tooltip content={label} disabled={!iconOnly} side="bottom" portalled className="!w-full">
        {tabContent}
      </Tooltip>
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

export function NavigationTabsMenu({
  tabs,
  value,
  onValueChange,
}: {
  tabs: readonly NavigationTabItem[]
  value?: string
  onValueChange?: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <DropdownMenu>
      <Tooltip content={t('navigationTabs.all')} side="bottom">
        <DropdownMenuTrigger asChild>
          <IconButton
            variant="ghostIcon"
            size="md"
            label={t('navigationTabs.all')}
            icon={<ChevronDown />}
            data-testid="navigation-tabs-overflow"
          />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        aria-label={t('navigationTabs.all')}
        className="w-[var(--vds-navigation-tab-max-width)] max-w-[var(--vds-popover-available-width)] max-h-[var(--vds-dialog-list-max-height)] overflow-y-auto !bg-[var(--vds-surface-raised)] !p-[var(--vds-space-2)]"
      >
        {tabs.map((tab) => (
          <DropdownMenuItem
            key={tab.id}
            aria-current={tab.id === value ? 'page' : undefined}
            className="!h-[var(--vds-control-height-md)] !gap-[var(--vds-space-2)] !text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)] aria-[current=page]:bg-[var(--vds-surface-hover)]"
            onClick={() => onValueChange?.(tab.id)}
          >
            <span className="flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center [&_svg]:size-full">
              {tab.icon ?? <File aria-hidden />}
            </span>
            <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
              {tab.label}
            </EllipsisText>
            {tab.dirty && <BadgeDot aria-label={t('navigationTabs.unsaved')} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      <X aria-hidden="true" className="size-[var(--vds-navigation-tab-close-icon-size)]" />
    </button>
  )
}
