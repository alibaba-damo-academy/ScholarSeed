import {
  Bot,
  ChevronRight,
  Database,
  MoreHorizontal,
  Pencil,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
  Input,
  SearchBox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  useToast,
} from '../../components/ui'
import {
  deleteResourceVersion,
  fetchResourceVersionContent,
  fetchResourceVersions,
  fetchVersionCapability,
  previewResourceRestore,
  previewResourceVersionDelete,
  restoreResourceVersion,
  updateResourceVersionAlias,
  type ResourceVersion,
  type ResourceVersionDeletePreview,
} from '../../contracts/resources'
import type { ResourceHistoryTarget } from '../../contracts/workbench'
import { useApp } from '../../store'
import { historyAccess } from './history'
import { SnapshotReview } from './SnapshotReview'
import { viewerForPath } from './tabs'
import { useWorkspaceController, type DocumentSession } from './workspace'

const ORIGIN_LABEL = {
  initial_scan: 'history.origin.initial',
  user: 'history.origin.user',
  external_confirmed: 'history.origin.external',
  agent: 'history.origin.agent',
  restore: 'history.origin.restore',
  delivery_revert: 'history.origin.deliveryRevert',
} as const

const USER_ORIGINS = new Set(['user', 'external_confirmed', 'restore'])
const AGENT_ORIGINS = new Set(['agent', 'delivery_revert'])
const SEARCH_DELAY_MS = 240

type HistoryNotice =
  | {
      key:
        | 'history.partialFailed'
        | 'history.readFailed'
        | 'history.moreFailed'
        | 'history.diskCheckFailed'
        | 'history.aliasFailed'
        | 'history.deletePreviewFailed'
        | 'history.deleteFailed'
    }
  | { key: 'history.pathConflict'; path: string }
  | { key: 'history.restoreFailed'; detail: string }
  | { key: 'history.restoredHistoryFailed'; sequence: number }
  | { key: 'history.restoredSyncFailed'; sequence: number }
  | { key: 'history.restoredConflict'; sequence: number }
type HistorySuccessNotice =
  | { key: 'history.restored'; sequence: number }
  | { key: 'history.aliasSaved'; sequence: number }
  | { key: 'history.deleted'; sequence: number }

