import { FileText, Info, Paperclip, SquarePen, StickyNote, Trash } from 'lucide-react'
import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import { FileFormatIcon } from '../../components/primitive'
import type { LiteratureDetail as Detail } from '../../contracts/literature'
import {
  isAttachmentAvailable,
  type LiteratureAttachmentSummary,
  type LiteratureFacet,
  type LiteratureUpdate,
} from '../../contracts/literature'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  EmptyState,
  EllipsisText,
  IconButton,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  semanticTagColor,
  semanticTagColorFor,
  SheetContent,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Textarea,
  Tooltip,
  useToast,
} from '../../components/ui'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import {
  LiteratureApiError,
  createLiteratureTag,
  deleteLiteratureAttachment,
  fetchArxivFulltext,
  fetchPaperMeta,
  getLiterature,
  getLiteratureFacets,
  getLiteratureProjects,
  updateLiterature,
  uploadLiteratureAttachment,
} from './api'
import { catalogue, useCatalogue } from './catalog'
import {
  fulltextFailureMessageKey,
  literatureErrorMessage,
  type LiteratureErrorMessage,
} from './error'
import {
  classifyPaperMetaFailure,
  canSyncMetadata,
  PAPER_META_FAILURE_KEYS,
  paperMetaDescriptionKey,
  paperMetaDiff,
  paperMetaFields,
  paperMetaPickedFields,
  paperMetaTitleKey,
  requiresConfirmation,
  selectPaperMetaQuery,
  type PaperMetaDiffRow,
  type PaperMetaMatch,
  type PaperMetaPayload,
} from './metadata'
import { LiteratureNotes } from './Notes'
import { TagPicker } from './Tags'
import { beginDetailRead } from './detail'
import { AttachmentImportDialog } from './Import'
import { latestLiteratureSummary, literatureCollections } from './projection'
import { literatureTasks } from './tasks'
import { loadPdfRecords, subscribePdfRecords, type PdfRecordSnapshot } from '../workbench/api'
import type { LiteratureDocumentSource } from '../../contracts/workbench'

const BIBLIOGRAPHY_TYPES = [
  'article',
  'inproceedings',
  'book',
  'incollection',
  'techreport',
  'phdthesis',
  'mastersthesis',
  'proceedings',
  'inbook',
  'manual',
  'unpublished',
  'booklet',
  'misc',
]
const DETAIL_SHEET_CLASS = [
  '!absolute !m-0 !w-[min(var(--vds-sheet-side-width),100%)] !min-w-0 flex-none flex flex-col text-[var(--vds-text-primary)]',
  '!gap-0 !overflow-hidden !rounded-none !border-0 !bg-[var(--vds-bg-gray-default)] !p-0',
  '!shadow-[var(--vds-shadow-3-left)]',
].join(' ')
const DETAIL_VALUE_TEXT_CLASS =
  'min-w-0 overflow-hidden whitespace-normal break-words text-[length:var(--vds-font-body-lv2)] font-normal leading-[22px] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]'
const DETAIL_VALUE_ROW_CLASS =
  'flex items-start gap-[var(--vds-library-detail-value-gap)] border-b border-[var(--vds-border-default)] py-[var(--vds-library-detail-value-padding-block)] text-[length:var(--vds-font-body-lv2)]'
const DETAIL_VALUE_LABEL_CLASS =
  'min-w-[var(--vds-library-detail-label-width)] max-w-[var(--vds-library-detail-label-max-width)] flex-[0_0_auto] overflow-hidden text-ellipsis whitespace-nowrap pt-[var(--vds-library-detail-label-padding-top)] text-[var(--vds-text-tertiary)]'
const DETAIL_VALUE_CONTENT_CLASS =
  'min-w-0 flex-[1_1_auto] break-words font-[var(--vds-library-detail-value-weight)] leading-[var(--vds-library-detail-value-line-height)] [overflow-wrap:anywhere]'
const DETAIL_SECTION_CLASS =
  'mx-[var(--vds-library-detail-section-margin-inline)] border-b border-[var(--vds-border-default)] px-[var(--vds-library-detail-section-padding-inline)] py-[var(--vds-library-detail-section-padding-block)]'
const DETAIL_SECTION_HEADING_CLASS =
  'mb-[var(--vds-library-detail-section-heading-margin-bottom)] mt-0 text-[length:var(--vds-font-body-lv2)]'
const DETAIL_SECTION_CONTENT_CLASS =
  'flex flex-wrap gap-[var(--vds-library-detail-section-content-gap)]'
const DETAIL_HEADER_CLASS =
  'flex items-start gap-[var(--vds-space-2)] border-b border-[var(--vds-border-default)] px-[var(--vds-library-detail-header-padding-inline)] pt-[var(--vds-library-detail-header-padding-top)] pb-[var(--vds-library-detail-header-padding-bottom)]'
const DETAIL_HEADER_CONTENT_CLASS =
  'flex min-w-0 flex-1 flex-col gap-[var(--vds-library-detail-header-content-gap)]'
const DETAIL_HEADER_TITLE_CLASS =
  'block max-w-full text-[length:var(--vds-library-detail-header-size)]'
const DETAIL_MUTED_CLASS = 'text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]'
const DETAIL_LOADING_CLASS =
  'grid min-h-0 place-items-center p-[var(--vds-library-detail-loading-padding)]'
const DETAIL_BODY_CLASS =
  'overflow-auto px-[var(--vds-library-detail-body-padding-inline)] pt-[var(--vds-library-detail-body-padding-top)] pb-[var(--vds-space-6)]'
type EditableField = keyof Pick<
  Detail,
  | 'citation_key'
  | 'item_type'
  | 'title'
  | 'subtitle'
  | 'creators_display'
  | 'publication_display'
  | 'year'
  | 'published_date'
  | 'abstract'
  | 'doi'
  | 'arxiv'
  | 'isbn'
  | 'url'
  | 'volume'
  | 'number'
  | 'pages'
  | 'publisher'
  | 'address'
>
const API_FIELDS: Record<EditableField, string> = {
  citation_key: 'citation_key',
  item_type: 'item_type',
  title: 'title',
  subtitle: 'subtitle',
  creators_display: 'authors',
  publication_display: 'publication',
  year: 'year',
  published_date: 'published_date',
  abstract: 'abstract',
  doi: 'doi',
  arxiv: 'arxiv',
  isbn: 'isbn',
  url: 'url',
  volume: 'volume',
  number: 'number',
  pages: 'pages',
  publisher: 'publisher',
  address: 'address',
}
const DETAIL_TAB = {
  info: 'info',
  attachments: 'attachments',
  notes: 'notes',
} as const
type DetailTab = (typeof DETAIL_TAB)[keyof typeof DETAIL_TAB]
/**
 * 打开详情时附带的一次性意图: 直接进新建笔记, 或直接唤起附件选择器。
 *
 * nonce 让「面板已经开着同一条文献」时也能重新触发 —— 那时 id 不变, 只有 nonce 变。
 */
export interface LiteratureDetailIntent {
  action: 'attachment' | 'note'
  nonce: number
}
type DetailFailureKind = 'fulltext' | 'upload'
type IdentifierField = 'doi' | 'arxiv'
const DETAIL_TAB_TRIGGER_CLASS =
  'min-w-0 flex-1 overflow-hidden whitespace-nowrap px-[var(--vds-space-1)]'

const SYNC_PREVIEW_LABEL_CLASS =
  'text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]'
const SYNC_PREVIEW_VALUE_CLASS = [
  'min-w-0 text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]',
  '[overflow-wrap:anywhere]',
].join(' ')
const PANEL_AFFECTING_FIELDS = new Set(['item_type', 'publication', 'year'])
const PANEL_AFFECTING_RELATIONS: Array<keyof LiteratureUpdate> = [
  'collection_ids',
  'tag_ids',
  'project_ids',
  'project_collection_ids',
]

const updateAffectsPanel = (update: LiteratureUpdate): boolean =>
  PANEL_AFFECTING_RELATIONS.some((key) => update[key] !== undefined) ||
  Object.keys(update.fields ?? {}).some((field) => PANEL_AFFECTING_FIELDS.has(field))

/**
 * 确认对话框里的逐字段新旧对比。
 *
 * 填充是用户的主权: 每行给出当前值与命中值, 勾选哪些就写哪些, 未勾选的保持现值;
 * 与当前值相同的行默认不勾选, 避免「确认」变成一次无意义的原值重写。
 */
