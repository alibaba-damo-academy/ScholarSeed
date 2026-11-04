import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  LibraryAction,
  LIBRARY_HEADER_ACTION_CLASS,
  LibrarySelectionChange,
  LibraryToolbar,
  LibraryToolbarTarget,
} from '../../components/business/Library'
import { Groups } from './Groups'
import { RowTags, TagFilter } from './Tags'
import { listLiteratureCollections, type LibraryCollection } from './api'

import {
  isAttachmentAvailable,
  type LiteratureAttachmentSummary,
  type LiteratureFacet,
  type LiteratureProject,
  type LiteratureQuery,
  type LiteratureSummary,
  type LiteratureTask,
} from '../../contracts/literature'
import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisText,
  EmptyState,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  SearchBox,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  Spinner,
  Tag,
  Tooltip,
  useToast,
} from '../../components/ui'
import emptyImage from '../../assets/empty_img.webp'
import { hasDraggedFiles, writeLiteratureDrag } from '../../drag'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import {
  ArrowLeft,
  ArrowUpFromLine,
  ChevronDown,
  Link,
  MonitorDown,
  Plus,
  Trash,
} from 'lucide-react'
import { fileIconForName, FileFormatIcon, IconFont } from '../../components/primitive'
import { writeClipboard } from '../../components/primitive/clipboard'
import { IMPORT_SOURCES } from './imports'
import { ImportSourceItem } from './ImportSourceItem'
import { IdentifierImport } from './IdentifierImport'
import {
  LiteratureApiError,
  MAX_EXPORT_RECORDS,
  bulkLiteratures,
  createImportTask,
  deleteLiteratures,
  exportBibtex,
  getLiteratureFacets,
  getLiteratureProjects,
  getLiteratureTask,
  importBibliography,
  importPdf,
  listAllLiteratures,
  literatureQueryKey,
  previewZotero,
  ZOTERO_LIBRARY_ROOT_KEY,
  type PdfImportPhase,
  type ZoteroCollectionNode,
  type ZoteroPreview,
} from './api'
import { catalogue, importDestination, importDestinationLabel, useCatalogue } from './catalog'
import {
  literatureErrorMessage,
  literatureTaskErrorMessage,
  literatureTaskStatusMessage,
  type LiteratureErrorMessage,
} from './error'
import { saveBibtex } from './export'
import { LiteratureDetail, type LiteratureDetailIntent } from './LiteratureDetail'
import { LiteratureRowMenu, type RowMenuActions } from './RowMenu'
import { MetadataBatch } from './MetadataBatch'
import {
  mergeLiteratureSummaries,
  literatureCollections,
  replaceLiteratureSummary,
  timestampLabel,
} from './projection'
import { createFormatters } from '../../../../localization/format'
import {
  inheritedZoteroSelection,
  updateZoteroSelection,
  zoteroImportBlocked,
  zoteroNodeState,
  zoteroSelectionDirectives,
} from './zotero'

const SEARCH_DEBOUNCE_MS = 260
const LEADING_COLUMN_WIDTH = 72
const COLUMN_STORAGE_KEY = 'scholarseed.literature.columns.v1'
const PROJECT_COLUMN_STORAGE_KEY = 'scholarseed.literature.project-columns.v1'
const SORT_STORAGE_KEY = 'scholarseed.literature.sort.v1'
// 曲别针列的排序键，与后端 ATTACHMENT_SORT_KEY 同名：有附件=0 排在无附件=1 之前，
// 次级键是列表原始序。它不在 COLUMN_META 里 —— 这一列固定常驻在标题前，
// 既是附件有无的标识，也是展开附件行的唯一入口，不能被隐藏或拖走。
const ATTACHMENT_SORT: NonNullable<LiteratureQuery['sort']> = 'attachment'
const EMPTY_CELL = '—'
const CHIP_CELL_CLASS = 'flex items-center gap-[var(--vds-space-1)]'
// 芯片不参与压缩: 否则它们会先自己缩小并内部省略, 单元格就不再溢出, tooltip 也无法判定展示不全。
const CHIP_CLASS = 'shrink-0 max-w-none'
// 折叠计数芯片: 同样不参与压缩, 数字宽度稳定避免列表滚动时跳动。
const MORE_CHIP_CLASS = 'shrink-0 max-w-none tabular-nums'
// 行元素类名: 既是样式钩子, 也是「这次按下是否落在行上」的判定依据, 只此一处定义。
const ROW_SELECTOR_CLASS = 'lit-row'
const ROW_CLASS =
  'lit-row relative grid min-w-[var(--literature-grid-width)] library-narrow:min-w-[max(var(--vds-library-table-narrow-min-width),var(--literature-grid-width))] items-center min-h-[var(--vds-library-row-height)] text-[length:var(--vds-font-body-lv2)] border-b border-[var(--vds-border-default)] cursor-default bg-[var(--vds-bg-gray-default)] hover:bg-[var(--vds-bg-gray-hover)] [&.is-focused]:bg-[var(--vds-bg-gray-hover)] [&.is-selected]:bg-[var(--vds-brand-light-bg-default)] [&>span]:px-[var(--vds-library-table-cell-padding-inline)] [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap'
const ATTACHMENT_ROW_CLASS =
  'lit-attachment-row flex min-w-[var(--literature-grid-width)] library-narrow:min-w-[max(var(--vds-library-table-narrow-min-width),var(--literature-grid-width))] min-h-[var(--vds-library-attachment-row-min-height)] cursor-pointer items-center gap-[var(--vds-space-2)] bg-[var(--vds-bg-gray-default)] py-0 pr-[var(--vds-library-attachment-row-padding-inline-end)] pl-[var(--vds-library-attachment-row-padding-inline-start)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-primary)] font-[var(--vds-fw-regular)] [&+.lit-row]:border-t [&+.lit-row]:border-[var(--vds-border-default)] [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap'
const STICKY_CELLS_CLASS = String.raw`lit-sticky-cells sticky left-0 z-[var(--vds-z-local-decoration)] grid h-full grid-cols-[var(--vds-library-sticky-cells-columns)] items-center gap-[var(--vds-library-sticky-cells-gap)] bg-inherit px-[var(--vds-library-sticky-cells-padding-inline)] [&_.vds-checkbox\_\_label]:hidden [&_.vds-checkbox]:min-h-[var(--vds-control-height-xs)]`
const STICKY_HEADER_CELLS_CLASS = `${STICKY_CELLS_CLASS} z-[var(--vds-z-local-top)]`
const TABLE_EMPTY_STATE_CLASS =
  '[&>.vds-empty-state]:[--vds-empty-state-gap:var(--vds-space-1)] [&>.vds-empty-state]:flex [&>.vds-empty-state]:flex-col [&>.vds-empty-state]:items-center [&>.vds-empty-state]:justify-center [&>.vds-empty-state]:min-h-[var(--vds-library-list-empty-min-height)] [&>.vds-empty-state]:text-[var(--vds-text-primary)]'
const COLUMN_RESIZER_CLASS =
  'absolute right-[var(--vds-library-column-resizer-right)] top-[var(--vds-library-column-resizer-top)] z-[var(--vds-z-local-control)] h-[var(--vds-library-column-resizer-height)] w-[var(--vds-library-column-resizer-width)] cursor-col-resize hover:border-r-[var(--vds-border-width-2)] hover:border-r-[var(--vds-brand-bg-default)]'
// 虚拟化只渲染视口内的条目, 行高是首屏估算值: 真实高度由 measureElement 逐条回填,
// 估算值与 literature.css 的 .lit-row / .lit-attachment-row min-height 同源, 改样式时同步。
const LIST_ROW_HEIGHT = 45
const LIST_ATTACHMENT_ROW_HEIGHT = 34
const LIST_OVERSCAN = 8
// 目标行滚进窗口需要一次提交, 落焦因此按帧重试; 次数只是兜底, 不是等待策略。
const ROW_FOCUS_ATTEMPTS = 3
type ColumnKey =
  | 'title'
  | 'subtitle'
  | 'creator'
  | 'publication'
  | 'year'
  | 'published_date'
  | 'citation_key'
  | 'item_type'
  | 'bib_type'
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
  | 'created_at'
  | 'updated_at'
  | 'collections'
  | 'tags'
  | 'projects'
type ColumnSetting = { key: ColumnKey; width: number; visible: boolean }
const COLUMN_META: Record<
  ColumnKey,
  {
    labelKey: `columns.${ColumnKey}`
    sort?: LiteratureQuery['sort']
    minimum: number
    maximum?: number
  }
> = {
  title: { labelKey: 'columns.title', sort: 'title', minimum: 180 },
  subtitle: { labelKey: 'columns.subtitle', sort: 'subtitle', minimum: 140 },
  creator: { labelKey: 'columns.creator', sort: 'creator', minimum: 100 },
  publication: {
    labelKey: 'columns.publication',
    sort: 'publication',
    minimum: 130,
  },
  year: { labelKey: 'columns.year', sort: 'year', minimum: 64 },
  published_date: {
    labelKey: 'columns.published_date',
    sort: 'published_date',
    minimum: 110,
  },
  citation_key: {
    labelKey: 'columns.citation_key',
    sort: 'citation_key',
    minimum: 110,
  },
  item_type: { labelKey: 'columns.item_type', sort: 'item_type', minimum: 100 },
  bib_type: { labelKey: 'columns.bib_type', sort: 'bib_type', minimum: 100 },
  abstract: { labelKey: 'columns.abstract', minimum: 240 },
  doi: { labelKey: 'columns.doi', sort: 'doi', minimum: 140 },
  arxiv: { labelKey: 'columns.arxiv', sort: 'arxiv', minimum: 120 },
  isbn: { labelKey: 'columns.isbn', sort: 'isbn', minimum: 120 },
  url: { labelKey: 'columns.url', sort: 'url', minimum: 180 },
  volume: { labelKey: 'columns.volume', sort: 'volume', minimum: 64 },
  number: { labelKey: 'columns.number', sort: 'number', minimum: 64 },
  pages: { labelKey: 'columns.pages', sort: 'pages', minimum: 80 },
  publisher: { labelKey: 'columns.publisher', sort: 'publisher', minimum: 130 },
  address: { labelKey: 'columns.address', sort: 'address', minimum: 100 },
  created_at: {
    labelKey: 'columns.created_at',
    sort: 'created_at',
    minimum: 160,
  },
  updated_at: {
    labelKey: 'columns.updated_at',
    sort: 'updated_at',
    minimum: 160,
  },
  collections: { labelKey: 'columns.collections', minimum: 130 },
  tags: { labelKey: 'columns.tags', minimum: 110 },
  projects: { labelKey: 'columns.projects', minimum: 120 },
}
const DEFAULT_VISIBLE = new Set<ColumnKey>(['title', 'creator', 'year', 'created_at', 'projects'])
const DEFAULT_COLUMNS: ColumnSetting[] = (Object.keys(COLUMN_META) as ColumnKey[]).map((key) => ({
  key,
  width:
    key === 'tags'
      ? COLUMN_META.tags.minimum
      : key === 'title'
        ? 340
        : Math.max(COLUMN_META[key].minimum, 150),
  visible: DEFAULT_VISIBLE.has(key),
}))
const PROJECT_COLUMN_KEYS: ColumnKey[] = [
  'title',
  'subtitle',
  'creator',
  'publication',
  'year',
  'tags',
]
const PROJECT_DEFAULT_COLUMNS: ColumnSetting[] = [
  ...PROJECT_COLUMN_KEYS,
  ...(Object.keys(COLUMN_META) as ColumnKey[]).filter((key) => !PROJECT_COLUMN_KEYS.includes(key)),
].map((key) => ({
  key,
  width:
    key === 'tags'
      ? COLUMN_META.tags.minimum
      : key === 'title'
        ? 300
        : Math.max(COLUMN_META[key].minimum, 120),
  visible: key !== 'subtitle' && PROJECT_COLUMN_KEYS.includes(key),
}))
function loadColumns(storageKey: string, defaults: ColumnSetting[]): ColumnSetting[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as ColumnSetting[]
    if (stored.length && stored.every((entry) => entry.key in COLUMN_META)) {
      const values = new Map(stored.map((entry) => [entry.key, entry]))
      return [
        // 列的最小宽度会随展示文案调整, 已保存的宽度按当前下限收敛, 避免旧宽度继续截断内容。
        ...stored
          .filter((entry) => entry.key in COLUMN_META)
          .map((entry) => ({
            ...entry,
            width: Math.min(
              COLUMN_META[entry.key].maximum ?? Infinity,
              Math.max(COLUMN_META[entry.key].minimum, entry.width)
            ),
          })),
        ...defaults.filter((entry) => !values.has(entry.key)),
      ]
    }
  } catch {
    /* use defaults */
  }
  return defaults
}
function hasActiveListRefinement(query: LiteratureQuery): boolean {
  return Boolean(query.q?.trim())
}
type PdfImportStatus = 'pending' | PdfImportPhase | 'completed' | 'failed'
type BatchDialog = 'project' | 'collection' | 'tag' | null
type PdfImportRecord = {
  id: string
  file: File
  name: string
  progress: number
  status: PdfImportStatus
  title?: string
  error?: LiteratureErrorMessage
}
/** 摊平后的一维列表条目: 文献行, 或它展开后的一个附件行。虚拟化按条目计量与开窗。 */
type ListEntry =
  | { kind: 'item'; item: LiteratureSummary; index: number }
  | {
      kind: 'attachment'
      item: LiteratureSummary
      index: number
      attachment: LiteratureAttachmentSummary
    }