function HistoryNoticeText({
  notice,
}: {
  notice: HistoryNotice | HistorySuccessNotice
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  switch (notice.key) {
    case 'history.pathConflict':
      return <>{t(notice.key, notice)}</>
    case 'history.restoreFailed':
      return <>{t(notice.key, notice)}</>
    case 'history.restoredHistoryFailed':
      return <>{t(notice.key, notice)}</>
    case 'history.restoredSyncFailed':
      return <>{t(notice.key, notice)}</>
    case 'history.restoredConflict':
      return <>{t(notice.key, notice)}</>
    case 'history.restored':
      return <>{t(notice.key, notice)}</>
    case 'history.aliasSaved':
      return <>{t(notice.key, notice)}</>
    case 'history.deleted':
      return <>{t(notice.key, notice)}</>
    default:
      return <>{t(notice.key)}</>
  }
}

interface BinaryPreview {
  version: ResourceVersion
  size: number
}

function Preview({ preview }: { preview: BinaryPreview }): React.JSX.Element {
  const { t, i18n } = useTranslation('workbench')
  return (
    <div className="vds-version-preview rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)]">
      <strong>{t('history.preview.binary', { sequence: preview.version.sequence })}</strong>
      <span>
        {t('history.preview.binaryDescription', {
          size: preview.size.toLocaleString(i18n.language),
        })}
      </span>
    </div>
  )
}

interface VersionHistoryProps {
  session?: DocumentSession
  file?: ResourceHistoryTarget
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onPreview?: () => void
  onRestored?: () => void
}

export function VersionHistory({
  session,
  file,
  open: controlledOpen,
  onOpenChange,
  onPreview,
  onRestored,
}: VersionHistoryProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation('workbench')
  const workspace = useWorkspaceController()
  const { act } = useApp()
  const { toast } = useToast()
  const [localOpen, setLocalOpen] = React.useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (next: boolean): void => {
    setLocalOpen(next)
    onOpenChange?.(next)
  }
  const [gitManaged, setGitManaged] = React.useState(false)
  const [pendingReview, setPendingReview] = React.useState<boolean | null>(null)
  const [fileCanPreview, setFileCanPreview] = React.useState(false)
  const [fileCanDiff, setFileCanDiff] = React.useState(false)
  const [versions, setVersions] = React.useState<ResourceVersion[]>([])
  const [cursor, setCursor] = React.useState<number | null>(null)
  const [total, setTotal] = React.useState(0)
  const [fileId, setFileId] = React.useState<string | null>(null)
  const [currentVersionId, setCurrentVersionId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [origin, setOrigin] = React.useState('all')
  const [order, setOrder] = React.useState<'newest' | 'oldest'>('newest')
  const loadSequence = React.useRef(0)
  const [loading, setLoading] = React.useState(false)
  const [notice, setNotice] = React.useState<HistoryNotice | null>(null)
  const [preview, setPreview] = React.useState<BinaryPreview | null>(null)
  const [conflict, setConflict] = React.useState<{
    version: ResourceVersion
    token: string
    previousPath: string
  } | null>(null)
  const [aliasTarget, setAliasTarget] = React.useState<ResourceVersion | null>(null)
  const [aliasValue, setAliasValue] = React.useState('')
  const [deleteTarget, setDeleteTarget] = React.useState<{
    version: ResourceVersion
    preview: ResourceVersionDeletePreview
  } | null>(null)
  const [mutating, setMutating] = React.useState(false)

  React.useEffect(() => {
    loadSequence.current += 1
    setLocalOpen(false)
    setGitManaged(false)
    setPendingReview(null)
    setFileCanPreview(false)
    setFileCanDiff(false)
    setVersions([])
    setCursor(null)
    setTotal(0)
    setLoading(false)
  }, [session?.id, file?.project, file?.fileId])

  const available = Boolean(
    file || (session?.source.kind === 'project' && historyAccess(session.versioning).available)
  )
  const readOnly = gitManaged || session?.versioning?.management_state === 'git'
  const canPreview = file ? fileCanPreview : historyAccess(session?.versioning).canPreview
  const project =
    file?.project ??
    (session?.source.kind === 'project' ? (session.source.project ?? 'current') : 'current')
  const sourcePath = file?.path ?? session?.source.path ?? ''
  const sourceFileId = file?.fileId ?? session?.versioning?.file_id ?? null

  const canInspectVersion = (path: string): boolean => viewerForPath(path) !== 'pdf'

  const notifySuccess = (success: HistorySuccessNotice): void => {
    setNotice(null)
    toast({ title: <HistoryNoticeText notice={success} />, tone: 'success' })
  }

  const load = async (
    path = sourcePath,
    knownFileId = sourceFileId,
    cursorValue?: number,
    append = false
  ): Promise<boolean> => {
    const sequence = ++loadSequence.current
    setLoading(true)
    const capability = await fetchVersionCapability(project, path)
    const resolvedFileId = knownFileId ?? capability?.file_id
    const history = resolvedFileId
      ? await fetchResourceVersions(project, resolvedFileId, {
          cursor: cursorValue,
          q: query.trim() || undefined,
          origin: origin === 'all' ? undefined : origin,
          order,
        })
      : null
    if (sequence !== loadSequence.current) return false
    setGitManaged(capability?.management_state === 'git')
    setPendingReview(capability ? Boolean(capability.pending?.review) : null)
    setFileId(resolvedFileId ?? null)
    setCurrentVersionId(
      capability?.snapshot_state === 'saved' && !capability.drifted ? capability.version_id : null
    )
    setFileCanPreview(historyAccess(capability).canPreview)
    setFileCanDiff(capability?.can_diff === true)
    if (history !== null) {
      setVersions((current) =>
        append
          ? [
              ...new Map(
                [...current, ...history.versions].map((version) => [version.id, version])
              ).values(),
            ]
          : history.versions
      )
      setCursor(history.next_cursor)
      setTotal(history.total)
    }
    setNotice(history !== null ? null : { key: 'history.partialFailed' })
    setLoading(false)
    return history !== null
  }

  React.useEffect(() => {
    if (!available || !open) return undefined
    const timer = window.setTimeout(() => {
      void load()
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [available, open, query, origin, order, sourcePath, sourceFileId, session?.versioning])

  if (!available) return null

  const inspect = async (version: ResourceVersion): Promise<void> => {
    if (!canPreview || !canInspectVersion(version.path) || version.state === 'tombstone') return
    const viewer = viewerForPath(version.path)
    const opensComparison =
      fileCanDiff ||
      session?.capabilities.can_diff === true ||
      viewer === 'office' ||
      viewer === 'spreadsheet'
    if (opensComparison) {
      if (!fileId || !currentVersionId) {
        setNotice({ key: 'history.readFailed' })
        return
      }
      act.openVersionDiff({
        project,
        fileId,
        path: sourcePath,
        historicalVersionId: version.id,
        currentVersionId,
        historicalSequence: version.sequence,
        processor: session?.processor ?? null,
      })
      setOpen(false)
      onPreview?.()
      return
    }
    const bytes = await fetchResourceVersionContent(project, version.id)
    if (!bytes) {
      setNotice({ key: 'history.readFailed' })
      return
    }
    setPreview({ version, size: bytes.byteLength })
  }

  const loadMore = async (): Promise<void> => {
    if (cursor === null || !fileId || loading) return
    const complete = await load(sourcePath, fileId, cursor, true)
    if (!complete) setNotice({ key: 'history.moreFailed' })
  }

  const apply = async (
    version: ResourceVersion,
    token: string,
    force: boolean,
    previousPath: string
  ): Promise<void> => {
    const restored = await restoreResourceVersion(
      project,
      version.id,
      force ? 'force' : 'strict',
      token
    )
    if (!restored.ok) {
      setNotice({ key: 'history.restoreFailed', detail: restored.error })
      return
    }
    setConflict(null)
    const synchronized = await workspace.reconcileRestoredFiles(project, [
      {
        fileId: restored.result.file_id,
        versionId: restored.result.id,
        previousPath,
        path: restored.result.path,
        state: restored.result.state,
      },
    ])
    await act.reloadResourceTree()
    const historySynchronized = await load(restored.result.path, restored.result.file_id)
    const restoredNotice: HistoryNotice | null = !historySynchronized
      ? { key: 'history.restoredHistoryFailed', sequence: version.sequence }
      : synchronized.failed.length
        ? { key: 'history.restoredSyncFailed', sequence: version.sequence }
        : synchronized.conflicted.length
          ? { key: 'history.restoredConflict', sequence: version.sequence }
          : null
    if (restoredNotice) setNotice(restoredNotice)
    else notifySuccess({ key: 'history.restored', sequence: version.sequence })
    onRestored?.()
  }

  const restore = async (version: ResourceVersion): Promise<void> => {
    const restorePreview = await previewResourceRestore(project, version.id)
    if (!restorePreview) {
      setNotice({ key: 'history.diskCheckFailed' })
      return
    }
    if (restorePreview.path_conflict) {
      setNotice({ key: 'history.pathConflict', path: version.path })
      return
    }
    if (restorePreview.conflict) {
      setConflict({
        version,
        token: restorePreview.preflight_token,
        previousPath: restorePreview.path,
      })
      return
    }
    await apply(version, restorePreview.preflight_token, false, restorePreview.path)
  }

  const openAlias = (version: ResourceVersion): void => {
    setAliasTarget(version)
    setAliasValue(version.alias ?? '')
  }
  const saveAlias = async (): Promise<void> => {
    if (!aliasTarget || mutating) return
    setMutating(true)
    const result = await updateResourceVersionAlias(
      project,
      aliasTarget,
      aliasValue,
      crypto.randomUUID()
    )
    setMutating(false)
    if (!result.ok) {
      setNotice({ key: 'history.aliasFailed' })
      return
    }
    setVersions((current) =>
      current.map((version) => (version.id === result.result.id ? result.result : version))
    )
    setAliasTarget(null)
    notifySuccess({ key: 'history.aliasSaved', sequence: result.result.sequence })
  }

  const openDelete = async (version: ResourceVersion): Promise<void> => {
    const result = await previewResourceVersionDelete(project, version.id)
    if (!result) {
      setNotice({ key: 'history.deletePreviewFailed' })
      return
    }
    setDeleteTarget({ version, preview: result })
  }

  const confirmDelete = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (!deleteTarget || mutating || !deleteTarget.preview.deletable) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    setMutating(true)
    const result = await deleteResourceVersion(
      project,
      deleteTarget.version.id,
      deleteTarget.preview.preflight_token,
      crypto.randomUUID()
    )
    setMutating(false)
    if (!result.ok) {
      setNotice({ key: 'history.deleteFailed' })
      const refreshed = await previewResourceVersionDelete(project, deleteTarget.version.id)
      if (refreshed) setDeleteTarget({ ...deleteTarget, preview: refreshed })
      return
    }
    if (preview?.version.id === deleteTarget.version.id) setPreview(null)
    const deletedSequence = deleteTarget.version.sequence
    setDeleteTarget(null)
    await load()
    notifySuccess({ key: 'history.deleted', sequence: deletedSequence })
  }

  const dayLabel = (timestamp: number): string => {
    const date = new Date(timestamp)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (date.toDateString() === today.toDateString()) return t('history.today')
    if (date.toDateString() === yesterday.toDateString()) return t('history.yesterday')
    return date.toLocaleDateString(i18n.language, { month: 'long', day: 'numeric' })
  }
  const groups = versions.reduce<Array<{ label: string; items: ResourceVersion[] }>>(
    (result, version) => {
      const label = dayLabel(version.created_at_ms)
      const last = result[result.length - 1]
      if (last?.label === label) last.items.push(version)
      else result.push({ label, items: [version] })
      return result
    },
    []
  )
  const originIcon = (version: ResourceVersion): React.JSX.Element => {
    if (AGENT_ORIGINS.has(version.origin)) return <Bot className="size-[var(--vds-icon-8)]" />
    if (USER_ORIGINS.has(version.origin)) return <UserRound className="size-[var(--vds-icon-8)]" />
    return <Database className="size-[var(--vds-icon-8)]" />
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          loadSequence.current += 1
          setLoading(false)
          setPreview(null)
        }
      }}
    >
      {controlledOpen === undefined && (
        <SheetTrigger data-testid="document-version-history">{t('history.trigger')}</SheetTrigger>
      )}
      {createPortal(
        <SheetPortal>
          <SheetOverlay />
          <SheetContent
            className="vds-version-history !w-[var(--vds-version-history-sheet-width)] min-w-[var(--vds-version-history-sheet-min-width)] max-w-[var(--vds-version-history-sheet-max-width)] !gap-0 !px-0 !py-[var(--vds-space-3)]"
            side="right"
          >
            <SheetHeader className="relative border-b border-[var(--vds-border-default)] pb-[var(--vds-space-4)] pl-[var(--vds-sheet-padding)] pr-[calc(var(--vds-sheet-padding)+var(--vds-space-10))]">
              <SheetTitle>{t('history.title')}</SheetTitle>
              <SheetDescription className="min-w-0">
                <EllipsisText tooltipPortalled wrapperClassName="block w-full">
                  {sourcePath}
                </EllipsisText>
              </SheetDescription>
              <SheetClose
                aria-label={t('history.close')}
                className="absolute right-[var(--vds-sheet-padding)] top-[calc(var(--vds-space-1)*-1)] size-[var(--vds-space-8)] min-h-0 !border-0 bg-transparent !p-0 hover:bg-[var(--vds-other-overlay-1)]"
              >
                <X size={14} strokeWidth={1.6} />
              </SheetClose>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-3)] overflow-hidden px-[var(--vds-sheet-padding)] pt-[var(--vds-space-5)]">
              <div className="grid grid-cols-[minmax(0,1fr)_124px_124px] gap-[var(--vds-space-2)]">
                <SearchBox
                  aria-label={t('history.search')}
                  placeholder={t('history.searchPlaceholder')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Select value={origin} onValueChange={setOrigin}>
                  <SelectTrigger aria-label={t('history.source')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('history.allSources')}</SelectItem>
                    <SelectItem value="user">{t('history.origin.user')}</SelectItem>
                    <SelectItem value="agent">{t('history.origin.agent')}</SelectItem>
                    <SelectItem value="external_confirmed">
                      {t('history.origin.external')}
                    </SelectItem>
                    <SelectItem value="initial_scan">{t('history.origin.initial')}</SelectItem>
                    <SelectItem value="restore">{t('history.origin.restore')}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={order}
                  onValueChange={(value) => setOrder(value as 'newest' | 'oldest')}
                >
                  <SelectTrigger aria-label={t('history.sort')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">{t('history.newest')}</SelectItem>
                    <SelectItem value="oldest">{t('history.oldest')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {!canPreview && (
                <Alert tone="info">
                  <AlertDescription>{t('history.previewUnavailable')}</AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert tone="info">
                  <AlertTitle>{t('history.status')}</AlertTitle>
                  <AlertDescription>
                    <HistoryNoticeText notice={notice} />
                  </AlertDescription>
                </Alert>
              )}
              {pendingReview === true && (
                <Badge
                  tone="neutral"
                  className="self-start"
                  data-testid="version-history-pending-review"
                >
                  {t('history.pendingReview')}
                </Badge>
              )}
              {pendingReview === false && (session || file) && (
                <SnapshotReview session={session} file={file} onResolved={() => load()} />
              )}
              {conflict && (
                <Alert
                  action={
                    <div className="vds-version-actions flex gap-[var(--vds-space-2)]">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          void apply(conflict.version, conflict.token, true, conflict.previousPath)
                        }
                      >
                        {t('history.forceRestore')}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setConflict(null)}>
                        {t('history.cancelRestore')}
                      </Button>
                    </div>
                  }
                  description={t('history.diskChangedDescription')}
                  layout="stacked"
                  title={t('history.diskChanged')}
                  tone="warning"
                />
              )}
              {preview && <Preview preview={preview} />}
              <div className="vds-version-list min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
                {loading && versions.length === 0 && (
                  <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                    {t('history.loading')}
                  </span>
                )}
                {!loading && versions.length === 0 && (
                  <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                    {t('history.empty')}
                  </span>
                )}
                {groups.map((group) => (
                  <section key={group.label} className="mb-[var(--vds-space-4)]">
                    <h3 className="mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-secondary)]">
                      {group.label}
                    </h3>
                    <div>
                      {group.items.map((version) => {
                        const current = version.id === currentVersionId
                        const disabled =
                          !canPreview ||
                          !canInspectVersion(version.path) ||
                          version.state === 'tombstone'
                        return (
                          <div
                            className="vds-version-row group relative grid grid-cols-[var(--vds-space-2)_var(--vds-space-8)_minmax(0,1fr)_auto_auto_auto] items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] hover:bg-[var(--vds-bg-gray-light-default)]"
                            key={version.id}
                          >
                            <span className="size-[var(--vds-space-2)] rounded-full bg-[var(--vds-accent-bg-default)]" />
                            <span className="flex size-[var(--vds-space-8)] items-center justify-center rounded-full bg-[var(--vds-bg-component)] text-[var(--vds-text-secondary)]">
                              {originIcon(version)}
                            </span>
                            <Button
                              unstyled
                              className="min-w-0 cursor-pointer rounded-[var(--vds-radius-2)] px-[var(--vds-space-1)] py-[var(--vds-space-half)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vds-border-brand)] disabled:cursor-default"
                              data-testid="version-history-row-action"
                              disabled={disabled}
                              onClick={() => void inspect(version)}
                            >
                              <span className="flex min-w-0 items-center gap-[calc(var(--vds-space-1)+var(--vds-space-half))] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)]">
                                <strong>v{version.sequence}</strong>
                                {version.alias && (
                                  <span className="truncate">· {version.alias}</span>
                                )}
                                {current && <Badge tone="success">{t('history.current')}</Badge>}
                              </span>
                              <small className="block truncate text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                                {version.review_backup
                                  ? t('history.reviewBackup')
                                  : Object.prototype.hasOwnProperty.call(
                                        ORIGIN_LABEL,
                                        version.origin
                                      )
                                    ? t(ORIGIN_LABEL[version.origin as keyof typeof ORIGIN_LABEL])
                                    : version.origin}
                                {' · '}
                                {new Date(version.created_at_ms).toLocaleTimeString(i18n.language, {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </small>
                              <small className="block truncate text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                                {version.restored_from_sequence
                                  ? t('history.restoredFrom', {
                                      sequence: version.restored_from_sequence,
                                    })
                                  : version.turn_id
                                    ? t('history.agentTurn', { id: version.turn_id })
                                    : version.path}
                              </small>
                            </Button>
                            <Button
                              data-testid="version-history-restore"
                              variant="secondary"
                              size="sm"
                              disabled={readOnly || current}
                              title={
                                readOnly
                                  ? t('history.gitReadOnly')
                                  : current
                                    ? t('history.currentRestoreDisabled')
                                    : undefined
                              }
                              onClick={() => void restore(version)}
                            >
                              {t('history.restore')}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <IconButton
                                  label={t('history.moreActions')}
                                  icon={<MoreHorizontal />}
                                  size="sm"
                                  variant="ghost"
                                />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="z-[var(--vds-z-sheet-flyout)]">
                                <DropdownMenuItem onSelect={() => openAlias(version)}>
                                  <Pencil />
                                  {t('history.alias')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  destructive
                                  disabled={readOnly || current}
                                  onSelect={() => void openDelete(version)}
                                >
                                  <Trash2 />
                                  {t('history.deleteVersion')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {!disabled && (
                              <IconButton
                                data-testid="version-history-inspect"
                                label={t('history.inspect', { sequence: version.sequence })}
                                icon={<ChevronRight />}
                                size="sm"
                                variant="ghost"
                                onClick={() => void inspect(version)}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
                {cursor !== null && (
                  <Button
                    className="w-full"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => void loadMore()}
                  >
                    {t('history.loadMore')}
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-[var(--vds-space-3)] border-t border-[var(--vds-border-default)] px-[var(--vds-sheet-padding)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {t('history.total', { count: total })}
            </div>
          </SheetContent>
        </SheetPortal>,
        document.body
      )}

      <Dialog
        open={aliasTarget !== null}
        onOpenChange={(next) => {
          if (!next && !mutating) setAliasTarget(null)
        }}
      >
        <DialogPortal>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('history.aliasTitle', { sequence: aliasTarget?.sequence ?? 0 })}
              </DialogTitle>
              <DialogDescription>{t('history.aliasDescription')}</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              maxLength={80}
              value={aliasValue}
              placeholder={t('history.aliasPlaceholder')}
              onChange={(event) => setAliasValue(event.target.value)}
            />
            <DialogFooter>
              <DialogClose disabled={mutating}>{t('history.cancel')}</DialogClose>
              <Button disabled={mutating} onClick={() => void saveAlias()}>
                {t('history.saveAlias')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !mutating) setDeleteTarget(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('history.deleteTitle', { sequence: deleteTarget?.version.sequence ?? 0 })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.preview.deletable
                  ? deleteTarget.preview.affected_delivery_ids.length > 0
                    ? t('history.deleteDeliveryImpact', {
                        count: deleteTarget.preview.affected_delivery_ids.length,
                      })
                    : t('history.deleteDescription')
                  : t('history.deleteBlocked')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={mutating}>{t('history.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="danger"
                disabled={mutating || !deleteTarget?.preview.deletable}
                onClick={(event) => void confirmDelete(event)}
              >
                {t('history.confirmDelete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </Sheet>
  )
}