function PaperMetaDiffView({
  rows,
  selected,
  onToggle,
}: {
  item: Detail
  rows: PaperMetaDiffRow[]
  selected: ReadonlySet<string>
  onToggle: (field: string, checked: boolean) => void
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  return (
    <div className="grid gap-[var(--vds-space-2)]" data-testid="literature-sync-match">
      {rows.map((row) => (
        <div
          key={row.field}
          className="grid gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-2)]"
        >
          <Checkbox
            checked={selected.has(row.field)}
            label={literature(row.labelKey as 'columns.title')}
            onCheckedChange={(checked) => onToggle(row.field, checked)}
          />
          <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-[var(--vds-space-2)] gap-y-[var(--vds-space-1)]">
            <dt className={SYNC_PREVIEW_LABEL_CLASS}>{literature('detail.sync.currentValue')}</dt>
            <dd className={`${SYNC_PREVIEW_VALUE_CLASS} m-0`}>{row.current || '—'}</dd>
            <dt className={SYNC_PREVIEW_LABEL_CLASS}>{literature('detail.sync.nextValue')}</dt>
            <dd className={`${SYNC_PREVIEW_VALUE_CLASS} m-0`}>{row.next}</dd>
          </dl>
        </div>
      ))}
    </div>
  )
}

const STATUS_CARD_CLASS =
  'flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border p-[var(--vds-space-3)]'
/**
 * 卡片配色沿用设计系统的状态语义: notice 是「提示」, warning 才是「需要处理的异常」。
 * 同步元数据是随时可用的常规操作, 因此走 info(notice) 而不是黄色 warning。
 * 边框色与底色由 tone 单独给全, 避免同一元素上两套 bg/border 任意值互相覆盖。
 */
type StatusCardTone = 'default' | 'info' | 'warning'
const STATUS_CARD_TONE_CLASS: Record<StatusCardTone, string> = {
  default: 'border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]',
  info: 'border-[var(--vds-notice-light-border)] bg-[var(--vds-notice-light-bg-default)]',
  warning: 'border-[var(--vds-warning-light-border)] bg-[var(--vds-warning-light-bg-default)]',
}
const STATUS_CARD_ICON_TONE_CLASS: Record<StatusCardTone, string> = {
  default: 'text-[var(--vds-text-secondary)]',
  info: 'text-[var(--vds-notice-text-primary)]',
  warning: 'text-[var(--vds-warning-text-primary)]',
}
const FULLTEXT_ROW_CLASS =
  'grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]'
const FULLTEXT_NAME_CLASS =
  'flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-nowrap text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]'
const STATUS_CARD_REASON_CLASS =
  'block text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)] [overflow-wrap:anywhere]'
const attachmentNameParts = (name: string): { basename: string; suffix: string } => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { basename: name, suffix: '' }
  return { basename: name.slice(0, dot), suffix: name.slice(dot) }
}
/**
 * 状态提示卡: 只常驻简短状态与操作, 原因与处理方式收在悬停/键盘聚焦里;
 * 触屏没有 hover, 原因改为常驻一行, 保证无指针设备也读得到「为什么」。
 */
