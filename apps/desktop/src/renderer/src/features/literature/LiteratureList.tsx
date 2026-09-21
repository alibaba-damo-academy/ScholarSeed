import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  isAttachmentAvailable,
  type LiteratureFacet,
  type LiteratureProject,
  type LiteratureQuery,
  type LiteratureSummary,
  type LiteratureTask
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
  semanticTagColorFor,
  Sheet,
  Spinner,
  Tag,
  Tooltip,
  useToast
} from '../../components/ui'
import emptyImage from '../../assets/empty_img.webp'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { ArrowDownToLine, ArrowLeft, FileDown, Link, MonitorDown, Trash } from 'lucide-react'
import { fileIconForName, IconFont } from '../../components/primitive'
import { IMPORT_SOURCES } from './imports'
import {
  LiteratureApiError,
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
  previewZotero,
  ZOTERO_LIBRARY_ROOT_KEY,
  type PdfImportPhase,
  type ZoteroCollectionNode,
  type ZoteroPreview
} from './api'
import {
  catalogue,
  importDestination,
  importDestinationLabel,
  useCatalogue
} from './catalog'
import {
  literatureErrorMessage,
  literatureTaskErrorMessage,
  literatureTaskStatusMessage,
  type LiteratureErrorMessage
} from './error'
import { saveBibtex } from './export'
import { LiteratureDetail } from './LiteratureDetail'
import { timestampLabel } from './projection'
import { createFormatters } from '../../../../localization/format'
import {
  inheritedZoteroSelection,
  updateZoteroSelection,
  zoteroImportBlocked,
  zoteroNodeState,
  zoteroSelectionDirectives
} from './zotero'

import './literature.css'

const SEARCH_DEBOUNCE_MS = 260
const COLUMN_STORAGE_KEY = 'scholarseed.literature.columns.v1'
const SORT_STORAGE_KEY = 'scholarseed.literature.sort.v1'
// 曲别针列的排序键，与后端 ATTACHMENT_SORT_KEY 同名：有附件=0 排在无附件=1 之前，
// 次级键是列表原始序。它不在 COLUMN_META 里 —— 这一列固定常驻在标题前，
// 既是附件有无的标识，也是展开附件行的唯一入口，不能被隐藏或拖走。
const ATTACHMENT_SORT: NonNullable<LiteratureQuery['sort']> = 'attachment'
const EMPTY_CELL = '—'
const CHIP_CELL_CLASS = 'flex items-center gap-1'
// 芯片不参与压缩: 否则它们会先自己缩小并内部省略, 单元格就不再溢出, tooltip 也无法判定展示不全。
const CHIP_CLASS = 'shrink-0 max-w-none'
// 折叠计数芯片: 同样不参与压缩, 数字宽度稳定避免列表滚动时跳动。
const MORE_CHIP_CLASS = 'shrink-0 max-w-none tabular-nums'
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
  }
