import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'

import { Button, CopyButton, IconButton, Tabs, TabsList, TabsTrigger } from '../../../components/ui'
import { writeClipboard } from '../../../components/primitive/clipboard'
import type { PdfComment, PdfMark } from '../api'
import { PdfPanel } from './Panel'
import { filterMarks, PDF_MARK_PALETTE, type PdfMarkCategory } from './records'

function groupMarksByPage(marks: readonly PdfMark[]): Array<{ page: number; marks: PdfMark[] }> {
  const groups = new Map<number, PdfMark[]>()
  for (const mark of marks) groups.set(mark.page, [...(groups.get(mark.page) ?? []), mark])
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, pageMarks]) => ({ page, marks: pageMarks }))
}

export function PdfAnnotations({
  comments,
  marks,
  saving,
  expanded,
  onToggleExpanded,
  onClose,
  onDelete,
  onFocus,
}: {
  comments: readonly PdfComment[]
  marks: readonly PdfMark[]
  saving: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onClose: () => void
  onDelete: (markId: string) => void
  onFocus: (mark: PdfMark) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [filter, setFilter] = useState<PdfMarkCategory>('all')
  const [expandedMarks, setExpandedMarks] = useState<Set<string>>(new Set())
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set())
  const visibleMarks = useMemo(
    () => filterMarks(marks, comments, filter),
    [comments, filter, marks]
  )
  const groups = useMemo(() => groupMarksByPage(visibleMarks), [visibleMarks])
  const categories: PdfMarkCategory[] = [
    'all',
    'highlight',
    'underline',
    'strikethrough',
    'comment',
  ]
  const categoryLabels: Record<PdfMarkCategory, string> = {
    all: t('pdfAnnotation.filter.all'),
    highlight: t('pdfAnnotation.filter.highlight'),
    underline: t('pdfAnnotation.filter.underline'),
    strikethrough: t('pdfAnnotation.filter.strikethrough'),
    comment: t('pdfAnnotation.filter.comment'),
  }
  const kindLabels: Record<Exclude<PdfMarkCategory, 'all'>, string> = {
    highlight: t('pdfAnnotation.kind.highlight'),
    underline: t('pdfAnnotation.kind.underline'),
    strikethrough: t('pdfAnnotation.kind.strikethrough'),
    comment: t('pdfAnnotation.kind.comment'),
  }
  const counts = Object.fromEntries(
    categories.map((category) => [category, filterMarks(marks, comments, category).length])
  ) as Record<PdfMarkCategory, number>
  const toggleExpanded = (markId: string): void => {
    setExpandedMarks((current) => {
      const next = new Set(current)
      if (next.has(markId)) next.delete(markId)
      else next.add(markId)
      return next
    })
  }
  const toggleCommentExpanded = (commentId: string): void => {
    setExpandedComments((current) => {
      const next = new Set(current)
      if (next.has(commentId)) next.delete(commentId)
      else next.add(commentId)
      return next
    })
  }

  const toolbar = (
    <div className="overflow-x-auto border-b border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as PdfMarkCategory)}>
        <TabsList aria-label={t('pdfAnnotation.pdfRecords')} className="w-max justify-self-start">
          {categories.map((category) => (
            <TabsTrigger
              key={category}
              value={category}
              className="min-w-0 flex-none whitespace-nowrap px-[var(--vds-space-2)]"
            >
              {categoryLabels[category]} {counts[category]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <PdfPanel
      ariaLabel={t('pdfAnnotation.pdfRecords')}
      bodyTestId="pdf-annotation-list"
      closeLabel={t('pdfAnnotation.closeRecords')}
      expanded={expanded}
      icon={<Pencil size={16} />}
      testId="pdf-annotations"
      title={t('pdfAnnotation.records')}
      toolbar={toolbar}
      onClose={onClose}
      onToggleExpanded={onToggleExpanded}
    >
      <div>
        {!visibleMarks.length ? (
          <p className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
            {marks.length ? t('pdfAnnotation.filterEmpty') : t('pdfAnnotation.empty')}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.page}>
            <div className="border-b border-[var(--vds-divider-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
              {t('pdfAnnotation.pageSummary', { page: group.page, count: group.marks.length })}
            </div>
            {group.marks.map((mark) => {
              const markComments = comments.filter((comment) => comment.mark_id === mark.id)
              const hasComments = markComments.length > 0
              const category = markComments.length ? 'comment' : mark.style
              const color =
                PDF_MARK_PALETTE.find((candidate) => candidate.name === mark.color)?.hex ??
                PDF_MARK_PALETTE[0].hex
              const expanded = expandedMarks.has(mark.id)
              const expandable = mark.text.length > 96 || mark.text.split(/\r?\n/u).length > 4
              return (
                <article
                  className="m-[var(--vds-space-3)] rounded-[var(--vds-radius-5)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] shadow-[var(--vds-shadow-xs)]"
                  key={mark.id}
                >
                  <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
                    <Button
                      className="min-w-0 justify-start px-0"
                      size="sm"
                      variant="ghost"
                      onClick={() => onFocus(mark)}
                    >
                      <span
                        className="mr-2 size-2.5 shrink-0 rounded-full bg-[var(--pdf-mark-color)]"
                        style={{ '--pdf-mark-color': color } as React.CSSProperties}
                      />
                      <span className="min-w-0 truncate">
                        {t('pdfAnnotation.pageKind', {
                          page: mark.page,
                          kind: kindLabels[category],
                        })}
                      </span>
                    </Button>
                    <Button
                      className="shrink-0 px-[var(--vds-space-1)]"
                      size="sm"
                      variant="ghost"
                      onClick={() => onFocus(mark)}
                    >
                      {t('pdfAnnotation.viewSource')}
                    </Button>
                  </div>
                  {!hasComments ? (
                    <Button
                      className="mt-[var(--vds-space-2)] block h-auto w-full px-0 text-left text-[var(--vds-text-primary)]"
                      onClick={() => onFocus(mark)}
                      size="content"
                      unstyled
                      variant="ghost"
                    >
                      <span
                        className={`vds-pdf-annotation-text min-w-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-lh-subhead)] line-clamp-4${expanded ? ' is-expanded !block !overflow-visible !line-clamp-none' : ''}`}
                      >
                        {mark.text}
                      </span>
                    </Button>
                  ) : null}
                  {!hasComments && expandable ? (
                    <Button
                      className="mt-[var(--vds-space-1)] px-0"
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpanded(mark.id)}
                    >
                      {expanded ? t('pdfAnnotation.collapse') : t('pdfAnnotation.expand')}
                    </Button>
                  ) : null}
                  {markComments.length ? (
                    <div className="mt-[var(--vds-space-3)] grid gap-[calc(var(--vds-space-1)+var(--vds-space-half))]">
                      <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                        {t('pdfAnnotation.sourceLabel')}
                      </span>
                      <div className="border-l-2 border-[var(--vds-border-default)] pl-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
                        <span className="vds-pdf-annotation-source-preview min-w-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-lh-subhead)] line-clamp-4">
                          {mark.text}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {markComments.map((comment) => {
                    const commentExpanded = expandedComments.has(comment.id)
                    const commentExpandable =
                      comment.body.length > 96 || comment.body.split(/\r?\n/u).length > 4
                    return (
                      <div
                        className="mt-[var(--vds-space-3)] rounded-[var(--vds-radius-5)] bg-[var(--vds-brand-light-bg-default)] p-[var(--vds-space-3)]"
                        key={comment.id}
                      >
                        <span className="mb-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]">
                          {t('pdfAnnotation.commentLabel')}
                        </span>
                        <p
                          className={`vds-pdf-annotation-comment m-0 min-w-0 overflow-hidden whitespace-pre-wrap text-[var(--vds-text-primary)] [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-lh-subhead)] line-clamp-4${commentExpanded ? ' is-expanded !block !overflow-visible !line-clamp-none' : ''}`}
                        >
                          {comment.body}
                        </p>
                        {commentExpandable ? (
                          <Button
                            className="mt-[var(--vds-space-2)] px-0"
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleCommentExpanded(comment.id)}
                          >
                            {commentExpanded
                              ? t('pdfAnnotation.collapseComment')
                              : t('pdfAnnotation.expandComment')}
                          </Button>
                        ) : null}
                      </div>
                    )
                  })}
                  <div className="mt-[var(--vds-space-2)] flex flex-wrap items-center gap-[var(--vds-space-1)]">
                    {markComments.map((comment) => (
                      <CopyButton
                        key={comment.id}
                        value={comment.body}
                        writeText={writeClipboard}
                        size="sm"
                        variant="ghost"
                        idleLabel={t('pdfAnnotation.copyComment')}
                      />
                    ))}
                    <CopyButton
                      value={mark.text}
                      writeText={writeClipboard}
                      size="sm"
                      variant="ghost"
                      idleLabel={t('pdfAnnotation.copySource')}
                    />
                    <IconButton
                      label={t('pdfAnnotation.deletePageKind', {
                        page: mark.page,
                        kind: kindLabels[category],
                      })}
                      icon={<Trash2 size={13} />}
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => onDelete(mark.id)}
                    />
                  </div>
                </article>
              )
            })}
          </section>
        ))}
      </div>
    </PdfPanel>
  )
}
