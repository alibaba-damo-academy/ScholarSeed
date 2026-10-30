import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Funnel, Plus, RefreshCcw, Search } from 'lucide-react'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchBox,
  Tooltip,
  type ButtonProps,
} from '../ui'

export const LIBRARY_TABLE_HEADER_CLASS =
  '[&_th]:h-[var(--vds-library-header-height)] [&_th]:!py-0 [&_th]:bg-[var(--vds-library-header-background)] [&_th]:text-[var(--vds-text-tertiary)] [&_th]:font-[var(--vds-fw-regular)] [&_th_button]:!font-[var(--vds-fw-regular)] [&_td]:h-[var(--vds-library-row-height)] [&_td]:!py-0 [&_td]:text-[var(--vds-text-tertiary)] [&_td:first-child]:text-[var(--vds-text-primary)] [&_td]:font-[var(--vds-fw-regular)] [&_td_button]:!font-[var(--vds-fw-regular)] [&_td:first-child_button]:!text-[var(--vds-text-primary)] [&_thead_tr]:border-[var(--vds-divider-default)]'
export const LIBRARY_TABLE_CLASS = `${LIBRARY_TABLE_HEADER_CLASS} w-full table-fixed [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap [&_tbody_td:nth-child(n+2):nth-child(-n+4)]:!pl-[calc(var(--vds-table-cell-padding-x)+var(--vds-space-2)+var(--vds-border-width-1))] [&_th]:sticky [&_th]:top-0 [&_th]:z-[var(--vds-z-sticky-header)] [&_th:first-child]:w-[var(--vds-library-name-column)] [&_th:nth-child(2)]:w-[var(--vds-library-type-column)] [&_th:nth-child(3)]:w-[var(--vds-library-detail-column)] [&_th:nth-child(4)]:w-[var(--vds-library-detail-column)]`
export const LIBRARY_PAGE_CLASS =
  'flex h-full min-h-0 min-w-0 flex-col gap-[var(--vds-space-4)] p-[var(--vds-space-4)]'
export const LIBRARY_HEADER_ACTION_CLASS =
  '!h-[var(--vds-control-height-md)] !justify-start !gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-4)] !px-[var(--vds-space-2)] text-inherit [&_svg]:!size-[var(--vds-icon-7)]'

export const LibraryToolbarTarget = createContext<HTMLElement | null | undefined>(undefined)
export const LibrarySelectionChange = createContext<((selected: boolean) => void) | null>(null)

