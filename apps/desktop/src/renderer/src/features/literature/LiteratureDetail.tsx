import { FileText, Info, Paperclip, SquarePen, StickyNote, Trash } from 'lucide-react'
import React, { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import attachmentIconHtml from '../../assets/icon-html.png'
import attachmentIconImg from '../../assets/icon-img.png'
import attachmentIconMusic from '../../assets/icon-music.png'
import attachmentIconPdf from '../../assets/icon-pdf.png'
import attachmentIconPpt from '../../assets/icon-ppt.png'
import attachmentIconTsx from '../../assets/icon-tsx.png'
import attachmentIconTxt from '../../assets/icon-txt.png'
import attachmentIconUnknown from '../../assets/icon-unknown.png'
import attachmentIconVideo from '../../assets/icon-video.png'
import attachmentIconWord from '../../assets/icon-word.png'
import attachmentIconXls from '../../assets/icon-xls.png'
import attachmentIconZip from '../../assets/icon-zip.png'
import {
  isAttachmentAvailable,
  type LiteratureAttachmentSummary,
  LiteratureDetail as Detail,
  type LiteratureFacet,
  type LiteratureUpdate
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
  Popover,
  PopoverContent,
  PopoverTrigger,
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
  useToast
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
  uploadLiteratureAttachment
} from './api'
import { catalogue, useCatalogue } from './catalog'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'
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
  type PaperMetaMatch
} from './metadata'
import { LiteratureNotes } from './Notes'
import { AttachmentImportDialog } from './Import'
import {
  loadPdfRecords,
  subscribePdfRecords,
  type PdfRecordSnapshot
} from '../workbench/api'
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
  'misc'
]
const DETAIL_SHEET_CLASS = [
  'lit-detail !absolute !m-0 !w-[min(var(--vds-sheet-side-width),100%)] !min-w-[400px]',
  '!gap-0 !overflow-hidden !rounded-none !border-0 !bg-[var(--vds-bg-gray-default)] !p-0',
  '!shadow-[var(--vds-shadow-3-left)]'
].join(' ')
const DETAIL_VALUE_TEXT_CLASS =
  'min-w-0 overflow-visible whitespace-normal break-words text-[length:var(--vds-font-body-lv2)] font-normal leading-[22px] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]'
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
  address: 'address'
}
const DETAIL_TAB = {
  info: 'info',
  attachments: 'attachments',
  notes: 'notes'
} as const
type DetailTab = (typeof DETAIL_TAB)[keyof typeof DETAIL_TAB]
type DetailFailureKind = 'fulltext' | 'upload'
type IdentifierField = 'doi' | 'arxiv'
const DETAIL_TAB_TRIGGER_CLASS =
  'min-w-0 flex-1 overflow-hidden whitespace-nowrap px-[var(--vds-space-1)]'

const SYNC_PREVIEW_LABEL_CLASS =
  'text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]'
const SYNC_PREVIEW_VALUE_CLASS = [
  'min-w-0 text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]',
  '[overflow-wrap:anywhere]'
].join(' ')

/**
 * 确认对话框里的逐字段新旧对比。
 *
 * 填充是用户的主权: 每行给出当前值与命中值, 勾选哪些就写哪些, 未勾选的保持现值;
 * 与当前值相同的行默认不勾选, 避免「确认」变成一次无意义的原值重写。
 */
