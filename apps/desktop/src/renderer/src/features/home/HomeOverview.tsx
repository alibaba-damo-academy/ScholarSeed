import React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import {
  Box,
  FileDown,
  Inbox,
  MonitorDown
} from 'lucide-react'

import homeBook from '../../assets/home_book.webp'
import recentIconHtml from '../../assets/icon-html.png'
import recentIconImg from '../../assets/icon-img.png'
import recentIconMusic from '../../assets/icon-music.png'
import recentIconPdf from '../../assets/icon-pdf.png'
import recentIconPpt from '../../assets/icon-ppt.png'
import recentIconTsx from '../../assets/icon-tsx.png'
import recentIconTxt from '../../assets/icon-txt.png'
import recentIconUnknown from '../../assets/icon-unknown.png'
import recentIconVideo from '../../assets/icon-video.png'
import recentIconWord from '../../assets/icon-word.png'
import recentIconXls from '../../assets/icon-xls.png'
import recentIconZip from '../../assets/icon-zip.png'
import scholarseedLogoMark from '../../assets/logo.svg'
import { catalogue } from '../literature/catalog'
import type {
  LiteratureCounts,
  LiteratureSummary
} from '../../contracts/literature'
import { createFormatters } from '../../../../localization/format'
import {
  Alert,
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
  DropdownMenuTrigger,
  EllipsisText,
  Input,
  ProgressBar,
  ScrollArea,
  Spinner,
  useToast
} from '../../components/ui'
import { Icon } from '../../icons'
import { IconFont } from '../../components/primitive'
import { ProjectActionsMenu } from '../../components/business/ProjectActions'
import {
  createImportTask,
  LiteratureApiError,
  getLiterature,
  getLiteratureCounts,
  getLiteratureTask,
  importBibliography,
  importPdf,
  listLiteratures,
  previewZotero,
  ZOTERO_LIBRARY_ROOT_KEY,
  type PdfImportPhase,
  type ZoteroCollectionNode,
  type ZoteroPreview
} from '../literature/api'
import {
  openedLiteratureAttachment,
  openedLiteratureIconKind,
  openedLiteratureLabel,
  openRecentLiterature,
  RECENT_LITERATURE_DISPLAY_LIMIT,
  RECENT_LITERATURE_RESOLVE_LIMIT,
  type RecentLiteratureIconKind
} from './recent'
import {
  inheritedZoteroSelection,
  updateZoteroSelection,
  zoteroImportBlocked,
  zoteroNodeState,
  zoteroSelectionDirectives
} from '../literature/zotero'
import {
  literatureErrorMessage,
  type LiteratureErrorMessage
} from '../literature/error'
import { fetchResourceCount } from '../resources/api'
import { projectModifiedLabel, projectSummary } from '../../project'
import { useApp } from '../../store'
import emptyBg from '../../assets/empty-bg.webp'

// HomeOverview.tsx — 工作台首页空间（原型 home space「项目全览」）。
// 内容三段：文献全览入口卡（全库篇数 + 近 7 天新增）、我的项目卡片网格
// （最近修改绝对时间 + 资料/文献计数）、虚线新建项目卡。
// 数据全部来自既有域接口：文献计数走 literature 域，项目身份走 content 域的
// 项目登记表，资料计数走 resources 域的完整枚举端点；本组件只装配呈现，
// 不持有跨域状态。

const PROJECT_PATH_SEPARATOR = '/'
const PROJECT_DESCRIPTION_LIMIT = 56
const IMPORT_TASK_POLL_INTERVAL_MS = 1200
const IMPORT_TASK_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled'
])

type PdfImportStatus = 'pending' | PdfImportPhase | 'completed' | 'failed'

interface PdfImportRecord {
  id: string
  file: File
  name: string
  progress: number
  status: PdfImportStatus
  title?: string
  error?: LiteratureErrorMessage
}

/** 首页「最近打开」行：指针在偏好里，展示字段按 id 回文献域现取；只收附件行。 */
interface RecentOpenRow {
  id: string
  attachmentName: string
  iconKind: RecentLiteratureIconKind
  openedAt: number
}

