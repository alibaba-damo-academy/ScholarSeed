import { Highlighter, MessageSquare } from 'lucide-react'
import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  IconButton,
  ScrollArea,
} from '../../components/ui'
import { useApp } from '../../store'
import type { NoteProvenance } from '../../contracts/literature'
import { subscribeChanges } from '../../app/notifications'
import { getNoteSources, resolveNoteSources, LiteratureApiError } from './api'
import { SourcePager } from './SourcePager'
import { DirtyRefresh } from '../../../../notifications'
import {
  NOTE_SOURCE_LIMIT,
  NOTE_SOURCE_PREFIX,
  NOTE_SOURCE_VERSION,
  noteSourceKey,
  noteSourceLink,
  noteSourceLinks,
  noteProvenancePreview,
  notePreviewSourceGroup,
  noteUnreferencedGroups,
  type NoteSource,
  type NoteSourceCandidates,
  type ResolvedNoteSource,
} from './sources'

export interface NoteSourceControls {
  previewText: string
  stale: boolean
  coverageView: ReactNode
  tools: (insert: (markdown: string) => void) => ReactNode
  renderLink: (href: string) => ReactNode
  editView: ReactNode
}

export function NoteSources({
  itemId,
  text,
  provenance,
  children,
}: {
  itemId: string
  text: string
  provenance?: NoteProvenance | null
  children: (controls: NoteSourceControls) => ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { act } = useApp()
  const preview = useMemo(() => {
    const bound = noteProvenancePreview(text, provenance)
    const unreferenced = noteUnreferencedGroups(provenance)
    return {
      ...bound,
      groups: { ...bound.groups, ...unreferenced },
      unreferenced: Object.keys(unreferenced),
    }
  }, [text, provenance])
  const links = useMemo(
    () => [...noteSourceLinks(text), ...Object.keys(preview.groups)],
    [text, preview]
  )
  const [resolved, setResolved] = useState<Record<string, ResolvedNoteSource[]>>({})
  const [selected, setSelected] = useState('')
  const [insert, setInsert] = useState<((markdown: string) => void) | null>(null)
  const [candidates, setCandidates] = useState<NoteSourceCandidates | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const candidateCount = candidates?.items.length ?? 0
  const exceedsSelectionLimit = candidateCount > NOTE_SOURCE_LIMIT
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const refresher = new DirtyRefresh(
      async (signal) => {
        const next: Record<string, ResolvedNoteSource[]> = {}
        for (const href of links) {
          const group = notePreviewSourceGroup(href, preview.groups)
          if (!group) continue
          try {
            next[href] = (await resolveNoteSources(itemId, group, signal)).items
          } catch (error) {
            if (!(error instanceof LiteratureApiError) || error.failure.status >= 500) throw error
            next[href] = group.sources.map((source) => ({
              source,
              state: 'unavailable',
              current: null,
            }))
          }
        }
        return next
      },
      setResolved,
      (error) => console.warn('[note-sources] refresh unavailable', error)
    )
    const refresh = (): void => refresher.invalidate()
    refresh()
    const unsubscribe = links.length
      ? subscribeChanges(['records', 'literature', 'resources'], (reset) =>
          refresher.invalidate(reset)
        )
      : undefined
    window.addEventListener('focus', refresh)
    return () => {
      refresher.stop()
      unsubscribe?.()
      window.removeEventListener('focus', refresh)
    }
  }, [itemId, links, preview])

  const label = (source: NoteSource): string =>
    t('noteSources.sourceLabel', {
      page: source.page,
      kind: t(
        source.kind === 'user_comment'
          ? 'noteSources.comment'
          : source.kind === 'location'
            ? 'noteSources.location'
            : 'noteSources.text'
      ),
    })
  const navigate = async (source: NoteSource): Promise<void> => {
    try {
      const result = await resolveNoteSources(itemId, {
        version: NOTE_SOURCE_VERSION,
        sources: [source],
      })
      const current = result.items[0]?.current
      if (!current || result.items[0].state !== 'available') {
        setError(true)
        return
      }
      const opened = await act.openLiteratureAttachment(
        itemId,
        current.record_target.subject_id,
        current.page,
        {
          annotation: {
            revision: current.source_revision,
            page: current.page,
            markId: current.mark_id,
          },
        }
      )
      if (opened) {
        setSelected(noteSourceKey(source))
        setError(false)
      } else setError(true)
    } catch {
      setError(true)
    }
  }
  const renderLink = (href: string): ReactNode => {
    if (!Object.hasOwn(preview.groups, href) && !href.startsWith(NOTE_SOURCE_PREFIX))
      return undefined
    const group = notePreviewSourceGroup(href, preview.groups)
    if (!group) return <span role="status">{t('noteSources.invalid')}</span>
    const entries = resolved[href]
    return (
      <span data-testid="note-source-group">
        <SourcePager
          key={JSON.stringify(group.sources.map(noteSourceKey))}
          items={group.sources.map((source, index) => ({
            label: t(
              source.kind === 'user_comment'
                ? 'noteSources.comment'
                : source.kind === 'location'
                  ? 'noteSources.location'
                  : 'noteSources.text'
            ),
            title: `${label(source)}\n${source.attachment_name}\n${source.text}`,
            available: entries?.[index]?.state === 'available',
            selected: selected === noteSourceKey(source),
            navigate: () => navigate(source),
          }))}
        />
      </span>
    )
  }
  const open = async (callback: (markdown: string) => void): Promise<void> => {
    setInsert(() => callback)
    setChosen(new Set())
    setCandidates(null)
    setError(false)
    setLoading(true)
    try {
      setCandidates(await getNoteSources(itemId))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }
  const controls: NoteSourceControls = {
    coverageView: (
      <>
        {provenance?.status === 'indexed' &&
        Boolean(provenance.unresolved_source_ids?.length || provenance.skipped_paragraphs) ? (
          <Alert tone="info" data-testid="note-provenance-indexed">
            {provenance.unresolved_source_ids?.length ? (
              <span>
                {t('noteSources.unresolved', { ids: provenance.unresolved_source_ids.join(', ') })}
              </span>
            ) : null}
            {provenance.skipped_paragraphs ? (
              <span>{t('noteSources.skipped', { count: provenance.skipped_paragraphs })}</span>
            ) : null}
          </Alert>
        ) : null}
        {provenance?.status === 'unverified' ? (
          <Alert tone="warning" data-testid="note-provenance-unverified">
            {t('noteSources.unverified')}
          </Alert>
        ) : null}
        {preview.unreferenced.length ? (
          <section
            className="mt-[var(--vds-space-4)] flex flex-col gap-[var(--vds-space-2)]"
            data-testid="note-unreferenced-sources"
            aria-label={t('noteSources.unreferencedTitle')}
          >
            <Alert
              tone="info"
              layout="stacked"
              title={t('noteSources.unreferenced', {
                count: preview.unreferenced.reduce(
                  (count, href) => count + preview.groups[href].sources.length,
                  0
                ),
              })}
            />
            {preview.unreferenced.map((href) => (
              <div key={href}>{renderLink(href)}</div>
            ))}
          </section>
        ) : null}
      </>
    ),
    tools: (callback) => (
      <IconButton
        icon={<Highlighter size={14} />}
        label={t('noteSources.attach')}
        size="sm"
        variant="ghostIcon"
        onClick={() => void open(callback)}
      />
    ),
    renderLink: (href) => renderLink(href),
    previewText: preview.text,
    stale: preview.stale,
    editView: links.length ? (
      <ScrollArea className="min-h-0" viewportClassName="flex flex-col gap-[var(--vds-space-2)]">
        {links
          .filter((href) => !preview.unreferenced.includes(href))
          .map((href) => (
            <div key={href}>{renderLink(href)}</div>
          ))}
      </ScrollArea>
    ) : null,
  }
  return (
    <>
      {children(controls)}
      {error && !insert ? <span role="alert">{t('noteSources.failed')}</span> : null}
      <Dialog
        open={Boolean(insert)}
        onOpenChange={(value) => {
          if (!value) setInsert(null)
        }}
      >
        <DialogPortal>
          <DialogContent
            headerLayout="aligned"
            className="!flex min-h-0 max-h-[calc(100dvh-var(--vds-space-8))] flex-col overflow-hidden !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !py-[var(--vds-space-3)] !bg-[var(--vds-bg-gray-light-default)]"
          >
            <DialogHeader>
              <DialogTitle>{t('noteSources.attach')}</DialogTitle>
            </DialogHeader>
            {loading ? <span role="status">{t('noteSources.loading')}</span> : null}
            {error ? <span role="alert">{t('noteSources.failed')}</span> : null}
            {candidates && !candidates.items.length ? <span>{t('noteSources.empty')}</span> : null}
            {candidates &&
            (candidates.omitted_count > 0 || candidates.unavailable_attachment_ids.length > 0) ? (
              <span role="status">{t('noteSources.partial')}</span>
            ) : null}
            {candidateCount > 0 ? (
              <div className="flex shrink-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Checkbox
                  label={t('generation.all')}
                  checked={chosen.size === candidateCount ? true : chosen.size ? 'mixed' : false}
                  disabled={exceedsSelectionLimit}
                  onCheckedChange={(checked) =>
                    setChosen(new Set(checked ? candidates?.items.map(noteSourceKey) : []))
                  }
                />
                <span role="status" className="text-[var(--vds-text-tertiary)]">
                  {t('generation.selected', { count: chosen.size })}
                </span>
                {exceedsSelectionLimit ? (
                  <span className="text-[var(--vds-text-tertiary)]">
                    {t('generation.limit', { count: NOTE_SOURCE_LIMIT })}
                  </span>
                ) : null}
              </div>
            ) : null}
            <ScrollArea
              overlay
              shadow={false}
              className="flex min-h-0 max-h-[var(--vds-dialog-list-max-height)] flex-1 flex-col -mr-[var(--vds-space-5)]"
              viewportClassName="min-h-0 flex-1 pr-[var(--vds-space-5)]"
            >
              <div className="flex flex-col gap-[var(--vds-space-3)]">
                {candidates?.items.map((source) => {
                  const key = noteSourceKey(source)
                  return (
                    <Checkbox
                      key={key}
                      align="first-line"
                      className="w-full shrink-0 !items-start rounded-[var(--vds-radius-4)] !border !border-[var(--vds-divider-default)] !bg-[var(--vds-bg-component)] !px-[var(--vds-space-3)] !pb-[var(--vds-space-3)] !pt-[var(--vds-space-2)]"
                      checked={chosen.has(key)}
                      disabled={!chosen.has(key) && chosen.size >= NOTE_SOURCE_LIMIT}
                      aria-label={`${label(source)} · ${source.attachment_name} · ${source.text}`}
                      onCheckedChange={(checked) =>
                        setChosen((previous) => {
                          const next = new Set(previous)
                          if (checked) next.add(key)
                          else next.delete(key)
                          return next
                        })
                      }
                    >
                      <span className="min-w-0 flex-1 text-[var(--vds-text-tertiary)]">
                        <span className="flex items-center gap-[var(--vds-space-2)]">
                          <span className="shrink-0">{label(source)}</span>
                          <span className="min-w-0 flex-1 truncate">{source.attachment_name}</span>
                          {source.kind === 'user_comment' ? (
                            <MessageSquare
                              aria-hidden="true"
                              className="size-[var(--vds-icon-8)] shrink-0"
                            />
                          ) : (
                            <Highlighter
                              aria-hidden="true"
                              className="size-[var(--vds-icon-8)] shrink-0"
                            />
                          )}
                        </span>
                        <span className="mt-[var(--vds-space-2)] line-clamp-2 border-l-[length:var(--vds-border-width-2)] border-[var(--vds-accent-bg-default)] pl-[var(--vds-space-2)] [overflow-wrap:anywhere]">
                          {source.text}
                        </span>
                      </span>
                    </Checkbox>
                  )
                })}
              </div>
            </ScrollArea>
            <DialogFooter className="pb-[var(--vds-space-2)]">
              <Button variant="outline" onClick={() => setInsert(null)}>
                {t('noteSources.cancel')}
              </Button>
              <Button
                disabled={!chosen.size || loading}
                onClick={() => {
                  const sources =
                    candidates?.items.filter((source) => chosen.has(noteSourceKey(source))) ?? []
                  if (!sources.length) return
                  try {
                    insert?.(`[${t('noteSources.label')}](${noteSourceLink(sources)})`)
                    setInsert(null)
                  } catch {
                    setError(true)
                  }
                }}
              >
                {t('noteSources.insert')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  )
}
