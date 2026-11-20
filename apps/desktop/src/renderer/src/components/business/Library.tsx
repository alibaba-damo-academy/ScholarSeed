import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react'
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
  Spinner,
  LoadingFallback,
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
export const LibraryToolbarTrailing = createContext<React.ReactNode>(null)
export const LibrarySelectionChange = createContext<((selected: boolean) => void) | null>(null)

export function LibraryLoading(): React.JSX.Element {
  return (
    <LoadingFallback className="sticky left-0 min-h-[calc(100%-var(--vds-library-header-height))]" />
  )
}

export const LibraryAction = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { label: string; collapsible?: boolean; showChevron?: boolean }
>(
  (
    { label, collapsible = true, showChevron = true, icon = <Plus />, className, ...props },
    ref
  ) => (
    <Tooltip content={label} disabled={!collapsible} portalled side="bottom">
      <Button
        {...props}
        ref={ref}
        aria-label={label}
        icon={icon}
        className={[
          'relative overflow-hidden',
          collapsible &&
            'group-data-[compact=true]/library-toolbar:aspect-square group-data-[compact=true]/library-toolbar:!px-0 group-data-[search-open=true]/library-toolbar:aspect-square group-data-[search-open=true]/library-toolbar:!px-0',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span
          data-library-action-label={collapsible ? '' : undefined}
          className={
            collapsible
              ? 'w-max group-data-[compact=true]/library-toolbar:absolute group-data-[compact=true]/library-toolbar:invisible group-data-[search-open=true]/library-toolbar:absolute group-data-[search-open=true]/library-toolbar:invisible'
              : undefined
          }
        >
          {label}
        </span>
        {showChevron && (
          <ChevronDown
            data-library-action-chevron
            className={
              collapsible
                ? 'group-data-[compact=true]/library-toolbar:hidden group-data-[search-open=true]/library-toolbar:hidden'
                : undefined
            }
          />
        )}
      </Button>
    </Tooltip>
  )
)

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
  expandableSearch = false,
  refreshAfterActions = false,
}: {
  query: string
  onQuery: (query: string) => void
  placeholder: string
  refreshing?: boolean
  onRefresh?: () => void
  leading?: React.ReactNode
  children?: React.ReactNode
  searchVisible?: boolean
  expandableSearch?: boolean
  refreshAfterActions?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [expanded, setExpanded] = useState(false)
  const [compact, setCompact] = useState(false)
  const [searchCompact, setSearchCompact] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const restoreSearchFocus = useRef(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchWidthRef = useRef<HTMLSpanElement>(null)
  const actionWidths = useRef(new WeakMap<HTMLElement, { width: number; labelWidth: number }>())
  const target = useContext(LibraryToolbarTarget)
  const trailing = useContext(LibraryToolbarTrailing)
  const projectToolbar = target !== undefined
  const disclosureSearch = projectToolbar || expandableSearch
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    const search = searchRef.current
    const searchWidth = searchWidthRef.current
    if (!target || !toolbar || !search || !searchWidth) return
    const controls = [...toolbar.children].filter((child) => child !== searchWidth)
    const labels = [...toolbar.querySelectorAll<HTMLElement>('[data-library-action-label]')]
    const group = toolbar.querySelector<HTMLElement>('[data-library-group]')
    const groupContent = group?.querySelector<HTMLElement>('[data-library-group-content]')
    const measure = (): void => {
      const gap = parseFloat(getComputedStyle(toolbar).getPropertyValue('--vds-space-2')) || 0
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
      if (group && groupContent) {
        const style = getComputedStyle(groupContent)
        const groupStyle = getComputedStyle(group)
        const labelWidth = groupContent.firstElementChild?.scrollWidth ?? 0
        const chevronWidth =
          group.querySelector('[data-library-group-chevron]')?.getBoundingClientRect().width ?? 0
        const fullWidth = Math.min(
          parseFloat(groupStyle.maxWidth),
          labelWidth +
            chevronWidth +
            (parseFloat(style.columnGap) || 0) +
            (parseFloat(style.paddingLeft) || 0) +
            (parseFloat(style.paddingRight) || 0) +
            (parseFloat(groupStyle.borderLeftWidth) || 0) +
            (parseFloat(groupStyle.borderRightWidth) || 0)
        )
        groupExpansion = fullWidth - group.getBoundingClientRect().width
      }
      const required =
        hiddenLabels +
        groupExpansion +
        controls.reduce(
          (width, control) => {
            const element = control === search ? (searchButtonRef.current ?? search) : control
            return width + element.getBoundingClientRect().width
          },
          gap * Math.max(0, controls.length - 1)
        )
      const available = target.clientWidth
      const actionSavings = labels.reduce((width, label) => {
        const natural = actionWidths.current.get(label)
        return width + (natural ? natural.width - label.parentElement!.offsetHeight : 0)
      }, 0)
      setSearchCompact(
        required -
          actionSavings -
          (searchButtonRef.current?.offsetWidth ?? 0) +
          searchWidth.getBoundingClientRect().width >
          available
      )
      setCompact(required > available)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [target, ...controls, ...labels, searchWidth]) {
      observer.observe(element)
    }
    if (groupContent) observer.observe(groupContent)
    measure()
    return () => observer.disconnect()
  }, [target, leading, children, trailing])
  useLayoutEffect(() => {
    if (target === null) {
      setExpanded(false)
      restoreSearchFocus.current = false
      return
    }
    if (disclosureSearch && expanded && !searchCompact) {
      searchInputRef.current?.focus({ preventScroll: true })
    }
    if (!expanded && restoreSearchFocus.current) {
      restoreSearchFocus.current = false
      searchButtonRef.current?.focus({ preventScroll: true })
    }
  }, [expanded, disclosureSearch, searchCompact, target])
  const closeSearchOnEscape = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    restoreSearchFocus.current = true
    setExpanded(false)
  }
  const refreshButton = !projectToolbar && onRefresh && (
    <IconButton
      variant="outline"
      size="md"
      label={t('refreshLibrary')}
      title={t('refreshLibrary')}
      disabled={refreshing}
      loading={refreshing}
      icon={<RefreshCcw />}
      onClick={onRefresh}
    />
  )
  const toolbar = (
    <div
      ref={toolbarRef}
      data-compact={compact}
      data-search-open={disclosureSearch && expanded}
      className={
        projectToolbar
          ? 'group/library-toolbar relative flex min-w-max flex-1 items-center justify-end gap-[var(--vds-space-2)] data-[compact=true]:gap-[var(--vds-space-1)] [&>*]:shrink-0'
          : 'group/library-toolbar flex min-w-0 flex-wrap items-center justify-end gap-[var(--vds-space-2)]'
      }
    >
      {leading && <div className="mr-auto min-w-0">{leading}</div>}
      {projectToolbar && (
        <span
          ref={searchWidthRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 h-0 w-[var(--vds-library-toolbar-search-width)]"
        />
      )}
      {disclosureSearch ? (
        <div ref={searchRef} className="grid items-center">
          {searchCompact ? (
            <Popover open={expanded} onOpenChange={setExpanded}>
              <PopoverTrigger asChild>
                <IconButton
                  ref={searchButtonRef}
                  variant="ghost"
                  size="sm"
                  className="!text-[var(--vds-icon-outline-default)] aria-expanded:invisible"
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
                  onBlur={() => setExpanded(false)}
                  onKeyDown={closeSearchOnEscape}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <>
              <IconButton
                ref={searchButtonRef}
                variant="ghost"
                size="sm"
                className="col-start-1 row-start-1 aria-expanded:invisible"
                aria-expanded={expanded}
                aria-controls={searchId}
                label={placeholder}
                icon={<Search />}
                onClick={() => setExpanded(true)}
              />
              <div
                id={searchId}
                inert={!expanded}
                aria-hidden={!expanded}
                data-open={expanded}
                className="col-start-1 row-start-1 w-0 overflow-hidden transition-[width] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] data-[open=true]:w-[var(--vds-library-toolbar-search-width)] motion-reduce:transition-none"
              >
                <SearchBox
                  ref={searchInputRef}
                  containerClassName="w-[var(--vds-library-toolbar-search-width)]"
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={query}
                  onChange={(event) => onQuery(event.target.value)}
                  onBlur={() => setExpanded(false)}
                  onKeyDown={closeSearchOnEscape}
                />
              </div>
            </>
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
      {!refreshAfterActions && refreshButton}
      {children}
      {refreshAfterActions && refreshButton}
      {trailing}
    </div>
  )
  if (target === null) return <></>
  return target ? createPortal(toolbar, target) : toolbar
}

export function LibraryFilter({
  label,
  value,
  options,
  onChange,
  onOpenChange,
  loading,
  includeAll = true,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  includeAll?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
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
      <DropdownMenuContent aria-busy={loading || undefined}>
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
          {loading && <Spinner size="sm" />}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