function Row({
  item,
  columns,
  grid,
  checked,
  expanded,
  focused,
  isNew,
  menu,
  projectId,
  entryIndex,
  onActivate,
  onDragStart,
  onKeyDown,
  rowRef,
  tabIndex,
  onOpenFulltext,
  onItemUpdated,
  onTagMinimumWidth,
  onToggle,
}: {
  item: LiteratureSummary
  columns: ColumnSetting[]
  projectPresentation: boolean
  grid: string
  checked: boolean
  expanded: boolean
  focused: boolean
  isNew: boolean
  menu: RowMenuActions
  projectId?: string
  /** 虚拟化条目下标: measureElement 从 data-index 读回它计量的是哪一条。 */
  entryIndex: number
  onActivate: () => void
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  rowRef: (node: HTMLDivElement | null) => void
  tabIndex: number
  onOpenFulltext: (attachmentId: string) => void
  onItemUpdated: (item: LiteratureSummary) => void
  onTagMinimumWidth: (id: string, width: number) => void
  onToggle: () => void
}): React.JSX.Element {
  const { t: literature, i18n } = useTranslation('literature')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const collections = literatureCollections(item, projectId)
  const facetNames = (values: Array<{ name: string }>): string =>
    values.map((value) => value.name).join('、') || EMPTY_CELL
  // 双击的目标是主附件(全文)。判空必须在渲染层做完: store 的 openLiteratureAttachment
  // 找不到附件时会弹「附件当前不可用」错误提示, 而产品要求没有主附件时**什么都不做**。
  // 文件已丢失的主附件同样按「没有主附件」处理: 打开只会拿到一个错误提示。
  const primaryAttachment = isAttachmentAvailable(item.primary_attachment)
    ? item.primary_attachment
    : null
  // 每一列都走 EllipsisText: 只有文案被列宽截断时才浮出完整内容; tooltip 必须 portal,
  // 否则会被单元格与表格自身的 overflow 裁掉。
  const cell = (key: ColumnKey): React.ReactNode =>
    key === 'title' ? (
      <EllipsisText
        key={key}
        tooltip={item.title}
        tooltipPortalled
        wrapperClassName="lit-title-cell text-[var(--vds-text-primary)]"
      >
        <span className="inline-flex max-w-full items-center gap-[var(--vds-space-2)] align-middle">
          {primaryAttachment ? <FileFormatIcon name={primaryAttachment.name} /> : null}
          <span className="truncate font-[var(--vds-fw-regular)]">{item.title}</span>
        </span>
      </EllipsisText>
    ) : key === 'creator' ? (
      <EllipsisText
        key={key}
        tooltipPortalled
        tooltipContentClassName="[--vds-tooltip-max-height:var(--vds-literature-author-tooltip-max-height)]"
      >
        {item.creators_display || EMPTY_CELL}
      </EllipsisText>
    ) : key === 'publication' ? (
      <EllipsisText key={key} tooltipPortalled>
        {item.publication_display || EMPTY_CELL}
      </EllipsisText>
    ) : key === 'year' ? (
      <EllipsisText key={key} tooltipPortalled>
        {item.year ?? EMPTY_CELL}
      </EllipsisText>
    ) : key === 'created_at' || key === 'updated_at' ? (
      <EllipsisText key={key} tooltipPortalled>
        {timestampLabel(item[key], format) || EMPTY_CELL}
      </EllipsisText>
    ) : key === 'projects' ? (
      // 一篇文献可归属多个项目: 列内只画第一个项目, 其余折叠成 +N 芯片。
      // 折叠后单元格通常不再溢出, 所以完整名单由 +N 自己的 tooltip 承担; 单元格 tooltip 仍是全量兜底。
      // 无归属项目时与作者/出版物/标签列保持一致: 只留空单元格占位, 不画品牌色芯片。
      <EllipsisText key={key} tooltip={facetNames(item.projects)} tooltipPortalled>
        <span className={CHIP_CELL_CLASS}>
          {item.projects.length === 0 ? (
            EMPTY_CELL
          ) : (
            <>
              <Badge className={CHIP_CLASS} tone="brand">
                {item.projects[0].name}
              </Badge>
              {item.projects.length > 1 ? (
                <Tooltip
                  className="shrink-0"
                  content={facetNames(item.projects.slice(1))}
                  portalled
                >
                  <Badge
                    aria-label={literature('list.moreProjects', {
                      count: item.projects.length - 1,
                      names: facetNames(item.projects.slice(1)),
                    })}
                    className={MORE_CHIP_CLASS}
                    size="sm"
                    tone="neutral"
                  >
                    +{item.projects.length - 1}
                  </Badge>
                </Tooltip>
              ) : null}
            </>
          )}
        </span>
      </EllipsisText>
    ) : key === 'tags' ? (
      <RowTags
        key={`${projectId ?? ''}:${item.id}`}
        item={item}
        projectId={projectId}
        onUpdated={onItemUpdated}
        onMinimumWidth={onTagMinimumWidth}
      />
    ) : key === 'collections' ? (
      <EllipsisText key={key} tooltip={facetNames(collections)} tooltipPortalled>
        <span className={CHIP_CELL_CLASS}>
          {collections.length === 0
            ? EMPTY_CELL
            : collections.map((facet) => (
                <Badge className={CHIP_CLASS} key={facet.id} tone="brand">
                  {facet.name}
                </Badge>
              ))}
        </span>
      </EllipsisText>
    ) : key === 'bib_type' || key === 'item_type' ? (
      // 类型列展示翻译后的类型名。值来自导入数据(如 Zotero 原始 itemType), 可能是词表外的
      // 未知类型; 而缺失 key 会被引擎的 parseMissingKeyHandler 渲染成启动失败文案,
      // 所以先用 exists 校验, 未知值按原文兜底。
      <EllipsisText key={key} tooltipPortalled>
        {item[key] && i18n.exists(`detail.bibTypes.${item[key]}`, { ns: 'literature' })
          ? literature(`detail.bibTypes.${item[key]}` as 'detail.bibTypes.article')
          : item[key] || EMPTY_CELL}
      </EllipsisText>
    ) : (
      <EllipsisText key={key} tooltipPortalled>
        {String(item[key] ?? '') || EMPTY_CELL}
      </EllipsisText>
    )
  return (
    <LiteratureRowMenu actions={menu} item={item} projectId={projectId}>
      <div
        className={`${ROW_CLASS} group/literature font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)] [&_.vds-badge]:!text-[var(--vds-text-tertiary)] [&_.vds-badge]:!font-[var(--vds-fw-regular)] [&_.vds-tag]:!font-[var(--vds-fw-regular)] [&_.vds-tag>span]:!text-[var(--vds-text-tertiary)]${checked ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`}
        style={{ gridTemplateColumns: grid }}
        data-index={entryIndex}
        ref={rowRef}
        tabIndex={tabIndex}
        aria-label={item.title}
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        onDoubleClick={primaryAttachment ? () => onOpenFulltext(primaryAttachment.id) : undefined}
      >
        <div className={STICKY_CELLS_CLASS}>
          <span
            className={`size-[var(--vds-library-unread-indicator-size)] rounded-full${isNew ? ' is-on bg-[var(--vds-brand-bg-default)]' : ''}`}
            title={isNew ? literature('list.newImport') : undefined}
          />
          <span
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={checked}
              label={literature('list.select', { title: item.title })}
              onCheckedChange={(value) => catalogue.select(item.id, value)}
            />
          </span>
          <span
            className="lit-pdf-cell grid place-items-center text-[var(--vds-text-tertiary)]"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {item.attachments.length ? (
              <IconButton
                label={
                  expanded
                    ? literature('list.collapseAttachments')
                    : literature('list.expandAttachments')
                }
                variant="ghostIcon"
                size="sm"
                icon={<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />}
                onClick={onToggle}
              />
            ) : null}
          </span>
        </div>
        {columns.filter((column) => column.visible).map((column) => cell(column.key))}
      </div>
    </LiteratureRowMenu>
  )
}