export const LibraryAction = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { label: string; collapsible?: boolean }
>(({ label, collapsible = true, className, ...props }, ref) => (
  <Tooltip content={label} disabled={!collapsible} portalled side="bottom">
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      icon={<Plus />}
      className={[
        'relative overflow-hidden',
        collapsible &&
          'group-data-[compact=true]/library-toolbar:aspect-square group-data-[compact=true]/library-toolbar:!px-0',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        data-library-action-label={collapsible ? '' : undefined}
        className={
          collapsible
            ? 'w-max group-data-[compact=true]/library-toolbar:absolute group-data-[compact=true]/library-toolbar:invisible'
            : undefined
        }
      >
        {label}
      </span>
      <ChevronDown
        data-library-action-chevron
        className={collapsible ? 'group-data-[compact=true]/library-toolbar:hidden' : undefined}
      />
    </Button>
  </Tooltip>
))

LibraryAction.displayName = 'LibraryAction'

export function LibraryToolbar({
  query,
  onQuery,
  placeholder,
  refreshing,
  onRefresh,
  leading,
  children,
  searchVisible = false,
  refreshAfterActions = false,
}: {
  query: string
  onQuery: (query: string) => void
  placeholder: string
  refreshing: boolean
  onRefresh: () => void
  leading?: React.ReactNode
  children?: React.ReactNode
  searchVisible?: boolean
  refreshAfterActions?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: ui } = useTranslation('ui')
  const [expanded, setExpanded] = useState(false)
  const [compact, setCompact] = useState(false)
  const [searchCompact, setSearchCompact] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchWidthRef = useRef<HTMLSpanElement>(null)
  const actionWidths = useRef(new WeakMap<HTMLElement, { width: number; labelWidth: number }>())
  const target = useContext(LibraryToolbarTarget)
  const projectToolbar = target !== undefined
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    const search = searchRef.current
    const searchWidth = searchWidthRef.current
    if (!target || !toolbar || !search || !searchWidth) return
    const controls = [...toolbar.children].filter((child) => child !== searchWidth)
    const labels = [...toolbar.querySelectorAll<HTMLElement>('[data-library-action-label]')]
    const group = toolbar.querySelector<HTMLElement>('[data-library-group]')
    const viewport = target.closest<HTMLElement>('[data-library-toolbar-viewport]') ?? target
    const siblings =
      viewport === target
        ? []
        : [...target.parentElement!.children].filter((element) => element !== target)
    const measure = (): void => {
      const gap = parseFloat(getComputedStyle(toolbar).columnGap) || 0
      const hiddenLabels = labels.reduce((width, label) => {
        const buttonWidth = label.parentElement!.getBoundingClientRect().width
        const labelWidth = label.getBoundingClientRect().width
        if (getComputedStyle(label).position !== 'absolute') {
          actionWidths.current.set(label, { width: buttonWidth, labelWidth })
          return width
        }
        const natural = actionWidths.current.get(label)
        return width + (natural ? natural.width + labelWidth - natural.labelWidth - buttonWidth : 0)
      }, 0)
      let groupExpansion = 0
      if (group) {
        const style = getComputedStyle(group)
        const labelWidth = group.querySelector('span')?.scrollWidth ?? 0
        const chevronWidth = group.querySelector('svg')?.getBoundingClientRect().width ?? 0
        const fullWidth = Math.min(
          parseFloat(style.getPropertyValue('--vds-library-paper-filter-width')),
          labelWidth +
            chevronWidth +
            (parseFloat(style.columnGap) || 0) +
            (parseFloat(style.paddingLeft) || 0) +
            (parseFloat(style.paddingRight) || 0) +
            (parseFloat(style.borderLeftWidth) || 0) +
            (parseFloat(style.borderRightWidth) || 0)
        )
        groupExpansion = fullWidth - group.getBoundingClientRect().width
      }
      const required =
        hiddenLabels +
        groupExpansion +
        controls.reduce(
          (width, control) =>
            width + (control === search ? searchWidth : control).getBoundingClientRect().width,
          gap * Math.max(0, controls.length - 1)
        )
      const parentGap = parseFloat(getComputedStyle(target.parentElement!).columnGap) || 0
      const viewportStyle = getComputedStyle(viewport)
      const available =
        viewport.clientWidth -
        (parseFloat(viewportStyle.paddingLeft) || 0) -
        (parseFloat(viewportStyle.paddingRight) || 0) -
        siblings.reduce(
          (width, element) => width + element.getBoundingClientRect().width + parentGap,
          0
        )
      const iconWidth =
        refreshRef.current?.getBoundingClientRect().width ?? search.getBoundingClientRect().width
      const requiredWithSearchIcon =
        required - searchWidth.getBoundingClientRect().width + iconWidth
      setSearchCompact(!searchVisible || required > available)
      setCompact(requiredWithSearchIcon > available)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [target, viewport, ...siblings, ...controls, ...labels, searchWidth]) {
      observer.observe(element)
    }
    measure()
    return () => observer.disconnect()
  }, [target, leading, children, searchVisible])
  useLayoutEffect(() => setExpanded(false), [searchCompact])
  const refreshAtEnd = projectToolbar || refreshAfterActions
  const refreshControl = (
    <IconButton
      ref={refreshRef}
      variant={projectToolbar ? 'ghost' : 'outline'}
      size="md"
      className={projectToolbar ? '!text-[var(--vds-icon-outline-default)]' : undefined}
      label={t('refreshLibrary')}
      title={projectToolbar ? undefined : t('refreshLibrary')}
      disabled={refreshing}
      loading={refreshing}
      icon={<RefreshCcw />}
      onClick={onRefresh}
    />
  )
  const refreshButton = projectToolbar ? (
    <Tooltip content={ui('refresh')} portalled side="bottom">
      {refreshControl}
    </Tooltip>
  ) : (
    refreshControl
  )
  const toolbar = (
    <div
      ref={toolbarRef}
      data-compact={compact}
      className={
        projectToolbar
          ? 'group/library-toolbar relative flex min-w-max flex-1 items-center justify-end gap-[var(--vds-space-2)] [&>*]:shrink-0'
          : 'flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-[var(--vds-space-2)]'
      }
    >
      {leading && (
        <div className={projectToolbar ? 'min-w-0 shrink-0' : 'mr-auto min-w-0'}>{leading}</div>
      )}
      {projectToolbar && (
        <span
          ref={searchWidthRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 h-0 w-[var(--vds-library-toolbar-search-width)]"
        />
      )}
      {projectToolbar ? (
        <div ref={searchRef}>
          {searchCompact ? (
            <Popover open={expanded} onOpenChange={setExpanded}>
              <PopoverTrigger asChild>
                <IconButton
                  variant={query ? 'secondary' : 'ghost'}
                  size="sm"
                  className="!text-[var(--vds-icon-outline-default)]"
                  label={placeholder}
                  icon={<Search />}
                />
              </PopoverTrigger>
              <PopoverContent align="end" aria-label={placeholder}>
                <SearchBox
                  containerClassName="w-[var(--vds-library-toolbar-search-width)]"
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={query}
                  onChange={(event) => onQuery(event.target.value)}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <SearchBox
              containerClassName="w-[var(--vds-library-toolbar-search-width)]"
              aria-label={placeholder}
              placeholder={placeholder}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
          )}
        </div>
      ) : searchVisible || expanded || query ? (
        <SearchBox
          autoFocus={!searchVisible}
          containerClassName={
            searchVisible
              ? 'min-w-0 flex-1 max-w-[var(--vds-library-output-search-width)]'
              : 'min-w-0 flex-1'
          }
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !query) setExpanded(false)
          }}
        />
      ) : (
        <IconButton
          variant="outline"
          className="!text-[var(--vds-icon-outline-default)]"
          label={placeholder}
          icon={<Search />}
          onClick={() => setExpanded(true)}
        />
      )}
      {!refreshAtEnd && refreshButton}
      {children}
      {projectToolbar && (
        <span
          aria-hidden="true"
          className="h-[var(--vds-space-4)] w-[var(--vds-border-width-1)] shrink-0 bg-[var(--vds-divider-default)]"
        />
      )}
      {refreshAtEnd && refreshButton}
    </div>
  )
  return target === null ? <></> : target ? createPortal(toolbar, target) : toolbar
}

export function LibraryFilter({
  label,
  value,
  options,
  onChange,
  includeAll = true,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  includeAll?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="md"
          className={`${LIBRARY_HEADER_ACTION_CLASS} max-w-full whitespace-nowrap`}
          aria-label={label}
          title={options.find((option) => option.value === value)?.label}
        >
          <span className="min-w-0 truncate">{label}</span>
          <Funnel
            className={
              value
                ? '!text-[var(--vds-brand-text-primary)]'
                : '!text-[var(--vds-icon-fill-default)]'
            }
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup>
          {includeAll && (
            <>
              <DropdownMenuRadioItem
                variant="select"
                checked={!value}
                onSelect={() => onChange('')}
              >
                {t('all')}
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
            </>
          )}
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              variant="select"
              checked={value === option.value}
              onSelect={() => onChange(option.value)}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