function StatusCard({
  icon,
  title,
  reason,
  failure,
  tone = 'default',
  testId,
  children,
}: {
  icon: React.ReactNode
  title: string
  reason?: string
  failure?: string
  tone?: StatusCardTone
  testId?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const cardClassName = `${STATUS_CARD_CLASS} ${STATUS_CARD_TONE_CLASS[tone]}`
  const iconClassName = STATUS_CARD_ICON_TONE_CLASS[tone]
  const iconNode = <span className={`inline-flex shrink-0 ${iconClassName}`}>{icon}</span>
  return (
    <div className={cardClassName} data-testid={testId}>
      {reason ? (
        <Tooltip align="start" content={reason} portalled side="bottom">
          {iconNode}
        </Tooltip>
      ) : (
        iconNode
      )}
      <div className="min-w-0 flex-1">
        <strong className="block text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
          {title}
        </strong>
        {failure ? <small className={STATUS_CARD_REASON_CLASS}>{failure}</small> : null}
        {reason ? (
          <>
            <small className={`${STATUS_CARD_REASON_CLASS} [@media(hover:hover)]:hidden`}>
              {reason}
            </small>
            <span className="sr-only">{literature('detail.sync.reasonLabel')}</span>
          </>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-[var(--vds-space-1)]">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function DeleteAttachmentDialog({
  itemId,
  target,
  onDeleted,
  onOpenChange,
}: {
  itemId: string
  target: LiteratureAttachmentSummary | null
  onDeleted: (target: LiteratureAttachmentSummary) => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null)
          onOpenChange(false)
        }
      }}
    >
      <DialogPortal>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{literature('detail.deleteAttachment')}</DialogTitle>
            <DialogDescription>
              {literature('detail.deleteDescription', {
                name: target?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert
              tone="error"
              title={literature('detail.deleteAttachmentFailed')}
              description={error.detail ?? literature(error.key)}
            />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {ui('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!target) return
                void deleteLiteratureAttachment(itemId, target.id)
                  .then(() => {
                    onDeleted(target)
                    onOpenChange(false)
                  })
                  .catch((reason) =>
                    setError(
                      literatureErrorMessage(
                        reason instanceof LiteratureApiError ? reason.failure.code : undefined,
                        reason instanceof Error ? reason.message : undefined,
                        'detail.deleteAttachmentFailed'
                      )
                    )
                  )
              }}
            >
              {literature('batch.confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

function literatureDocumentSource(
  literatureId: string,
  attachment: LiteratureAttachmentSummary
): LiteratureDocumentSource {
  return {
    kind: 'literature',
    literatureId,
    attachmentId: attachment.id,
    recordTarget: attachment.record_target,
    path: attachment.name,
    mediaType: attachment.media_type,
  }
}

function AttachmentMarks({
  source,
  onOpen,
}: {
  source: LiteratureDocumentSource
  onOpen: (page: number) => void
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const [snapshot, setSnapshot] = useState<PdfRecordSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [expandedMarks, setExpandedMarks] = useState<Set<string>>(new Set())
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set())
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
  useEffect(() => {
    let active = true
    const unsubscribe = subscribePdfRecords(source, (records) => {
      if (active) {
        setSnapshot(records)
        setLoaded(true)
      }
    })
    void loadPdfRecords(source)
      .then((records) => {
        if (active) setSnapshot(records)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [source.attachmentId, source.literatureId])
  if (!snapshot)
    return loaded ? (
      <small>{literature('attachment.marksLoadFailed')}</small>
    ) : (
      <Spinner aria-label={literature('attachment.marksLoading')} />
    )
  const marks = snapshot.records.marks
  const comments = snapshot.records.comments
  return (
    <div className="lit-attachment-marks grid gap-[var(--vds-space-2)]">
      {marks.length ? (
        marks.map((mark) => {
          const expanded = expandedMarks.has(mark.id)
          const expandable = mark.text.length > 96 || mark.text.split(/\r?\n/u).length > 4
          const markComments = comments.filter((comment) => comment.mark_id === mark.id)
          const hasComments = markComments.length > 0
          return (
            <article
              className="lit-attachment-mark-card w-full min-w-0 p-[var(--vds-space-3)] border border-[var(--vds-border-default)] rounded-[var(--vds-radius-5)] bg-[var(--vds-bg-white-default)] text-left whitespace-normal"
              key={mark.id}
            >
              <Button
                className="lit-attachment-mark-open !h-auto w-full min-w-0 !justify-start !items-stretch !flex-col gap-[var(--vds-space-2)] !p-0 !text-left whitespace-normal"
                variant="ghost"
                disabled={mark.anchor_state === 'stale'}
                onClick={() => onOpen(mark.page)}
              >
                <Badge className="lit-attachment-mark-page w-fit max-w-full">
                  {mark.anchor_state === 'stale'
                    ? literature('attachment.sourceChanged')
                    : literature('attachment.page', { page: mark.page })}
                </Badge>
                {hasComments ? (
                  <span className="lit-attachment-mark-label block w-full text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                    {literature('attachment.sourceLabel')}
                  </span>
                ) : null}
                <span
                  className={`lit-attachment-mark-text line-clamp-4 min-w-0 w-full whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-library-attachment-mark-line-height)] text-[var(--vds-text-primary)] [&.is-source]:pl-[var(--vds-space-2)] [&.is-source]:border-l-2 [&.is-source]:border-[var(--vds-border-default)] [&.is-expanded]:block [&.is-expanded]:overflow-visible [&.is-expanded]:[-webkit-line-clamp:unset]${hasComments ? ' is-source' : ''}${expanded ? ' is-expanded' : ''}`}
                >
                  {mark.text}
                </span>
              </Button>
              {expandable ? (
                <Button
                  className="lit-attachment-mark-toggle mt-[var(--vds-space-2)] px-0"
                  size="sm"
                  variant="ghost"
                  onClick={() => toggleExpanded(mark.id)}
                >
                  {expanded
                    ? literature('attachment.collapseMark')
                    : literature('attachment.expandMark')}
                </Button>
              ) : null}
              {markComments.map((comment) => {
                const commentExpanded = expandedComments.has(comment.id)
                const commentExpandable =
                  comment.body.length > 96 || comment.body.split(/\r?\n/u).length > 4
                return (
                  <div
                    className="lit-attachment-mark-comment mt-[var(--vds-space-3)] p-[var(--vds-space-3)] rounded-[var(--vds-radius-5)] bg-[var(--vds-brand-light-bg-default)]"
                    key={comment.id}
                  >
                    <span className="lit-attachment-mark-label block w-full text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                      {literature('attachment.commentLabel')}
                    </span>
                    <span
                      className={`lit-attachment-mark-comment-text mt-[var(--vds-space-1)] line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] leading-[var(--vds-library-attachment-mark-line-height)] text-[var(--vds-text-primary)] [&.is-expanded]:block [&.is-expanded]:overflow-visible [&.is-expanded]:[-webkit-line-clamp:unset]${commentExpanded ? ' is-expanded' : ''}`}
                    >
                      {comment.body}
                    </span>
                    {commentExpandable ? (
                      <Button
                        className="lit-attachment-mark-toggle mt-[var(--vds-space-2)] px-0"
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleCommentExpanded(comment.id)}
                      >
                        {commentExpanded
                          ? literature('attachment.collapseAnnotation')
                          : literature('attachment.expandAnnotation')}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </article>
          )
        })
      ) : (
        <small className={DETAIL_MUTED_CLASS}>{literature('attachment.noMarks')}</small>
      )}
    </div>
  )
}

function EditableValue({
  field,
  item,
  label,
  multiline = false,
  focusNonce = 0,
  trailing,
  onSave,
}: {
  field: EditableField
  item: Detail
  label: string
  multiline?: boolean
  focusNonce?: number
  trailing?: React.ReactNode
  onSave: (update: LiteratureUpdate) => Promise<void>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const original = item[field]
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(original ?? ''))
  const wrapper = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!editing) setValue(String(original ?? ''))
  }, [editing, original])
  // 补充标识入口要把用户带到对应编辑区: 进入编辑态 (输入框自带 autoFocus),
  // 滚动到可视区, 但不额外加外层高亮框。
  useEffect(() => {
    if (!focusNonce) return
    setEditing(true)
    wrapper.current?.scrollIntoView({ block: 'center' })
  }, [focusNonce])
  const commit = async (): Promise<void> => {
    if (!editing) return
    setEditing(false)
    const normalized = field === 'year' ? (value.trim() ? Number(value) : null) : value.trim()
    if (normalized === original || (normalized === '' && original == null)) return
    await onSave({ fields: { [API_FIELDS[field]]: normalized } })
  }
  return (
    <div ref={wrapper} className={DETAIL_VALUE_ROW_CLASS}>
      <span
        className={`${DETAIL_VALUE_LABEL_CLASS}${multiline ? ' max-w-[var(--vds-library-detail-label-wide-max-width)]' : ''}`}
      >
        {label}
      </span>
      {editing ? (
        multiline ? (
          <Textarea
            autoFocus
            aria-label={literature('detail.edit', { label })}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <Input
            autoFocus
            aria-label={literature('detail.edit', { label })}
            type={field === 'year' ? 'number' : 'text'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit()
              if (event.key === 'Escape') setEditing(false)
            }}
          />
        )
      ) : (
        <div className="flex min-w-0 w-full flex-1 items-start gap-[var(--vds-space-2)]">
          <Button
            variant="ghost"
            size="content"
            className="lit-detail-edit flex-1 w-auto min-w-0 min-h-[var(--vds-library-detail-edit-min-height)] p-[var(--vds-library-detail-edit-padding)] items-start justify-between text-left [&_svg]:mt-[var(--vds-space-1)] [&_svg]:opacity-0 hover:[&_svg]:opacity-[var(--vds-opacity-full)] focus-visible:[&_svg]:opacity-[var(--vds-opacity-full)]"
            onClick={() => setEditing(true)}
          >
            <strong className={DETAIL_VALUE_TEXT_CLASS}>{String(original ?? '') || '—'}</strong>
            <SquarePen size={12} />
          </Button>
          {trailing}
        </div>
      )}
    </div>
  )
}

function RelationDialog({
  facets,
  item,
  kind,
  projectScoped,
  onClose,
  onSave,
}: {
  facets: LiteratureFacet[]
  item: Detail
  kind: 'projects' | 'collections' | 'tags' | null
  projectScoped: boolean
  onClose: () => void
  onSave: (update: LiteratureUpdate) => Promise<void>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const values =
    kind === 'projects'
      ? [...item.projects, ...item.project_collections].map((entry) => entry.id)
      : kind === 'collections' && projectScoped
        ? item.project_collections.map((entry) => entry.id)
        : kind
          ? item[kind].map((entry) => entry.id)
          : []
  const [selected, setSelected] = useState<Set<string>>(new Set(values))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    setSelected(new Set(values))
  }, [item, kind, projectScoped])
  const children = new Map<string | null, LiteratureFacet[]>()
  facets.forEach((facet) => {
    const parent = facet.parent_id ?? null
    children.set(parent, [...(children.get(parent) ?? []), facet])
  })
  const tree = (parent: string | null): React.JSX.Element[] =>
    (children.get(parent) ?? []).map((facet) => {
      const descendants = children.get(facet.id) ?? []
      return (
        <React.Fragment key={facet.id}>
          <div className="flex min-w-0 items-center gap-1">
            {descendants.length ? (
              <IconButton
                label={
                  expanded.has(facet.id)
                    ? literature('relations.collapse')
                    : literature('relations.expand')
                }
                size="sm"
                variant="ghostIcon"
                icon={
                  <Icon
                    name={expanded.has(facet.id) ? 'chevron-down' : 'chevron-right'}
                    size={12}
                  />
                }
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(facet.id)) next.delete(facet.id)
                    else next.add(facet.id)
                    return next
                  })
                }
              />
            ) : (
              <span className="w-6" />
            )}
            <Checkbox
              key={facet.id}
              checked={selected.has(facet.id)}
              label={facet.name}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current)
                  if (checked) {
                    next.add(facet.id)
                    if (kind === 'projects' && facet.project_id) next.add(facet.project_id)
                  } else {
                    next.delete(facet.id)
                    if (kind === 'projects' && !facet.project_id) {
                      facets
                        .filter((entry) => entry.project_id === facet.id)
                        .forEach((entry) => next.delete(entry.id))
                    }
                  }
                  return next
                })
              }
            />
          </div>
          {expanded.has(facet.id) ? <div className="ml-4">{tree(facet.id)}</div> : null}
        </React.Fragment>
      )
    })
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPortal>
        <DialogContent className="lit-relation-dialog w-[var(--vds-library-relation-dialog-width)] max-h-[var(--vds-library-relation-dialog-max-height)]">
          <DialogHeader>
            <DialogTitle>
              {kind === 'projects'
                ? literature('relations.projects')
                : kind === 'collections'
                  ? literature('relations.collections')
                  : literature('relations.tags')}
            </DialogTitle>
            <DialogDescription>{literature('relations.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea
            className="max-h-[min(420px,55vh)] rounded-lg border border-[var(--vds-border-default)]"
            viewportClassName="flex flex-col gap-2 p-3"
          >
            {facets.length === 0 ? (
              <small>{literature('detail.noOptions')}</small>
            ) : kind === 'tags' ? (
              facets.map((facet) => (
                <Checkbox
                  key={facet.id}
                  checked={selected.has(facet.id)}
                  label={facet.name}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(facet.id)
                      else next.delete(facet.id)
                      return next
                    })
                  }
                />
              ))
            ) : (
              tree(null)
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {ui('cancel')}
            </Button>
            <Button
              onClick={() =>
                void onSave(
                  kind === 'projects'
                    ? {
                        project_ids: facets
                          .filter((facet) => !facet.project_id && selected.has(facet.id))
                          .map((facet) => facet.id),
                        project_collection_ids: facets
                          .filter((facet) => facet.project_id && selected.has(facet.id))
                          .map((facet) => facet.id),
                      }
                    : kind === 'collections'
                      ? { collection_ids: [...selected] }
                      : { tag_ids: [...selected] }
                )
              }
            >
              {literature('relations.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

/**
 * 标签区块: 已关联标签以 chip 展示, × 仅解除与当前文献的关联 (不删除标签);
 * 右上角 + 打开 popover, 勾选即关联/取消, 底部输入回车创建新标签并直接关联。
 */
function TagSection({
  item,
  tags,
  onCreate,
  onSave,
}: {
  item: Detail
  tags: LiteratureFacet[]
  onCreate: (name: string) => Promise<void>
  onSave: (update: LiteratureUpdate) => Promise<void>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const linked = new Set(item.tags.map((tag) => tag.id))
  const toggle = (target: { id: string }): Promise<void> => {
    const next = item.tags.filter((tag) => tag.id !== target.id).map((tag) => tag.id)
    if (!linked.has(target.id)) next.push(target.id)
    return onSave({ tag_ids: next })
  }
  return (
    <section className={DETAIL_SECTION_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-library-detail-section-content-gap)]">
        <h3 className={`${DETAIL_SECTION_HEADING_CLASS} !m-0`}>{literature('panel.tags')}</h3>
        <TagPicker tags={tags} linked={linked} onToggle={toggle} onCreate={onCreate} />
      </div>
      <div className={DETAIL_SECTION_CONTENT_CLASS}>
        {item.tags.length ? (
          item.tags.map((value) => {
            const facet = tags.find((tag) => tag.id === value.id || tag.name === value.name)
            return (
              <Tag
                key={value.id}
                closeLabel={literature('detail.removeTag')}
                color={semanticTagColor(facet?.color) ?? semanticTagColorFor(facet?.id ?? value.id)}
                onClose={() => toggle(value)}
              >
                {value.name}
              </Tag>
            )
          })
        ) : (
          <small className={DETAIL_MUTED_CLASS}>{literature('panel.noTags')}</small>
        )}
      </div>
    </section>
  )
}

export function LiteratureDetail({
  id,
  attachmentId,
  intent,
  onClose,
  onIntentConsumed,
  onItemUpdated,
}: {
  id: string | null
  attachmentId: string | null
  intent?: LiteratureDetailIntent | null
  onClose: () => void
  /** 意图已落地 (选择器已唤起 / 新笔记已开); 列表据此回收它那份意图。 */
  onIntentConsumed?: () => void
  onItemUpdated: (item: Detail) => void
}): React.JSX.Element | null {
  const { t: literature } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const { act, state } = useApp()
  const { toast } = useToast()
  const format = createFormatters(state.lang)
  const projectId = state.homeSelectedProjectId ?? undefined
  const [item, setItem] = useState<Detail | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)
  const [collections, setCollections] = useState<LiteratureFacet[]>([])
  const [tags, setTags] = useState<LiteratureFacet[]>([])
  const [projects, setProjects] = useState<LiteratureFacet[]>([])
  const [relation, setRelation] = useState<'projects' | 'collections' | 'tags' | null>(null)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  // 忙状态来自进程内登记表而不是本地 state: 关掉面板再打开时组件会重挂, 但请求还在飞,
  // 按钮必须继续显示忙, 也不能让用户再点一次把同一个 DOI 重复下载一遍。
  useSyncExternalStore(literatureTasks.subscribe, literatureTasks.getSnapshot)
  const [arxivError, setArxivError] = useState<LiteratureErrorMessage | null>(null)
  const [failureKind, setFailureKind] = useState<DetailFailureKind>('fulltext')
  const [uploading, setUploading] = useState<'primary' | 'attachment' | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [copyProject, setCopyProject] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<LiteratureAttachmentSummary | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>(DETAIL_TAB.info)
  // 待落地的意图: 目标 tab 与 (笔记场景) 编辑器都挂好之后才算消费完。
  const [pendingIntent, setPendingIntent] = useState<LiteratureDetailIntent | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMatch, setSyncMatch] = useState<PaperMetaMatch | null>(null)
  const [syncPicked, setSyncPicked] = useState<Set<string>>(new Set())
  const [syncMissed, setSyncMissed] = useState(false)
  const [identifierFocus, setIdentifierFocus] = useState<{
    field: IdentifierField
    nonce: number
  } | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const primaryInput = useRef<HTMLInputElement>(null)
  const attachmentInput = useRef<HTMLInputElement>(null)
  const updateQueue = useRef<Promise<void>>(Promise.resolve())
  const detailIdentity = useRef({ id, projectId })
  detailIdentity.current = { id, projectId }
  const itemRef = useRef<Detail | null>(null)
  itemRef.current = item
  // 本实例已经负责收尾的任务: 自己发起的、以及重开面板时续接上的, 都不再重复处理结果。
  const ownedTasks = useRef(new Set<Promise<unknown>>())
  // 结果收尾函数定义在下面那个早返回之后, 所以渲染期挂到 ref 上 (与 detailIdentity 同形),
  // 续接用的 effect 才能在早返回之前声明。成功和失败都要接: 只接成功的话, 重开面板后
  // 任务失败就只剩一个悄悄变回可点的按钮, 用户不知道发生过什么。
  const resumeFulltext = useRef<(detail: Detail) => void>(() => {})
  const resumeMetadata = useRef<(payload: PaperMetaPayload) => void>(() => {})
  const failFulltext = useRef<(reason: unknown) => void>(() => {})
  const failMetadata = useRef<(reason: unknown) => void>(() => {})
  const { reload } = useCatalogue()
  const syncedReload = useRef(reload)
  useEffect(() => {
    if (!id) return
    setItem(null)
    setDetailTab(DETAIL_TAB.info)
    setError(null)
    setArxivError(null)
    setFailureKind('fulltext')
    setSyncing(false)
    setSyncMatch(null)
    setSyncPicked(new Set())
    setSyncMissed(false)
    setIdentifierFocus(null)
    setDeleteTarget(null)
    return beginDetailRead(
      () =>
        Promise.all([
          getLiterature(id, projectId),
          getLiteratureFacets({ project_id: projectId }),
          getLiteratureProjects(),
        ]),
      ([detail, facets, projectResult]) => {
        setItem(detail)
        setCollections(facets.collections)
        setTags(facets.tags)
        setCopyProject((current) => {
          const available = projectResult.projects.map((project) => project.id)
          if (current && available.includes(current)) return current
          if (state.homeSelectedProjectId && available.includes(state.homeSelectedProjectId))
            return state.homeSelectedProjectId
          return available.length === 1 ? available[0] : ''
        })
        setProjects(
          projectResult.projects.flatMap((project) => [
            { id: project.id, name: project.name, count: project.count },
            ...project.collections.map((collection) => ({
              ...collection,
              project_id: project.id,
              parent_id: collection.parent_id ?? project.id,
            })),
          ])
        )
      },
      (reason: unknown) => {
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'detail.loadFailed'
          )
        )
      }
    )
  }, [id, projectId, loadRevision])
  // 面板外的变更 (左侧标签管理删除/列表批量操作) 通过 catalogue.reload 广播;
  // 这里静默重取题录与 facets, 让已关联 chip 和 popover 列表同步移除失效标签。
  useEffect(() => {
    if (syncedReload.current === reload) return
    syncedReload.current = reload
    if (!id) return
    return beginDetailRead(
      () =>
        Promise.all([getLiterature(id, projectId), getLiteratureFacets({ project_id: projectId })]),
      ([detail, facets]) => {
        setItem(detail)
        setCollections(facets.collections)
        setTags(facets.tags)
        setError(null)
      },
      (reason: unknown) => {
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'detail.loadFailed'
          )
        )
      }
    )
  }, [id, projectId, reload, loadRevision])
  // 换文献/换项目时, 上一个条目遗留的续接登记不再有意义。
  useEffect(() => {
    ownedTasks.current.clear()
  }, [id, projectId])
  /**
   * 接住列表右键菜单递来的意图: 先把 tab 切到位, 再登记待落地动作。
   *
   * 必须排在载入 effect 之后 —— 换文献时那个 effect 会把 tab 复位成基本信息,
   * 同一轮提交里后声明者胜出, 意图才不会被复位盖掉。
   */
  useEffect(() => {
    if (!id || !intent) return
    setDetailTab(intent.action === 'note' ? DETAIL_TAB.notes : DETAIL_TAB.attachments)
    setPendingIntent(intent)
  }, [id, intent])
  const consumeIntent = useCallback((): void => {
    setPendingIntent(null)
    onIntentConsumed?.()
  }, [onIntentConsumed])
  // 附件意图要等 tab 真正挂上: 隐藏的 file input 只活在附件页里, 早一步 click 打在空 ref 上。
  useEffect(() => {
    if (pendingIntent?.action !== 'attachment' || !item) return
    if (detailTab !== DETAIL_TAB.attachments || !attachmentInput.current) return
    attachmentInput.current.click()
    consumeIntent()
  }, [pendingIntent, item, detailTab, consumeIntent])
  /**
   * 重开面板时续接仍在飞的任务: 忙状态由登记表驱动, 所以按钮接着显示忙; 结果也不丢 ——
   * attach 只挂到已有请求上, 不会为了续接再打一次后端。等 item 载入后再挂, 元数据收尾
   * 要用它算逐字段差异。
   */
  useEffect(() => {
    if (!id || !item) return
    const fulltext = literatureTasks.attach<Detail>(id, 'fulltext')
    if (fulltext && !ownedTasks.current.has(fulltext)) {
      ownedTasks.current.add(fulltext)
      void fulltext.then(
        (detail) => resumeFulltext.current(detail),
        (reason) => failFulltext.current(reason)
      )
    }
    const metadata = literatureTasks.attach<PaperMetaPayload>(id, 'metadata')
    if (metadata && !ownedTasks.current.has(metadata)) {
      ownedTasks.current.add(metadata)
      void metadata.then(
        (payload) => resumeMetadata.current(payload),
        (reason) => failMetadata.current(reason)
      )
    }
  }, [id, projectId, item])
  if (!id) return null
  const fetchingArxiv = literatureTasks.isRunning(id, 'fulltext')
  const metadataRunning =
    literatureTasks.isRunning(id, 'metadata') || literatureTasks.isRunning(id, 'metadata-batch')
  const acceptUpdatedItem = (updated: Detail): void => {
    setItem((current) => (current ? latestLiteratureSummary(current, updated) : updated))
    onItemUpdated(updated)
  }
  const queueLiteratureUpdate = (update: LiteratureUpdate): Promise<Detail | null> => {
    const itemId = id
    const itemProjectId = projectId
    const request = updateQueue.current.then(() => updateLiterature(itemId, update, itemProjectId))
    updateQueue.current = request.then(
      () => undefined,
      () => undefined
    )
    return request.then((updated) =>
      detailIdentity.current.id === itemId && detailIdentity.current.projectId === itemProjectId
        ? updated
        : null
    )
  }
  const isCurrentDetail = (): boolean =>
    detailIdentity.current.id === id && detailIdentity.current.projectId === projectId
  const save = async (update: LiteratureUpdate): Promise<void> => {
    try {
      setError(null)
      const updated = await queueLiteratureUpdate(update)
      if (!updated) return
      acceptUpdatedItem(updated)
      setRelation(null)
      if (updateAffectsPanel(update)) catalogue.reloadPanel()
    } catch (reason) {
      if (!isCurrentDetail()) return
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'detail.saveFailed'
        )
      )
    }
  }
  const editable = (field: EditableField, label: string, multiline = false): React.JSX.Element => (
    <EditableValue
      key={field}
      field={field}
      item={item as Detail}
      label={label}
      multiline={multiline}
      onSave={save}
    />
  )
  /** 创建标签后立刻关联到当前文献; 创建是全库操作, 关联失败不影响标签本身已存在。 */
  const createTag = async (name: string): Promise<void> => {
    try {
      await createLiteratureTag(name)
      const facets = await getLiteratureFacets({ project_id: projectId })
      setTags(facets.tags)
      const created = facets.tags.find((tag) => tag.name === name)
      if (created && item && !item.tags.some((tag) => tag.id === created.id)) {
        await save({ tag_ids: [...item.tags.map((tag) => tag.id), created.id] })
      }
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'panel.error.createFailed'
        )
      )
    }
  }
  /** 全文收尾: 自己点的那次与重开面板续接上的那次走同一条路径。 */
  const acceptFulltext = (detail: Detail): void => {
    if (!isCurrentDetail()) return
    setItem(detail)
    catalogue.reload()
  }
  resumeFulltext.current = acceptFulltext
  /** 全文失败收尾: 自己点的那次与重开面板续接上的那次给出同一条错误。 */
  const rejectFulltext = (reason: unknown): void => {
    if (!isCurrentDetail()) return
    // 获取全文只报三种结果, 文案完全由本地 i18n 决定: 服务端诊断不再上屏 (它只有中文,
    // 而且会把「获取全文失败」拆成十几种说法)。续接路径也要认这是全文失败。
    setFailureKind('fulltext')
    setArxivError({
      key: fulltextFailureMessageKey(
        reason instanceof LiteratureApiError ? reason.failure.code : undefined
      ),
    })
  }
  failFulltext.current = rejectFulltext
  const fetchArxiv = async (): Promise<void> => {
    if (fetchingArxiv) return
    setArxivError(null)
    setFailureKind('fulltext')
    // 登记在进程内: 面板关掉再打开, 按钮仍是忙态, 且不会重复下载同一个 DOI。
    const task = literatureTasks.run(id, 'fulltext', () => fetchArxivFulltext(id))
    ownedTasks.current.add(task)
    try {
      acceptFulltext(await task)
    } catch (reason) {
      rejectFulltext(reason)
    }
  }
  /** 把勾选的命中字段写回文献并刷新详情; 失败时保留待确认项, 让用户能重试而不是白跑一次检索。 */
  const applyMetadata = async (
    fields: NonNullable<LiteratureUpdate['fields']>,
    bibType?: string
  ): Promise<void> => {
    setSyncing(true)
    try {
      const update = { fields, ...(bibType ? { bib_type: bibType } : {}) }
      const updated = await queueLiteratureUpdate(update)
      if (!updated) return
      acceptUpdatedItem(updated)
      setSyncMatch(null)
      setSyncMissed(false)
      if (updateAffectsPanel(update)) catalogue.reloadPanel()
      toast({ title: literature('detail.sync.succeeded'), tone: 'success' })
    } catch (reason) {
      if (!isCurrentDetail()) return
      toast({ title: literature('detail.sync.failed'), tone: 'error' })
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'detail.saveFailed'
        )
      )
    } finally {
      if (isCurrentDetail()) setSyncing(false)
    }
  }
  /**
   * 同步元数据: DOI/arXiv 公开 BibTeX 优先，都没有才按标题检索 OpenAlex，三条腿都免登录。
   *
   * doi/arxiv 是标识符解析, 命中即唯一, 直接落库; title 是模糊匹配, 命中先弹逐字段
   * 对比确认框 (默认只勾选与现值不同的字段) —— 确认与否只看维度, 不看响应形状,
   * 因为 serve 侧三腿同形返回 `{ success, fields, bib_type? }`。上游限流单独提示
   * (用户能行动), 未命中给出补充标识入口, 其余失败一律「同步元数据失败」。
   */
  /**
   * 检索结果收尾: 无命中给补标识入口, 模糊维度弹逐字段确认, 其余直接落库。自己点的那次
   * 与重开面板续接上的那次共用这条路径, 所以确认框在续接后也照常弹出。
   */
  const acceptPaperMeta = async (payload: PaperMetaPayload): Promise<void> => {
    const current = itemRef.current
    if (!current || !isCurrentDetail()) return
    const query = selectPaperMetaQuery(current)
    if (!query) return
    const fields = paperMetaFields(payload)
    if (!Object.keys(fields).length) {
      setSyncMissed(true)
      toast({ title: literature('detail.sync.missed'), tone: 'error' })
      return
    }
    if (requiresConfirmation(query.dimension)) {
      setSyncPicked(
        new Set(
          paperMetaDiff(fields, current)
            .filter((row) => row.current !== row.next)
            .map((row) => row.field)
        )
      )
      setSyncMatch({ fields, bibType: payload.bib_type })
      return
    }
    await applyMetadata(fields, payload.bib_type)
  }
  resumeMetadata.current = (payload) => {
    void acceptPaperMeta(payload)
  }
  /** 检索失败收尾: 限流/未命中/网络各自有可行动的提示, 续接后也必须给出。 */
  const rejectMetadata = (reason: unknown): void => {
    if (!isCurrentDetail()) return
    const kind = classifyPaperMetaFailure(
      reason instanceof LiteratureApiError ? reason.failure : null
    )
    toast({
      title: literature(PAPER_META_FAILURE_KEYS[kind]),
      tone: 'error',
    })
  }
  failMetadata.current = rejectMetadata
  const syncMetadata = async (): Promise<void> => {
    if (!item || syncing || metadataRunning) return
    const query = selectPaperMetaQuery(item)
    if (!query) return
    setError(null)
    // 只把「打注册库」这段登记进进程内: 它是慢的那一段, 也是重开面板后需要续接的那一段。
    const task = literatureTasks.run(id, 'metadata', () => fetchPaperMeta(query))
    ownedTasks.current.add(task)
    try {
      await acceptPaperMeta(await task)
    } catch (reason) {
      rejectMetadata(reason)
    }
  }
  /** 补充标识入口: 切回基本信息并把对应字段推进编辑态 + 短暂高亮。 */
  const focusIdentifier = (field: IdentifierField): void => {
    setDetailTab(DETAIL_TAB.info)
    setIdentifierFocus({ field, nonce: Date.now() })
  }
  const syncQuery = item ? selectPaperMetaQuery(item) : null
  const showSync = Boolean(item && canSyncMetadata(item))
  const fulltextAvailable = isAttachmentAvailable(item?.primary_attachment)
  const hasFulltextIdentifier = (currentItem: Detail): boolean =>
    Boolean(currentItem.doi?.trim() || currentItem.arxiv?.trim())
  type NoFulltextReasonKey =
    'detail.noFulltextReasonArxiv' | 'detail.noFulltextReasonDoi' | 'detail.noFulltextReasonNone'
  const noFulltextReasonKey = (currentItem: Detail): NoFulltextReasonKey => {
    if (currentItem.arxiv?.trim()) return 'detail.noFulltextReasonArxiv'
    if (currentItem.doi?.trim()) return 'detail.noFulltextReasonDoi'
    return 'detail.noFulltextReasonNone'
  }
  /**
   * 无全文提示卡: 状态 (尚无/丢失/失败) + 下一步操作。
   *
   * 与元信息卡同屏时操作降为次级 (需求: 双卡只突出一个主操作, 元信息为主);
   * 「上传全文」是常驻出路 (无标识也能自己补 PDF), 状态自己的动作排在它右边;
   * 失败态额外把真实原因常驻展示。
   */
  const fulltextCard = (currentItem: Detail, secondary: boolean): React.JSX.Element => {
    const lost = currentItem.primary_attachment != null
    const failure = failureKind === 'fulltext' ? arxivError : null
    const actionVariant = secondary ? 'secondary' : undefined
    // 上传全文是这张卡的常驻入口: 没有 DOI/arXiv 也能自己补 PDF, 所以各状态共用同一个
    // 按钮, 状态自己的动作排在它右边。入口只有 primaryInput 一个 (单文件 + 仅 PDF)。
    const uploadFulltext = (
      variant: React.ComponentProps<typeof Button>['variant']
    ): React.JSX.Element => (
      <Button
        size="sm"
        variant={variant}
        loading={uploading === 'primary'}
        onClick={() => primaryInput.current?.click()}
      >
        {literature('detail.uploadFulltext')}
      </Button>
    )
    return (
      <StatusCard
        icon={<StickyNote size={18} />}
        title={
          failure
            ? literature('detail.fulltextFailed')
            : lost
              ? literature('detail.fulltextMissing')
              : literature('detail.noFulltext')
        }
        failure={failure ? literature(failure.key) : undefined}
        reason={
          failure
            ? undefined
            : lost
              ? literature('detail.fulltextMissingDescription')
              : literature(noFulltextReasonKey(currentItem))
        }
      >
        {failure ? (
          <>
            {uploadFulltext('secondary')}
            <Button
              size="sm"
              variant={actionVariant}
              loading={fetchingArxiv}
              onClick={() => void fetchArxiv()}
            >
              {literature('detail.retry')}
            </Button>
          </>
        ) : lost ? (
          uploadFulltext(actionVariant)
        ) : (
          <>
            {uploadFulltext('secondary')}
            {hasFulltextIdentifier(currentItem) ? (
              <Button
                size="sm"
                variant={actionVariant}
                loading={fetchingArxiv}
                onClick={() => void fetchArxiv()}
              >
                {fetchingArxiv ? literature('detail.fetching') : literature('detail.fetchFulltext')}
              </Button>
            ) : (
              <Button size="sm" variant={actionVariant} onClick={() => focusIdentifier('arxiv')}>
                {literature('detail.supplementArxiv')}
              </Button>
            )}
          </>
        )}
      </StatusCard>
    )
  }
  const fulltextRow = (currentItem: Detail): React.JSX.Element | null => {
    const attachment = currentItem.primary_attachment
    if (!attachment || !isAttachmentAvailable(attachment)) return null
    const nameParts = attachmentNameParts(attachment.name)
    return (
      <div className={FULLTEXT_ROW_CLASS} data-testid="literature-fulltext-row">
        <FileText size={18} className="shrink-0 text-[var(--vds-text-secondary)]" />
        <span className={FULLTEXT_NAME_CLASS}>
          <EllipsisText
            className="text-inherit"
            tooltip={attachment.name}
            tooltipPortalled
            tooltipSide="bottom"
            wrapperClassName="min-w-0"
          >
            {nameParts.basename}
          </EllipsisText>
          {nameParts.suffix ? <span className="shrink-0">{nameParts.suffix}</span> : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => act.openLiteratureAttachment(currentItem.id, attachment.id)}
        >
          {ui('open')}
        </Button>
      </div>
    )
  }
  const upload = async (files: readonly File[], primary: boolean): Promise<void> => {
    if (!files.length) return
    setUploading(primary ? 'primary' : 'attachment')
    setFailureKind('upload')
    setArxivError(null)
    try {
      const failures: string[] = []
      for (const file of files) {
        try {
          await uploadLiteratureAttachment(id, file, primary)
        } catch (reason) {
          const failure = literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'detail.uploadFailed'
          )
          failures.push(`${file.name}: ${failure.detail ?? literature(failure.key)}`)
        }
      }
      if (failures.length) {
        setArxivError({ key: 'detail.uploadFailed', detail: failures.join('\n') })
      }
      const detail = await getLiterature(id, projectId)
      setItem(detail)
      catalogue.reload()
    } catch (reason) {
      setArxivError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'detail.uploadFailed'
        )
      )
    } finally {
      setUploading(null)
    }
  }
  const attachment = item?.attachments.find((entry) => entry.id === attachmentId)
  const attachmentSource: LiteratureDocumentSource | null =
    item && attachment ? literatureDocumentSource(item.id, attachment) : null
  const detailStatus = error ? (
    <div className="grid content-start gap-[var(--vds-space-3)] p-[var(--vds-space-4)]">
      <Alert tone="error" title={literature(error.key)} description={error.detail} />
      <Button variant="secondary" onClick={() => setLoadRevision((value) => value + 1)}>
        {literature('detail.retry')}
      </Button>
    </div>
  ) : (
    <div className={DETAIL_LOADING_CLASS}>
      <Spinner aria-label={literature('detail.loading')} />
    </div>
  )
  if (item && attachment)
    return (
      <SheetContent
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className={DETAIL_SHEET_CLASS}
        side="right"
      >
        <header className={DETAIL_HEADER_CLASS}>
          <div className={DETAIL_HEADER_CONTENT_CLASS}>
            <Tooltip content={attachment.name} side="bottom">
              <strong
                id={titleId}
                className={`${DETAIL_HEADER_TITLE_CLASS} truncate`}
                title={attachment.name}
              >
                {attachment.name}
              </strong>
            </Tooltip>
            <span id={descriptionId} className={DETAIL_MUTED_CLASS}>
              {literature('detail.attachment')}
            </span>
          </div>
          <IconButton
            label={literature('detail.close')}
            variant="ghostIcon"
            size="sm"
            icon={<Icon name="close" size={14} />}
            onClick={onClose}
          />
        </header>
        <div className={DETAIL_BODY_CLASS}>
          {isAttachmentAvailable(attachment) ? null : (
            <Alert
              className="mb-[var(--vds-space-3)]"
              tone="warning"
              title={literature('attachment.missingTitle')}
              description={literature('attachment.missingDescription')}
              data-testid="literature-attachment-missing"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => catalogue.focus(item.id)}>
              {literature('detail.backToList')}
            </Button>
            <Button
              disabled={!isAttachmentAvailable(attachment)}
              onClick={() => act.openLiteratureAttachment(item.id, attachment.id)}
            >
              {literature('detail.openAttachment')}
            </Button>
            <Button
              data-testid="literature-copy-to-project"
              variant="secondary"
              onClick={() => setImportOpen(true)}
            >
              {literature('attachment.copyToProject')}
            </Button>
            <IconButton
              label={literature('relations.deleteAttachment')}
              variant="ghostIcon"
              className="enabled:hover:!text-[var(--vds-error-text-primary)] enabled:active:!text-[var(--vds-error-text-primary)] enabled:hover:[&_.vds-icon]:!text-[var(--vds-error-text-primary)] enabled:active:[&_.vds-icon]:!text-[var(--vds-error-text-primary)]"
              icon={<Trash size={16} />}
              onClick={() => setDeleteTarget(attachment)}
            />
            <AttachmentImportDialog
              key={attachment.id}
              open={importOpen}
              onOpenChange={setImportOpen}
              itemId={item.id}
              attachment={attachment}
              projects={projects}
              initialProject={copyProject}
            />
          </div>
          {projects.every((project) => project.project_id) ? (
            <Alert
              className="mt-2"
              tone="info"
              title={literature('attachment.noProjects')}
              description={literature('attachment.noProjectsDescription')}
            />
          ) : null}
          {error ? (
            <Alert
              tone="error"
              title={literature('attachment.operationFailed')}
              description={error.detail ?? literature(error.key)}
            />
          ) : null}
          <div className={DETAIL_VALUE_ROW_CLASS}>
            <span className={DETAIL_VALUE_LABEL_CLASS}>{literature('detail.uploaded')}</span>
            <strong className={DETAIL_VALUE_CONTENT_CLASS}>
              {attachment.created_at
                ? format.date(new Date(attachment.created_at), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : '—'}
            </strong>
          </div>
          <div className={DETAIL_VALUE_ROW_CLASS}>
            <span className={DETAIL_VALUE_LABEL_CLASS}>{literature('detail.format')}</span>
            <strong className={DETAIL_VALUE_CONTENT_CLASS}>{attachment.media_type || '—'}</strong>
          </div>
          <div className={DETAIL_VALUE_ROW_CLASS}>
            <span className={DETAIL_VALUE_LABEL_CLASS}>{literature('detail.size')}</span>
            <strong className={DETAIL_VALUE_CONTENT_CLASS}>
              {attachment.size === null ? '—' : format.bytes(attachment.size)}
            </strong>
          </div>
          <section className={DETAIL_SECTION_CLASS}>
            <h3 className={DETAIL_SECTION_HEADING_CLASS}>
              {literature('detail.marks')} <Badge>{attachment.annotation_count}</Badge>
            </h3>
            {attachmentSource && attachment.media_type === 'application/pdf' ? (
              <AttachmentMarks
                source={attachmentSource}
                onOpen={(page) => act.openLiteratureAttachment(item.id, attachment.id, page)}
              />
            ) : null}
          </section>
          <DeleteAttachmentDialog
            itemId={item.id}
            target={deleteTarget}
            onDeleted={(deleted) => {
              // 附件已经没了, 它开着的全文标签也必须一起收掉:
              // 否则中央区还挂着那份 PDF, 看起来就像主附件仍然存在。
              act.closeLiteratureAttachment(item.id, deleted.id)
              onClose()
              catalogue.reload()
            }}
            onOpenChange={(open) => {
              if (!open) setDeleteTarget(null)
            }}
          />
        </div>
      </SheetContent>
    )
  return (
    <SheetContent aria-labelledby={titleId} className={DETAIL_SHEET_CLASS} side="right">
      <header className={DETAIL_HEADER_CLASS}>
        <div className="min-w-0 flex-1">
          <Tooltip content={item?.title ?? literature('detail.title')} side="bottom">
            <strong
              id={titleId}
              className="line-clamp-2 block max-w-full overflow-hidden text-[length:var(--vds-library-detail-header-size)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]"
            >
              {item?.title ?? literature('detail.title')}
            </strong>
          </Tooltip>
        </div>
        <IconButton
          label={literature('detail.close')}
          variant="ghostIcon"
          size="sm"
          icon={<Icon name="close" size={14} />}
          onClick={onClose}
        />
      </header>
      <Tabs
        className="min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden"
        value={detailTab}
        onValueChange={(value) => setDetailTab(value as DetailTab)}
      >
        <TabsList
          className="mx-[var(--vds-space-3)] mt-[var(--vds-space-3)] mb-0 w-auto self-stretch"
          aria-label={literature('detail.views')}
        >
          <TabsTrigger className={DETAIL_TAB_TRIGGER_CLASS} value={DETAIL_TAB.info}>
            {literature('detail.tabs.info')}
          </TabsTrigger>
          <TabsTrigger className={DETAIL_TAB_TRIGGER_CLASS} value={DETAIL_TAB.attachments}>
            {literature('detail.tabs.attachments')} {item?.attachments.length ?? 0}
          </TabsTrigger>
          <TabsTrigger className={DETAIL_TAB_TRIGGER_CLASS} value={DETAIL_TAB.notes}>
            {literature('detail.tabs.notes')} {item?.note_count ?? 0}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="min-h-0 overflow-hidden" value={DETAIL_TAB.notes}>
          {item ? (
            <LiteratureNotes
              itemId={item.id}
              notes={item.notes ?? []}
              startNew={pendingIntent?.action === 'note' ? pendingIntent.nonce : 0}
              onReload={async () => {
                setItem(await getLiterature(item.id, projectId))
              }}
              onStartNew={consumeIntent}
            />
          ) : detailTab === DETAIL_TAB.notes ? (
            detailStatus
          ) : null}
        </TabsContent>
        <TabsContent className="min-h-0 overflow-hidden" value={DETAIL_TAB.attachments}>
          {!item ? (
            detailTab === DETAIL_TAB.attachments ? (
              detailStatus
            ) : null
          ) : (
            <div className={`${DETAIL_BODY_CLASS} h-full`}>
              {failureKind === 'upload' && arxivError ? (
                <Alert
                  className="mb-[var(--vds-space-3)]"
                  tone="error"
                  title={literature('detail.uploadFailed')}
                  description={arxivError.detail ?? literature(arxivError.key)}
                />
              ) : null}
              <div className="mb-[var(--vds-space-3)] flex items-center justify-between gap-[var(--vds-space-2)]">
                <small className="min-w-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
                  {literature('detail.attachmentTypes')}
                </small>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={uploading === 'attachment'}
                  onClick={() => attachmentInput.current?.click()}
                >
                  {literature('detail.uploadAttachment')}
                </Button>
              </div>
              <Input
                ref={attachmentInput}
                className="hidden"
                type="file"
                multiple
                aria-label={literature('detail.uploadAttachment')}
                disabled={uploading !== null}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  event.target.value = ''
                  void upload(files, false)
                }}
              />
              {item.attachments.length ? (
                <div
                  className="grid gap-[var(--vds-space-2)]"
                  data-testid="literature-detail-attachments"
                >
                  {item.attachments.map((candidate) => {
                    const nameParts = attachmentNameParts(candidate.name)
                    return (
                      <div
                        key={candidate.id}
                        className="lit-detail-attachment-row group/detail-attachment flex min-w-0 items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-1)] py-[var(--vds-space-2)] transition-colors hover:bg-[var(--vds-bg-gray-hover)]"
                        data-testid={`literature-detail-attachment-${candidate.id}`}
                        onDoubleClick={
                          isAttachmentAvailable(candidate)
                            ? () => act.openLiteratureAttachment(item.id, candidate.id)
                            : undefined
                        }
                      >
                        <FileFormatIcon
                          name={candidate.name}
                          className="size-[var(--vds-library-detail-attachment-icon-size)] shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 max-w-full items-baseline text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                            <EllipsisText
                              className="text-inherit"
                              tooltip={candidate.name}
                              tooltipPortalled
                              tooltipSide="bottom"
                              wrapperClassName="min-w-0"
                            >
                              {nameParts.basename}
                            </EllipsisText>
                            {nameParts.suffix ? (
                              <span className="shrink-0">{nameParts.suffix}</span>
                            ) : null}
                          </div>
                          <div className="mt-[var(--vds-library-detail-attachment-meta-margin-top)] flex min-w-0 flex-wrap items-center gap-x-[var(--vds-space-2)] gap-y-[var(--vds-library-detail-attachment-meta-row-gap)] text-[length:var(--vds-library-detail-attachment-meta-font-size)] leading-[var(--vds-library-detail-attachment-meta-line-height)] text-[var(--vds-text-tertiary)]">
                            <span
                              className={
                                candidate.role === 'primary'
                                  ? 'font-[var(--vds-fw-medium)] text-[var(--vds-success-text-primary)]'
                                  : ''
                              }
                            >
                              {candidate.role === 'primary'
                                ? literature('detail.primaryRole')
                                : literature('detail.supplementaryRole')}
                            </span>
                            <span>{candidate.media_type}</span>
                            {candidate.size === null ? null : (
                              <span>{format.bytes(candidate.size)}</span>
                            )}
                            {isAttachmentAvailable(candidate) ? null : (
                              <span className="font-[var(--vds-fw-medium)] text-[var(--vds-error-text-primary)]">
                                {literature('detail.attachmentMissing')}
                              </span>
                            )}
                            {candidate.annotation_count ? (
                              <span>
                                {literature('detail.markCount', {
                                  count: candidate.annotation_count,
                                })}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <span
                          className="lit-row-actions ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)] [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/detail-attachment:opacity-[var(--vds-opacity-full)] [@media(hover:hover)]:group-focus-within/detail-attachment:opacity-[var(--vds-opacity-full)]"
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!isAttachmentAvailable(candidate)}
                            onClick={() => act.openLiteratureAttachment(item.id, candidate.id)}
                          >
                            {ui('open')}
                          </Button>
                          <IconButton
                            label={literature('detail.attachmentDetails')}
                            variant="ghostIcon"
                            size="sm"
                            icon={<Info size={15} />}
                            onClick={() => catalogue.focusAttachment(item.id, candidate.id)}
                          />
                          <IconButton
                            label={literature('relations.deleteAttachment')}
                            variant="ghostIcon"
                            size="sm"
                            className="enabled:hover:!text-[var(--vds-error-text-primary)] enabled:active:!text-[var(--vds-error-text-primary)] enabled:hover:[&_.vds-icon]:!text-[var(--vds-error-text-primary)] enabled:active:[&_.vds-icon]:!text-[var(--vds-error-text-primary)]"
                            icon={<Trash size={15} />}
                            onClick={() => setDeleteTarget(candidate)}
                          />
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={<Paperclip size={18} />}
                  title={literature('detail.noAttachments')}
                  description={literature('detail.noAttachmentsDescription')}
                />
              )}
              <DeleteAttachmentDialog
                itemId={item.id}
                target={deleteTarget}
                onDeleted={(deleted) => {
                  act.closeLiteratureAttachment(item.id, deleted.id)
                  catalogue.reload()
                }}
                onOpenChange={(open) => {
                  if (!open) setDeleteTarget(null)
                }}
              />
            </div>
          )}
        </TabsContent>
        <TabsContent className="min-h-0 overflow-hidden" value={DETAIL_TAB.info}>
          {!item ? (
            detailTab === DETAIL_TAB.info ? (
              detailStatus
            ) : null
          ) : (
            <div className={`${DETAIL_BODY_CLASS} h-full`}>
              {error ? (
                <Alert
                  className="mb-[var(--vds-space-3)]"
                  tone="error"
                  title={literature('detail.saveFailed')}
                  description={
                    error.detail ??
                    (error.key !== 'detail.saveFailed' ? literature(error.key) : undefined)
                  }
                />
              ) : null}
              <div className="mb-[var(--vds-space-3)] grid gap-[var(--vds-space-2)]">
                {showSync && syncQuery ? (
                  <StatusCard
                    testId="literature-sync-banner"
                    icon={<Info size={18} />}
                    title={literature(paperMetaTitleKey(syncQuery.dimension))}
                    tone="info"
                    reason={literature(paperMetaDescriptionKey(syncQuery.dimension))}
                  >
                    {syncMissed ? (
                      <Button size="sm" variant="secondary" onClick={() => focusIdentifier('doi')}>
                        {literature('detail.sync.supplementIdentifier')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      loading={syncing || metadataRunning}
                      icon={<Icon name="refresh" size={14} />}
                      onClick={() => void syncMetadata()}
                    >
                      {literature('detail.sync.action')}
                    </Button>
                  </StatusCard>
                ) : null}
                {!fulltextAvailable ? fulltextCard(item, showSync) : null}
                {fulltextRow(item)}
              </div>
              <Input
                ref={primaryInput}
                className="hidden"
                type="file"
                accept="application/pdf,.pdf"
                aria-label={literature('detail.uploadPdf')}
                disabled={uploading !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void upload([file], true)
                  event.target.value = ''
                }}
              />
              <div className={DETAIL_VALUE_ROW_CLASS}>
                <span className={DETAIL_VALUE_LABEL_CLASS}>{literature('detail.type')}</span>
                <Select
                  aria-label={literature('detail.type')}
                  className="![padding-left:var(--vds-space-3)] min-w-0 flex-[1_1_auto]"
                  value={item.bib_type}
                  onValueChange={(value) => void save({ bib_type: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={literature('detail.chooseType')}>
                      {item.bib_type
                        ? literature(
                            `detail.bibTypes.${item.bib_type}` as 'detail.bibTypes.article'
                          )
                        : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {BIBLIOGRAPHY_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {literature(`detail.bibTypes.${type}` as 'detail.bibTypes.article')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editable('title', literature('columns.title'))}
              {editable('subtitle', literature('columns.subtitle'))}
              {editable('creators_display', literature('columns.creator'))}
              {editable('publication_display', literature('columns.publication'))}
              {editable('year', literature('columns.year'))}
              {editable('published_date', literature('columns.published_date'))}
              {editable('citation_key', literature('columns.citation_key'))}
              <EditableValue
                field="doi"
                item={item}
                label={literature('columns.doi')}
                focusNonce={identifierFocus?.field === 'doi' ? identifierFocus.nonce : 0}
                onSave={save}
              />
              <EditableValue
                field="arxiv"
                item={item}
                label="arXiv"
                focusNonce={identifierFocus?.field === 'arxiv' ? identifierFocus.nonce : 0}
                onSave={save}
              />
              {editable('isbn', literature('columns.isbn'))}
              {editable('url', literature('columns.url'))}
              {editable('volume', literature('columns.volume'))}
              {editable('number', literature('columns.number'))}
              {editable('pages', literature('columns.pages'))}
              {editable('publisher', literature('columns.publisher'))}
              {editable('address', literature('columns.address'))}
              {editable('abstract', literature('columns.abstract'), true)}
              {!projectId ? (
                <section className={DETAIL_SECTION_CLASS}>
                  <h3 className={DETAIL_SECTION_HEADING_CLASS}>
                    {literature('relations.linkedProjects')}
                  </h3>
                  <Button
                    variant="ghost"
                    className="lit-relation-trigger w-full h-auto min-h-[var(--vds-library-relation-trigger-min-height)] p-[var(--vds-space-1)] justify-between"
                    onClick={() => setRelation('projects')}
                  >
                    <div className="flex-1 flex justify-start">
                      {item.projects.length ? (
                        item.projects.map((value) => (
                          <Tag key={value.id} size="small">
                            {value.name}
                          </Tag>
                        ))
                      ) : (
                        <small>{literature('relations.chooseProject')}</small>
                      )}
                    </div>
                    <SquarePen size={12} />
                  </Button>
                </section>
              ) : null}
              <section className={DETAIL_SECTION_CLASS}>
                <h3 className={DETAIL_SECTION_HEADING_CLASS}>
                  {projectId ? literature('panel.collections') : literature('panel.custom')}
                </h3>
                <Button
                  variant="ghost"
                  className="lit-relation-trigger w-full h-auto min-h-[var(--vds-library-relation-trigger-min-height)] p-[var(--vds-space-1)] justify-between"
                  onClick={() => setRelation('collections')}
                >
                  <div className="flex-1 flex justify-start">
                    {literatureCollections(item, projectId).length ? (
                      literatureCollections(item, projectId).map((value) => (
                        <Tag key={value.id} size="small">
                          {value.name}
                        </Tag>
                      ))
                    ) : (
                      <small>{literature('detail.chooseCollection')}</small>
                    )}
                  </div>
                  <SquarePen size={12} />
                </Button>
              </section>
              <TagSection
                item={item}
                tags={tags}
                onCreate={(name) => createTag(name)}
                onSave={save}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
      {item ? (
        <RelationDialog
          facets={
            relation === 'projects' ? projects : relation === 'collections' ? collections : tags
          }
          item={item}
          kind={relation}
          projectScoped={Boolean(projectId)}
          onClose={() => setRelation(null)}
          onSave={(update) =>
            save(
              projectId && update.collection_ids
                ? { project_collection_ids: update.collection_ids }
                : update
            )
          }
        />
      ) : null}
      <Dialog
        open={Boolean(syncMatch)}
        onOpenChange={(open) => {
          if (!open && !syncing) setSyncMatch(null)
        }}
      >
        <DialogPortal>
          <DialogContent className="max-h-[var(--vds-library-relation-dialog-max-height)] grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader>
              <DialogTitle>{literature('detail.sync.confirmTitle')}</DialogTitle>
              <DialogDescription>{literature('detail.sync.confirmDescription')}</DialogDescription>
            </DialogHeader>
            {syncMatch && item ? (
              <div className="min-h-0 overflow-y-auto">
                <PaperMetaDiffView
                  item={item}
                  rows={paperMetaDiff(syncMatch.fields, item)}
                  selected={syncPicked}
                  onToggle={(field, checked) =>
                    setSyncPicked((current) => {
                      const next = new Set(current)
                      if (checked) next.add(field)
                      else next.delete(field)
                      return next
                    })
                  }
                />
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" disabled={syncing} onClick={() => setSyncMatch(null)}>
                {ui('cancel')}
              </Button>
              <Button
                loading={syncing}
                disabled={syncPicked.size === 0}
                onClick={() => {
                  if (syncMatch)
                    void applyMetadata(
                      paperMetaPickedFields(syncMatch.fields, syncPicked),
                      syncMatch.bibType
                    )
                }}
              >
                {literature('detail.sync.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </SheetContent>
  )
}
