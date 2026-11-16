import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Copy,
  Highlighter,
  Layers,
  MessageSquareText,
  MoreVertical,
  Pencil,
  Trash2,
} from 'lucide-react'

import {
  Button,
  CopyButton,
  EmptyState,
  ScrollArea,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '../../../components/ui'
import { Icon } from '../../../icons'
import { writeClipboard } from '../../../components/primitive/clipboard'
import type { PdfComment, PdfMark } from '../api'
import { filterMarks, PDF_MARK_PALETTE, type PdfMarkCategory } from './records'

const COMMENT_COPY_FEEDBACK_DURATION_MS = 3_000

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
  onDelete,
  onFocus,
  renderEditor,
  footer,
  onActionMenuOpen,
}: {
  comments: readonly PdfComment[]
  marks: readonly PdfMark[]
  saving: boolean
  onDelete: (markId: string) => void
  onFocus: (mark: PdfMark) => void
  renderEditor?: (
    mark: PdfMark,
    close: () => void,
    mode: 'edit' | 'comment',
    inlineComment?: boolean
  ) => React.ReactNode
  footer?: React.ReactNode
  onActionMenuOpen?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [filter, setFilter] = useState<PdfMarkCategory>('all')
  const [expandedMarks, setExpandedMarks] = useState<Set<string>>(new Set())
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<{ id: string; mode: 'edit' | 'comment' } | null>(null)
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
  const categoryIcons: Record<PdfMarkCategory, React.ReactNode> = {
    all: <Layers size={14} />,
    highlight: <Highlighter size={14} />,
    underline: <Icon name="underline" size={14} />,
    strikethrough: <Icon name="strikethrough" size={14} />,
    comment: <MessageSquareText size={14} />,
  }
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
    <div className="px-[var(--vds-space-3)] pt-[var(--vds-space-3)] pb-[var(--vds-space-2)]">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as PdfMarkCategory)}>
        <TabsList
          aria-label={t('pdfAnnotation.pdfRecords')}
          className="!h-auto w-full !gap-[var(--vds-space-1)] !rounded-[var(--vds-radius-4)] !bg-[var(--vds-other-overlay-1)] !p-[var(--vds-space-1)] [&>span[aria-hidden=true]]:hidden!"
        >
          {categories.map((category) => (
            <TabsTrigger
              key={category}
              value={category}
              aria-label={`${categoryLabels[category]} ${counts[category]}`}
              className="group flex !h-[var(--vds-pdf-annotation-tab-height)] min-w-0 flex-1 items-center justify-center gap-[var(--vds-space-half)] whitespace-nowrap rounded-[var(--vds-radius-3)] !px-0 !py-0 text-[var(--vds-text-tertiary)] [&_svg]:!text-inherit hover:!text-[var(--vds-text-primary)] data-[state=active]:!bg-[var(--vds-bg-white-default)] data-[state=active]:!text-[var(--vds-text-primary)] data-[state=active]:font-[var(--vds-fw-medium)] data-[state=active]:shadow-[var(--vds-shadow-1-center)]"
            >
              <Tooltip
                portalled
                content={categoryLabels[category]}
                side="bottom"
                className="flex size-full items-center justify-center"
              >
                {category === 'all' ? (
                  <span className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] group-data-[state=active]:font-[var(--vds-fw-medium)]">
                    {categoryLabels.all}
                  </span>
                ) : (
                  categoryIcons[category]
                )}
              </Tooltip>
              <span className="sr-only">{counts[category]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <section
      aria-label={t('pdfAnnotation.pdfRecords')}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="pdf-annotations"
    >
      {toolbar}
      <ScrollArea
        overlay
        className="min-h-0 flex-1"
        viewportClassName="h-full"
        viewportProps={{
          'data-testid': 'pdf-annotation-list',
          'aria-label': t('pdfAnnotation.pdfRecords'),
        }}
      >
        <div className="min-h-full min-w-0 flex flex-col">
          {!visibleMarks.length ? (
            <EmptyState
              variant="compact"
              title={marks.length ? t('pdfAnnotation.filterEmpty') : t('pdfAnnotation.empty')}
              className="flex-1 [&>div>div]:text-[length:var(--vds-font-body-lv1)] [&>div>div]:leading-[var(--vds-lh-body-lv1)]"
            />
          ) : null}
          {groups.map((group) => (
            <Collapsible key={group.page} defaultOpen className="!gap-0">
              <div className="flex items-center justify-between gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="group !px-[var(--vds-space-1)] !text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)]"
                    data-testid={`pdf-annotation-page-${group.page}`}
                  >
                    {t('page', { page: group.page })}
                    <span className="inline-flex -rotate-90 group-data-[state=open]:rotate-0">
                      <Icon name="chevron-down" size={12} />
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <span>{t('pdfAnnotation.pageCount', { count: group.marks.length })}</span>
              </div>
              <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0">
                {group.marks.map((mark) => {
                  const markComments = comments.filter((comment) => comment.mark_id === mark.id)
                  const category = markComments.length ? 'comment' : mark.style
                  const color =
                    PDF_MARK_PALETTE.find((candidate) => candidate.name === mark.color)?.hex ??
                    PDF_MARK_PALETTE[0].hex
                  const expanded = expandedMarks.has(mark.id)
                  const expandable = mark.text.length > 96 || mark.text.split(/\r?\n/u).length > 4
                  return (
                    <article
                      className="mx-[var(--vds-space-3)] mb-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-caption)]"
                      style={{ '--pdf-mark-color': color } as React.CSSProperties}
                      key={mark.id}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-1)] pb-[var(--vds-space-2)]">
                        <Button
                          className="min-w-0 justify-start gap-[var(--vds-space-1)] px-0 !text-[length:var(--vds-font-caption)] !font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
                          size="xs"
                          variant="ghost"
                          aria-label={t('pdfAnnotation.pageKind', {
                            page: mark.page,
                            kind: kindLabels[category],
                          })}
                          onClick={() => onFocus(mark)}
                        >
                          <span className="min-w-0 truncate">{t('page', { page: mark.page })}</span>
                        </Button>
                        <div
                          className="flex shrink-0 items-center"
                          data-testid="pdf-annotation-card-actions"
                        >
                          {renderEditor ? (
                            <Tooltip portalled content={t('pdfAnnotation.comment')}>
                              <IconButton
                                label={t('pdfAnnotation.comment')}
                                title={undefined}
                                icon={<MessageSquareText size={12} />}
                                size="xs"
                                variant="ghostIcon"
                                disabled={saving}
                                aria-expanded={editor?.id === mark.id && editor.mode === 'comment'}
                                onClick={() =>
                                  setEditor((current) =>
                                    current?.id === mark.id && current.mode === 'comment'
                                      ? null
                                      : { id: mark.id, mode: 'comment' }
                                  )
                                }
                              />
                            </Tooltip>
                          ) : null}
                          <DropdownMenu
                            onOpenChange={(open) => {
                              setEditor(null)
                              if (open) onActionMenuOpen?.()
                            }}
                          >
                            <Tooltip portalled content={t('pdfAnnotation.more')}>
                              <DropdownMenuTrigger asChild>
                                <IconButton
                                  label={t('pdfAnnotation.more')}
                                  title={undefined}
                                  icon={<MoreVertical size={12} />}
                                  size="xs"
                                  variant="ghostIcon"
                                  disabled={saving}
                                />
                              </DropdownMenuTrigger>
                            </Tooltip>
                            <DropdownMenuContent
                              align="end"
                              className="!w-max !min-w-[var(--vds-pdf-annotation-menu-width)]"
                            >
                              <DropdownMenuItem onSelect={() => void writeClipboard(mark.text)}>
                                <Icon name="copy" size={12} />
                                {t('pdfAnnotation.copySource')}
                              </DropdownMenuItem>
                              {renderEditor && (
                                <Popover
                                  open={editor?.id === mark.id && editor.mode === 'edit'}
                                  onOpenChange={(open) => {
                                    if (!open) setEditor(null)
                                  }}
                                >
                                  <PopoverTrigger asChild>
                                    <DropdownMenuItem
                                      onClick={(event) => {
                                        event.preventDefault()
                                        setEditor({ id: mark.id, mode: 'edit' })
                                      }}
                                    >
                                      <Pencil size={12} />
                                      {t('pdfAnnotation.edit')}
                                    </DropdownMenuItem>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    side="right"
                                    align="start"
                                    className="w-max! max-w-[var(--vds-popover-available-width)]! gap-0! p-0!"
                                  >
                                    {renderEditor(mark, () => setEditor(null), 'edit')}
                                  </PopoverContent>
                                </Popover>
                              )}
                              <DropdownMenuItem
                                destructive
                                aria-label={t('pdfAnnotation.deletePageKind', {
                                  page: mark.page,
                                  kind: kindLabels[category],
                                })}
                                onSelect={() => onDelete(mark.id)}
                              >
                                <Trash2 size={12} />
                                {t('pdfAnnotation.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                      {mark.style !== 'comment' ? (
                        <Button
                          className="block h-auto w-full border-l-[length:var(--vds-border-width-3)] border-[var(--pdf-mark-color)] py-0 pl-[var(--vds-space-2)] pr-0 text-left text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]"
                          onClick={() => onFocus(mark)}
                          size="content"
                          unstyled
                          variant="ghost"
                        >
                          <span
                            className={`vds-pdf-annotation-text min-w-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-lh-body-lv1)] line-clamp-3${expanded ? ' is-expanded !block !overflow-visible !line-clamp-none' : ''}`}
                          >
                            {mark.text}
                          </span>
                        </Button>
                      ) : null}
                      {mark.style !== 'comment' && expandable ? (
                        <Button
                          aria-expanded={expanded}
                          className="mt-[var(--vds-space-1)] px-0 text-[var(--vds-brand-text-primary)]"
                          size="xs"
                          variant="ghost"
                          onClick={() => toggleExpanded(mark.id)}
                        >
                          {expanded ? t('pdfAnnotation.collapse') : t('pdfAnnotation.expand')}
                        </Button>
                      ) : null}
                      {editor?.id === mark.id && editor.mode === 'comment' && renderEditor ? (
                        <div
                          className="mt-[var(--vds-space-2)]"
                          data-testid="pdf-annotation-inline-comment-editor"
                        >
                          <div className="mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                            {t('pdfAnnotation.comment')}
                          </div>
                          {renderEditor(mark, () => setEditor(null), 'comment', true)}
                        </div>
                      ) : (
                        markComments.map((comment) => {
                          const commentExpanded = expandedComments.has(comment.id)
                          const commentExpandable =
                            comment.body.length > 96 || comment.body.split(/\r?\n/u).length > 4
                          return (
                            <div
                              className="mt-[var(--vds-space-2)]"
                              data-testid="pdf-annotation-comment-content"
                              key={comment.id}
                            >
                              <div
                                className="mb-[var(--vds-space-1)] flex items-center justify-between text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
                                data-testid="pdf-annotation-comment-caption"
                              >
                                <span className="font-[var(--vds-fw-regular)]">
                                  {t('pdfAnnotation.comment')}
                                </span>
                                <div className="flex items-center">
                                  <CopyButton
                                    className="!text-[var(--vds-icon-outline-default)]"
                                    iconOnly
                                    icon={<Copy size={16} />}
                                    copiedIcon={<Check size={12} />}
                                    feedbackDuration={COMMENT_COPY_FEEDBACK_DURATION_MS}
                                    value={comment.body}
                                    writeText={writeClipboard}
                                    size="xs"
                                    variant="ghost"
                                    idleLabel={t('pdfAnnotation.copyComment')}
                                  />
                                </div>
                              </div>
                              <Button
                                className="block h-auto w-full cursor-pointer select-text! rounded-[var(--vds-radius-2)] p-0 text-left focus-visible:shadow-[var(--vds-focus-brand)]"
                                onClick={() => onFocus(mark)}
                                size="content"
                                unstyled
                                variant="ghost"
                              >
                                <span
                                  className={`vds-pdf-annotation-comment m-0 min-w-0 overflow-hidden whitespace-pre-wrap text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-lh-body-lv1)] ${commentExpanded ? 'is-expanded !block !overflow-visible !line-clamp-none' : 'line-clamp-10'}`}
                                >
                                  {comment.body}
                                </span>
                              </Button>
                              {commentExpandable ? (
                                <Button
                                  className="mt-[var(--vds-space-1)] px-0 text-[var(--vds-brand-text-primary)]"
                                  size="xs"
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
                        })
                      )}
                    </article>
                  )
                })}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </ScrollArea>
      {footer ? (
        <div className="shrink-0 border-t border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
          {footer}
        </div>
      ) : null}
    </section>
  )
}