> = {
  title: { labelKey: 'columns.title', sort: 'title', minimum: 180 },
  subtitle: { labelKey: 'columns.subtitle', sort: 'subtitle', minimum: 140 },
  creator: { labelKey: 'columns.creator', sort: 'creator', minimum: 100 },
  publication: {
    labelKey: 'columns.publication',
    sort: 'publication',
    minimum: 130
  },
  year: { labelKey: 'columns.year', sort: 'year', minimum: 64 },
  published_date: {
    labelKey: 'columns.published_date',
    sort: 'published_date',
    minimum: 110
  },
  citation_key: {
    labelKey: 'columns.citation_key',
    sort: 'citation_key',
    minimum: 110
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
    minimum: 160
  },
  updated_at: {
    labelKey: 'columns.updated_at',
    sort: 'updated_at',
    minimum: 160
  },
  collections: { labelKey: 'columns.collections', minimum: 130 },
  tags: { labelKey: 'columns.tags', minimum: 120 },
  projects: { labelKey: 'columns.projects', minimum: 120 }
}
const DEFAULT_VISIBLE = new Set<ColumnKey>([
  'title',
  'creator',
  'year',
  'created_at',
  'projects'
])
const DEFAULT_COLUMNS: ColumnSetting[] = (
  Object.keys(COLUMN_META) as ColumnKey[]
).map((key) => ({
  key,
  width: key === 'title' ? 340 : Math.max(COLUMN_META[key].minimum, 150),
  visible: DEFAULT_VISIBLE.has(key)
}))
function loadColumns(): ColumnSetting[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem(COLUMN_STORAGE_KEY) ?? '[]'
    ) as ColumnSetting[]
    if (stored.length && stored.every((entry) => entry.key in COLUMN_META)) {
      const values = new Map(stored.map((entry) => [entry.key, entry]))
      return [
        // 列的最小宽度会随展示文案调整, 已保存的宽度按当前下限收敛, 避免旧宽度继续截断内容。
        ...stored
          .filter((entry) => entry.key in COLUMN_META)
          .map((entry) => ({
            ...entry,
            width: Math.max(COLUMN_META[entry.key].minimum, entry.width)
          })),
        ...DEFAULT_COLUMNS.filter((entry) => !values.has(entry.key))
      ]
    }
  } catch {
    /* use defaults */
  }
  return DEFAULT_COLUMNS
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
function Row({
  item,
  columns,
  grid,
  checked,
  expanded,
  focused,
  isNew,
  onOpen,
  onOpenFulltext,
  onToggle
}: {
  item: LiteratureSummary
  columns: ColumnSetting[]
  grid: string
  checked: boolean
  expanded: boolean
  focused: boolean
  isNew: boolean
  onOpen: () => void
  onOpenFulltext: (attachmentId: string) => void
  onToggle: () => void
}): React.JSX.Element {
  const { t: literature, i18n } = useTranslation('literature')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
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
        wrapperClassName="lit-title-cell"
      >
        <strong>{item.title}</strong>
      </EllipsisText>
    ) : key === 'creator' ? (
      <EllipsisText key={key} tooltipPortalled tooltipContentClassName="[--vds-tooltip-max-height:var(--vds-literature-author-tooltip-max-height)]">
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
      <EllipsisText
        key={key}
        tooltip={
          item.projects.length === 0
            ? literature('list.noProject')
            : facetNames(item.projects)
        }
        tooltipPortalled
      >
        <span className={CHIP_CELL_CLASS}>
          {item.projects.length === 0 ? (
            <Badge className={CHIP_CLASS} tone="brand">
              {literature('list.noProject')}
            </Badge>
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
                      names: facetNames(item.projects.slice(1))
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
      <EllipsisText key={key} tooltip={facetNames(item[key])} tooltipPortalled>
        <span className={CHIP_CELL_CLASS}>
          {item.tags.length === 0 ? EMPTY_CELL : (
            <>
                <Tag
                  className="min-w-0 max-w-full"
                  color={semanticTagColorFor(item.tags[0].id)}
                >
                  {item.tags[0].name}
                </Tag>
                {item.tags.length > 1 ? (
                  <Tooltip
                    className="shrink-0"
                    content={(
                      <span className="flex flex-wrap gap-1">
                        {item.tags.slice(1).map((tag) => (
                          <Tag color={semanticTagColorFor(tag.id)} key={tag.id}>
                            {tag.name}
                          </Tag>
                        ))}
                      </span>
                    )}
                    contentClassName="[--vds-tooltip-bg:var(--vds-bg-white-default)] [--vds-tooltip-color:var(--vds-text-primary)]"
                    portalled
                  >
                    <Badge
                      aria-label={literature('list.moreTags', {
                        count: item.tags.length - 1,
                        names: facetNames(item.tags.slice(1))
                      })}
                      className={MORE_CHIP_CLASS}
                      size="sm"
                      tabIndex={0}
                      tone="neutral"
                    >
                      +{item.tags.length - 1}
                    </Badge>
                  </Tooltip>
                ) : null}
            </>
          )}
        </span>
      </EllipsisText>
    ) : key === 'collections' ? (
      <EllipsisText key={key} tooltip={facetNames(item[key])} tooltipPortalled>
        <span className={CHIP_CELL_CLASS}>
          {item[key].length === 0
            ? EMPTY_CELL
            : item[key].map((facet) => (
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
    <div
      className={`lit-row${checked ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`}
      style={{ gridTemplateColumns: grid }}
      onClick={onOpen}
      onDoubleClick={
        primaryAttachment
          ? () => onOpenFulltext(primaryAttachment.id)
          : undefined
      }
    >
      <div className="lit-sticky-cells">
        <span
          className={`lit-unread${isNew ? ' is-on' : ''}`}
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
          className="lit-pdf-cell"
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
              icon={
                <Icon
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={13}
                />
              }
              onClick={onToggle}
            />
          ) : null}
        </span>
      </div>
      {columns
        .filter((column) => column.visible)
        .map((column) => cell(column.key))}
    </div>
  )
}

function ZoteroTreeNode({
  depth,
  directives,
  includeUnfiled,
  node,
  onToggle,
  onToggleUnfiled,
  parentSelected
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
  const selected = inheritedZoteroSelection(
    node.key,
    parentSelected,
    directives
  )
  const state = zoteroNodeState(node, parentSelected, directives)
  const displayedState =
    node.key !== ZOTERO_LIBRARY_ROOT_KEY ||
    state === 'mixed' ||
    state === includeUnfiled
      ? state
      : 'mixed'
  const hasChildren = node.children.length > 0
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-level={depth + 1}
    >
      <div
        className="flex min-h-8 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-sm)] pl-[calc(var(--zotero-depth)*var(--vds-space-4))] pr-[var(--vds-space-2)] hover:bg-[var(--vds-surface-hover)]"
        style={{ '--zotero-depth': depth } as React.CSSProperties}
      >
        {hasChildren ? (
          <IconButton
            label={literature(open ? 'zotero.collapse' : 'zotero.expand', {
              name: node.name
            })}
            size="sm"
            variant="ghostIcon"
            icon={
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            }
            onClick={() => setOpen((current) => !current)}
          />
        ) : (
          <span className="inline-block w-8" />
        )}
        <Checkbox
          checked={displayedState}
          aria-label={literature(
            displayedState === true ? 'zotero.deselect' : 'zotero.select',
            { name: node.name }
          )}
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
                  includeUnfiled
                    ? 'zotero.deselectUnfiled'
                    : 'zotero.selectUnfiled'
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

export function LiteratureList(): React.JSX.Element {
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
      ? state.projects.find(
          (project) => project.id === state.workbenchReturnProjectId
        )
      : undefined
  const {
    query,
    selected,
    focusedId,
    focusedAttachmentId,
    reload,
    importRequest
  } = useCatalogue()
  const projectId = query.project_id
  const [items, setItems] = useState<LiteratureSummary[]>([])
  const [search, setSearch] = useState(query.q ?? '')
  // 导入落点 = 左侧当前选择; PDF / Bib-RIS / Zotero 三条渠道共用这一份推导。
  const destination = importDestination(query)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  const [task, setTask] = useState<LiteratureTask | null>(null)
  const taskError =
    task && (task.error || task.error_code)
      ? literatureTaskErrorMessage(task)
      : null
  const [zoteroOpen, setZoteroOpen] = useState(false)
  const [zoteroLoading, setZoteroLoading] = useState(false)
  const [zoteroSubmitting, setZoteroSubmitting] = useState(false)
  // 一次「打开对话框 → 提交」共用一个受理幂等键: 连点、或提交响应丢失后的重试都拿
  // 同一个 key 去受理, 服务端就交回同一个任务, 而不是再导一遍 (文献是追加语义)。
  const zoteroSubmitKey = useRef(crypto.randomUUID())
  const [zoteroPreview, setZoteroPreview] = useState<ZoteroPreview | null>(null)
  const [zoteroError, setZoteroError] = useState<LiteratureErrorMessage | null>(
    null
  )
  const [zoteroSelection, setZoteroSelection] = useState<Map<string, boolean>>(
    new Map()
  )
  const [zoteroUnfiled, setZoteroUnfiled] = useState(true)
  const [zoteroCollections, setZoteroCollections] = useState(true)
  const [zoteroDestination, setZoteroDestination] = useState('')
  const [pdfImportOpen, setPdfImportOpen] = useState(false)
  const [pdfImports, setPdfImports] = useState<PdfImportRecord[]>([])
  const [newlyImported, setNewlyImported] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [batchDialog, setBatchDialog] = useState<BatchDialog>(null)
  const [batchProjects, setBatchProjects] = useState<LiteratureProject[]>([])
  const [batchCollections, setBatchCollections] = useState<LiteratureFacet[]>(
    []
  )
  const [batchTags, setBatchTags] = useState<LiteratureFacet[]>([])
  const [batchProjectId, setBatchProjectId] = useState('')
  const [batchSelection, setBatchSelection] = useState<Set<string>>(new Set())
  const [batchSearch, setBatchSearch] = useState('')
  const [batchSaving, setBatchSaving] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchExpanded, setBatchExpanded] = useState<Set<string>>(new Set())
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [emptyImportOpen, setEmptyImportOpen] = useState(false)
  const [columns, setColumns] = useState<ColumnSetting[]>(loadColumns)
  const [draggedColumn, setDraggedColumn] = useState<ColumnKey | null>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const bibliographyInput = useRef<HTMLInputElement>(null)
  const scopedColumns = columns.filter(
    (column) => !projectId || column.key !== 'projects'
  )
  const visibleColumns = scopedColumns.filter((column) => column.visible)
  const grid = `72px ${visibleColumns.map((column) => `${column.width}px`).join(' ')}`
  const saveColumns = (next: ColumnSetting[]): void => {
    setColumns(next)
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(next))
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
    const move = (moveEvent: PointerEvent): void =>
      saveColumns(
        columns.map((column) =>
          column.key === key
            ? {
                ...column,
                width: Math.max(
                  COLUMN_META[key].minimum,
                  current.width + moveEvent.clientX - start
                )
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
      const saved = JSON.parse(
        localStorage.getItem(SORT_STORAGE_KEY) ?? 'null'
      ) as {
        sort?: LiteratureQuery['sort']
        order?: LiteratureQuery['order']
      } | null
      if (saved?.sort && saved.order) catalogue.query(saved)
    } catch {
      /* use catalogue defaults */
    }
  }, [])
  useEffect(() => {
    const value = search.trim() || undefined
    if (value === query.q) return
    const timer = window.setTimeout(
      () => catalogue.query({ q: value }),
      SEARCH_DEBOUNCE_MS
    )
    return () => window.clearTimeout(timer)
  }, [query.q, search])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    listAllLiteratures(query, controller.signal)
      .then((value) => {
        if (active) {
          setItems(value)
          catalogue.items(value)
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            literatureErrorMessage(
              reason instanceof LiteratureApiError
                ? reason.failure.code
                : undefined,
              reason instanceof Error ? reason.message : undefined,
              'batch.loadFailed'
            )
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, reload])
  useEffect(() => {
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status))
      return
    const timer = window.setInterval(() => {
      getLiteratureTask(task.id)
        .then((value) => {
          setTask(value)
          if (value.status === 'completed') {
            setNewlyImported(
              (current) => new Set([...current, ...(value.imported_ids ?? [])])
            )
            revealImported()
          }
        })
        .catch(() => undefined)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [task])
  // 导入结果是瞬时反馈：终态用 Toast 承接并收掉 lit-task 横幅，不在列表上常驻。
  useEffect(() => {
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status))
      return
    if (task.status === 'completed') {
      toast({
        title: literature('importTask.resultCompleted', {
          count: task.completed_count
        }),
        tone: 'success'
      })
    } else if (task.status === 'cancelled') {
      toast({
        title: literature('importTask.resultCancelled'),
        tone: 'warning'
      })
    } else {
      const message = literatureTaskErrorMessage(task)
      toast({
        title: literature('importTask.failed'),
        description: message.detail ?? literature(message.key),
        tone: 'error'
      })
    }
    setTask(null)
  }, [task, literature, toast])

  const allChecked =
    items.length > 0 && items.every((item) => selected.includes(item.id))
  const filtered = hasActiveListRefinement(query)
  const libraryEmpty = items.length === 0 && !filtered
  const picked = useMemo(() => new Set(selected), [selected])
  const deletePicked = async (): Promise<void> => {
    const count = selected.length
    setDeleteConfirmOpen(false)
    try {
      if (projectId) {
        await bulkLiteratures(selected, 'unlink_project', {
          project_id: projectId
        })
      } else {
        await deleteLiteratures(selected)
      }
      catalogue.clear()
      catalogue.reload()
      toast({
        title: projectId
          ? literature('batch.removeSucceeded', { count })
          : literature('batch.deleteSucceeded', { count }),
        tone: 'success'
      })
    } catch (reason: unknown) {
      const message = literatureErrorMessage(
        reason instanceof LiteratureApiError ? reason.failure.code : undefined,
        reason instanceof Error ? reason.message : undefined,
        'batch.deleteFailed'
      )
      toast({
        description: message.detail ?? literature(message.key),
        title: literature('batch.deleteFailed'),
        tone: 'error'
      })
    }
  }
  const runBulk = async (operation: string): Promise<void> => {
    try {
      await bulkLiteratures(selected, operation)
      catalogue.clear()
      catalogue.reload()
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'batch.bulkFailed'
        )
      )
    }
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
    Promise.all([
      getLiteratureProjects(),
      getLiteratureFacets({ project_id: projectId })
    ])
      .then(([projectResult, facets]) => {
        if (!active) return
        setBatchProjects(projectResult.projects)
        setBatchCollections(facets.collections)
        setBatchTags(facets.tags)
        setBatchProjectId(
          projectResult.current || projectResult.projects[0]?.id || ''
        )
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError
              ? reason.failure.code
              : undefined,
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
  }, [batchDialog, projectId])
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
                collection_ids: [...batchSelection]
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
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
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
      ? (batchProjects.find((project) => project.id === batchProjectId)
          ?.collections ?? [])
      : batchCollections
  const visibleBatchTags = batchTags.filter((tag) =>
    tag.name.toLowerCase().includes(batchSearch.toLowerCase())
  )
  const batchCollectionRows = (
    values: LiteratureFacet[]
  ): React.JSX.Element[] => {
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
            className="flex items-center gap-1 pl-[calc(var(--tree-depth)*var(--vds-space-4))]"
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
                    name={
                      batchExpanded.has(value.id)
                        ? 'chevron-down'
                        : 'chevron-right'
                    }
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
          ...(batchExpanded.has(value.id) ? visit(value.id, depth + 1) : [])
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
    const result = await exportBibtex(ids)
    if (!result.ok || typeof result.bibtex !== 'string') {
      setError({
        key: 'relations.exportFailed',
        detail: result.error || undefined
      })
      return
    }
    // 成功提示的条数以后端实际写入的条目为准: 选中的 id 可能已在别处被删除, 拿请求数会虚报。
    const exported = result.count ?? ids.length
    // 必须等用户在原生保存对话框里选完位置并真的落盘才算成功; 取消保存不提示, 也不报错。
    const saved = await saveBibtex(result.bibtex)
    if (saved.kind === 'saved') {
      toast({
        title: literature('batch.exportSucceeded', { count: exported }),
        tone: 'success'
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
    const scope = query.without_collection
      ? literature('panel.unfiled')
      : destination.projectId
        ? literature('navigation.project')
        : literature('navigation.overview')
    try {
      const [facets, projects] = await Promise.all([
        getLiteratureFacets({ project_id: destination.projectId || undefined }),
        getLiteratureProjects()
      ])
      return importDestinationLabel(
        destination,
        facets.collections,
        projects.projects,
        scope
      )
    } catch {
      return scope
    }
  }
  const startImport = async (source: string): Promise<void> => {
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
        const [preview, label] = await Promise.all([
          previewZotero(),
          resolveDestinationLabel()
        ])
        setZoteroPreview(preview)
        setZoteroDestination(label)
        setZoteroSelection(new Map([[preview.library.key, true]]))
      } catch (reason) {
        setZoteroError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError
              ? reason.failure.code
              : undefined,
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
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
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
      const selection = zoteroSelectionDirectives(zoteroSelection)
      setTask(
        await createImportTask('zotero', {
          project_id: destination.projectId,
          collection_id: destination.collectionId,
          selection,
          include_unfiled: zoteroUnfiled,
          import_collections: zoteroCollections,
          preview_revision: zoteroPreview.revision
        }, zoteroSubmitKey.current)
      )
      setZoteroOpen(false)
    } catch (reason) {
      setZoteroError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'zotero.importFailed'
        )
      )
    } finally {
      setZoteroSubmitting(false)
    }
  }
  const toggleZoteroNode = (
    node: ZoteroCollectionNode,
    selected: boolean
  ): void => {
    setZoteroSelection((current) => {
      return updateZoteroSelection(current, node, selected)
    })
  }
  const uploadPdf = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    const records = files.map(
      (file, index): PdfImportRecord => ({
        id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
        file,
        name: file.name,
        progress: 0,
        status: 'pending'
      })
    )
    setPdfImports(records)
    setPdfImportOpen(records.length > 1)
    setError(null)
    const updateImport = (
      id: string,
      update: Partial<PdfImportRecord>
    ): void => {
      setPdfImports((current) =>
        current.map((record) =>
          record.id === id ? { ...record, ...update } : record
        )
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
          error: { key: 'pdfImport.onlyPdf' }
        })
        setPdfImportOpen(true)
        continue
      }
      try {
        const item = await importPdf(
          record.file,
          (progress, phase) =>
            updateImport(record.id, { progress, status: phase }),
          destination.projectId,
          destination.collectionId
        )
        updateImport(record.id, {
          progress: 100,
          status: 'completed',
          title: item.title
        })
        setNewlyImported((current) => new Set(current).add(item.id))
        landed += 1
      } catch (reason) {
        setPdfImportOpen(true)
        updateImport(record.id, {
          status: 'failed',
          error: literatureErrorMessage(
            reason instanceof LiteratureApiError
              ? reason.failure.code
              : undefined,
            reason instanceof Error ? reason.message : undefined,
            'pdfImport.parseFailed'
          )
        })
      }
    }
    // 一份都没落地时不要动用户的筛选: 清搜索词与标签是为「新文献看得见」服务的。
    if (landed > 0) revealImported()
  }
  const uploadBibliography = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    setError(null)
    try {
      const result = await importBibliography(files, {
        projectId: destination.projectId,
        collectionId: destination.collectionId
      })
      setNewlyImported(
        (current) =>
          new Set([...current, ...result.items.map((item) => item.id)])
      )
      if (result.items.length > 0) revealImported()
    } catch (reason) {
      setError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'batch.bibliographyFailed'
        )
      )
    }
  }
  return (
    <section className="lit-page" data-testid="literature-overview">
      <Input
        ref={pdfInput}
        className="hidden"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        aria-label={literature('pdfImport.choose')}
        onChange={(event) => void uploadPdf(event)}
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
            <DialogDescription>
              {literature('pdfImport.description')}
            </DialogDescription>
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
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-[calc(var(--vds-space-3)/2)]">
                      {React.createElement(fileIconForName(record.name), {
                        className: 'shrink-0 text-[var(--vds-icon-outline-default)]',
                        size: 15,
                        strokeWidth: 1.8
                      })}
                      <strong
                        className="block min-w-0 truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                        title={record.name}
                      >
                        {record.name}
                      </strong>
                    </div>
                    {!['completed', 'failed'].includes(record.status) ? (
                      <span className="ml-[calc(15px+var(--vds-space-3)/2)] mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                      {record.status === 'pending'
                        ? literature('pdfImport.pending')
                        : record.status === 'uploading'
                          ? literature('pdfImport.uploading', {
                              progress: record.progress
                            })
                          : literature('pdfImport.parsing')}
                      </span>
                    ) : null}
                  </div>
                  {record.status === 'completed' || record.status === 'failed' ? (
                    <Tag tone={record.status === 'completed' ? 'success' : 'error'}>
                      {literature(record.status === 'completed' ? 'pdfImport.completed' : 'pdfImport.failed')}
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
                    description={
                      record.error.detail ?? literature(record.error.key)
                    }
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
                  completed: pdfImports.filter(
                    (record) => record.status === 'completed'
                  ).length,
                  total: pdfImports.length,
                  failed: pdfImports.filter(
                    (record) => record.status === 'failed'
                  ).length
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
      <Dialog open={zoteroOpen} onOpenChange={setZoteroOpen}>
        <DialogContent
          data-ways="zotero"
          className="w-[min(720px,calc(100vw-48px))]"
        >
          <DialogHeader>
            <DialogTitle>{literature('zotero.title')}</DialogTitle>
            <DialogDescription>
              {literature('zotero.description')}
            </DialogDescription>
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
                    <strong className="block text-sm">
                      {literature('zotero.connected')}
                    </strong>
                    <span className="text-xs text-[var(--vds-text-secondary)]">
                      {literature('zotero.summary', {
                        items: zoteroPreview.items,
                        pdfs: zoteroPreview.pdfs,
                        collections: zoteroPreview.collections
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
                    'aria-label': literature('zotero.tree')
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
                    <p className="m-0 mb-2 truncate text-xs text-[var(--vds-text-primary)]">
                      {literature('panel.importDestination', {
                        target: zoteroDestination
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
            <Button variant="outline" onClick={() => setZoteroOpen(false)}>
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
      <header className="lit-toolbar" data-workbench-divider>
        {returnProject ? (
          <Button
            data-testid="literature-return-project"
            className="mr-auto shrink-0"
            variant="secondary"
            size="md"
            icon={<ArrowLeft />}
            onClick={() => {
              act.selectProject(returnProject.id)
              act.openWorkbenchView('literature', { preserveProject: true })
            }}
          >
            {literature('navigation.returnProject')}
          </Button>
        ) : null}
        {selected.length > 0 ? (
          <div className="lit-batch">
            <strong>
              {literature('batch.selected', { count: selected.length })}
            </strong>
            {!projectId ? (
              <Button
                size="md"
                variant="secondary"
                icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                onClick={() => void openBatch('project')}
              >
                {literature('linkProject.title')}
              </Button>
            ) : null}
            <Button
              size="md"
              variant="secondary"
              icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
              onClick={() => void openBatch('collection')}
            >
              {projectId
                ? literature('batch.addCollection')
                : literature('batch.collection')}
            </Button>
            <Button
              size="md"
              variant="secondary"
              icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
              onClick={() => void openBatch('tag')}
            >
              {literature('batch.tag')}
            </Button>
            <Button
              size="md"
              variant="secondary"
              icon={<ArrowDownToLine size={14} />}
              onClick={() => void exportSelected()}
            >
              {literature('batch.export')}
            </Button>
            <Button
              size="md"
              variant="danger"
              icon={<Trash size={14} />}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {projectId ? literature('batch.removeProject') : ui('delete')}
            </Button>
            <AlertDialog
              open={deleteConfirmOpen}
              onOpenChange={setDeleteConfirmOpen}
            >
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
                          count: selected.length
                        })
                      : literature('batch.deleteDescription', {
                          count: selected.length
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
            <Button
              size="md"
              variant="outline"
              onClick={() => catalogue.clear()}
            >
              {ui('cancel')}
            </Button>
          </div>
        ) : (
          <div className="lit-actions">
            <form
              className="lit-search"
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
        <div className="lit-task">
          <span>
            {literature('list.importTask')} ·{' '}
            {literature(literatureTaskStatusMessage(task.status))}
          </span>
          <ProgressBar value={Math.round(task.progress * 100)} />
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
      {error ? (
        <div className="lit-error">
          <span>{error.detail ?? literature(error.key)}</span>
          <Button size="sm" variant="ghost" onClick={() => catalogue.reload()}>
            {ui('retry')}
          </Button>
        </div>
      ) : null}
      <div className={`lit-body${focusedId ? ' has-detail' : ''} isolate p-4`}>
        <div className="relative flex flex-1 min-w-0">
          <div className="lit-table flex-1 min-w-0 overflow-x-auto overflow-y-auto rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-line-1)] bg-[var(--vds-bg-gray-default)]">
            <div
              className="lit-table-head"
              style={{ gridTemplateColumns: grid }}
            >
              <div className="lit-sticky-cells">
                <span />
                <Checkbox
                  checked={allChecked}
                  label={literature('list.selectAll')}
                  onCheckedChange={(checked) =>
                    catalogue.selectAll(
                      items.map((item) => item.id),
                      checked
                    )
                  }
                />
                <span className="lit-pdf-cell">
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
                  className="lit-column-head"
                  draggable
                  onDragStart={() => setDraggedColumn(column.key)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (!draggedColumn || draggedColumn === column.key) return
                    const next = [...columns]
                    const from = next.findIndex(
                      (entry) => entry.key === draggedColumn
                    )
                    const to = next.findIndex(
                      (entry) => entry.key === column.key
                    )
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    saveColumns(next)
                    setDraggedColumn(null)
                  }}
                >
                  <Button
                    variant="ghost"
                    size="md"
                    disabled={!COLUMN_META[column.key].sort}
                    onClick={() => {
                      const sort = COLUMN_META[column.key].sort
                      if (!sort) return
                      applySort(sort)
                    }}
                  >
                    <EllipsisText
                      tooltipPortalled
                      tooltipSide="bottom"
                      wrapperClassName="min-w-0"
                    >
                      {literature(COLUMN_META[column.key].labelKey)}
                    </EllipsisText>
                    {query.sort === COLUMN_META[column.key].sort ? (
                      <span
                        className={query.order === 'asc' ? 'rotate-180' : ''}
                      >
                        <Icon name="chevron-down" size={11} />
                      </span>
                    ) : null}
                  </Button>
                  <i
                    className="lit-column-resizer"
                    onPointerDown={(event) => resizeColumn(column.key, event)}
                  />
                </span>
              ))}
            </div>
            {loading ? (
              <div className="lit-loading">
                <Spinner aria-label={literature('list.loading')} />
              </div>
            ) : items.length === 0 ? (
              libraryEmpty ? (
                <EmptyState
                  image={{ src: emptyImage, alt: '' }}
                  title={literature('list.empty')}
                  action={
                    <DropdownMenu open={emptyImportOpen} onOpenChange={setEmptyImportOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}>
                          {literature('panel.import')}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-52">
                        {projectId ? (
                          <>
                            <DropdownMenuItem
                              onSelect={() => {
                                act.openWorkbenchView('literature', { returnProjectId: projectId })
                              }}
                            >
                              <Link />
                              {literature('panel.linkFromOverview')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        ) : null}
                        {IMPORT_SOURCES.map((source) => (
                          <DropdownMenuItem
                            key={source.value}
                            onSelect={() => {
                              void startImport(source.value)
                            }}
                          >
                            {source.icon === 'local-pdf' ? (
                              <MonitorDown />
                            ) : source.icon === 'bib-ris' ? (
                              <FileDown />
                            ) : (
                              <IconFont type="icon-zotero" />
                            )}
                            {literature(source.labelKey)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              ) : (
                <EmptyState
                  image={{ src: emptyImage, alt: '' }}
                  title={literature('list.emptyScope')}
                  description={literature('list.emptyScopeDescription')}
                />
              )
            ) : (
              items.flatMap((item) => [
                <Row
                  key={item.id}
                  item={item}
                  columns={scopedColumns}
                  grid={grid}
                  checked={picked.has(item.id)}
                  isNew={newlyImported.has(item.id)}
                  expanded={expanded.has(item.id)}
                  focused={focusedId === item.id && !focusedAttachmentId}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }
                  onOpen={() => {
                    setNewlyImported((current) => {
                      if (!current.has(item.id)) return current
                      const next = new Set(current)
                      next.delete(item.id)
                      return next
                    })
                    catalogue.focus(item.id)
                  }}
                  onOpenFulltext={(attachmentId) =>
                    act.openLiteratureAttachment(item.id, attachmentId)
                  }
                />,
                ...(expanded.has(item.id)
                  ? item.attachments.map((attachment) => (
                      <div
                        key={attachment.id}
                        data-testid={`literature-attachment-${attachment.id}`}
                        className={
                          focusedAttachmentId === attachment.id
                            ? 'lit-attachment-row is-focused'
                            : 'lit-attachment-row'
                        }
                        onClick={() =>
                          catalogue.focusAttachment(item.id, attachment.id)
                        }
                        onDoubleClick={
                          isAttachmentAvailable(attachment)
                            ? () =>
                                act.openLiteratureAttachment(
                                  item.id,
                                  attachment.id
                                )
                            : undefined
                        }
                      >
                        {React.createElement(fileIconForName(attachment.name), {
                          size: 16,
                          strokeWidth: 1.8
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
                    ))
                  : [])
              ])
            )}
          </div>
          <div className="lit-column-actions">
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
                            entry.key === column.key
                              ? { ...entry, visible }
                              : entry
                          )
                        )
                      }
                    />
                  ))}
                </ScrollArea>
                <Button
                  className="mt-3 w-full"
                  variant="outline"
                  onClick={() => saveColumns(DEFAULT_COLUMNS)}
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
            if (!open) catalogue.focus(null)
          }}
        >
          <LiteratureDetail
            id={focusedId}
            attachmentId={focusedAttachmentId}
            onClose={() => catalogue.focus(null)}
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
            <p className="m-0 text-xs leading-5 text-[var(--vds-text-secondary)]">
              {literature('batch.noProjects')}
            </p>
          ) : batchDialog === 'project' ? (
            <Select
              disabled={batchLoading || batchSaving}
              value={batchProjectId}
              onValueChange={(value) => {
                setBatchProjectId(value)
                setBatchSelection(new Set())
              }}
            >
              <SelectTrigger
                aria-label={literature('batch.selectProject')}
                className="mb-3 w-full"
              >
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
          ) : batchDialog === 'project' &&
            batchProjects.length === 0 ? null : batchDialog === 'project' &&
            collectionOptions.length === 0 ? (
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
                batchDialog === 'tag'
                  ? 'flex flex-wrap items-center gap-x-3 gap-y-2 p-3'
                  : 'p-3'
              }
            >
              {batchDialog === 'tag'
                ? visibleBatchTags.map((value) => (
                    <Checkbox
                      key={value.id}
                      checked={batchSelection.has(value.id)}
                      label={value.name}
                      onCheckedChange={(checked) =>
                        toggleBatchValue(value.id, checked)
                      }
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
                (batchDialog === 'project'
                  ? !batchProjectId
                  : batchSelection.size === 0)
              }
              loading={batchLoading || batchSaving}
              onClick={() => void submitBatch()}
            >
              {literature('batch.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