function ZoteroTreeNode({
  depth,
  directives,
  includeUnfiled,
  node,
  onToggle,
  onToggleUnfiled,
  parentSelected,
}: {
  depth: number
  directives: ReadonlyMap<string, boolean>
  includeUnfiled: boolean
  node: ZoteroCollectionNode
  onToggle: (node: ZoteroCollectionNode, selected: boolean) => void
  onToggleUnfiled: (selected: boolean) => void
  parentSelected: boolean
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  const [open, setOpen] = useState(depth < 2)
  const selected = inheritedZoteroSelection(node.key, parentSelected, directives)
  const state = zoteroNodeState(node, parentSelected, directives)
  const displayedState =
    node.key !== ZOTERO_LIBRARY_ROOT_KEY || state === 'mixed' || state === includeUnfiled
      ? state
      : 'mixed'
  const hasChildren = node.children.length > 0
  return (
    <div role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-level={depth + 1}>
      <div
        className="flex min-h-8 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-sm)] pl-[calc(var(--zotero-depth)*var(--vds-space-4))] pr-[var(--vds-space-2)] hover:bg-[var(--vds-surface-hover)]"
        style={{ '--zotero-depth': depth } as React.CSSProperties}
      >
        {hasChildren ? (
          <IconButton
            label={literature(open ? 'zotero.collapse' : 'zotero.expand', {
              name: node.name,
            })}
            size="sm"
            variant="ghostIcon"
            icon={<Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}
            onClick={() => setOpen((current) => !current)}
          />
        ) : (
          <span className="inline-block w-8" />
        )}
        <Checkbox
          checked={displayedState}
          aria-label={literature(displayedState === true ? 'zotero.deselect' : 'zotero.select', {
            name: node.name,
          })}
          onCheckedChange={(checked) => {
            onToggle(node, checked)
            if (node.key === ZOTERO_LIBRARY_ROOT_KEY) onToggleUnfiled(checked)
          }}
        />
        <span
          className="min-w-0 flex-1 truncate text-xs text-[var(--vds-text-primary)]"
          title={node.name}
        >
          {node.name}
        </span>
        <span className="flex-none text-[11px] text-[var(--vds-text-secondary)]">
          {literature('zotero.items', { count: node.subtree_item_count })}
        </span>
      </div>
      {hasChildren && open ? (
        <div role="group">
          {node.children.map((child) => (
            <ZoteroTreeNode
              key={child.key}
              depth={depth + 1}
              directives={directives}
              includeUnfiled={includeUnfiled}
              node={child}
              onToggle={onToggle}
              onToggleUnfiled={onToggleUnfiled}
              parentSelected={selected}
            />
          ))}
          {node.key === ZOTERO_LIBRARY_ROOT_KEY ? (
            <div
              className="flex min-h-8 items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-sm)] pl-[calc((var(--zotero-depth)+1)*var(--vds-space-4)+var(--vds-space-8))] pr-[var(--vds-space-2)] hover:bg-[var(--vds-surface-hover)]"
              style={{ '--zotero-depth': depth } as React.CSSProperties}
              role="treeitem"
              aria-level={depth + 2}
            >
              <Checkbox
                checked={includeUnfiled}
                aria-label={literature(
                  includeUnfiled ? 'zotero.deselectUnfiled' : 'zotero.selectUnfiled'
                )}
                onCheckedChange={onToggleUnfiled}
              />
              <span className="min-w-0 flex-1 text-xs text-[var(--vds-text-primary)]">
                {literature('zotero.unfiled')}
              </span>
              <span className="text-[11px] text-[var(--vds-text-secondary)]">
                {literature('zotero.items', { count: node.direct_item_count })}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function LiteratureList({
  presentation = 'default',
}: {
  presentation?: 'default' | 'project'
}): React.JSX.Element {
  const projectPresentation = presentation === 'project'
  const toolbarTarget = useContext(LibraryToolbarTarget)
  const onSelectionChange = useContext(LibrarySelectionChange)
  const renderSelection = (content: React.ReactNode): React.ReactNode =>
    projectPresentation && toolbarTarget ? createPortal(content, toolbarTarget) : content
  const { t: layoutText } = useTranslation('layout')
  const [collectionCatalog, setCollectionCatalog] = useState<{
    projectId: string
    items: LibraryCollection[]
  }>({ projectId: '', items: [] })
  const [collectionsFailed, setCollectionsFailed] = useState(false)
  const { t: literature } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const { toast } = useToast()
  // 双击打开全文必须走 store 的 openLiteratureAttachment: 它负责退出列表标签、开文档
  // 工作区并带上文献/附件身份, 列表里不另写一份。代价是本组件从此订阅 store, 而这个
  // 代价是有界的 —— 列表只在文献视图是当前标签时挂载 (Workbench 只渲染一个 viewer),
  // 且文档一打开 activeTab 就切走, 列表随即卸载。
  const { act, state } = useApp()
  const returnProject =
    state.homeSelectedProjectId === null
      ? state.projects.find((project) => project.id === state.workbenchReturnProjectId)
      : undefined
  const returnProjectId = returnProject?.id ?? ''
  /*
   * scopeProjectId 是作用域 (项目文献库 / 文献中心), 由 LiteratureScope 跟随
   * homeSelectedProjectId 同步; 下面的 projectId 只是列表过滤条件 query.project_id。
   * 二者在全览里会分叉: 点侧栏的项目/分类行只写 query.project_id, 作用域仍是全览,
   * 且这份过滤条件会被 catalogue.scope() 的作用域存档长期保留。只属于项目文献库的
   * 入口必须判 scopeProjectId, 不能判 projectId。
   */
  const {
    projectId: scopeProjectId,
    query,
    selected,
    focusedId,
    focusedAttachmentId,
    itemsReady,
    reload,
    importRequest,
  } = useCatalogue()
  const hasSelection = projectPresentation && selected.length > 0
  useEffect(() => {
    onSelectionChange?.(hasSelection)
    return () => onSelectionChange?.(false)
  }, [hasSelection, onSelectionChange])
  const projectId = query.project_id
  const projectCollections =
    collectionCatalog.projectId === scopeProjectId ? collectionCatalog.items : []
  useEffect(() => {
    if (projectPresentation && query.recent) catalogue.query({ recent: undefined })
  }, [projectPresentation, query.recent])
  useEffect(() => {
    if (!projectPresentation || !scopeProjectId) return
    let active = true
    setCollectionsFailed(false)
    void listLiteratureCollections(scopeProjectId)
      .then((collections) => {
        if (active) setCollectionCatalog({ projectId: scopeProjectId, items: collections })
      })
      .catch(() => {
        if (active) setCollectionsFailed(true)
      })
    return () => {
      active = false
    }
  }, [scopeProjectId, projectPresentation, reload])
  /** 列表取数只认查询内容: 见 literatureQueryKey 的说明。 */
  const queryKey = useMemo(() => literatureQueryKey(query), [query])
  const [items, setItems] = useState<LiteratureSummary[]>(() => catalogue.getSnapshot().items)
  const [search, setSearch] = useState(query.q ?? '')
  // 导入落点 = 左侧当前选择; PDF / Bib-RIS / Zotero 三条渠道共用这一份推导。
  const destination = importDestination(query)
  const importDestinationOverride = useRef<typeof destination | null>(null)
  const activeImportDestination = (): typeof destination =>
    importDestinationOverride.current ?? destination
  const [loading, setLoading] = useState(!itemsReady)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  const [task, setTask] = useState<LiteratureTask | null>(null)
  const taskError =
    task && (task.error || task.error_code) ? literatureTaskErrorMessage(task) : null
  const [zoteroOpen, setZoteroOpen] = useState(false)
  const [zoteroLoading, setZoteroLoading] = useState(false)
  const [zoteroSubmitting, setZoteroSubmitting] = useState(false)
  // 一次「打开对话框 → 提交」共用一个受理幂等键: 连点、或提交响应丢失后的重试都拿
  // 同一个 key 去受理, 服务端就交回同一个任务, 而不是再导一遍 (文献是追加语义)。
  const zoteroSubmitKey = useRef(crypto.randomUUID())
  const [zoteroPreview, setZoteroPreview] = useState<ZoteroPreview | null>(null)
  const [zoteroError, setZoteroError] = useState<LiteratureErrorMessage | null>(null)
  const [zoteroSelection, setZoteroSelection] = useState<Map<string, boolean>>(new Map())
  const [zoteroUnfiled, setZoteroUnfiled] = useState(true)
  const [zoteroCollections, setZoteroCollections] = useState(true)
  const [zoteroDestination, setZoteroDestination] = useState('')
  const [pdfImportOpen, setPdfImportOpen] = useState(false)
  const [identifierOpen, setIdentifierOpen] = useState(false)
  const [pdfImports, setPdfImports] = useState<PdfImportRecord[]>([])
  const [pdfDropActive, setPdfDropActive] = useState(false)
  const pdfDragDepth = useRef(0)
  const [newlyImported, setNewlyImported] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [batchDialog, setBatchDialog] = useState<BatchDialog>(null)
  const [batchProjects, setBatchProjects] = useState<LiteratureProject[]>([])
  const [batchCollections, setBatchCollections] = useState<LiteratureFacet[]>([])
  const [batchTags, setBatchTags] = useState<LiteratureFacet[]>([])
  const [batchProjectId, setBatchProjectId] = useState('')
  const [batchSelection, setBatchSelection] = useState<Set<string>>(new Set())
  const [batchSearch, setBatchSearch] = useState('')
  const [batchSaving, setBatchSaving] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchExpanded, setBatchExpanded] = useState<Set<string>>(new Set())
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // 行右键菜单的「打开详情后立刻做什么」: 详情面板消费一次后回收, nonce 让同一条
  // 文献连续两次选同一项也能重新触发 (面板已经开着时 id 不变, 靠 nonce 区分)。
  const [detailIntent, setDetailIntent] = useState<LiteratureDetailIntent | null>(null)
  const clearDetailIntent = useCallback(() => setDetailIntent(null), [])
  const retainedFocus = useRef({
    id: focusedId,
    attachmentId: focusedAttachmentId,
  })
  if (focusedId) {
    retainedFocus.current = {
      id: focusedId,
      attachmentId: focusedAttachmentId,
    }
  }
  // 单条移出/删除的确认目标; 与批量条的 deleteConfirmOpen 分开, 文案里的数量不同。
  const [removeTarget, setRemoveTarget] = useState<LiteratureSummary | null>(null)
  const [removing, setRemoving] = useState(false)
  const localUpdates = useRef(
    new Map<
      string,
      {
        item: LiteratureSummary
        projectId: string | undefined
        request: number
      }
    >()
  )
  const listRequest = useRef(0)
  const pendingListRequest = useRef<number | null>(null)
  const [columns, setColumns] = useState<ColumnSetting[]>(() =>
    loadColumns(
      projectPresentation ? PROJECT_COLUMN_STORAGE_KEY : COLUMN_STORAGE_KEY,
      projectPresentation ? PROJECT_DEFAULT_COLUMNS : DEFAULT_COLUMNS
    )
  )
  const [draggedColumn, setDraggedColumn] = useState<ColumnKey | null>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const bibliographyInput = useRef<HTMLInputElement>(null)
  const scopedColumns = columns.filter((column) => !projectId || column.key !== 'projects')
  const [tagWidths, setTagWidths] = useState<Record<string, number>>({})
  const onTagMinimumWidth = useCallback((id: string, width: number): void => {
    setTagWidths((current) => (current[id] === width ? current : { ...current, [id]: width }))
  }, [])
  const tagMinimum = Math.max(
    COLUMN_META.tags.minimum,
    ...items.map((item) => tagWidths[item.id] ?? 0)
  )
  const visibleColumns = scopedColumns.filter((column) => column.visible)
  const columnWidths = visibleColumns.map((column) =>
    column.key === 'tags' ? Math.max(column.width, tagMinimum) : column.width
  )
  const grid = `var(--vds-library-sticky-cells-width) ${columnWidths.map((width) => `${width}px`).join(' ')}`
  const gridWidth = columnWidths.reduce((total, width) => total + width, LEADING_COLUMN_WIDTH)
  const saveColumns = (next: ColumnSetting[]): void => {
    setColumns(next)
    localStorage.setItem(
      projectPresentation ? PROJECT_COLUMN_STORAGE_KEY : COLUMN_STORAGE_KEY,
      JSON.stringify(next)
    )
  }
  const updateVisibleItem = (updated: LiteratureSummary): void => {
    const request = pendingListRequest.current
    if (request !== null)
      localUpdates.current.set(updated.id, { item: updated, projectId, request })
    setItems((current) => replaceLiteratureSummary(current, updated))
    const catalogueItems = catalogue.getSnapshot().items
    const nextCatalogueItems = replaceLiteratureSummary(catalogueItems, updated)
    if (nextCatalogueItems !== catalogueItems) catalogue.items(nextCatalogueItems)
  }
  /**
   * 所有列共用的排序切换：同一列再点一次反转方向，并持久化到 SORT_STORAGE_KEY，
   * 下次挂载时恢复。曲别针列与普通列走同一条路径，因此反转手感和记忆都一致；
   * 它自己不画升降指示器，表头只留一个曲别针。
   */
  const applySort = (sort: NonNullable<LiteratureQuery['sort']>): void => {
    const order = query.sort === sort && query.order === 'asc' ? 'desc' : 'asc'
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ sort, order }))
    catalogue.query({ sort, order })
  }
  const resizeColumn = (key: ColumnKey, event: React.PointerEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const start = event.clientX
    const current = columns.find((column) => column.key === key)
    if (!current) return
    const initialWidth = key === 'tags' ? Math.max(current.width, tagMinimum) : current.width
    const move = (moveEvent: PointerEvent): void =>
      saveColumns(
        columns.map((column) =>
          column.key === key
            ? {
                ...column,
                width: Math.min(
                  COLUMN_META[key].maximum ?? Infinity,
                  Math.max(
                    key === 'tags' ? tagMinimum : COLUMN_META[key].minimum,
                    initialWidth + moveEvent.clientX - start
                  )
                ),
              }
            : column
        )
      )
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null') as {
        sort?: LiteratureQuery['sort']
        order?: LiteratureQuery['order']
      } | null
      if (saved?.sort && saved.order && (saved.sort !== query.sort || saved.order !== query.order))
        catalogue.query(saved)
    } catch {
      /* use catalogue defaults */
    }
  }, [])
  useEffect(() => {
    const value = search.trim() || undefined
    if (value === query.q) return
    const timer = window.setTimeout(() => catalogue.query({ q: value }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query.q, search])
  useEffect(() => {
    if (catalogue.itemsFresh()) return
    let active = true
    const request = ++listRequest.current
    pendingListRequest.current = request
    const controller = new AbortController()
    if (!catalogue.getSnapshot().itemsReady) {
      setLoading(true)
      setItems([])
    }
    setError(null)
    listAllLiteratures(query, controller.signal)
      .then((value) => {
        if (active) {
          const currentUpdates = new Map(
            [...localUpdates.current.entries()]
              .filter(([, update]) => update.projectId === projectId && update.request === request)
              .map(([itemId, update]) => [itemId, update.item])
          )
          const next = mergeLiteratureSummaries(value, currentUpdates)
          for (const itemId of currentUpdates.keys()) localUpdates.current.delete(itemId)
          setItems(next)
          catalogue.items(next)
        }
      })
      .catch((reason: unknown) => {
        // 取消不是失败: 换作用域、切项目与卸载都会主动 abort, 那不该在列表上留一条错误,
        // 也不该被当成一次加载失败上报。
        if (active && !controller.signal.aborted)
          setError(
            literatureErrorMessage(
              reason instanceof LiteratureApiError ? reason.failure.code : undefined,
              reason instanceof Error ? reason.message : undefined,
              'batch.loadFailed'
            )
          )
      })
      .finally(() => {
        if (active) {
          pendingListRequest.current = null
          setLoading(false)
        }
      })
    return () => {
      active = false
      controller.abort()
      if (pendingListRequest.current === request) pendingListRequest.current = null
      for (const [itemId, update] of localUpdates.current)
        if (update.request === request) localUpdates.current.delete(itemId)
    }
    /*
     * 依赖是 queryKey 而不是 query: 内容没变的引用变化不该取消在飞请求再重拉一遍。
     * projectId 是 queryKey 的组成部分, 二者同增同减, 闭包里的值不会过期。
     */
  }, [queryKey, reload])
  useEffect(() => {
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return
    const timer = window.setInterval(() => {
      getLiteratureTask(task.id)
        .then((value) => {
          setTask(value)
          if (value.status === 'completed') {
            setNewlyImported((current) => new Set([...current, ...(value.imported_ids ?? [])]))
            revealImported()
          }
        })
        .catch(() => undefined)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [task])
  // 导入结果是瞬时反馈：终态用 Toast 承接并收掉 lit-task 横幅，不在列表上常驻。
  useEffect(() => {
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) return
    if (task.status === 'completed') {
      toast({
        title: literature('importTask.resultCompleted', {
          count: task.completed_count,
        }),
        tone: 'success',
      })
    } else if (task.status === 'cancelled') {
      toast({
        title: literature('importTask.resultCancelled'),
        tone: 'warning',
      })
    } else {
      const message = literatureTaskErrorMessage(task)
      toast({
        title: literature('importTask.failed'),
        description: message.detail ?? literature(message.key),
        tone: 'error',
      })
    }
    setTask(null)
  }, [task, literature, toast])

  const picked = useMemo(() => new Set(selected), [selected])
  const visibleSelectedCount = items.filter((item) => picked.has(item.id)).length
  const selectAllState =
    visibleSelectedCount === 0 ? false : visibleSelectedCount === items.length ? true : 'mixed'
  const filtered = hasActiveListRefinement(query)
  const libraryEmpty = items.length === 0 && !filtered
  /**
   * 移出项目 / 删除文献的真实动作, 批量条与行右键菜单共用。
   *
   * 语义由作用域决定: 项目文献库里是「移出项目」(文献仍留在文献中心), 文献中心里
   * 才是删除。失败统一走同一条 toast, 调用方只拿布尔结果决定要不要收尾。
   */
  const removeLiteratures = async (ids: readonly string[]): Promise<boolean> => {
    if (!ids.length) return false
    try {
      if (projectId) {
        await bulkLiteratures([...ids], 'unlink_project', {
          project_id: projectId,
        })
      } else {
        await deleteLiteratures([...ids])
      }
      return true
    } catch (reason: unknown) {
      const message = literatureErrorMessage(
        reason instanceof LiteratureApiError ? reason.failure.code : undefined,
        reason instanceof Error ? reason.message : undefined,
        'batch.deleteFailed'
      )
      toast({
        description: message.detail ?? literature(message.key),
        title: literature('batch.deleteFailed'),
        tone: 'error',
      })
      return false
    }
  }
  const removedToast = (count: number): void => {
    toast({
      title: projectId
        ? literature('batch.removeSucceeded', { count })
        : literature('batch.deleteSucceeded', { count }),
      tone: 'success',
    })
  }
  const deletePicked = async (): Promise<void> => {
    const count = selected.length
    setDeleteConfirmOpen(false)
    if (!(await removeLiteratures(selected))) return
    catalogue.clear()
    catalogue.reload()
    removedToast(count)
  }
  /** 行右键菜单的移出/删除: 只动这一条, 不牵连批量勾选。 */
  const confirmRemoveItem = async (): Promise<void> => {
    const target = removeTarget
    if (!target || removing) return
    setRemoving(true)
    const removed = await removeLiteratures([target.id])
    setRemoving(false)
    if (!removed) return
    setRemoveTarget(null)
    // select(id, false) 同时收掉焦点: 行已经不在了, 详情面板不该继续指着它。
    catalogue.select(target.id, false)
    catalogue.reload()
    removedToast(1)
  }
  /**
   * 行右键菜单的「复制标题」: 纯前端动作, 不打后端, 也不改库里的题录。
   *
   * 走 `writeClipboard` 而不是直接用 `navigator.clipboard`: 后者要求文档处于聚焦态,
   * 而右键菜单收起的瞬间焦点未必已经回到窗口, 主进程剪贴板能力没有这个前提。
   */
  const copyItemTitle = async (item: LiteratureSummary): Promise<void> => {
    const title = item.title.trim()
    if (!title) return
    try {
      await writeClipboard(title)
      toast({ title: literature('list.rowMenu.titleCopied'), tone: 'success' })
    } catch {
      toast({
        title: literature('list.rowMenu.copyTitleFailed'),
        tone: 'error',
      })
    }
  }
  /**
   * 打开详情面板: 行单击与右键菜单的「查看基本信息 / 添加笔记 / 添加附件」共用。
   *
   * 「本次新导入」的小蓝点在打开详情后就不再有意义, 所以三条入口都顺手清掉它。
   */
  const openDetail = (item: LiteratureSummary, action?: LiteratureDetailIntent['action']): void => {
    setNewlyImported((current) => {
      if (!current.has(item.id)) return current
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
    setDetailIntent(action ? { action, nonce: Date.now() } : null)
    catalogue.focus(item.id)
  }
  /**
   * 行单击 / Enter 的详情开关: 抽屉正开着这条就收起, 否则打开这条。
   *
   * 双击打开全文时 click 会先触发两次, 一开一关正好抵消, 于是「双击前抽屉是什么
   * 状态, 关掉 PDF 回来还是什么状态」, 双击路径不需要额外收尾。右键菜单的
   * 「查看基本信息 / 添加笔记 / 添加附件」是显式意图, 恒打开, 不参与 toggle。
   */
  const toggleDetail = (item: LiteratureSummary): void => {
    if (focusedId === item.id && !focusedAttachmentId) {
      catalogue.focus(null)
      return
    }
    openDetail(item)
  }
  /** 行键盘可达: roving tabindex + 方向键移动焦点, Enter 与单击同语义。 */
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const [keyRowIndex, setKeyRowIndex] = useState(0)
  /**
   * 列表窗口化: 文献行与它展开的附件行摊平成一维条目, 只渲染视口内 ± overscan 的部分。
   * 2000+ 篇时全量挂载意味着数万个 DOM 节点、每单元格一个 ResizeObserver, 以及每次
   * 状态变更 (敲搜索词、点行开抽屉、勾选) 都要重渲染整表; 窗口化把这些都降到 O(视口)。
   */
  const entries = useMemo<ListEntry[]>(() => {
    const flat: ListEntry[] = []
    items.forEach((item, index) => {
      flat.push({ kind: 'item', item, index })
      if (!expanded.has(item.id)) return
      for (const attachment of item.attachments)
        flat.push({ kind: 'attachment', item, index, attachment })
    })
    return flat
  }, [items, expanded])
  const entryIndexOfItem = useMemo(() => {
    const positions = new Map<number, number>()
    entries.forEach((entry, position) => {
      if (entry.kind === 'item') positions.set(entry.index, position)
    })
    return positions
  }, [entries])
  const tableScroll = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    estimateSize: (entryIndex) =>
      entries[entryIndex]?.kind === 'attachment' ? LIST_ATTACHMENT_ROW_HEIGHT : LIST_ROW_HEIGHT,
    getScrollElement: () => tableScroll.current,
    overscan: LIST_OVERSCAN,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const listPadTop = virtualRows[0]?.start ?? 0
  const listPadBottom = Math.max(0, rowVirtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0))
  // 目标行可能还在窗口外: 先滚到它, 等它真的挂载后再落焦。
  const pendingRowFocus = useRef<{ index: number; attempts: number } | null>(null)
  const focusRow = (itemIndex: number): void => {
    const entryIndex = entryIndexOfItem.get(itemIndex)
    if (entryIndex !== undefined) rowVirtualizer.scrollToIndex(entryIndex)
    pendingRowFocus.current = { index: itemIndex, attempts: ROW_FOCUS_ATTEMPTS }
  }
  /*
   * 没有依赖数组: 落焦要等 scrollToIndex 引起的那次提交把行挂进 DOM, 而那可能发生在
   * 本次渲染之后的任意一次渲染里。每次提交只读一个 ref 与一个 Map, 成本可忽略。
   */
  useEffect(() => {
    const pending = pendingRowFocus.current
    if (!pending) return
    const node = rowRefs.current.get(items[pending.index]?.id ?? '')
    if (node) {
      pendingRowFocus.current = null
      node.focus()
      return
    }
    pendingRowFocus.current =
      pending.attempts <= 0 ? null : { index: pending.index, attempts: pending.attempts - 1 }
  })
  const rowKeyDown = (index: number, event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    const item = items[index]
    if (!item) return
    if (event.key === 'Enter') {
      event.preventDefault()
      toggleDetail(item)
      return
    }
    let next = -1
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0 || next === index) return
    event.preventDefault()
    setKeyRowIndex(next)
    focusRow(next)
  }
  const openBatch = (kind: Exclude<BatchDialog, null>): void => {
    setBatchLoading(true)
    setBatchProjectId('')
    setBatchProjects([])
    setBatchCollections([])
    setBatchTags([])
    setBatchDialog(kind)
    setBatchSelection(new Set())
    setBatchSearch('')
    setBatchExpanded(new Set())
  }
  useEffect(() => {
    if (!batchDialog) return
    let active = true
    Promise.all([getLiteratureProjects(), getLiteratureFacets({ project_id: projectId })])
      .then(([projectResult, facets]) => {
        if (!active) return
        setBatchProjects(projectResult.projects)
        setBatchCollections(facets.collections)
        setBatchTags(facets.tags)
        // 默认落点优先级: 来源项目 (从项目跳来全览时带的上下文) > 工作区当前项目 > 第一个。
        // 来源项目必须确实在候选里: 否则 Select 没有对应项, 提交时会带一个用户看不见的 id。
        const known = new Set(projectResult.projects.map((project) => project.id))
        const contextual = known.has(returnProjectId) ? returnProjectId : ''
        setBatchProjectId(
          contextual || projectResult.current || projectResult.projects[0]?.id || ''
        )
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'batch.loadFailed'
          )
        )
        setBatchDialog(null)
      })
      .finally(() => {
        if (active) setBatchLoading(false)
      })
    return () => {
      active = false
    }
  }, [batchDialog, projectId, returnProjectId])
  const submitBatch = async (): Promise<void> => {
    if (
      !batchDialog ||
      batchLoading ||
      batchSaving ||
      (batchDialog === 'project' && !batchProjectId)
    )
      return
    setBatchSaving(true)
    try {
      const parameters =
        batchDialog === 'project'
          ? { project_id: batchProjectId, collection_ids: [...batchSelection] }
          : batchDialog === 'collection'
            ? {
                project_id: projectId,
                collection_ids: [...batchSelection],
              }
            : { tag_ids: [...batchSelection] }
      await bulkLiteratures(
        selected,
        batchDialog === 'project'
          ? 'link_project'
          : batchDialog === 'collection'
            ? 'add_collections'
            : 'add_tags_by_id',
        parameters
      )
      setBatchDialog(null)
      catalogue.clear()
      catalogue.reload()
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'batch.saveFailed'
        )
      )
    } finally {
      setBatchSaving(false)
    }
  }
  const toggleBatchValue = (id: string, checked: boolean): void =>
    setBatchSelection((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  const toggleBatchExpanded = (id: string): void =>
    setBatchExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const collectionOptions =
    batchDialog === 'project'
      ? (batchProjects.find((project) => project.id === batchProjectId)?.collections ?? [])
      : batchCollections
  const visibleBatchTags = batchTags.filter((tag) =>
    tag.name.toLowerCase().includes(batchSearch.toLowerCase())
  )
  const batchCollectionRows = (values: LiteratureFacet[]): React.JSX.Element[] => {
    const byParent = new Map<string | null, LiteratureFacet[]>()
    values.forEach((value) => {
      const parent = value.parent_id ?? null
      byParent.set(parent, [...(byParent.get(parent) ?? []), value])
    })
    const visit = (parent: string | null, depth: number): React.JSX.Element[] =>
      (byParent.get(parent) ?? []).flatMap((value) => {
        const children = byParent.get(value.id) ?? []
        return [
          <div
            key={value.id}
            className="flex items-center gap-[var(--vds-space-1)] pl-[calc(var(--tree-depth)*var(--vds-space-4))]"
            style={{ '--tree-depth': depth } as React.CSSProperties}
          >
            {children.length > 0 ? (
              <IconButton
                label={
                  batchExpanded.has(value.id)
                    ? literature('relations.collapse')
                    : literature('relations.expand')
                }
                size="sm"
                variant="ghostIcon"
                icon={
                  <Icon
                    name={batchExpanded.has(value.id) ? 'chevron-down' : 'chevron-right'}
                    size={12}
                  />
                }
                onClick={() => toggleBatchExpanded(value.id)}
              />
            ) : (
              <span className="w-6" />
            )}
            <Checkbox
              checked={batchSelection.has(value.id)}
              label={value.name}
              onCheckedChange={(checked) => toggleBatchValue(value.id, checked)}
            />
          </div>,
          ...(batchExpanded.has(value.id) ? visit(value.id, depth + 1) : []),
        ]
      })
    return visit(null, 0)
  }
  const exportSelected = async (): Promise<void> => {
    const ids = selected.length > 0 ? selected : items.map((item) => item.id)
    if (ids.length === 0) {
      setError({ key: 'relations.nothingToExport' })
      return
    }
    // 上限先在前端拦一次: 服务端同样会拒 (422 EXPORT_TOO_MANY_ITEMS), 但没必要让用户
    // 等一次注定失败的请求。两处共用 MAX_EXPORT_RECORDS 这一个数字。
    if (ids.length > MAX_EXPORT_RECORDS) {
      setError({ key: 'relations.exportTooMany' })
      return
    }
    const result = await exportBibtex(ids)
    if (!result.ok || typeof result.bibtex !== 'string') {
      setError(literatureErrorMessage(result.error, undefined, 'relations.exportFailed'))
      return
    }
    // 成功提示的条数以后端实际写入的条目为准: 选中的 id 可能已在别处被删除, 拿请求数会虚报。
    const exported = result.count ?? ids.length
    // 必须等用户在原生保存对话框里选完位置并真的落盘才算成功; 取消保存不提示, 也不报错。
    const saved = await saveBibtex(result.bibtex)
    if (saved.kind === 'saved') {
      toast({
        title: literature('batch.exportSucceeded', { count: exported }),
        tone: 'success',
      })
      return
    }
    if (saved.kind === 'failed') {
      setError({ key: 'relations.exportFailed', detail: saved.error })
    }
  }
  /**
   * 导入落地后让新文献当场可见: 清掉它一定不满足的窄化筛选 (标签、搜索词) 并回到
   * 第 1 页。搜索词是本地态, 必须一起清 —— 只改 query 的话防抖 effect 会把输入框里
   * 的旧词再写回去。计数与 facet 的刷新由 catalogue.imported 在同一次更新里带上。
   */
  const revealImported = (): void => {
    setSearch('')
    catalogue.imported({ q: undefined, tag_id: undefined })
  }
  /**
   * 解析落点的可读名字给 Zotero 弹窗显示。名字只是提示: 取不到就退回作用域本身,
   * 绝不能因为它挡住导入。
   */
  const resolveDestinationLabel = async (): Promise<string> => {
    const importDestination = activeImportDestination()
    const scope =
      importDestinationOverride.current === null && query.without_collection
        ? literature('panel.unfiled')
        : importDestination.projectId
          ? literature('navigation.project')
          : literature('navigation.overview')
    try {
      const [facets, projects] = await Promise.all([
        getLiteratureFacets({ project_id: importDestination.projectId || undefined }),
        getLiteratureProjects(),
      ])
      return importDestinationLabel(importDestination, facets.collections, projects.projects, scope)
    } catch {
      return scope
    }
  }
  const startImport = async (source: string): Promise<void> => {
    if (source === 'identifier') {
      setIdentifierOpen(true)
      return
    }
    if (source === 'files') {
      pdfInput.current?.click()
      return
    }
    if (source === 'bib_ris') {
      bibliographyInput.current?.click()
      return
    }
    if (source === 'zotero') {
      setZoteroOpen(true)
      setZoteroLoading(true)
      zoteroSubmitKey.current = crypto.randomUUID()
      setZoteroPreview(null)
      setZoteroError(null)
      setZoteroSelection(new Map())
      setZoteroUnfiled(true)
      setZoteroCollections(true)
      setZoteroDestination('')
      try {
        const [preview, label] = await Promise.all([previewZotero(), resolveDestinationLabel()])
        setZoteroPreview(preview)
        setZoteroDestination(label)
        setZoteroSelection(new Map([[preview.library.key, true]]))
      } catch (reason) {
        setZoteroError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'zotero.connectionFailed'
          )
        )
      } finally {
        setZoteroLoading(false)
      }
      return
    }
    try {
      setTask(await createImportTask(source))
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'batch.importFailed'
        )
      )
    }
  }
  // 左侧面板的「+」在列表卸载时 (全文文档标签占用中区) 也要能发起导入: 意图走
  // store, 列表挂载后消费一次, 而不是靠一个可能没人听的 DOM 事件。
  useEffect(() => {
    if (!importRequest) return
    catalogue.consumeImportRequest()
    importDestinationOverride.current = importRequest.destination
    void startImport(importRequest.source)
  }, [importRequest])
  const startZoteroImport = async (): Promise<void> => {
    // 受理返回前对话框还开着, 这里必须自己闭锁: 连点会各起一个后台导入, 而文献库
    // 是追加语义 (proposal 91), 两次点击就是两份条目。
    if (zoteroSubmitting) return
    setZoteroSubmitting(true)
    setZoteroError(null)
    try {
      if (!zoteroPreview) return
      const importDestination = activeImportDestination()
      const selection = zoteroSelectionDirectives(zoteroSelection)
      setTask(
        await createImportTask(
          'zotero',
          {
            project_id: importDestination.projectId,
            collection_id: importDestination.collectionId,
            selection,
            include_unfiled: zoteroUnfiled,
            import_collections: zoteroCollections,
            preview_revision: zoteroPreview.revision,
          },
          zoteroSubmitKey.current
        )
      )
      setZoteroOpen(false)
      importDestinationOverride.current = null
    } catch (reason) {
      setZoteroError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'zotero.importFailed'
        )
      )
    } finally {
      setZoteroSubmitting(false)
    }
  }
  const toggleZoteroNode = (node: ZoteroCollectionNode, selected: boolean): void => {
    setZoteroSelection((current) => {
      return updateZoteroSelection(current, node, selected)
    })
  }
  const importPdfFiles = async (
    input: FileList | readonly File[],
    importDestination = destination
  ): Promise<void> => {
    const files = Array.from(input)
    if (!files.length) return
    const records = files.map((file, index): PdfImportRecord => ({
      id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
      file,
      name: file.name,
      progress: 0,
      status: 'pending',
    }))
    setPdfImports(records)
    setPdfImportOpen(true)
    setError(null)
    const updateImport = (id: string, update: Partial<PdfImportRecord>): void => {
      setPdfImports((current) =>
        current.map((record) => (record.id === id ? { ...record, ...update } : record))
      )
    }
    let landed = 0
    for (const record of records) {
      if (
        record.file.type !== 'application/pdf' &&
        !record.name.toLocaleLowerCase().endsWith('.pdf')
      ) {
        updateImport(record.id, {
          status: 'failed',
          error: { key: 'pdfImport.onlyPdf' },
        })
        setPdfImportOpen(true)
        continue
      }
      try {
        const item = await importPdf(
          record.file,
          (progress, phase) => updateImport(record.id, { progress, status: phase }),
          importDestination.projectId,
          importDestination.collectionId
        )
        updateImport(record.id, {
          progress: 100,
          status: 'completed',
          title: item.title,
        })
        setNewlyImported((current) => new Set(current).add(item.id))
        landed += 1
      } catch (reason) {
        setPdfImportOpen(true)
        updateImport(record.id, {
          status: 'failed',
          error: literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            reason instanceof Error ? reason.message : undefined,
            'pdfImport.parseFailed'
          ),
        })
      }
    }
    // 一份都没落地时不要动用户的筛选: 清搜索词与标签是为「新文献看得见」服务的。
    if (landed > 0) revealImported()
  }
  const uploadPdf = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    const importDestination = activeImportDestination()
    importDestinationOverride.current = null
    void importPdfFiles(files, importDestination)
  }
  const clearPdfDrop = (): void => {
    pdfDragDepth.current = 0
    setPdfDropActive(false)
  }
  const uploadBibliography = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    const importDestination = activeImportDestination()
    importDestinationOverride.current = null
    setError(null)
    try {
      const result = await importBibliography(files, {
        projectId: importDestination.projectId,
        collectionId: importDestination.collectionId,
      })
      setNewlyImported((current) => new Set([...current, ...result.items.map((item) => item.id)]))
      if (result.items.length > 0) revealImported()
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError ? reason.failure.code : undefined,
          reason instanceof Error ? reason.message : undefined,
          'batch.bibliographyFailed'
        )
      )
    }
  }
  const renderImportMenu = (iconOnly = false, empty = false): React.JSX.Element => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {projectPresentation ? (
          <LibraryAction
            data-testid="literature-toolbar-import"
            variant={empty ? 'outline' : 'primary'}
            collapsible={!empty}
            label={literature('panel.projectAdd')}
          />
        ) : iconOnly ? (
          <IconButton
            data-testid="literature-toolbar-import"
            variant="outline"
            label={literature('panel.import')}
            icon={<IconFont type="icon-line-operation-add" />}
          />
        ) : (
          <Button
            variant="outline"
            icon={
              <IconFont
                type="icon-line-operation-add"
                className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none"
              />
            }
          >
            {literature('panel.import')}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[var(--vds-library-import-menu-width)]">
        {scopeProjectId ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                act.openWorkbenchView('literature', {
                  returnProjectId: scopeProjectId,
                })
              }}
            >
              <Link />
              {literature('panel.linkFromOverview')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {/* 菜单靠视口右缘（工具栏 .lit-actions 右对齐），提示气泡只能向左展开。 */}
        {IMPORT_SOURCES.map((source) => (
          <ImportSourceItem
            key={source.value}
            hint={source.hintKey ? literature(source.hintKey) : undefined}
            hintSide="left"
            icon={source.icon}
            label={literature(source.labelKey)}
            onSelect={() => {
              importDestinationOverride.current = null
              void startImport(source.value)
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <section
      className="lit-page h-full flex flex-col bg-[var(--vds-bg-gray-default)] text-[var(--vds-text-primary)] [--lit-muted:var(--vds-text-tertiary)] [--lit-green:var(--vds-brand-bg-default)] [--lit-muted-bg:var(--vds-bg-gray-default)] [--lit-text:var(--vds-text-primary)] [--lit-line:var(--vds-border-default)]"
      data-testid="literature-overview"
    >
      <Input
        ref={pdfInput}
        className="hidden"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        aria-label={literature('pdfImport.choose')}
        onChange={uploadPdf}
      />
      <Input
        ref={bibliographyInput}
        className="hidden"
        type="file"
        accept=".bib,.bibtex,.ris"
        multiple
        aria-label={literature('pdfImport.chooseBibliography')}
        onChange={(event) => void uploadBibliography(event)}
      />
      {identifierOpen ? (
        <IdentifierImport
          onClose={() => setIdentifierOpen(false)}
          onImported={(item) => {
            importDestinationOverride.current = null
            setNewlyImported((current) => new Set(current).add(item.id))
            revealImported()
          }}
          resolveDestination={activeImportDestination}
        />
      ) : null}
      <Dialog
        open={pdfImportOpen}
        onOpenChange={(open) => {
          const importing = pdfImports.some(
            (record) => !['completed', 'failed'].includes(record.status)
          )
          if (open || !importing) setPdfImportOpen(open)
        }}
      >
        <DialogContent className="w-[min(720px,calc(100vw-48px))] !gap-[var(--vds-space-2)]">
          <DialogHeader>
            <DialogTitle>{literature('panel.importPdf')}</DialogTitle>
            <DialogDescription>{literature('pdfImport.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea
            className="max-h-[min(420px,55vh)]"
            viewportClassName="space-y-[var(--vds-space-2)] pr-[var(--vds-space-2)]"
          >
            {pdfImports.map((record) => (
              <div
                key={record.id}
                className="rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-[var(--vds-space-3)]">
                  <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[calc(var(--vds-space-3)/2)]">
                    <div className="contents">
                      {React.createElement(fileIconForName(record.name), {
                        className: 'shrink-0 text-[var(--vds-icon-outline-default)]',
                        size: 15,
                        strokeWidth: 1.8,
                      })}
                      <strong
                        className="block min-w-0 truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                        title={record.name}
                      >
                        {record.name}
                      </strong>
                    </div>
                    {!['completed', 'failed'].includes(record.status) ? (
                      <span className="col-start-2 mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                        {record.status === 'pending'
                          ? literature('pdfImport.pending')
                          : record.status === 'uploading'
                            ? literature('pdfImport.uploading', {
                                progress: record.progress,
                              })
                            : literature('pdfImport.parsing')}
                      </span>
                    ) : null}
                  </div>
                  {record.status === 'completed' || record.status === 'failed' ? (
                    <Tag tone={record.status === 'completed' ? 'success' : 'error'}>
                      {literature(
                        record.status === 'completed' ? 'pdfImport.completed' : 'pdfImport.failed'
                      )}
                    </Tag>
                  ) : (
                    <Spinner size="sm" />
                  )}
                </div>
                {record.status !== 'failed' ? (
                  <ProgressBar
                    className="mt-[var(--vds-space-2)]"
                    indeterminate={record.status === 'parsing'}
                    value={record.progress}
                  />
                ) : null}
                {record.title ? (
                  <p
                    className="m-0 mt-[var(--vds-space-3)] truncate text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                    title={record.title}
                  >
                    <span className="text-[var(--vds-text-secondary)]">
                      {literature('pdfImport.title')}
                    </span>
                    {record.title}
                  </p>
                ) : null}
                {record.error ? (
                  <Alert
                    className="mt-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] !px-[var(--vds-space-4)] !py-[var(--vds-space-3)]"
                    tone="error"
                    title={literature('pdfImport.failure')}
                    description={record.error.detail ?? literature(record.error.key)}
                  />
                ) : null}
              </div>
            ))}
          </ScrollArea>
          <DialogFooter>
            <span className="mr-auto text-xs text-[var(--vds-text-secondary)]">
              {literature(
                pdfImports.some((record) => record.status === 'failed')
                  ? 'pdfImport.summaryWithFailures'
                  : 'pdfImport.summary',
                {
                  completed: pdfImports.filter((record) => record.status === 'completed').length,
                  total: pdfImports.length,
                  failed: pdfImports.filter((record) => record.status === 'failed').length,
                }
              )}
            </span>
            <Button
              disabled={pdfImports.some(
                (record) => !['completed', 'failed'].includes(record.status)
              )}
              onClick={() => setPdfImportOpen(false)}
            >
              {ui('done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={zoteroOpen}
        onOpenChange={(open) => {
          setZoteroOpen(open)
          if (!open) importDestinationOverride.current = null
        }}
      >
        <DialogContent data-ways="zotero" className="w-[min(720px,calc(100vw-48px))]">
          <DialogHeader>
            <DialogTitle>{literature('zotero.title')}</DialogTitle>
            <DialogDescription>{literature('zotero.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-40 flex-col gap-3 py-3">
            {zoteroLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[var(--vds-text-secondary)]">
                <Spinner size="sm" />
                {literature('zotero.connecting')}
              </div>
            ) : zoteroError ? (
              <Alert
                tone="error"
                title={literature('zotero.connectionFailed')}
                description={zoteroError.detail ?? literature(zoteroError.key)}
              />
            ) : zoteroPreview ? (
              <>
                <div className="flex items-center gap-3 rounded-md border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-3 py-2">
                  <Icon name="plug" size={16} />
                  <div className="min-w-0 flex-1">
                    <strong className="block text-sm">{literature('zotero.connected')}</strong>
                    <span className="text-xs text-[var(--vds-text-secondary)]">
                      {literature('zotero.summary', {
                        items: zoteroPreview.items,
                        pdfs: zoteroPreview.pdfs,
                        collections: zoteroPreview.collections,
                      })}
                    </span>
                  </div>
                </div>
                <ScrollArea
                  className="max-h-[min(360px,45vh)] rounded-md border border-[var(--vds-border-default)]"
                  shadow
                  viewportClassName="p-[var(--vds-space-2)]"
                  viewportProps={{
                    role: 'tree',
                    'aria-label': literature('zotero.tree'),
                  }}
                >
                  <ZoteroTreeNode
                    depth={0}
                    directives={zoteroSelection}
                    includeUnfiled={zoteroUnfiled}
                    node={zoteroPreview.library}
                    onToggle={toggleZoteroNode}
                    onToggleUnfiled={setZoteroUnfiled}
                    parentSelected={false}
                  />
                </ScrollArea>
                <div className="rounded-md border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-3">
                  {zoteroDestination ? (
                    <p className="m-0 mb-[var(--vds-space-2)] truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)]">
                      {literature('panel.importDestination', {
                        target: zoteroDestination,
                      })}
                    </p>
                  ) : null}
                  <Checkbox
                    checked={zoteroCollections}
                    label={literature('zotero.preserve')}
                    onCheckedChange={setZoteroCollections}
                  />
                  <p className="m-0 mt-1 pl-6 text-[11px] text-[var(--vds-text-secondary)]">
                    {zoteroCollections
                      ? literature('zotero.withCollections')
                      : literature('zotero.withoutCollections')}
                    {literature('zotero.append')}
                  </p>
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setZoteroOpen(false)
                importDestinationOverride.current = null
              }}
            >
              {literature('batch.cancel')}
            </Button>
            <Button
              disabled={zoteroImportBlocked(
                zoteroPreview,
                zoteroUnfiled,
                zoteroSelection,
                zoteroLoading || zoteroSubmitting
              )}
              loading={zoteroSubmitting}
              onClick={() => void startZoteroImport()}
            >
              {literature('zotero.start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <header
        className={
          projectPresentation
            ? returnProject
              ? 'shrink-0 p-[var(--vds-space-5)] pb-0'
              : 'contents'
            : 'lit-toolbar min-h-[var(--vds-workbench-content-toolbar-height)] py-[var(--vds-library-toolbar-padding-block)] px-[var(--vds-library-toolbar-padding-inline)] border-b border-[var(--vds-border-default)] flex items-center justify-end gap-[var(--vds-space-2)] min-w-0 flex-wrap'
        }
        data-workbench-divider
      >
        {returnProject ? (
          <Button
            data-testid="literature-return-project"
            className="mr-auto shrink-0"
            variant="secondary"
            size="md"
            icon={<ArrowLeft />}
            onClick={() => {
              act.selectProject(returnProject.id)
              act.openWorkbenchView('resource', { preserveProject: true })
            }}
          >
            {literature('navigation.returnProject')}
          </Button>
        ) : null}
        {selected.length > 0 ? (
          renderSelection(
            <div
              data-testid="literature-selection-toolbar"
              className={
                projectPresentation
                  ? 'flex min-w-max flex-1 items-center justify-end gap-[var(--vds-space-2)] whitespace-nowrap text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]'
                  : 'flex min-w-0 flex-1 flex-wrap items-center justify-end gap-[var(--vds-space-2)] whitespace-nowrap text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]'
              }
            >
              <span className="font-[var(--vds-fw-regular)]">
                {literature('batch.selected', { count: selected.length })}
              </span>
              <MetadataBatch
                entries={selected.map((id) => ({
                  id,
                  title: items.find((item) => item.id === id)?.title ?? id,
                }))}
                projectId={projectId}
                triggerVariant="tertiary"
              />
              <Button
                size="md"
                variant="tertiary"
                icon={<ArrowUpFromLine size={14} />}
                onClick={() => void exportSelected()}
              >
                {literature('batch.export')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="md" variant="tertiary" icon={<Plus />}>
                    {literature('batch.addTo')}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void openBatch('collection')}>
                    {literature('batch.collection')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void openBatch('project')}>
                    {literature('batch.project')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void openBatch('tag')}>
                    {literature('batch.tag')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="md"
                variant="danger"
                icon={<Trash size={14} />}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {ui('delete')}
              </Button>
              <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {projectId
                        ? literature('batch.removeProject')
                        : literature('batch.deleteTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {projectId
                        ? literature('batch.removeDescription', {
                            count: selected.length,
                          })
                        : literature('batch.deleteDescription', {
                            count: selected.length,
                          })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{ui('cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      className="![background:var(--vds-error-bg-default)] ![color:var(--vds-static-white)]"
                      onClick={(event) => {
                        event.preventDefault()
                        void deletePicked()
                      }}
                    >
                      {projectId
                        ? literature('batch.confirmRemove')
                        : literature('batch.confirmDelete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button size="md" variant="tertiary" onClick={() => catalogue.clear()}>
                {ui('cancel')}
              </Button>
            </div>
          )
        ) : projectPresentation ? (
          <LibraryToolbar
            searchVisible
            query={search}
            onQuery={setSearch}
            placeholder={literature('panel.projectSearchPlaceholder')}
            refreshing={loading}
            onRefresh={() => catalogue.reload()}
            leading={
              scopeProjectId && (
                <Groups
                  key={scopeProjectId}
                  projectId={scopeProjectId}
                  collections={projectCollections}
                  value={query.without_collection ? 'unfiled' : (query.collection_id?.[0] ?? 'all')}
                  onValueChange={(value) =>
                    catalogue.query({
                      collection_id: value !== 'all' && value !== 'unfiled' ? [value] : undefined,
                      recent: undefined,
                      without_collection: value === 'unfiled' ? true : undefined,
                    })
                  }
                  onCollectionsChange={(items) =>
                    setCollectionCatalog({ projectId: scopeProjectId, items })
                  }
                  onReload={() => catalogue.reload()}
                />
              )
            }
          >
            {renderImportMenu(true)}
          </LibraryToolbar>
        ) : (
          <div className="lit-actions ml-auto flex items-center gap-[var(--vds-library-list-actions-gap)] [&_.vds-icon-button]:w-[var(--vds-library-action-icon-button-size)] [&_.vds-icon-button]:h-[var(--vds-library-action-icon-button-size)] [&_.vds-icon-button]:text-[var(--vds-text-tertiary)]">
            <MetadataBatch entries={[]} projectId={projectId} />
            {renderImportMenu(true)}
            <form
              className="lit-search flex w-[var(--vds-library-list-search-width)] items-center gap-[var(--vds-library-list-gap)] ml-[var(--vds-library-list-search-margin-left)]"
              onSubmit={(event) => event.preventDefault()}
            >
              <SearchBox
                aria-label={literature('list.search')}
                placeholder={literature('list.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </form>
          </div>
        )}
      </header>
      {task ? (
        <div className="lit-task flex items-center gap-[var(--vds-library-list-gap)] border-b border-[var(--vds-border-default)] p-[var(--vds-library-list-task-padding)] text-[length:var(--vds-font-body-lv1)]">
          <span>
            {literature('list.importTask')} · {literature(literatureTaskStatusMessage(task.status))}
          </span>
          <ProgressBar className="flex-1" value={Math.round(task.progress * 100)} />
          <span>
            {task.completed_count}/{task.total_count}
          </span>
          {taskError ? (
            <span>
              {literature(taskError.key)}
              {taskError.detail ? <span> {taskError.detail}</span> : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {query.download_session_id ? (
        <Alert
          data-testid="literature-download-scope"
          description={literature('downloads.scope')}
          action={
            <Button size="sm" variant="ghost" onClick={() => catalogue.navigate()}>
              {literature('downloads.exitScope')}
            </Button>
          }
        />
      ) : null}
      {collectionsFailed ? (
        <div
          className="lit-error m-[var(--vds-library-list-error-margin)] flex items-center justify-between gap-[var(--vds-library-list-gap)] p-[var(--vds-library-list-error-padding)]"
          role="alert"
        >
          <span>{layoutText('readFailed')}</span>
          <Button size="sm" variant="ghost" onClick={() => catalogue.reload()}>
            {ui('retry')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="lit-error m-[var(--vds-library-list-error-margin)] flex items-center justify-between gap-[var(--vds-library-list-gap)] p-[var(--vds-library-list-error-padding)]">
          <span>{error.detail ?? literature(error.key)}</span>
          <Button size="sm" variant="ghost" onClick={() => catalogue.reload()}>
            {ui('retry')}
          </Button>
        </div>
      ) : null}
      <div
        className={`lit-body relative flex flex-1 min-h-0 items-stretch overflow-hidden${focusedId ? ' has-detail' : ''} isolate ${projectPresentation ? 'p-[var(--vds-space-4)]' : 'p-4'}`}
      >
        <div
          className="relative flex flex-1 min-w-0"
          data-drop-active={pdfDropActive ? 'true' : 'false'}
          data-testid="literature-drop-target"
          onPointerDownCapture={(event) => {
            if (event.button !== 0 || !focusedId) return
            // 落在行上的按下交给行自己的 onClick 去决定开还是关: 这里先关一次的话,
            // 随后的 click 读到的已经是清空后的 focusedId, 抽屉会被立刻重新打开,
            // 于是「再点一次收起」永远不成立。行内的复选框、附件展开等子控件也
            // 因此保住抽屉状态 —— 它们本来就在 click 上 stopPropagation。
            if ((event.target as HTMLElement).closest(`.${ROW_SELECTOR_CLASS}`)) return
            catalogue.focus(null)
            setDetailIntent(null)
          }}
          onDragEnter={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            pdfDragDepth.current += 1
            setPdfDropActive(true)
          }}
          onDragLeave={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            pdfDragDepth.current = Math.max(0, pdfDragDepth.current - 1)
            if (pdfDragDepth.current === 0) setPdfDropActive(false)
          }}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setPdfDropActive(true)
          }}
          onDrop={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'copy'
            clearPdfDrop()
            void importPdfFiles(event.dataTransfer.files)
          }}
        >
          <div
            className={`lit-table ${TABLE_EMPTY_STATE_CLASS} flex-1 w-full min-w-0 overflow-x-auto overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-line-1)] ${projectPresentation ? '[&>.lit-table-head]:min-w-[max(var(--vds-library-paper-width),var(--literature-grid-width))] [&>.lit-row]:min-w-[max(var(--vds-library-paper-width),var(--literature-grid-width))] [&>.lit-attachment-row]:min-w-[max(var(--vds-library-paper-width),var(--literature-grid-width))] [&_.lit-table-head]:bg-[var(--vds-library-header-background)]' : ''} bg-[var(--vds-bg-gray-default)]`}
            style={{ '--literature-grid-width': `${gridWidth}px` } as React.CSSProperties}
            ref={tableScroll}
          >
            <div
              className="lit-table-head sticky top-0 z-[var(--vds-z-local-top)] h-[var(--vds-library-header-height)] relative grid min-w-[var(--literature-grid-width)] library-narrow:min-w-[max(var(--vds-library-table-narrow-min-width),var(--literature-grid-width))] items-center border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-hover)] text-[var(--vds-text-tertiary)] text-[length:var(--vds-font-body-lv2)] [&>span]:px-[var(--vds-library-table-cell-padding-inline)] [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
              style={{ gridTemplateColumns: grid }}
            >
              <div className={STICKY_HEADER_CELLS_CLASS}>
                <span />
                <Checkbox
                  checked={selectAllState}
                  label={literature('list.selectAll')}
                  onCheckedChange={(checked) =>
                    catalogue.selectAll(
                      items.map((item) => item.id),
                      checked
                    )
                  }
                />
                <span className="lit-pdf-cell grid place-items-center text-[var(--vds-text-tertiary)]">
                  <IconButton
                    label={literature('list.sortByAttachment')}
                    variant="ghostIcon"
                    size="sm"
                    icon={<Icon name="clip" size={13} />}
                    onClick={() => applySort(ATTACHMENT_SORT)}
                  />
                </span>
              </div>
              {visibleColumns.map((column) => (
                <span
                  key={column.key}
                  className={`lit-column-head relative flex h-full items-center p-0 font-[var(--vds-fw-regular)] [&_button]:!font-[var(--vds-fw-regular)]${column.key === 'title' ? ' text-[var(--vds-text-primary)]' : ''}`}
                  draggable
                  onDragStart={() => setDraggedColumn(column.key)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (!draggedColumn || draggedColumn === column.key) return
                    const next = [...columns]
                    const from = next.findIndex((entry) => entry.key === draggedColumn)
                    const to = next.findIndex((entry) => entry.key === column.key)
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    saveColumns(next)
                    setDraggedColumn(null)
                  }}
                >
                  {column.key === 'tags' ? (
                    <TagFilter />
                  ) : COLUMN_META[column.key].sort ? (
                    <Button
                      variant="ghost"
                      size="md"
                      className={`${LIBRARY_HEADER_ACTION_CLASS} !mx-[var(--vds-space-2)] !w-[calc(100%-var(--vds-space-2)-var(--vds-space-2))]`}
                      onClick={() => applySort(COLUMN_META[column.key].sort!)}
                    >
                      <EllipsisText
                        tooltipPortalled
                        tooltipSide="bottom"
                        wrapperClassName="min-w-0"
                      >
                        {projectPresentation && column.key === 'publication'
                          ? literature('columns.journal')
                          : literature(COLUMN_META[column.key].labelKey)}
                      </EllipsisText>
                      {query.sort === COLUMN_META[column.key].sort ? (
                        <span className={query.order === 'asc' ? 'rotate-180' : ''}>
                          <Icon name="chevron-down" size={11} />
                        </span>
                      ) : null}
                    </Button>
                  ) : (
                    <span className="flex h-full min-w-0 items-center px-[var(--vds-space-2)]">
                      <EllipsisText
                        tooltipPortalled
                        tooltipSide="bottom"
                        wrapperClassName="min-w-0"
                      >
                        {literature(COLUMN_META[column.key].labelKey)}
                      </EllipsisText>
                    </span>
                  )}
                  <i
                    className={COLUMN_RESIZER_CLASS}
                    onPointerDown={(event) => resizeColumn(column.key, event)}
                  />
                </span>
              ))}
            </div>
            {loading ? (
              <div className="grid min-h-[var(--vds-library-loading-min-height)] place-items-center">
                <Spinner aria-label={literature('list.loading')} />
              </div>
            ) : items.length === 0 ? (
              libraryEmpty ? (
                <EmptyState
                  image={{ src: emptyImage, alt: '' }}
                  title={literature('list.empty')}
                  action={renderImportMenu(false, true)}
                />
              ) : (
                <EmptyState
                  image={{ src: emptyImage, alt: '' }}
                  title={literature('list.emptyScope')}
                  description={literature('list.emptyScopeDescription')}
                />
              )
            ) : (
              <>
                <div aria-hidden style={{ height: listPadTop }} />
                {virtualRows.map((virtual) => {
                  const entry = entries[virtual.index]
                  if (!entry) return null
                  if (entry.kind === 'attachment') {
                    const { attachment, item } = entry
                    return (
                      <div
                        key={attachment.id}
                        data-index={virtual.index}
                        data-testid={`literature-attachment-${attachment.id}`}
                        ref={rowVirtualizer.measureElement}
                        className={`${ATTACHMENT_ROW_CLASS}${focusedAttachmentId === attachment.id ? ' is-focused' : ''}`}
                        onClick={() => catalogue.focusAttachment(item.id, attachment.id)}
                        onDoubleClick={
                          isAttachmentAvailable(attachment)
                            ? () => act.openLiteratureAttachment(item.id, attachment.id)
                            : undefined
                        }
                      >
                        {React.createElement(fileIconForName(attachment.name), {
                          size: 16,
                          strokeWidth: 1.8,
                        })}
                        <EllipsisText
                          tooltip={attachment.name}
                          tooltipPortalled
                          wrapperClassName="min-w-0"
                        >
                          {attachment.name.length > 128
                            ? `${attachment.name.slice(0, 62)}…${attachment.name.slice(-65)}`
                            : attachment.name}
                        </EllipsisText>
                      </div>
                    )
                  }
                  const { item, index } = entry
                  return (
                    <Row
                      key={item.id}
                      item={item}
                      onItemUpdated={updateVisibleItem}
                      onTagMinimumWidth={onTagMinimumWidth}
                      entryIndex={virtual.index}
                      columns={scopedColumns}
                      projectPresentation={projectPresentation}
                      grid={grid}
                      checked={picked.has(item.id)}
                      isNew={newlyImported.has(item.id)}
                      expanded={expanded.has(item.id)}
                      focused={focusedId === item.id && !focusedAttachmentId}
                      projectId={projectId}
                      onDragStart={
                        projectPresentation && scopeProjectId
                          ? (event) =>
                              writeLiteratureDrag(
                                event.dataTransfer,
                                scopeProjectId,
                                item,
                                items.filter((entry) => selected.includes(entry.id))
                              )
                          : undefined
                      }
                      menu={{
                        viewPdf: (attachmentId) =>
                          act.openLiteratureAttachment(item.id, attachmentId),
                        copyTitle: () => void copyItemTitle(item),
                        viewInfo: () => openDetail(item),
                        addNote: () => openDetail(item, 'note'),
                        addAttachment: () => openDetail(item, 'attachment'),
                        remove: () => setRemoveTarget(item),
                      }}
                      rowRef={(node) => {
                        rowVirtualizer.measureElement(node)
                        if (node) rowRefs.current.set(item.id, node)
                        else rowRefs.current.delete(item.id)
                      }}
                      tabIndex={index === keyRowIndex ? 0 : -1}
                      onKeyDown={(event) => rowKeyDown(index, event)}
                      onToggle={() =>
                        setExpanded((current) => {
                          const next = new Set(current)
                          if (next.has(item.id)) next.delete(item.id)
                          else next.add(item.id)
                          return next
                        })
                      }
                      onActivate={() => {
                        setKeyRowIndex(index)
                        toggleDetail(item)
                      }}
                      onOpenFulltext={(attachmentId) =>
                        act.openLiteratureAttachment(item.id, attachmentId)
                      }
                    />
                  )
                })}
                <div aria-hidden style={{ height: listPadBottom }} />
              </>
            )}
          </div>
          {pdfDropActive ? (
            <div
              className="pointer-events-none absolute inset-0 z-[var(--vds-z-local-control)] flex items-center justify-center rounded-[var(--vds-radius-6)] border-2 border-dashed border-[var(--vds-brand-border-default)] bg-[var(--vds-brand-light-bg-default)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-brand-text-primary)]"
              role="status"
            >
              <span className="flex items-center gap-[var(--vds-space-2)]">
                <MonitorDown size={18} strokeWidth={1.8} />
                {literature('pdfImport.drop')}
              </span>
            </div>
          ) : null}
          <div
            className={`lit-column-actions absolute top-0 right-0 z-[var(--vds-z-scroll-control)] w-[var(--vds-library-column-actions-width)] h-[var(--vds-library-header-height)] flex items-center justify-center bg-[var(--vds-bg-gray-hover)] border-t border-r border-[var(--vds-line-1)] rounded-tr-[var(--vds-radius-6)] ${projectPresentation ? 'opacity-0 hover:opacity-[var(--vds-opacity-full)] focus-within:opacity-[var(--vds-opacity-full)]' : ''}`}
          >
            <Popover>
              <PopoverTrigger asChild>
                <IconButton
                  label={literature('list.columns')}
                  variant="ghostIcon"
                  size="md"
                  icon={<Icon name="settings" size={14} />}
                />
              </PopoverTrigger>
              <PopoverContent className="w-72 p-3">
                <strong className="block text-sm text-[var(--vds-text-primary)]">
                  {literature('list.customizeColumns')}
                </strong>
                <span className="mb-3 block text-xs text-[var(--vds-text-tertiary)]">
                  {literature('list.columnsDescription')}
                </span>
                <ScrollArea
                  className="max-h-[min(440px,60vh)]"
                  viewportClassName="grid grid-cols-2 gap-x-3 gap-y-2 pr-2"
                >
                  {scopedColumns.map((column) => (
                    <Checkbox
                      key={column.key}
                      checked={column.visible}
                      disabled={column.key === 'title'}
                      label={literature(COLUMN_META[column.key].labelKey)}
                      onCheckedChange={(visible) =>
                        saveColumns(
                          columns.map((entry) =>
                            entry.key === column.key ? { ...entry, visible } : entry
                          )
                        )
                      }
                    />
                  ))}
                </ScrollArea>
                <Button
                  className="mt-3 w-full"
                  variant="outline"
                  onClick={() =>
                    saveColumns(projectPresentation ? PROJECT_DEFAULT_COLUMNS : DEFAULT_COLUMNS)
                  }
                >
                  {literature('list.restoreColumns')}
                </Button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <Sheet
          open={Boolean(focusedId)}
          onOpenChange={(open) => {
            if (open) return
            catalogue.focus(null)
            setDetailIntent(null)
          }}
        >
          <LiteratureDetail
            id={focusedId ?? retainedFocus.current.id}
            attachmentId={focusedId ? focusedAttachmentId : retainedFocus.current.attachmentId}
            intent={detailIntent}
            onClose={() => {
              catalogue.focus(null)
              setDetailIntent(null)
            }}
            onIntentConsumed={clearDetailIntent}
            onItemUpdated={updateVisibleItem}
          />
        </Sheet>
      </div>
      <Dialog
        open={batchDialog !== null}
        onOpenChange={(open) => {
          if (!open) setBatchDialog(null)
        }}
      >
        <DialogContent className="w-[min(560px,calc(100vw-36px))]">
          <DialogHeader>
            <DialogTitle>
              {batchDialog === 'project'
                ? literature('batch.project')
                : batchDialog === 'collection'
                  ? projectId
                    ? literature('batch.addCollection')
                    : literature('batch.collection')
                  : literature('batch.tag')}
            </DialogTitle>
            <DialogDescription>
              {literature('batch.description', { count: selected.length })}
            </DialogDescription>
          </DialogHeader>
          {batchDialog === 'project' && batchProjects.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Icon name="folder" />}
              title={literature('batch.noProjects')}
            />
          ) : batchDialog === 'project' ? (
            <Select
              disabled={batchLoading || batchSaving}
              value={batchProjectId}
              onValueChange={(value) => {
                setBatchProjectId(value)
                setBatchSelection(new Set())
              }}
            >
              <SelectTrigger aria-label={literature('batch.selectProject')} className="mb-3 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {batchProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {batchDialog === 'tag' && batchTags.length > 0 ? (
            <SearchBox
              value={batchSearch}
              onChange={(event) => setBatchSearch(event.target.value)}
              placeholder={literature('batch.searchTagsPlaceholder')}
              aria-label={literature('batch.searchTags')}
              containerClassName="mb-3 w-full"
            />
          ) : null}
          {batchDialog === 'collection' && collectionOptions.length === 0 ? (
            <p className="m-0 text-xs leading-5 text-[var(--vds-text-secondary)]">
              {literature('batch.noCustom')}
            </p>
          ) : batchDialog === 'project' && batchProjects.length === 0 ? null : batchDialog ===
              'project' && collectionOptions.length === 0 ? (
            <p className="m-0 text-xs leading-5 text-[var(--vds-text-secondary)]">
              {literature('batch.noProjectCollections')}
            </p>
          ) : batchDialog === 'tag' && visibleBatchTags.length === 0 ? (
            <p className="m-0 text-xs leading-5 text-[var(--vds-text-secondary)]">
              {literature('batch.noTags')}
            </p>
          ) : (
            <ScrollArea
              className="max-h-[min(360px,50vh)] rounded-md border border-[var(--vds-border-default)]"
              viewportClassName={
                batchDialog === 'tag' ? 'flex flex-wrap items-center gap-x-3 gap-y-2 p-3' : 'p-3'
              }
            >
              {batchDialog === 'tag'
                ? visibleBatchTags.map((value) => (
                    <Checkbox
                      key={value.id}
                      checked={batchSelection.has(value.id)}
                      label={value.name}
                      onCheckedChange={(checked) => toggleBatchValue(value.id, checked)}
                    />
                  ))
                : batchCollectionRows(collectionOptions)}
            </ScrollArea>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDialog(null)}>
              {literature('batch.cancel')}
            </Button>
            <Button
              disabled={
                batchLoading ||
                batchSaving ||
                (batchDialog === 'project' ? !batchProjectId : batchSelection.size === 0)
              }
              loading={batchLoading || batchSaving}
              onClick={() => void submitBatch()}
            >
              {literature('batch.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent data-testid="literature-row-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {projectId ? literature('batch.removeProject') : literature('batch.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {projectId
                ? literature('list.rowMenu.removeDescription', {
                    title: removeTarget?.title ?? '',
                  })
                : literature('list.rowMenu.deleteDescription', {
                    title: removeTarget?.title ?? '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{ui('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="![background:var(--vds-error-bg-default)] ![color:var(--vds-static-white)]"
              disabled={removing}
              onClick={(event) => {
                event.preventDefault()
                void confirmRemoveItem()
              }}
            >
              {projectId ? literature('batch.confirmRemove') : literature('batch.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