function PaperMetaDiffView({
  item,
  rows,
  selected,
  onToggle
}: {
  item: Detail
  rows: PaperMetaDiffRow[]
  selected: ReadonlySet<string>
  onToggle: (field: string, checked: boolean) => void
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  return (
    <div
      className="grid gap-[var(--vds-space-2)]"
      data-testid="literature-sync-match"
    >
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
            <dt className={SYNC_PREVIEW_LABEL_CLASS}>
              {literature('detail.sync.currentValue')}
            </dt>
            <dd className={`${SYNC_PREVIEW_VALUE_CLASS} m-0`}>
              {row.current || '—'}
            </dd>
            <dt className={SYNC_PREVIEW_LABEL_CLASS}>
              {literature('detail.sync.nextValue')}
            </dt>
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
  warning: 'border-[var(--vds-warning-light-border)] bg-[var(--vds-warning-light-bg-default)]'
}
const STATUS_CARD_ICON_TONE_CLASS: Record<StatusCardTone, string> = {
  default: 'text-[var(--vds-text-secondary)]',
  info: 'text-[var(--vds-notice-text-primary)]',
  warning: 'text-[var(--vds-warning-text-primary)]'
}
const FULLTEXT_ROW_CLASS =
  'grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]'
const FULLTEXT_NAME_CLASS =
  'flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-nowrap text-[length:var(--vds-font-body-lv1)] font-medium text-[var(--vds-text-primary)]'
const STATUS_CARD_REASON_CLASS =
  'block text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)] [overflow-wrap:anywhere]'
type AttachmentIconKind =
  | 'pdf'
  | 'word'
  | 'xls'
  | 'ppt'
  | 'txt'
  | 'html'
  | 'img'
  | 'video'
  | 'music'
  | 'zip'
  | 'tsx'
  | 'unknown'
const ATTACHMENT_ICON_BY_KIND: Record<AttachmentIconKind, string> = {
  pdf: attachmentIconPdf,
  word: attachmentIconWord,
  xls: attachmentIconXls,
  ppt: attachmentIconPpt,
  txt: attachmentIconTxt,
  html: attachmentIconHtml,
  img: attachmentIconImg,
  video: attachmentIconVideo,
  music: attachmentIconMusic,
  zip: attachmentIconZip,
  tsx: attachmentIconTsx,
  unknown: attachmentIconUnknown
}
const ATTACHMENT_ICON_KIND_BY_EXTENSION: Record<string, AttachmentIconKind> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  xls: 'xls',
  xlsx: 'xls',
  csv: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
  md: 'txt',
  markdown: 'txt',
  txt: 'txt',
  text: 'txt',
  html: 'html',
  htm: 'html',
  png: 'img',
  jpg: 'img',
  jpeg: 'img',
  gif: 'img',
  webp: 'img',
  svg: 'img',
  bmp: 'img',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  mp3: 'music',
  wav: 'music',
  flac: 'music',
  m4a: 'music',
  ogg: 'music',
  zip: 'zip',
  rar: 'zip',
  '7z': 'zip',
  tar: 'zip',
  gz: 'zip',
  py: 'tsx',
  js: 'tsx',
  ts: 'tsx',
  tsx: 'tsx',
  jsx: 'tsx',
  json: 'tsx',
  java: 'tsx',
  c: 'tsx',
  cpp: 'tsx',
  go: 'tsx',
  rs: 'tsx'
}
const attachmentIconFor = (attachment: LiteratureAttachmentSummary): string => {
  const dot = attachment.name.lastIndexOf('.')
  const extension = dot >= 0 ? attachment.name.slice(dot + 1).toLowerCase() : ''
  if (attachment.kind === 'pdf' || attachment.media_type === 'application/pdf') {
    return ATTACHMENT_ICON_BY_KIND.pdf
  }
  const byExtension = ATTACHMENT_ICON_KIND_BY_EXTENSION[extension]
  if (byExtension) return ATTACHMENT_ICON_BY_KIND[byExtension]
  if (attachment.media_type.startsWith('text/')) return ATTACHMENT_ICON_BY_KIND.txt
  if (attachment.media_type.startsWith('image/')) return ATTACHMENT_ICON_BY_KIND.img
  if (attachment.media_type.startsWith('video/')) return ATTACHMENT_ICON_BY_KIND.video
  if (attachment.media_type.startsWith('audio/')) return ATTACHMENT_ICON_BY_KIND.music
  return ATTACHMENT_ICON_BY_KIND.unknown
}
const attachmentNameParts = (
  name: string
): { basename: string; suffix: string } => {
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
  children
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
  const iconNode = (
    <span className={`inline-flex shrink-0 ${iconClassName}`}>{icon}</span>
  )
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
        {failure ? (
          <small className={STATUS_CARD_REASON_CLASS}>{failure}</small>
        ) : null}
        {reason ? (
          <>
            <small
              className={`${STATUS_CARD_REASON_CLASS} [@media(hover:hover)]:hidden`}
            >
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
  onOpenChange
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
                name: target?.name ?? ''
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
                        reason instanceof LiteratureApiError
                          ? reason.failure.code
                          : undefined,
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
    mediaType: attachment.media_type
  }
}

function AttachmentMarks({
  source,
  onOpen
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
    <div className="lit-attachment-marks">
      {marks.length ? (
        marks.map((mark) => {
          const expanded = expandedMarks.has(mark.id)
          const expandable = mark.text.length > 96 || mark.text.split(/\r?\n/u).length > 4
          const markComments = comments.filter((comment) => comment.mark_id === mark.id)
          const hasComments = markComments.length > 0
          return (
            <article className="lit-attachment-mark-card" key={mark.id}>
              <Button
                className="lit-attachment-mark-open"
                variant="ghost"
                disabled={mark.anchor_state === 'stale'}
                onClick={() => onOpen(mark.page)}
              >
                <Badge className="lit-attachment-mark-page">
                  {mark.anchor_state === 'stale'
                    ? literature('attachment.sourceChanged')
                    : literature('attachment.page', { page: mark.page })}
                </Badge>
                {hasComments ? <span className="lit-attachment-mark-label">{literature('attachment.sourceLabel')}</span> : null}
                <span className={`lit-attachment-mark-text${hasComments ? ' is-source' : ''}${expanded ? ' is-expanded' : ''}`}>{mark.text}</span>
              </Button>
              {expandable ? (
                <Button
                  className="lit-attachment-mark-toggle"
                  size="sm"
                  variant="ghost"
                  onClick={() => toggleExpanded(mark.id)}
                >
                  {expanded ? literature('attachment.collapseMark') : literature('attachment.expandMark')}
                </Button>
              ) : null}
              {markComments.map((comment) => {
                const commentExpanded = expandedComments.has(comment.id)
                const commentExpandable = comment.body.length > 96 || comment.body.split(/\r?\n/u).length > 4
                return (
                  <div className="lit-attachment-mark-comment" key={comment.id}>
                    <span className="lit-attachment-mark-label">{literature('attachment.commentLabel')}</span>
                    <span className={`lit-attachment-mark-comment-text${commentExpanded ? ' is-expanded' : ''}`}>{comment.body}</span>
                    {commentExpandable ? (
                      <Button
                        className="lit-attachment-mark-toggle"
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleCommentExpanded(comment.id)}
                      >
                        {commentExpanded ? literature('attachment.collapseAnnotation') : literature('attachment.expandAnnotation')}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </article>
          )
        })
      ) : (
        <small>{literature('attachment.noMarks')}</small>
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
  onSave
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
    const normalized =
      field === 'year' ? (value.trim() ? Number(value) : null) : value.trim()
    if (normalized === original || (normalized === '' && original == null))
      return
    await onSave({ fields: { [API_FIELDS[field]]: normalized } })
  }
  return (
    <div
      ref={wrapper}
      className={`lit-detail-value${multiline ? ' is-wide' : ''}`}
    >
      <span>{label}</span>
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
        <div className="lit-detail-inline flex min-w-0 items-start gap-[var(--vds-space-2)]">
          <Button
            variant="ghost"
            size="content"
            className="lit-detail-edit items-start"
            onClick={() => setEditing(true)}
          >
            <strong className={DETAIL_VALUE_TEXT_CLASS}>
              {String(original ?? '') || '—'}
            </strong>
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
  onSave
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
                    name={
                      expanded.has(facet.id) ? 'chevron-down' : 'chevron-right'
                    }
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
                    if (kind === 'projects' && facet.project_id)
                      next.add(facet.project_id)
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
          {expanded.has(facet.id) ? (
            <div className="ml-4">{tree(facet.id)}</div>
          ) : null}
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
        <DialogContent className="lit-relation-dialog max-h-[min(680px,85vh)]">
          <DialogHeader>
            <DialogTitle>
              {kind === 'projects'
                ? literature('relations.projects')
                : kind === 'collections'
                  ? literature('relations.collections')
                  : literature('relations.tags')}
            </DialogTitle>
            <DialogDescription>
              {literature('relations.description')}
            </DialogDescription>
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
                          .filter(
                            (facet) => !facet.project_id && selected.has(facet.id)
                          )
                          .map((facet) => facet.id),
                        project_collection_ids: facets
                          .filter(
                            (facet) => facet.project_id && selected.has(facet.id)
                          )
                          .map((facet) => facet.id)
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
  onSave
}: {
  item: Detail
  tags: LiteratureFacet[]
  onCreate: (name: string) => Promise<void>
  onSave: (update: LiteratureUpdate) => Promise<void>
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const linked = new Set(item.tags.map((tag) => tag.id))
  const toggle = (target: { id: string }): void => {
    const next = item.tags.filter((tag) => tag.id !== target.id).map((tag) => tag.id)
    if (!linked.has(target.id)) next.push(target.id)
    void onSave({ tag_ids: next })
  }
  const submit = (): void => {
    const name = draft.trim()
    if (!name) return
    setDraft('')
    void onCreate(name)
  }
  return (
    <section className="lit-detail-section">
      <div className="items-center justify-between">
        <h3 className="!m-0">{literature('panel.tags')}</h3>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>
            <IconButton
              label={literature('detail.addTag')}
              size="sm"
              variant="ghostIcon"
              icon={<Icon name="plus" size={14} />}
            />
          </PopoverTrigger>
          <PopoverContent className="w-64">
            <div className="grid max-h-56 gap-[var(--vds-space-1)] overflow-y-auto">
              {tags.length ? (
                tags.map((facet) => (
                  <Checkbox
                    key={facet.id}
                    checked={linked.has(facet.id)}
                    label={facet.name}
                    onCheckedChange={() => toggle(facet)}
                  />
                ))
              ) : (
                <small className="px-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
                  {literature('panel.noTags')}
                </small>
              )}
            </div>
            <Input
              aria-label={literature('detail.newTagPlaceholder')}
              placeholder={literature('detail.newTagPlaceholder')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div>
        {item.tags.length ? (
          item.tags.map((value) => {
            const facet = tags.find(
              (tag) => tag.id === value.id || tag.name === value.name
            )
            return (
              <Tag
                key={value.id}
                closeLabel={literature('detail.removeTag')}
                color={
                  semanticTagColor(facet?.color) ??
                  semanticTagColorFor(facet?.id ?? value.id)
                }
                onClose={() => toggle(value)}
              >
                {value.name}
              </Tag>
            )
          })
        ) : (
          <small>{literature('panel.noTags')}</small>
        )}
      </div>
    </section>
  )
}

export function LiteratureDetail({
  id,
  attachmentId,
  onClose
}: {
  id: string | null
  attachmentId: string | null
  onClose: () => void
}): React.JSX.Element | null {
  const { t: literature } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const { act, state } = useApp()
  const { toast } = useToast()
  const format = createFormatters(state.lang)
  const projectId = state.homeSelectedProjectId ?? undefined
  const [item, setItem] = useState<Detail | null>(null)
  const [collections, setCollections] = useState<LiteratureFacet[]>([])
  const [tags, setTags] = useState<LiteratureFacet[]>([])
  const [projects, setProjects] = useState<LiteratureFacet[]>([])
  const [relation, setRelation] = useState<
    'projects' | 'collections' | 'tags' | null
  >(null)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  const [fetchingArxiv, setFetchingArxiv] = useState(false)
  const [arxivError, setArxivError] = useState<LiteratureErrorMessage | null>(null)
  const [failureKind, setFailureKind] = useState<DetailFailureKind>('fulltext')
  const [uploading, setUploading] = useState<'primary' | 'attachment' | null>(
    null
  )
  const [importOpen, setImportOpen] = useState(false)
  const [copyProject, setCopyProject] = useState('')
  const [deleteTarget, setDeleteTarget] =
    useState<LiteratureAttachmentSummary | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>(DETAIL_TAB.info)
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
  const { reload } = useCatalogue()
  const syncedReload = useRef(reload)
  useEffect(() => {
    if (!id) return
    setItem(null)
    setDetailTab(DETAIL_TAB.info)
    setError(null)
    setFetchingArxiv(false)
    setArxivError(null)
    setFailureKind('fulltext')
    setSyncing(false)
    setSyncMatch(null)
    setSyncPicked(new Set())
    setSyncMissed(false)
    setIdentifierFocus(null)
    setDeleteTarget(null)
    Promise.all([
      getLiterature(id, projectId),
      getLiteratureFacets({ project_id: projectId }),
      getLiteratureProjects()
    ])
      .then(([detail, facets, projectResult]) => {
        setItem(detail)
        setCollections(facets.collections)
        setTags(facets.tags)
        setCopyProject((current) => {
          const available = projectResult.projects.map((project) => project.id)
          if (current && available.includes(current)) return current
          if (
            state.homeSelectedProjectId &&
            available.includes(state.homeSelectedProjectId)
          )
            return state.homeSelectedProjectId
          return available.length === 1 ? available[0] : ''
        })
        setProjects(
          projectResult.projects.flatMap((project) => [
            { id: project.id, name: project.name, count: project.count },
            ...project.collections.map((collection) => ({
              ...collection,
              project_id: project.id,
              parent_id: collection.parent_id ?? project.id
            }))
          ])
        )
      })
      .catch((reason: unknown) =>
        setError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.loadFailed'))
      )
  }, [id, projectId])
  // 面板外的变更 (左侧标签管理删除/列表批量操作) 通过 catalogue.reload 广播;
  // 这里静默重取题录与 facets, 让已关联 chip 和 popover 列表同步移除失效标签。
  useEffect(() => {
    if (syncedReload.current === reload) return
    syncedReload.current = reload
    if (!id) return
    let active = true
    Promise.all([getLiterature(id, projectId), getLiteratureFacets({ project_id: projectId })])
      .then(([detail, facets]) => {
        if (!active) return
        setItem(detail)
        setCollections(facets.collections)
        setTags(facets.tags)
      })
      .catch((reason: unknown) =>
        setError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.loadFailed'))
      )
    return () => {
      active = false
    }
  }, [id, projectId, reload])
  if (!id) return null
  const save = async (update: LiteratureUpdate): Promise<void> => {
    try {
      setError(null)
      setItem(await updateLiterature(id, update, projectId))
      setRelation(null)
      catalogue.reload()
    } catch (reason) {
      setError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.saveFailed'))
    }
  }
  const editable = (
    field: EditableField,
    label: string,
    multiline = false
  ): React.JSX.Element => (
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
  const fetchArxiv = async (): Promise<void> => {
    if (fetchingArxiv) return
    setFetchingArxiv(true)
    setArxivError(null)
    setFailureKind('fulltext')
    try {
      setItem(await fetchArxivFulltext(id))
      catalogue.reload()
    } catch (reason) {
      setArxivError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.fulltextFailed'))
    } finally {
      setFetchingArxiv(false)
    }
  }
  /** 把勾选的命中字段写回文献并刷新详情; 失败时保留待确认项, 让用户能重试而不是白跑一次检索。 */
  const applyMetadata = async (
    fields: NonNullable<LiteratureUpdate['fields']>,
    bibType?: string
  ): Promise<void> => {
    setSyncing(true)
    try {
      setItem(await updateLiterature(id, { fields, ...(bibType ? { bib_type: bibType } : {}) }, projectId))
      setSyncMatch(null)
      setSyncMissed(false)
      catalogue.reload()
      toast({ title: literature('detail.sync.succeeded'), tone: 'success' })
    } catch (reason) {
      toast({ title: literature('detail.sync.failed'), tone: 'error' })
      setError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.saveFailed'))
    } finally {
      setSyncing(false)
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
  const syncMetadata = async (): Promise<void> => {
    if (!item || syncing) return
    const query = selectPaperMetaQuery(item)
    if (!query) return
    setSyncing(true)
    setError(null)
    try {
      const payload = await fetchPaperMeta(query)
      const fields = paperMetaFields(payload)
      if (!Object.keys(fields).length) {
        setSyncMissed(true)
        toast({ title: literature('detail.sync.missed'), tone: 'error' })
        return
      }
      if (requiresConfirmation(query.dimension)) {
        setSyncPicked(
          new Set(
            paperMetaDiff(fields, item)
              .filter((row) => row.current !== row.next)
              .map((row) => row.field)
          )
        )
        setSyncMatch({ fields, bibType: payload.bib_type })
        return
      }
      await applyMetadata(fields, payload.bib_type)
    } catch (reason) {
      const kind = classifyPaperMetaFailure(reason instanceof LiteratureApiError ? reason.failure : null)
      toast({
        title: literature(PAPER_META_FAILURE_KEYS[kind]),
        tone: 'error'
      })
    } finally {
      setSyncing(false)
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
    | 'detail.noFulltextReasonArxiv'
    | 'detail.noFulltextReasonDoi'
    | 'detail.noFulltextReasonNone'
  const noFulltextReasonKey = (
    currentItem: Detail
  ): NoFulltextReasonKey => {
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
        failure={
          failure ? (failure.detail ?? literature(failure.key)) : undefined
        }
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
                {fetchingArxiv
                  ? literature('detail.fetching')
                  : literature('detail.fetchFulltext')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={actionVariant}
                onClick={() => focusIdentifier('arxiv')}
              >
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
      <div
        className={FULLTEXT_ROW_CLASS}
        data-testid="literature-fulltext-row"
      >
        <FileText
          size={18}
          className="shrink-0 text-[var(--vds-text-secondary)]"
        />
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
          {nameParts.suffix ? (
            <span className="shrink-0">{nameParts.suffix}</span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() =>
            act.openLiteratureAttachment(currentItem.id, attachment.id)
          }
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
          const failure = literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.uploadFailed')
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
      setArxivError(literatureErrorMessage(reason instanceof LiteratureApiError ? reason.failure.code : undefined, reason instanceof Error ? reason.message : undefined, 'detail.uploadFailed'))
    } finally {
      setUploading(null)
    }
  }
  const attachment = item?.attachments.find(
    (entry) => entry.id === attachmentId
  )
  const attachmentSource: LiteratureDocumentSource | null =
    item && attachment ? literatureDocumentSource(item.id, attachment) : null
  if (item && attachment)
    return (
      <SheetContent
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className={DETAIL_SHEET_CLASS}
        side="right"
      >
        <header className="lit-detail-head">
          <div>
            <Tooltip content={attachment.name} side="bottom">
              <strong
                id={titleId}
                className="block max-w-full truncate"
                title={attachment.name}
              >
                {attachment.name}
              </strong>
            </Tooltip>
            <span id={descriptionId}>{literature('detail.attachment')}</span>
          </div>
          <IconButton
            label={literature('detail.close')}
            variant="ghostIcon"
            size="sm"
            icon={<Icon name="close" size={14} />}
            onClick={onClose}
          />
        </header>
        <div className="lit-detail-body">
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
            <Button
              variant="secondary"
              onClick={() => catalogue.focus(item.id)}
            >
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
          <div className="lit-detail-value">
            <span>{literature('detail.uploaded')}</span>
            <strong>
              {attachment.created_at
                ? format.date(new Date(attachment.created_at), {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                  })
                : '—'}
            </strong>
          </div>
          <div className="lit-detail-value">
            <span>{literature('detail.format')}</span>
            <strong>{attachment.media_type || '—'}</strong>
          </div>
          <div className="lit-detail-value">
            <span>{literature('detail.size')}</span>
            <strong>
              {attachment.size === null ? '—' : format.bytes(attachment.size)}
            </strong>
          </div>
          <section className="lit-detail-section">
            <h3>
              {literature('detail.marks')} <Badge>{attachment.annotation_count}</Badge>
            </h3>
            {attachmentSource && attachment.media_type === 'application/pdf' ? (
              <AttachmentMarks
                source={attachmentSource}
                onOpen={(page) =>
                  act.openLiteratureAttachment(item.id, attachment.id, page)
                }
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
    <SheetContent
      aria-labelledby={titleId}
      className={DETAIL_SHEET_CLASS}
      side="right"
    >
      <header className="lit-detail-head">
        <div className="min-w-0 flex-1">
          <Tooltip
            content={item?.title ?? literature('detail.title')}
            side="bottom"
          >
            <strong
              id={titleId}
              className="lit-detail-title line-clamp-2 block max-w-full overflow-hidden text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]"
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
          <TabsTrigger
            className={DETAIL_TAB_TRIGGER_CLASS}
            value={DETAIL_TAB.info}
          >
            {literature('detail.tabs.info')}
          </TabsTrigger>
          <TabsTrigger
            className={DETAIL_TAB_TRIGGER_CLASS}
            value={DETAIL_TAB.attachments}
          >
            {literature('detail.tabs.attachments')}{' '}
            {item?.attachments.length ?? 0}
          </TabsTrigger>
          <TabsTrigger
            className={DETAIL_TAB_TRIGGER_CLASS}
            value={DETAIL_TAB.notes}
          >
            {literature('detail.tabs.notes')} {item?.note_count ?? 0}
          </TabsTrigger>
        </TabsList>
        <TabsContent
          className="min-h-0 overflow-hidden"
          value={DETAIL_TAB.notes}
        >
          {item ? (
            <LiteratureNotes
              itemId={item.id}
              notes={item.notes ?? []}
              onReload={async () => {
                setItem(await getLiterature(item.id, projectId))
              }}
            />
          ) : null}
        </TabsContent>
        <TabsContent
          className="min-h-0 overflow-hidden"
          value={DETAIL_TAB.attachments}
        >
          {!item ? (
            <div className="lit-detail-loading">
              <Spinner aria-label={literature('detail.loading')} />
            </div>
          ) : (
            <div className="lit-detail-body h-full">
              {failureKind === 'upload' && arxivError ? (
                <Alert
                  className="mb-[var(--vds-space-3)]"
                  tone="error"
                  title={literature('detail.uploadFailed')}
                  description={arxivError.detail ?? literature(arxivError.key)}
                />
              ) : null}
              <div className="mb-[var(--vds-space-3)] flex items-center justify-between gap-[var(--vds-space-2)]">
                <small className="min-w-0 text-[12px] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
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
                        className="lit-detail-attachment-row group flex min-w-0 items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-1)] py-[var(--vds-space-2)] transition-colors hover:bg-[var(--vds-bg-gray-hover)]"
                        data-testid={`literature-detail-attachment-${candidate.id}`}
                        onDoubleClick={isAttachmentAvailable(candidate)
                          ? () => act.openLiteratureAttachment(item.id, candidate.id)
                          : undefined}
                      >
                        <img
                          alt=""
                          aria-hidden="true"
                          className="size-7 shrink-0"
                          src={attachmentIconFor(candidate)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 max-w-full items-baseline text-[length:var(--vds-font-body-lv2)] font-medium leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
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
                          <div className="mt-[2px] flex min-w-0 flex-wrap items-center gap-x-[var(--vds-space-2)] gap-y-[2px] text-[12px] leading-[18px] text-[var(--vds-text-tertiary)]">
                            <span
                              className={
                                candidate.role === 'primary'
                                  ? 'font-medium text-[var(--vds-success-text-primary)]'
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
                              <span className="font-medium text-[var(--vds-error-text-primary)]">
                                {literature('detail.attachmentMissing')}
                              </span>
                            )}
                            {candidate.annotation_count ? (
                              <span>
                                {literature('detail.markCount', {
                                  count: candidate.annotation_count
                                })}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <span
                          className="lit-row-actions ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)]"
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!isAttachmentAvailable(candidate)}
                            onClick={() =>
                              act.openLiteratureAttachment(
                                item.id,
                                candidate.id
                              )
                            }
                          >
                            {ui('open')}
                          </Button>
                          <IconButton
                            label={literature('detail.attachmentDetails')}
                            variant="ghostIcon"
                            size="sm"
                            icon={<Info size={15} />}
                            onClick={() =>
                              catalogue.focusAttachment(item.id, candidate.id)
                            }
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
        <TabsContent
          className="min-h-0 overflow-hidden"
          value={DETAIL_TAB.info}
        >
          {!item ? (
            <div className="lit-detail-loading">
              <Spinner aria-label={literature('detail.loading')} />
            </div>
          ) : (
            <div className="lit-detail-body h-full">
              {error ? (
                <Alert
                  className="mb-[var(--vds-space-3)]"
                  tone="error"
                  title={literature('detail.saveFailed')}
                  description={error.detail ?? literature(error.key)}
                />
              ) : null}
              <div className="mb-[var(--vds-space-3)] grid gap-[var(--vds-space-2)]">
                {showSync && syncQuery ? (
                  <StatusCard
                    testId="literature-sync-banner"
                    icon={<Info size={18} />}
                    title={literature(paperMetaTitleKey(syncQuery.dimension))}
                    tone="info"
                    reason={literature(
                      paperMetaDescriptionKey(syncQuery.dimension)
                    )}
                  >
                    {syncMissed ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => focusIdentifier('doi')}
                      >
                        {literature('detail.sync.supplementIdentifier')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      loading={syncing}
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
              <div className="lit-detail-value">
                <span>{literature('detail.type')}</span>
                <Select
                  aria-label={literature('detail.type')}
                  className="![padding-left:var(--vds-space-3)]"
                  value={item.bib_type}
                  onValueChange={(value) => void save({ bib_type: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={literature('detail.chooseType')}>
                      {item.bib_type ? literature(`detail.bibTypes.${item.bib_type}` as 'detail.bibTypes.article') : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {BIBLIOGRAPHY_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {literature(
                          `detail.bibTypes.${type}` as 'detail.bibTypes.article'
                        )}
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
                focusNonce={
                  identifierFocus?.field === 'doi' ? identifierFocus.nonce : 0
                }
                onSave={save}
              />
              <EditableValue
                field="arxiv"
                item={item}
                label="arXiv"
                focusNonce={
                  identifierFocus?.field === 'arxiv' ? identifierFocus.nonce : 0
                }
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
              {!projectId ? <section className="lit-detail-section">
                <h3>{literature('relations.linkedProjects')}</h3>
                <Button
                  variant="ghost"
                  className="lit-relation-trigger"
                  onClick={() => setRelation('projects')}
                >
                  <div>
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
              </section> : null}
              <section className="lit-detail-section">
                <h3>{projectId ? literature('panel.collections') : literature('panel.custom')}</h3>
                <Button
                  variant="ghost"
                  className="lit-relation-trigger"
                  onClick={() => setRelation('collections')}
                >
                  <div>
                    {(projectId ? item.project_collections : item.collections)
                      .length ? (
                      (projectId
                        ? item.project_collections
                        : item.collections
                      ).map((value) => (
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
            relation === 'projects'
              ? projects
              : relation === 'collections'
                ? collections
                : tags
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
          <DialogContent className="max-h-[min(680px,85vh)] grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader>
              <DialogTitle>{literature('detail.sync.confirmTitle')}</DialogTitle>
              <DialogDescription>
                {literature('detail.sync.confirmDescription')}
              </DialogDescription>
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
              <Button
                variant="outline"
                disabled={syncing}
                onClick={() => setSyncMatch(null)}
              >
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