/** 附件类型 → assets 下 icon-<kind>.png；png 导入不进 node 测试面。 */
const RECENT_ICON_BY_KIND: Record<RecentLiteratureIconKind, string> = {
  pdf: recentIconPdf,
  word: recentIconWord,
  xls: recentIconXls,
  ppt: recentIconPpt,
  txt: recentIconTxt,
  html: recentIconHtml,
  img: recentIconImg,
  video: recentIconVideo,
  music: recentIconMusic,
  zip: recentIconZip,
  tsx: recentIconTsx,
  unknown: recentIconUnknown
}

function projectDescription(path: string): string {
  const segments = path.split(PROJECT_PATH_SEPARATOR).filter(Boolean)
  const summary = segments.slice(-2).join(PROJECT_PATH_SEPARATOR) || path
  return summary.length > PROJECT_DESCRIPTION_LIMIT
    ? `${summary.slice(0, PROJECT_DESCRIPTION_LIMIT)}…`
    : summary
}

function ZoteroTreeNode({
  depth,
  directives,
  includeUnfiled,
  node,
  onToggle,
  onToggleUnfiled,
  parentSelected,
  rootUnfiledCount
}: {
  depth: number
  directives: Map<string, boolean>
  includeUnfiled: boolean
  node: ZoteroCollectionNode
  onToggle: (node: ZoteroCollectionNode, selected: boolean) => void
  onToggleUnfiled: (selected: boolean) => void
  parentSelected: boolean
  rootUnfiledCount: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const selected = inheritedZoteroSelection(
    node.key,
    parentSelected,
    directives
  )
  const collectionState = zoteroNodeState(node, parentSelected, directives)
  const includesUnfiled =
    node.key === ZOTERO_LIBRARY_ROOT_KEY && rootUnfiledCount > 0
  const state = includesUnfiled
    ? collectionState === includeUnfiled
      ? collectionState
      : 'mixed'
    : collectionState

  return (
    <div role="treeitem" aria-selected={state !== false}>
      <div
        className="flex items-center gap-2 rounded-[var(--vds-radius-3)] pr-2 pl-[calc(var(--vds-space-2)+var(--tree-depth)*18px)] py-1.5 hover:bg-[var(--vds-surface-hover)]"
        style={{ '--tree-depth': depth } as React.CSSProperties}
      >
        <Checkbox
          checked={state}
          aria-label={`${state === true ? t('home.importFlow.deselect') : t('home.importFlow.select')} ${node.name}`}
          onCheckedChange={(value) => onToggle(node, value === true)}
        />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-xs text-[var(--vds-text-secondary)]">
          {node.subtree_item_count}
        </span>
      </div>
      {includesUnfiled ? (
        <div
          className="flex items-center gap-2 rounded-[var(--vds-radius-3)] pr-2 pl-[calc(var(--vds-space-2)+(var(--tree-depth)+1)*18px)] py-1.5 hover:bg-[var(--vds-surface-hover)]"
          style={{ '--tree-depth': depth } as React.CSSProperties}
        >
          <Checkbox
            checked={includeUnfiled}
            aria-label={`${includeUnfiled ? t('home.importFlow.deselect') : t('home.importFlow.select')} ${t('home.importFlow.unfiled')}`}
            onCheckedChange={(value) => onToggleUnfiled(value === true)}
          />
          <span className="min-w-0 flex-1 truncate">
            {t('home.importFlow.unfiled')}
          </span>
          <span className="text-xs text-[var(--vds-text-secondary)]">
            {rootUnfiledCount}
          </span>
        </div>
      ) : null}
      {node.children.length > 0 ? (
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
              rootUnfiledCount={rootUnfiledCount}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function HomeOverview(): React.JSX.Element {
  const { t: projectText } = useTranslation('project')
  const { state, set, act } = useApp()
  const { t } = useTranslation('components')
  const { t: literature } = useTranslation('literature')
  const { toast } = useToast()
  const format = createFormatters(state.lang)
  const [counts, setCounts] = React.useState<LiteratureCounts | null>(
    () => catalogue.overviewCounts()
  )
  const [recentOpens, setRecentOpens] = React.useState<RecentOpenRow[]>([])
  const [literatureByProject, setLiteratureByProject] = React.useState<
    Record<string, number>
  >({})
  const [resourceCountByProject, setResourceCountByProject] = React.useState<
    Record<string, number | null>
  >({})
  const literatureCount = Number(counts?.all ?? 0)
  const recentLiteratureCount = Number(counts?.recent ?? 0)
  const literatureEmpty = counts !== null && literatureCount === 0
  const pdfInput = React.useRef<HTMLInputElement>(null)
  const bibliographyInput = React.useRef<HTMLInputElement>(null)
  const [pdfImportOpen, setPdfImportOpen] = React.useState(false)
  const [pdfImports, setPdfImports] = React.useState<PdfImportRecord[]>([])
  const [zoteroOpen, setZoteroOpen] = React.useState(false)
  const [zoteroLoading, setZoteroLoading] = React.useState(false)
  const [zoteroImporting, setZoteroImporting] = React.useState(false)
  // 一次「打开对话框 → 提交」共用一个受理幂等键: 提交响应丢失后重试也拿同一个 key,
  // 服务端交回同一个任务, 而不是把同一批文献再导一遍 (文献是追加语义)。
  const zoteroSubmitKey = React.useRef(crypto.randomUUID())
  const [zoteroPreview, setZoteroPreview] =
    React.useState<ZoteroPreview | null>(null)
  const [zoteroError, setZoteroError] =
    React.useState<LiteratureErrorMessage | null>(null)
  const [zoteroSelection, setZoteroSelection] = React.useState<
    Map<string, boolean>
  >(new Map())
  const [zoteroUnfiled, setZoteroUnfiled] = React.useState(true)
  const [zoteroCollections, setZoteroCollections] = React.useState(true)
  const [importError, setImportError] =
    React.useState<LiteratureErrorMessage | null>(null)

  React.useEffect(() => {
    if (catalogue.overviewCountsFresh()) return
    let alive = true
    getLiteratureCounts()
      .then((value) => {
        catalogue.cacheOverviewCounts(value)
        if (alive) setCounts(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  React.useEffect(() => {
    let alive = true
    const entries = state.recentLiterature.slice(
      0,
      RECENT_LITERATURE_RESOLVE_LIMIT
    )
    void Promise.all(
      entries.map((entry) =>
        getLiterature(entry.id)
          .then((item) => ({ entry, item }))
          .catch(() => null)
      )
    ).then((resolved) => {
      if (!alive) return
      setRecentOpens(
        resolved
          .filter(
            (
              row
            ): row is {
              entry: (typeof entries)[number]
              item: LiteratureSummary
            } => row !== null
          )
          .sort((left, right) => right.entry.openedAt - left.entry.openedAt)
          .flatMap((row) => {
            // 只有能点开的附件才进「最近打开」：没有主附件的纯文献条目、
            // 以及文件已丢失的附件，都不再占这三行。
            const attachment = openedLiteratureAttachment(row.item)
            if (!attachment) return []
            return [
              {
                id: row.item.id,
                attachmentName: attachment.name,
                iconKind: openedLiteratureIconKind(row.item),
                openedAt: row.entry.openedAt
              }
            ]
          })
          .slice(0, RECENT_LITERATURE_DISPLAY_LIMIT)
      )
    })
    return () => {
      alive = false
    }
  }, [state.recentLiterature])

  React.useEffect(() => {
    let alive = true
    void Promise.all(
      state.projects.map((project) =>
        listLiteratures({ project_id: project.id, page_size: 1 })
          .then((page) => [project.id, page.total] as const)
          .catch(() => [project.id, 0] as const)
      )
    ).then((entries) => {
      if (alive) setLiteratureByProject(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [state.projects])

  React.useEffect(() => {
    let alive = true
    void Promise.all(
      state.projects.map((project) =>
        fetchResourceCount(project.id).then(
          (count) => [project.id, count] as const
        )
      )
    ).then((entries) => {
      if (alive) setResourceCountByProject(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [state.projects])

  const openLiteratureOverview = React.useCallback((): void => {
    act.openWorkbenchView('literature')
  }, [act])

  const openLiteratureStats = (recent: boolean): void => {
    catalogue.scope(null)
    catalogue.query({
      project_id: undefined,
      q: undefined,
      collection_id: undefined,
      tag_id: undefined,
      without_collection: undefined,
      without_project: undefined,
      is_unread: undefined,
      attachment: 'any',
      recent: recent || undefined
    })
    openLiteratureOverview()
    act.activateTab('literature')
  }

  const waitForImportTask = React.useCallback(
    async (taskId: string): Promise<boolean> => {
      while (true) {
        const task = await getLiteratureTask(taskId)
        if (task.status === 'completed') return true
        if (IMPORT_TASK_TERMINAL_STATUSES.has(task.status)) return false
        await new Promise((resolve) =>
          window.setTimeout(resolve, IMPORT_TASK_POLL_INTERVAL_MS)
        )
      }
    },
    []
  )

  const startZoteroPreview = async (): Promise<void> => {
    setImportError(null)
    setZoteroOpen(true)
    setZoteroLoading(true)
    zoteroSubmitKey.current = crypto.randomUUID()
    setZoteroPreview(null)
    setZoteroError(null)
    setZoteroSelection(new Map())
    setZoteroUnfiled(true)
    setZoteroCollections(true)
    try {
      const preview = await previewZotero()
      setZoteroPreview(preview)
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
  }

  const startZoteroImport = async (): Promise<void> => {
    if (!zoteroPreview || zoteroImporting) return
    setZoteroError(null)
    setZoteroImporting(true)
    try {
      const task = await createImportTask('zotero', {
        selection: zoteroSelectionDirectives(zoteroSelection),
        include_unfiled: zoteroUnfiled,
        import_collections: zoteroCollections,
        preview_revision: zoteroPreview.revision
      }, zoteroSubmitKey.current)
      const completed = await waitForImportTask(task.id)
      if (completed) {
        setZoteroOpen(false)
        openLiteratureOverview()
      } else {
        setZoteroError({ key: 'importTask.failed' })
      }
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
      setZoteroImporting(false)
    }
  }

  const toggleZoteroNode = (
    node: ZoteroCollectionNode,
    selected: boolean
  ): void => {
    setZoteroSelection((current) =>
      updateZoteroSelection(current, node, selected)
    )
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
    setImportError(null)
    let completedCount = 0
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
        const item = await importPdf(record.file, (progress, phase) =>
          updateImport(record.id, { progress, status: phase })
        )
        completedCount += 1
        updateImport(record.id, {
          progress: 100,
          status: 'completed',
          title: item.title
        })
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
    if (completedCount > 0) openLiteratureOverview()
  }

  const uploadBibliography = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    setImportError(null)
    try {
      await importBibliography(files)
      openLiteratureOverview()
    } catch (reason) {
      setImportError(
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
    <div className="vds-home-space" data-testid="home-overview">
      <Input
        ref={pdfInput}
        className="hidden"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        aria-label={t('home.importFlow.choosePdf')}
        onChange={(event) => void uploadPdf(event)}
      />
      <Input
        ref={bibliographyInput}
        className="hidden"
        type="file"
        accept=".bib,.bibtex,.ris"
        multiple
        aria-label={t('home.importFlow.chooseBib')}
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
        <DialogContent className="w-[min(720px,calc(100vw-48px))]">
          <DialogHeader>
            <DialogTitle>{t('home.importFlow.pdfTitle')}</DialogTitle>
            <DialogDescription>
              {t('home.importFlow.pdfDescription')}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            className="max-h-[min(420px,55vh)]"
            shadow
            viewportClassName="space-y-[var(--vds-space-2)] py-[var(--vds-space-2)] pr-[var(--vds-space-2)]"
          >
            {pdfImports.map((record) => (
              <div
                key={record.id}
                className="rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-[var(--vds-space-3)]">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-[var(--vds-space-3)]">
                      <Icon className="shrink-0 text-[var(--vds-icon-outline-default)]" name="pdf" size={15} />
                      <strong
                        className="block min-w-0 truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                        title={record.name}
                      >
                        {record.name}
                      </strong>
                    </div>
                    <span className="ml-[calc(15px+var(--vds-space-3))] mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                      {record.status === 'pending'
                        ? t('home.importFlow.pending')
                        : record.status === 'uploading'
                          ? t('home.importFlow.uploading', {
                              progress: record.progress
                            })
                          : record.status === 'parsing'
                            ? t('home.importFlow.parsing')
                            : record.status === 'completed'
                              ? t('home.importFlow.parsed')
                              : t('home.importFlow.failed')}
                    </span>
                  </div>
                  {!['completed', 'failed'].includes(record.status) ? (
                    <Spinner size="sm" />
                  ) : null}
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
                      {t('home.importFlow.titleLabel')}
                    </span>
                    {record.title}
                  </p>
                ) : null}
                {record.error ? (
                  <Alert
                    className="mt-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] !px-[var(--vds-space-4)] !py-[var(--vds-space-3)]"
                    tone="error"
                    title={t('home.importFlow.failure')}
                    description={
                      <>
                        {literature(record.error.key)}
                        {record.error.detail ? (
                          <span> {record.error.detail}</span>
                        ) : null}
                      </>
                    }
                  />
                ) : null}
              </div>
            ))}
          </ScrollArea>
          <DialogFooter>
            <span className="mr-auto text-xs text-[var(--vds-text-secondary)]">
              {t('home.importFlow.success')}{' '}
              {
                pdfImports.filter((record) => record.status === 'completed')
                  .length
              }{' '}
              / {pdfImports.length}
              {pdfImports.some((record) => record.status === 'failed')
                ? t('home.importFlow.failures', {
                    total: pdfImports.filter(
                      (record) => record.status === 'failed'
                    ).length
                  })
                : ''}
            </span>
            <Button
              disabled={pdfImports.some(
                (record) => !['completed', 'failed'].includes(record.status)
              )}
              onClick={() => setPdfImportOpen(false)}
            >
              {t('home.importFlow.done')}
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
            <DialogTitle>{t('home.importFlow.zoteroTitle')}</DialogTitle>
            <DialogDescription>
              {t('home.importFlow.zoteroDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-40 flex-col gap-3 py-3">
            {zoteroLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[var(--vds-text-secondary)]">
                <Spinner size="sm" />
                {t('home.importFlow.connecting')}
              </div>
            ) : zoteroError ? (
              <Alert
                tone="error"
                title={t('home.importFlow.connectionFailed')}
                description={
                  <>
                    {literature(zoteroError.key)}
                    {zoteroError.detail ? (
                      <span> {zoteroError.detail}</span>
                    ) : null}
                  </>
                }
              />
            ) : zoteroPreview ? (
              <>
                <div className="flex items-center gap-3 rounded-md border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-3 py-2">
                  <Icon name="plug" size={16} />
                  <div className="min-w-0 flex-1">
                    <strong className="block text-sm">
                      {t('home.importFlow.connected')}
                    </strong>
                    <span className="text-xs text-[var(--vds-text-secondary)]">
                      {t('home.importFlow.summary', {
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
                    'aria-label': t('home.importFlow.collections')
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
                    rootUnfiledCount={zoteroPreview.unfiled.count}
                  />
                </ScrollArea>
                <div className="rounded-md border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-3">
                  <Checkbox
                    checked={zoteroCollections}
                    label={t('home.importFlow.preserve')}
                    onCheckedChange={setZoteroCollections}
                  />
                  <p className="m-0 mt-1 pl-6 text-[11px] text-[var(--vds-text-secondary)]">
                    {zoteroCollections
                      ? t('home.importFlow.preserveHint')
                      : t('home.importFlow.flatHint')}
                    {t('home.importFlow.appendHint')}
                  </p>
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setZoteroOpen(false)}>
              {t('home.importFlow.cancel')}
            </Button>
            <Button
              loading={zoteroImporting}
              disabled={zoteroImportBlocked(
                zoteroPreview,
                zoteroUnfiled,
                zoteroSelection,
                zoteroLoading || zoteroImporting
              )}
              onClick={() => void startZoteroImport()}
            >
              {t('home.importFlow.start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="vds-home-in !mx-auto !box-border !w-[min(calc(100%_-_56px),880px)]">
        <div className="vds-home-welcome">
          <img alt="" draggable={false} src={scholarseedLogoMark} />
          <h1 className="vds-home-title">{t('home.welcome')}</h1>
        </div>

        <div className="vds-home-literature">
          <div className="vds-home-literature-head">
            <div className="vds-home-sec">{t('home.myLiterature')}</div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="vds-home-literature-import-trigger"
                  data-testid="home-literature-import"
                  icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                  variant="outline"
                >
                  {t('home.importLiterature')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="vds-home-literature-import-menu !border-0"
              >
                <DropdownMenuItem onSelect={() => pdfInput.current?.click()}>
                  <MonitorDown />
                  {t('home.importLocal')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => bibliographyInput.current?.click()}
                >
                  <FileDown />
                  {t('home.importBibRis')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void startZoteroPreview()}>
                  <IconFont type="icon-zotero" />
                  {t('home.importZotero')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {importError ? (
            <Alert
              className="mt-[var(--vds-space-2)]"
              tone="error"
              title={t('home.importFlow.importFailed')}
              description={
                <>
                  {literature(importError.key)}
                  {importError.detail ? (
                    <span> {importError.detail}</span>
                  ) : null}
                </>
              }
            />
          ) : null}
          {literatureEmpty && !importError ? (
            <div className="vds-home-literature-empty-divider" />
          ) : null}
          {!literatureEmpty && (
            <div className="relative flex w-full gap-6 overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default-transparent)] py-[var(--vds-space-4)] pr-[var(--vds-space-4)] pl-[var(--vds-space-2)]">
              <div className="flex min-w-0 flex-1 flex-col gap-[var(--vds-space-2)]">
                <span className="px-[var(--vds-space-2)] text-[var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
                  {t('home.recentOpened')}
                </span>
                {recentOpens.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-[var(--vds-space-2)] py-[var(--vds-space-3)] text-[var(--vds-text-tertiary)]">
                    <span className="flex h-[var(--vds-space-8)] w-[var(--vds-space-8)] items-center justify-center rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-gray-hover-transparent)]">
                      <Inbox size={16} strokeWidth={1.6} />
                    </span>
                    <span className="text-[var(--vds-font-body-lv2)]">
                      {t('home.recentOpenedEmpty')}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-[2px]">
                    {recentOpens.map((row) => (
                      <Button
                        unstyled
                        key={row.id}
                        className="flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-2)] py-[6px] text-left hover:bg-[var(--vds-bg-white-hover-transparent)]"
                        data-testid={`home-recent-literature-${row.id}`}
                        onClick={() => {
                          void openRecentLiterature(act, row.id)
                            .then((result) => {
                              if (result !== 'opened') toast({ title: t('home.recentOpenFailed'), tone: 'error' })
                            })
                            .catch(() => toast({ title: t('home.recentOpenFailed'), tone: 'error' }))
                        }}
                      >
                        <img
                          src={RECENT_ICON_BY_KIND[row.iconKind]}
                          alt=""
                          className="size-4 flex-none"
                        />
                        <EllipsisText
                          className="text-[var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                          wrapperClassName="min-w-0 flex-1"
                          tooltipPortalled
                        >
                          {row.attachmentName}
                        </EllipsisText>
                        <span className="flex-none text-[var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          {openedLiteratureLabel(row.openedAt, format)}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <div className="w-[var(--vds-border-width-1)] flex-none self-stretch bg-[var(--vds-divider-default)]" />
              <div
                className="flex min-w-0 flex-1 items-center"
                aria-label={t('home.literatureStats')}
              >
                <div className="grid w-full grid-cols-2 gap-[var(--vds-space-5)] px-[var(--vds-space-6)]">
                  <div className="flex flex-col gap-[var(--vds-space-1)]">
                    <span className="text-[var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
                      {t('home.allLiterature')}
                    </span>
                    <Button unstyled aria-label={t('home.allLiterature')} data-testid="home-all-literature" onClick={() => openLiteratureStats(false)} className="self-start cursor-pointer text-[length:var(--vds-font-display-lv2)] leading-[var(--vds-lh-display-lv2)] font-[var(--vds-fw-medium)] tabular-nums text-[var(--vds-text-primary)] focus-visible:outline-auto">
                      {literatureCount}
                    </Button>
                  </div>
                  <div className="flex flex-col gap-[var(--vds-space-1)]">
                    <span className="text-[var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
                      {t('home.recentLiterature')}
                    </span>
                    <Button unstyled aria-label={t('home.recentLiterature')} data-testid="home-recent-literature" onClick={() => openLiteratureStats(true)} className="self-start cursor-pointer text-[length:var(--vds-font-display-lv2)] leading-[var(--vds-lh-display-lv2)] font-[var(--vds-fw-medium)] tabular-nums text-[var(--vds-text-primary)] focus-visible:outline-auto">
                      {recentLiteratureCount}
                    </Button>
                  </div>
                </div>
              </div>
              <img
                alt=""
                className="pointer-events-none absolute bottom-[-30px] right-[-8px] h-[127px] w-[127px]"
                draggable={false}
                src={homeBook}
              />
            </div>
          )}
        </div>

        <div className="vds-home-project-head">
          <div className="vds-home-sec">{t('home.myProjects')}</div>
          {state.projects.length > 0 && (
            <Button
              variant="outline"
              data-testid="home-project-create-top"
              onClick={() => set({ projectForm: { mode: 'create' } })}
            >
              <IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />
              {t('home.newProject')}
            </Button>
          )}
        </div>
        <div className="vds-home-grid">
          {state.projects.length === 0 && (
            <Button
              unstyled
              className="vds-home-empty"
              data-testid="home-project-empty"
              onClick={() => set({ projectForm: { mode: 'create' } })}
            >
              <IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-8)] !text-[length:var(--vds-icon-8)] !leading-none" />
              <span>{t('home.emptyProjects')}</span>
            </Button>
          )}
          {state.projects.map((project) => {
            const summary = projectSummary(project, state.sessions)
            return (
              <div key={project.id} className="vds-home-card group/home-card">
                <Button
                  unstyled
                  className="flex w-full min-w-0 flex-1 flex-col items-start gap-[var(--vds-space-3)] text-left"
                  data-testid={`home-project-${project.name}`}
                  onClick={() => {
                    act.selectProject(project.id)
                    act.openWorkbenchView('resource')
                  }}
                  aria-label={t('home.enterProject', { name: project.name })}
                >
                  <span className="vds-home-card-head">
                    <span className="vds-home-card-icon">
                      <Box size={20} strokeWidth={1.6} />
                    </span>
                    <span className="vds-home-card-title-group">
                      <EllipsisText wrapperClassName="w-full" className="vds-home-card-t" tooltipPortalled>
                        {project.name}
                      </EllipsisText>
                      <span className="vds-home-card-m">
                        <span className="!w-auto flex-none whitespace-nowrap">
                          {t('home.recentlyModified')}
                        </span>
                        <span>{projectModifiedLabel(summary.activityAt)}</span>
                      </span>
                    </span>
                  </span>
                  <EllipsisText
                    wrapperClassName="w-full"
                    className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
                  >
                    {projectDescription(project.path)}
                  </EllipsisText>
                  <span className="flex gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] tabular-nums text-[var(--vds-text-placeholder)]">
                    <span className="vds-home-card-count">
                      <Trans
                        t={projectText}
                        ns="project"
                        i18nKey="overview.materials"
                        count={resourceCountByProject[project.id] ?? 0}
                        components={{ value: <span />, label: <span /> }}
                      />
                    </span>
                    <span className="vds-home-card-count">
                      <Trans
                        t={projectText}
                        ns="project"
                        i18nKey="overview.literature"
                        count={literatureByProject[project.id] ?? 0}
                        components={{ value: <span />, label: <span /> }}
                      />
                    </span>
                  </span>
                </Button>
                <ProjectActionsMenu
                  idPrefix="home-project-"
                  project={project}
                  triggerClassName="absolute right-[var(--vds-space-2)] top-[var(--vds-space-2)] z-[var(--vds-z-local-control)] opacity-0 transition-opacity group-hover/home-card:opacity-100 focus-visible:opacity-100 aria-[expanded=true]:opacity-100"
                  triggerTestId={`home-project-menu-${project.id}`}
                />
              </div>
            )
          })}
        </div>
        {state.projects.length === 0 && (
          <div className="vds-home-empty-bg" aria-hidden="true">
            <img alt="" draggable={false} src={emptyBg} />
          </div>
        )}
      </div>
    </div>
  )
}
