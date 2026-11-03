import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Filter, Plus, Tag as TagIcon } from 'lucide-react'

import type { LiteratureFacet, LiteratureSummary } from '../../contracts/literature'
import { LIBRARY_HEADER_ACTION_CLASS } from '../../components/business/Library'
import {
  Badge,
  Button,
  Checkbox,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  semanticTagColor,
  semanticTagColorFor,
  Spinner,
  Tag,
  Tooltip,
  useToast,
} from '../../components/ui'
import {
  createLiteratureTag,
  getLiteratureFacets,
  getLiteratureTagFacets,
  LiteratureApiError,
  updateLiterature,
} from './api'
import { catalogue, useCatalogue } from './catalog'
import { literatureErrorMessage } from './error'

export function TagFilter(): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { query, reload, panelReload } = useCatalogue()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [tags, setTags] = useState<LiteratureFacet[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const selected = query.tag_id ?? []
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setFailed(false)
    setTags([])
    getLiteratureTagFacets({
      collection_id: query.collection_id,
      project_id: query.project_id,
      recent: query.recent,
      without_collection: query.without_collection,
      without_project: query.without_project,
    })
      .then((facets) => {
        if (active) setTags(facets.tags)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [
    open,
    query.collection_id,
    query.project_id,
    query.recent,
    query.without_collection,
    query.without_project,
    reload,
    panelReload,
    attempt,
  ])
  const matching = tags.filter((tag) =>
    tag.name.toLowerCase().includes(search.trim().toLowerCase())
  )
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="md"
          aria-label={t('tagFilter.label')}
          data-active={selected.length > 0}
          className={`${LIBRARY_HEADER_ACTION_CLASS} !mx-[var(--vds-space-2)] max-w-[calc(100%-var(--vds-space-2)-var(--vds-space-2))] data-[active=true]:!text-[var(--vds-brand-text-primary)]`}
        >
          {t('columns.tags')}
          <Filter className="size-[var(--vds-icon-7)] shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('tagFilter.label')}
        className="w-[var(--vds-library-tag-menu-width)]"
      >
        <Input
          aria-label={t('panel.searchTags')}
          placeholder={t('panel.searchTags')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="grid max-h-[var(--vds-library-tag-options-height)] gap-[var(--vds-space-1)] overflow-y-auto">
          {loading ? (
            <Spinner size="sm" aria-label={t('tagFilter.loading')} />
          ) : failed ? (
            <div role="alert">
              {t('tagFilter.loadFailed')}
              <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                {t('detail.retry')}
              </Button>
            </div>
          ) : matching.length ? (
            matching.map((tag) => (
              <Checkbox
                key={tag.id}
                align="first-line"
                label={tag.name}
                checked={selected.includes(tag.id)}
                onCheckedChange={(checked) => {
                  const current = catalogue.getSnapshot().query.tag_id ?? []
                  const next = checked
                    ? [...new Set([...current, tag.id])]
                    : current.filter((id) => id !== tag.id)
                  catalogue.filter({ tag_id: next.length ? next : undefined })
                }}
              />
            ))
          ) : (
            <small className="text-[var(--vds-text-tertiary)]">
              {search.trim() ? t('tagFilter.noMatches') : t('panel.noTags')}
            </small>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => catalogue.filter({ tag_id: undefined })}>
          {t('tagFilter.clear')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

const TAG_NAME_MAX_LENGTH = 10

export function TagPicker({
  tags,
  linked,
  disabled = false,
  loading = false,
  size = 'sm',
  onOpenChange,
  onToggle,
  onCreate,
}: {
  tags: LiteratureFacet[]
  linked: ReadonlySet<string>
  disabled?: boolean
  loading?: boolean
  size?: 'xs' | 'sm'
  onOpenChange?: (open: boolean) => void
  onToggle: (tag: LiteratureFacet) => void | Promise<void>
  onCreate: (name: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setCreating(false)
          setDraft('')
        }
        onOpenChange?.(next)
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          label={t('detail.addTag')}
          size={size}
          variant="ghostIcon"
          icon={<Plus />}
          disabled={disabled}
        />
      </PopoverTrigger>
      <PopoverContent
        data-testid="literature-tag-picker"
        className="w-[var(--vds-library-tag-menu-width)]"
      >
        <div
          role="menu"
          className="grid max-h-[var(--vds-library-tag-options-height)] gap-[var(--vds-space-1)] overflow-y-auto"
        >
          {loading ? (
            <Spinner size="sm" />
          ) : tags.length ? (
            tags.map((tag) => (
              <Button
                key={tag.id}
                variant="ghost"
                role="menuitemcheckbox"
                aria-checked={linked.has(tag.id)}
                aria-disabled={disabled || loading}
                className={`w-full !justify-start gap-[var(--vds-space-2)] ${linked.has(tag.id) ? '![background:var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-text-primary)]' : ''}`}
                onClick={() => {
                  if (!disabled && !loading) void onToggle(tag)
                }}
              >
                <TagIcon
                  className={`size-[var(--vds-icon-6)] shrink-0 ${linked.has(tag.id) ? '' : 'text-[var(--vds-icon-fill-default)]'}`}
                />
                <span className="min-w-0 flex-1 truncate text-left">{tag.name}</span>
                {linked.has(tag.id) && <Check className="size-[var(--vds-icon-6)] shrink-0" />}
              </Button>
            ))
          ) : (
            <small className="flex w-full items-center justify-center px-[var(--vds-space-2)] py-[var(--vds-space-4)] text-center text-[var(--vds-text-tertiary)]">
              {t('panel.noTags')}
            </small>
          )}
        </div>
        <div className="mt-[var(--vds-space-2)] border-t border-[var(--vds-border-default)] pt-[var(--vds-space-2)]">
          {creating ? (
            <div className="relative">
              <Input
                autoFocus
                maxLength={TAG_NAME_MAX_LENGTH}
                className="pr-[calc(var(--vds-space-8)+var(--vds-space-4))]"
                aria-label={t('detail.newTagPlaceholder')}
                placeholder={t('detail.newTagPlaceholder')}
                value={draft}
                readOnly={disabled || loading}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.nativeEvent.isComposing ||
                    !draft.trim() ||
                    disabled ||
                    loading
                  )
                    return
                  event.preventDefault()
                  event.stopPropagation()
                  const name = draft.trim()
                  setDraft('')
                  setCreating(false)
                  void onCreate(name)
                }}
              />
              <span className="pointer-events-none absolute right-[var(--vds-space-3)] top-1/2 -translate-y-1/2 text-[var(--vds-text-tertiary)]">
                {draft.length}/{TAG_NAME_MAX_LENGTH}
              </span>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="w-full !justify-start gap-[var(--vds-space-2)]"
              disabled={disabled || loading}
              onClick={() => setCreating(true)}
            >
              <Plus className="size-[var(--vds-icon-6)]" />
              {t('panel.newTag')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function RowTags({
  item,
  projectId,
  onUpdated,
  onMinimumWidth,
}: {
  item: LiteratureSummary
  projectId?: string
  onUpdated: (item: LiteratureSummary) => void
  onMinimumWidth?: (id: string, width: number) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { toast } = useToast()
  const [tags, setTags] = useState<LiteratureFacet[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const active = useRef(true)
  const pending = useRef(false)
  const content = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = content.current
    if (!element || !onMinimumWidth) return
    const measure = (): void => {
      const parent = element.parentElement!
      const style = getComputedStyle(parent)
      onMinimumWidth(
        item.id,
        Math.ceil(
          element.getBoundingClientRect().width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight)
        )
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [item.id, onMinimumWidth])
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const report = (
    reason: unknown,
    fallback: 'detail.saveFailed' | 'panel.error.createFailed' | 'batch.loadFailed'
  ): void => {
    if (!active.current) return
    const error = literatureErrorMessage(
      reason instanceof LiteratureApiError ? reason.failure.code : undefined,
      undefined,
      fallback
    )
    toast({ tone: 'error', description: t(error.key) })
  }
  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const facets = await getLiteratureFacets({ project_id: projectId })
      if (active.current) setTags(facets.tags)
    } catch (reason) {
      report(reason, 'batch.loadFailed')
    } finally {
      if (active.current) setLoading(false)
    }
  }
  const save = async (ids: string[]): Promise<void> => {
    const updated = await updateLiterature(item.id, { tag_ids: ids }, projectId)
    if (!active.current) return
    onUpdated(updated)
    catalogue.reloadPanel()
  }
  const toggle = async (tag: { id: string }): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const ids = item.tags.filter((value) => value.id !== tag.id).map((value) => value.id)
      if (!item.tags.some((value) => value.id === tag.id)) ids.push(tag.id)
      await save(ids)
    } catch (reason) {
      report(reason, 'detail.saveFailed')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  const create = async (name: string): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await createLiteratureTag(name)
      const facets = await getLiteratureFacets({ project_id: projectId })
      if (!active.current) return
      setTags(facets.tags)
      const created = facets.tags.find((tag) => tag.name === name)
      if (created && !item.tags.some((tag) => tag.id === created.id))
        await save([...item.tags.map((tag) => tag.id), created.id])
    } catch (reason) {
      report(reason, 'panel.error.createFailed')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  const chip = (tag: LiteratureFacet): React.ReactNode => (
    <Tag
      key={tag.id}
      className="shrink-0 !max-w-none [&_button]:hidden group-hover/literature:[&_button]:inline-flex group-focus-within/literature:[&_button]:inline-flex"
      color={
        semanticTagColor(tags.find((value) => value.id === tag.id)?.color) ??
        semanticTagColorFor(tag.id)
      }
      closeLabel={t('detail.removeTag')}
      onClose={() => {
        void toggle(tag)
      }}
    >
      {tag.name}
    </Tag>
  )
  return (
    <span
      className="flex min-w-0 items-center gap-[var(--vds-space-1)] !px-[var(--vds-space-half)]"
      data-testid="literature-row-tags"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation()
      }}
    >
      <span ref={content} className="flex w-max shrink-0 items-center gap-[var(--vds-space-1)]">
        {item.tags[0] && (
          <Tooltip className="shrink-0" content={item.tags[0].name} portalled>
            {chip(item.tags[0])}
          </Tooltip>
        )}
        {item.tags.length > 1 && (
          <Tooltip
            portalled
            content={
              <span className="flex flex-wrap gap-[var(--vds-space-1)]">
                {item.tags.slice(1).map((tag) => (
                  <Tag key={tag.id} color={semanticTagColorFor(tag.id)}>
                    {tag.name}
                  </Tag>
                ))}
              </span>
            }
          >
            <Badge
              className="shrink-0 !px-0 !bg-transparent hover:!bg-transparent"
              tone="neutral"
              size="sm"
              tabIndex={0}
              aria-label={t('list.moreTags', {
                count: item.tags.length - 1,
                names: item.tags
                  .slice(1)
                  .map((tag) => tag.name)
                  .join('、'),
              })}
            >
              +{item.tags.length - 1}
            </Badge>
          </Tooltip>
        )}
        <span
          className={`ml-auto shrink-0 ${pickerOpen ? 'opacity-[var(--vds-opacity-full)]' : 'opacity-0 group-hover/literature:opacity-[var(--vds-opacity-full)] group-focus-within/literature:opacity-[var(--vds-opacity-full)]'}`}
        >
          <TagPicker
            size="xs"
            tags={tags}
            linked={new Set(item.tags.map((tag) => tag.id))}
            disabled={busy}
            loading={loading}
            onOpenChange={(open) => {
              setPickerOpen(open)
              if (open) void load()
            }}
            onToggle={toggle}
            onCreate={create}
          />
        </span>
      </span>
    </span>
  )
}
