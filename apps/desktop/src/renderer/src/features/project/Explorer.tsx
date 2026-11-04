import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownToLine,
  ChevronDown,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FilePlusCorner,
  FileSearch,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Link,
  MessageCirclePlus,
  MoreVertical,
  Pencil,
  RotateCw,
  Trash2,
} from 'lucide-react'

import finderIcon from '../../assets/finder.svg'
import { revealSystemPath } from '../../api'
import { IMPORT_PICKER_TARGET } from '../../../../picker'
import {
  Alert,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
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
  DropdownMenuSeparator,
  EllipsisText,
  EmptyState,
  IconButton,
  Input,
  ResizablePanel,
  SearchBox,
  Spinner,
  Tooltip,
  useToast,
} from '../../components/ui'
import { revealLabelKey } from '../../fileOpen'
import { selectedProject, useApp } from '../../store'
import { fetchResourceTree, resolveRevealTarget } from '../resources/api'
import { resourceFileIcon } from '../resources/icons'
import { resourceNameError } from '../resources/state'
import { writeProjectEntryDrag } from '../../drag'
import { DocumentView } from '../workbench/feature'
import { useDocumentWorkspace, useWorkspaceController } from '../workbench/workspace'
import { subscribeFileEvents } from './events'
import {
  importProjectFiles,
  listProjectFiles,
  mutateProjectNode,
  readProjectTree,
  type ProjectTreeNode,
  type ProjectTreePage,
} from './api'

type TreeNode = Pick<ProjectTreeNode, 'path' | 'name' | 'kind' | 'available' | 'artifact'>
type NameAction = 'create_document' | 'create_folder' | 'rename'
type InlineCreation = { parent: string; row: React.ReactNode }
type MenuState = { node: TreeNode; x: number; y: number; mode: 'add' | 'context' }
type ExplorerState = {
  expanded: ReadonlySet<string>
  rootExpanded: boolean
  preview: string | null
  previewPath: string | null
  collapsed: boolean
  width: string
  openInTab: boolean
}
const explorerStates = new Map<string, ExplorerState>()
const BREADCRUMB_TRAILING_PARTS = 2
const EXPLORER_TREE_MIN_WIDTH = 240

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

function useLoadingDirectories(): [ReadonlySet<string>, (path: string, loading: boolean) => void] {
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set())
  const update = useCallback((path: string, loading: boolean) => {
    setPaths((current) => {
      if (current.has(path) === loading) return current
      const next = new Set(current)
      if (loading) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])
  return [paths, update]
}

export function Directory({
  project,
  path,
  revision,
  expanded,
  selected,
  dragTarget,
  menuPath = null,
  creation,
  onToggle,
  onSelect,
  onMenu,
  onDrop,
  onDragTarget,
  onLoadingChange,
}: {
  project: string
  path: string
  revision: number
  expanded: ReadonlySet<string>
  selected: string | null
  dragTarget: string | null
  menuPath?: string | null
  creation?: InlineCreation
  onToggle: (path: string) => void
  onSelect: (node: ProjectTreeNode) => void
  onMenu: (node: TreeNode, x: number, y: number) => void
  onDrop: (source: string, destination: string) => void
  onDragTarget: (path: string | null) => void
  onLoadingChange?: (path: string, loading: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const identity = JSON.stringify([project, path])
  const [snapshot, setSnapshot] = useState<{ identity: string; page: ProjectTreePage | null }>({
    identity,
    page: null,
  })
  const page = snapshot.identity === identity ? snapshot.page : null
  const pageRef = useRef(page)
  pageRef.current = page
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [more, setMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [loadingDirectories, updateLoading] = useLoadingDirectories()
  const generation = useRef(0)
  const morePending = useRef(false)
  const directoryId = path || '/'
  useLayoutEffect(() => {
    const requestGeneration = ++generation.current
    const loadedCount = pageRef.current?.nodes.length ?? 0
    setLoading(true)
    setReadFailed(false)
    onLoadingChange?.(path, true)
    morePending.current = false
    setMore(false)
    setMoreError(false)
    const settle = (value: ProjectTreePage | null): void => {
      if (generation.current !== requestGeneration) return
      if (value) setSnapshot({ identity, page: value })
      setReadFailed(value === null)
      setLoading(false)
      onLoadingChange?.(path, false)
    }
    const refresh = async (): Promise<ProjectTreePage | null> => {
      let replacement = await readProjectTree(project, path)
      if (!replacement || generation.current !== requestGeneration) return null
      // Replace the loaded range atomically, keeping existing rows mounted while reading.
      while (replacement.nodes.length < Math.min(loadedCount, replacement.total)) {
        const next = await readProjectTree(project, path, replacement.nodes.length)
        if (generation.current !== requestGeneration || !next || !next.nodes.length) return null
        replacement = { ...next, nodes: [...replacement.nodes, ...next.nodes] }
      }
      return replacement
    }
    void refresh().then(settle, () => settle(null))
    return () => {
      generation.current += 1
      morePending.current = false
      onLoadingChange?.(path, false)
    }
  }, [identity, project, path, revision, retry, onLoadingChange])
  const loadMore = async (): Promise<void> => {
    if (!page || loading || morePending.current || page.nodes.length >= page.total) return
    const requestGeneration = generation.current
    morePending.current = true
    setMore(true)
    setMoreError(false)
    try {
      const next = await readProjectTree(project, path, page.nodes.length)
      if (generation.current !== requestGeneration) return
      if (next) {
        setSnapshot((current) =>
          current.identity === identity && current.page === page
            ? { identity, page: { ...next, nodes: [...page.nodes, ...next.nodes] } }
            : current
        )
      } else setMoreError(true)
    } catch {
      if (generation.current === requestGeneration) setMoreError(true)
    } finally {
      if (generation.current === requestGeneration) {
        morePending.current = false
        setMore(false)
      }
    }
  }
  const creationRow = creation?.parent === path ? creation.row : null
  const pendingRow = creationRow ? (
    <div className="pl-[var(--vds-space-5)]">{creationRow}</div>
  ) : null
  if (loading && !page) return <>{pendingRow}</>
  const failure = readFailed ? (
    <Alert
      tone="error"
      data-testid={`explorer-directory-error-${directoryId}`}
      title={t('readFailed')}
      action={
        <Button
          variant="ghost"
          data-testid={`explorer-directory-retry-${directoryId}`}
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('retry')}
        </Button>
      }
    />
  ) : null
  if (!page || (page.nodes.length === 0 && page.total === 0))
    return (
      <>
        {pendingRow}
        {failure}
      </>
    )
  return (
    <div className="flex min-w-0 flex-col gap-[var(--vds-space-1)] pl-[var(--vds-space-5)]">
      {creationRow}
      {failure}
      {page.nodes.map((node) => {
        const isDir = node.kind === 'dir'
        const FileIcon = resourceFileIcon(node.name, node.kind)
        const open = expanded.has(node.path)
        return (
          <React.Fragment key={node.path}>
            <div
              className={`group/explorer-row relative flex h-[var(--vds-space-9)] min-w-0 shrink-0 items-center gap-[calc(var(--vds-space-1)+var(--vds-space-half))] rounded-[var(--vds-radius-4)] px-[var(--vds-space-1)] hover:bg-[var(--vds-bg-white-active)] ${!isDir && selected === node.path ? 'bg-[var(--vds-bg-white-active)]' : ''} ${dragTarget === node.path ? 'ring-2 ring-[var(--vds-border-brand)]' : ''}`}
              data-testid={`explorer-node-${node.path}`}
              title={node.path}
              onContextMenu={(event) => {
                event.preventDefault()
                onMenu(node, event.clientX, event.clientY)
              }}
              onDragOver={(event) => {
                if (isDir) {
                  event.preventDefault()
                  onDragTarget(node.path)
                }
              }}
              onDrop={(event) => {
                if (!isDir) return
                event.preventDefault()
                event.stopPropagation()
                onDragTarget(null)
                const source = event.dataTransfer.getData('text/x-scholarseed-project-path')
                if (source) onDrop(source, node.path)
              }}
            >
              {isDir ? (
                <IconButton
                  variant="ghostIcon"
                  size="xs"
                  className="!size-[var(--vds-space-5)] !min-w-[var(--vds-space-5)] [--vds-icon-button-glyph:var(--vds-icon-8)]"
                  icon={
                    open && loadingDirectories.has(node.path) ? (
                      <Spinner size="sm" data-testid={`explorer-directory-loading-${node.path}`} />
                    ) : open ? (
                      <ChevronDown />
                    ) : (
                      <ChevronRight />
                    )
                  }
                  label={t(open ? 'explorerCollapseFolder' : 'explorerExpandFolder', {
                    name: node.name,
                  })}
                  aria-expanded={open}
                  aria-busy={open && loadingDirectories.has(node.path)}
                  onClick={() => onToggle(node.path)}
                />
              ) : (
                <span className="w-[var(--vds-space-5)] shrink-0" />
              )}
              <Button
                variant="ghost"
                disabled={!node.available}
                draggable={node.available}
                data-testid={`explorer-select-${node.path}`}
                className="!h-[var(--vds-space-9)] min-w-0 flex-1 !justify-start !gap-[calc(var(--vds-space-1)+var(--vds-space-half))] !px-0 !text-left !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)] !text-[var(--vds-text-tertiary)] hover:![background:transparent]"
                onClick={() => {
                  if (isDir) onToggle(node.path)
                  else onSelect(node)
                }}
                onDragStart={(event) => {
                  writeProjectEntryDrag(event.dataTransfer, project, node)
                  if (!isDir) {
                    event.dataTransfer.setData('text/x-scholarseed-project-path', node.path)
                    event.dataTransfer.effectAllowed = 'copyMove'
                  }
                }}
                onDragEnd={() => onDragTarget(null)}
              >
                {isDir ? (
                  open ? (
                    <FolderOpen className="shrink-0" size={16} />
                  ) : (
                    <Folder className="shrink-0" size={16} />
                  )
                ) : (
                  <FileIcon className="shrink-0" size={16} />
                )}
                <EllipsisText className="min-w-0">{node.name}</EllipsisText>
              </Button>
              <IconButton
                variant="ghostIcon"
                size="sm"
                icon={<MoreVertical />}
                className="pointer-events-none absolute right-[var(--vds-space-1)] opacity-0 group-hover/explorer-row:pointer-events-auto group-hover/explorer-row:static group-hover/explorer-row:opacity-[var(--vds-opacity-full)] group-focus-within/explorer-row:pointer-events-auto group-focus-within/explorer-row:static group-focus-within/explorer-row:opacity-[var(--vds-opacity-full)] aria-expanded:pointer-events-auto aria-expanded:static aria-expanded:opacity-[var(--vds-opacity-full)]"
                aria-haspopup="menu"
                aria-expanded={menuPath === node.path}
                label={`${node.name} ${t('explorerActions')}`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  onMenu(node, rect.left, rect.bottom)
                }}
              />
            </div>
            {isDir && open && (
              <Directory
                project={project}
                path={node.path}
                revision={revision}
                expanded={expanded}
                selected={selected}
                dragTarget={dragTarget}
                menuPath={menuPath}
                creation={creation}
                onToggle={onToggle}
                onSelect={onSelect}
                onMenu={onMenu}
                onDrop={onDrop}
                onDragTarget={onDragTarget}
                onLoadingChange={updateLoading}
              />
            )}
          </React.Fragment>
        )
      })}
      {moreError && (
        <Alert
          tone="error"
          data-testid={`explorer-more-error-${directoryId}`}
          title={t('explorerMoreFailed')}
        />
      )}
      {page.nodes.length < page.total && (
        <Button
          variant="ghost"
          data-testid={`explorer-more-${directoryId}`}
          loading={more}
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {t('loadMore')}
        </Button>
      )}
    </div>
  )
}

export function Explorer({
  tabId,
  active = true,
}: { tabId?: string; active?: boolean } = {}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('layout')
  const { t: resourceText } = useTranslation(['resources'])
  const { toast } = useToast()
  const project = selectedProject(state)
  const projectId = project?.id ?? null
  const stateKey = JSON.stringify([projectId, tabId])
  const workspace = useWorkspaceController()
  const documents = useDocumentWorkspace()
  const [revision, setRevision] = useState(0)
  const [modeControlHost, setModeControlHost] = useState<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => explorerStates.get(stateKey)?.expanded ?? new Set()
  )
  const [rootExpanded, setRootExpanded] = useState(
    () => explorerStates.get(stateKey)?.rootExpanded ?? true
  )
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [preview, setPreview] = useState<string | null>(
    () => explorerStates.get(stateKey)?.preview ?? null
  )
  const [previewPath, setPreviewPath] = useState<string | null>(
    () => explorerStates.get(stateKey)?.previewPath ?? null
  )
  const [collapsed, setCollapsed] = useState(() => explorerStates.get(stateKey)?.collapsed ?? false)
  const [width, setWidth] = useState(() => explorerStates.get(stateKey)?.width ?? '300px')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [nameAction, setNameAction] = useState<NameAction | null>(null)
  const [name, setName] = useState('')
  const [creationParent, setCreationParent] = useState('')
  const namePending = useRef(false)
  const nameEditing = useRef(false)
  const activeProject = useRef(projectId)
  activeProject.current = projectId
  const [busy, setBusy] = useState(false)
  const importPending = useRef(false)
  const [dragTarget, setDragTarget] = useState<string | null>(null)
  const [pathFailure, setPathFailure] = useState<string | null>(null)
  const [loadingDirectories, updateLoading] = useLoadingDirectories()
  const previewRequest = useRef(0)
  const pendingPreview = useRef<number | null>(null)
  const expectedPreview = useRef<string | null>(null)
  const previewTab = preview ? documents.tabs[preview] : undefined
  // Promotion transfers the tab to the dock; it must not retain a second editor in its old host.
  const tab = previewTab?.embedded && previewTab.hostTabId === tabId ? previewTab : undefined
  const previewSession = tab ? documents.sessions[tab.sessionId] : undefined
  const currentPath =
    previewSession?.source.kind === 'project' ? previewSession.source.path : previewPath
  const breadcrumbPath = tab ? currentPath : null
  const pathParts = breadcrumbPath?.split('/').filter(Boolean) ?? []
  const breadcrumbParts = [project?.name ?? '', ...pathParts]
  const breadcrumbRef = useRef<HTMLElement>(null)
  const breadcrumbMeasureRef = useRef<HTMLOListElement>(null)
  const [breadcrumbOverflow, setBreadcrumbOverflow] = useState(false)
  const [openInTab, setOpenInTab] = useState(() => explorerStates.get(stateKey)?.openInTab ?? false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const [searchFiles, setSearchFiles] = useState<{
    project: string
    revision: number
    nodes: ProjectTreeNode[] | null
  } | null>(null)
  const searching = searchOpen && searchQuery.trim().length > 0
  const currentSearch =
    searchFiles?.project === projectId && searchFiles.revision === revision ? searchFiles : null
  const matches = currentSearch?.nodes?.filter((node) =>
    node.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
  )
  useEffect(() => {
    setSearchFiles(null)
    if (!searching || !projectId) return
    const controller = new AbortController()
    void listProjectFiles(projectId, controller.signal).then((nodes) => {
      if (!controller.signal.aborted) setSearchFiles({ project: projectId, revision, nodes })
    })
    return () => controller.abort()
  }, [searching, projectId, revision])
  useLayoutEffect(() => {
    const container = breadcrumbRef.current
    const measurement = breadcrumbMeasureRef.current
    if (!container || !measurement) return
    const measure = (): void => {
      setBreadcrumbOverflow(measurement.getBoundingClientRect().width > container.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(measurement)
    measure()
    return () => observer.disconnect()
  }, [breadcrumbPath, project?.name])
  const visibleBreadcrumbParts =
    breadcrumbOverflow && breadcrumbParts.length > BREADCRUMB_TRAILING_PARTS + 1
      ? [breadcrumbParts[0], null, ...breadcrumbParts.slice(-BREADCRUMB_TRAILING_PARTS)]
      : breadcrumbParts

  const savedState = useRef<ExplorerState>({
    expanded,
    rootExpanded,
    preview,
    previewPath,
    collapsed,
    width,
    openInTab,
  })
  savedState.current = {
    expanded,
    rootExpanded,
    preview,
    previewPath,
    collapsed,
    width,
    openInTab,
  }
  useEffect(() => {
    previewRequest.current += 1
    pendingPreview.current = null
    expectedPreview.current = null
    setNameAction(null)
    nameEditing.current = false
    if (!projectId) return
    const restored = explorerStates.get(stateKey)
    setExpanded(restored?.expanded ?? new Set())
    setRootExpanded(restored?.rootExpanded ?? true)
    setSelected(null)
    setPreview(restored?.preview ?? null)
    setPreviewPath(restored?.previewPath ?? null)
    setCollapsed(restored?.collapsed ?? false)
    setWidth(restored?.width ?? '300px')
    setOpenInTab(restored?.openInTab ?? false)
    return () => {
      explorerStates.set(stateKey, savedState.current)
    }
  }, [projectId, stateKey])
  useEffect(
    () =>
      projectId
        ? subscribeFileEvents(projectId, () => setRevision((value) => value + 1))
        : undefined,
    [projectId]
  )
  useEffect(() => {
    setRevision((value) => value + 1)
  }, [state.resource.tree])
  useEffect(() => {
    const hosted = tabId
      ? Object.values(documents.tabs).find(
          (tab) => tab.embedded && tab.hostTabId === tabId && tab.activeInHost
        )
      : undefined
    if (hosted && hosted.id !== preview && pendingPreview.current === null) {
      const session = documents.sessions[hosted.sessionId]
      setPreview(hosted.id)
      if (session?.source.kind === 'project') setPreviewPath(session.source.path)
      return
    }
    if (preview && documents.tabs[preview] && preview === expectedPreview.current) {
      expectedPreview.current = null
      pendingPreview.current = null
    }
    if (preview && !documents.tabs[preview] && pendingPreview.current === null) {
      setPreview(null)
      setPreviewPath(null)
      setSelected(null)
    }
  }, [documents.tabs, documents.sessions, preview, tabId])
  if (!project) return <></>

  const root: TreeNode = { path: '', name: project.name, kind: 'dir', available: true }
  const targetDirectory = (node: TreeNode | null): string =>
    node?.kind === 'dir' ? node.path : node ? parentPath(node.path) : ''
  const choose = (node: ProjectTreeNode): void => {
    setSelected(node)
    if (node.kind !== 'file') return
    const request = ++previewRequest.current
    pendingPreview.current = request
    setPreviewPath(node.path)
    void workspace
      .open(
        { kind: 'project', project: project.id, path: node.path },
        'preview',
        node.name,
        undefined,
        undefined,
        { embedded: true, hostTabId: tabId }
      )
      .then((tabId) => {
        if (pendingPreview.current !== request) return
        expectedPreview.current = tabId
        setPreview(tabId)
        if (preview === tabId) {
          expectedPreview.current = null
          pendingPreview.current = null
        }
      })
      .catch((error) => {
        if (pendingPreview.current !== request) return
        pendingPreview.current = null
        expectedPreview.current = null
        setPreview(null)
        toast({
          title: t('explorerFailed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'error',
        })
      })
  }
  const startName = (action: NameAction, node: TreeNode | null): void => {
    if (namePending.current) return
    nameEditing.current = true
    setSelected(node)
    setName(action === 'rename' ? (node?.name ?? '') : '')
    setNameAction(action)
    setMenu(null)
    if (action !== 'rename') {
      const parent = targetDirectory(node)
      setCreationParent(parent)
      setRootExpanded(true)
      setSearchOpen(false)
      setExpanded((current) => {
        const next = new Set(current)
        const parts = parent.split('/').filter(Boolean)
        for (let index = 1; index <= parts.length; index += 1)
          next.add(parts.slice(0, index).join('/'))
        return next
      })
    }
  }
  const cancelCreation = (): void => {
    if (namePending.current) return
    nameEditing.current = false
    setNameAction(null)
  }
  const submitName = async (): Promise<void> => {
    if (!nameAction || !nameEditing.current || namePending.current) return
    const value = name.trim()
    const nameError = resourceNameError(value)
    if (nameError) {
      toast({ title: t('explorerFailed'), description: resourceText(nameError), tone: 'error' })
      return
    }
    const submitted =
      nameAction === 'create_document' && !value.toLowerCase().endsWith('.md')
        ? `${value}.md`
        : value
    const originalPath = selected?.path ?? ''
    if (nameAction === 'rename' && workspace.hasDirtyProjectPath(project.id, originalPath)) {
      toast({ title: t('explorerUnsaved'), tone: 'error' })
      return
    }
    namePending.current = true
    setBusy(true)
    const result = await mutateProjectNode(
      project.id,
      nameAction,
      nameAction === 'rename'
        ? { path: originalPath, name: submitted }
        : { parent: creationParent, name: submitted }
    )
    namePending.current = false
    setBusy(false)
    if (activeProject.current !== project.id) return
    if (!result.ok || !result.node) {
      toast({ title: t('explorerFailed'), description: result.error, tone: 'error' })
      return
    }
    nameEditing.current = false
    if (nameAction === 'rename') {
      const synced = await act.relocateProjectExplorerNode(
        originalPath,
        result.node.path,
        result.node.name
      )
      if (!synced) toast({ title: t('explorerContextSyncFailed'), tone: 'error' })
      if (previewPath === originalPath || previewPath?.startsWith(`${originalPath}/`))
        setPreviewPath(`${result.node.path}${previewPath.slice(originalPath.length)}`)
    } else setExpanded((current) => new Set([...current, creationParent]))
    setSelected({ ...result.node, available: true })
    setNameAction(null)
    setRevision((current) => current + 1)
    if (nameAction === 'create_document') choose({ ...result.node, available: true, count: null })
  }
  const move = async (source: string, destination: string): Promise<void> => {
    if (!source || parentPath(source) === destination) return
    if (workspace.hasDirtyProjectPath(project.id, source)) {
      toast({ title: t('explorerUnsaved'), tone: 'error' })
      return
    }
    const result = await mutateProjectNode(project.id, 'move', {
      path: source,
      targetDir: destination,
    })
    if (!result.ok || !result.node) {
      toast({
        title: result.error === 'name_exists' ? t('explorerRenameFirst') : t('explorerFailed'),
        description: result.error === 'name_exists' ? undefined : result.error,
        tone: 'error',
      })
      return
    }
    const synced = await act.relocateProjectExplorerNode(source, result.node.path, result.node.name)
    if (!synced) toast({ title: t('explorerContextSyncFailed'), tone: 'error' })
    if (previewPath === source || previewPath?.startsWith(`${source}/`))
      setPreviewPath(`${result.node.path}${previewPath.slice(source.length)}`)
    setSelected({ ...result.node, available: true })
    setExpanded((current) => new Set([...current, destination]))
    setRevision((current) => current + 1)
  }
  const importFiles = async (target: string): Promise<void> => {
    if (importPending.current || busy) return
    const picker = window.scholarseed?.pickImport
    if (!picker) {
      toast({ title: t('explorerPickerUnavailable'), tone: 'error' })
      return
    }
    importPending.current = true
    setBusy(true)
    try {
      const sources = await picker(IMPORT_PICKER_TARGET.FILE)
      if (!sources.length || activeProject.current !== project.id) return
      const result = await importProjectFiles(project.id, sources, target)
      if (activeProject.current !== project.id) return
      if (!result.ok) {
        toast({ title: t('explorerFailed'), description: result.error, tone: 'error' })
        return
      }
      setRootExpanded(true)
      setExpanded((current) => new Set([...current, target]))
      setRevision((current) => current + 1)
    } catch (error) {
      toast({
        title: t('explorerFailed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'error',
      })
    } finally {
      importPending.current = false
      setBusy(false)
    }
  }
  const copyPath = async (node: TreeNode, relative: boolean): Promise<void> => {
    const resolved = relative
      ? { ok: true, absolute: node.path || '.' }
      : node.path
        ? await resolveRevealTarget(node.path, project.id)
        : { ok: true, absolute: project.path }
    if (!resolved.ok || !resolved.absolute) {
      setPathFailure(node.path || project.path)
      return
    }
    const copied = await window.scholarseed?.writeClipboard(resolved.absolute)
    if (!copied?.ok) {
      setPathFailure(resolved.absolute)
      return
    }
    toast({ title: t('explorerCopied'), tone: 'success' })
  }
  const reveal = async (path: string): Promise<void> => {
    const resolved = path
      ? await resolveRevealTarget(path, project.id)
      : { ok: true, absolute: project.path }
    if (!resolved.ok || !resolved.absolute) {
      setPathFailure(path || project.path)
      return
    }
    const opened = await revealSystemPath(resolved.absolute)
    if (!opened.ok) setPathFailure(resolved.absolute)
  }
  const importArtifact = async (node: TreeNode): Promise<void> => {
    const listing = await fetchResourceTree(project.id)
    if (!listing) {
      toast({ title: t('explorerFailed'), tone: 'error' })
      return
    }
    const result = await mutateProjectNode(project.id, 'copy', {
      path: node.path,
      targetDir: listing.resourceRoot,
    })
    if (!result.ok) {
      toast({ title: t('explorerFailed'), description: result.error, tone: 'error' })
      return
    }
    await act.reloadResourceTree()
    toast({ title: t('explorerImportedToLibrary'), tone: 'success' })
  }
  const selectMenu = (node: TreeNode, x: number, y: number): void => {
    setSelected(node)
    setMenu({ node, x, y, mode: 'context' })
  }
  const menuNode = menu?.node ?? null
  const menuDirectory = targetDirectory(menuNode)
  const rememberOpenInTab = (value: boolean): void => {
    savedState.current = { ...savedState.current, openInTab: value }
    explorerStates.set(stateKey, savedState.current)
    setOpenInTab(value)
  }
  const openNewTab = (): void => {
    if (!preview || !tab) return
    workspace.setTabEmbedded(preview, false)
    act.activateTab(preview)
  }
  const creation: InlineCreation | undefined =
    nameAction && nameAction !== 'rename'
      ? {
          parent: creationParent,
          row: (
            <div
              className="flex h-[var(--vds-space-9)] min-w-0 shrink-0 items-center gap-[calc(var(--vds-space-1)+var(--vds-space-half))] rounded-[var(--vds-radius-4)] px-[var(--vds-space-1)]"
              data-testid="explorer-create-row"
            >
              <span className="w-[var(--vds-space-5)] shrink-0" />
              {nameAction === 'create_folder' ? (
                <Folder size={16} className="shrink-0" />
              ) : (
                <File size={16} className="shrink-0" />
              )}
              <Input
                key={`${nameAction}:${creationParent}`}
                data-testid="explorer-create-name"
                aria-label={t(
                  nameAction === 'create_folder' ? 'explorerNewFolder' : 'explorerNewMarkdown'
                )}
                size="sm"
                value={name}
                readOnly={busy}
                aria-busy={busy}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (!name.trim()) {
                    cancelCreation()
                    return
                  }
                  return submitName()
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    return submitName()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelCreation()
                  }
                }}
              />
            </div>
          ),
        }
      : undefined

  const tree = (
    <aside
      id="project-explorer-tree"
      className="flex h-full min-w-0 flex-col gap-[var(--vds-space-3)] bg-[var(--vds-bg-gray-default)] px-[var(--vds-space-3)] py-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-tertiary)]"
      data-testid="explorer-tree"
    >
      <header className="flex h-[var(--vds-space-7)] shrink-0 items-center gap-[var(--vds-space-1)] pl-[var(--vds-space-1)]">
        <span className="min-w-0 flex-1 font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]">
          {t('fileTree')}
        </span>
        {[
          {
            id: 'explorer-search',
            label: t('searchFiles'),
            icon: <FileSearch />,
            onClick: () => setSearchOpen((value) => !value),
          },
          {
            id: 'explorer-new-markdown',
            label: t('explorerNewMarkdown'),
            icon: <FilePlus2 />,
            onClick: () => startName('create_document', root),
          },
          {
            id: 'explorer-new-folder',
            label: t('explorerNewFolder'),
            icon: <FolderPlus />,
            onClick: () => startName('create_folder', root),
          },
          {
            id: 'explorer-import',
            label: t('explorerImport'),
            icon: <ArrowDownToLine strokeWidth={1.5} />,
            onClick: () => importFiles(root.path),
          },
          {
            id: 'explorer-refresh',
            label: t('explorerRefresh'),
            icon: <RotateCw />,
            onClick: () => setRevision((value) => value + 1),
          },
        ].map(({ id, label, icon, onClick }) => (
          <Tooltip key={id} content={label}>
            <IconButton
              variant="ghostIcon"
              size="sm"
              icon={icon}
              label={label}
              title=""
              ref={id === 'explorer-search' ? searchButtonRef : undefined}
              aria-expanded={id === 'explorer-search' ? searchOpen : undefined}
              aria-controls={id === 'explorer-search' ? 'explorer-search-input' : undefined}
              data-testid={id}
              onClick={onClick}
            />
          </Tooltip>
        ))}
      </header>
      {searchOpen && (
        <SearchBox
          id="explorer-search-input"
          data-testid="explorer-search-input"
          autoFocus
          value={searchQuery}
          placeholder={t('explorerFindFile')}
          aria-label={t('searchFiles')}
          containerClassName="shrink-0"
          onChange={(event) => setSearchQuery(event.target.value)}
          onBlur={(event) => {
            if (
              !event.currentTarget.value.trim() &&
              event.relatedTarget !== searchButtonRef.current
            ) {
              setSearchOpen(false)
              setSearchQuery('')
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSearchOpen(false)
              setSearchQuery('')
              searchButtonRef.current?.focus()
            }
          }}
        />
      )}
      <div
        className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-1)] overflow-auto"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const source = event.dataTransfer.getData('text/x-scholarseed-project-path')
          if (source) void move(source, '')
        }}
      >
        {searching && (
          <div
            className="flex min-w-0 flex-col gap-[var(--vds-space-1)]"
            data-testid="explorer-search-results"
            aria-busy={!currentSearch}
          >
            {!currentSearch ? (
              <Spinner size="sm" />
            ) : currentSearch.nodes === null ? (
              <Alert
                tone="error"
                title={t('readFailed')}
                action={
                  <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
                    {t('retry')}
                  </Button>
                }
              />
            ) : matches?.length === 0 ? (
              <span role="status" className="p-[var(--vds-space-2)]">
                {t('explorerNoFiles')}
              </span>
            ) : (
              matches?.map((node) => {
                const FileIcon = resourceFileIcon(node.name, node.kind)
                return (
                  <Button
                    key={node.path}
                    variant="ghost"
                    disabled={!node.available}
                    title={node.path}
                    data-testid={`explorer-search-result-${node.path}`}
                    className="!h-auto min-h-[var(--vds-space-9)] min-w-0 !justify-start !gap-[var(--vds-space-2)] !px-[var(--vds-space-2)] !text-left"
                    onClick={() => choose(node)}
                  >
                    <FileIcon className="shrink-0" size={16} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <EllipsisText>{node.name}</EllipsisText>
                      <EllipsisText className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                        {node.path}
                      </EllipsisText>
                    </span>
                  </Button>
                )
              })
            )}
          </div>
        )}
        <div className={searching ? 'hidden' : 'contents'}>
          <div
            className="flex h-[var(--vds-space-9)] shrink-0 items-center gap-[calc(var(--vds-space-1)+var(--vds-space-half))] rounded-[var(--vds-radius-4)] px-[var(--vds-space-1)] hover:bg-[var(--vds-bg-white-active)]"
            title={project.path}
            data-testid="explorer-root"
            onContextMenu={(event) => {
              event.preventDefault()
              selectMenu(root, event.clientX, event.clientY)
            }}
          >
            <IconButton
              variant="ghostIcon"
              size="xs"
              className="!size-[var(--vds-space-5)] !min-w-[var(--vds-space-5)] [--vds-icon-button-glyph:var(--vds-icon-8)]"
              icon={
                rootExpanded && loadingDirectories.has('') ? (
                  <Spinner size="sm" data-testid="explorer-directory-loading-/" />
                ) : rootExpanded ? (
                  <ChevronDown />
                ) : (
                  <ChevronRight />
                )
              }
              label={t(rootExpanded ? 'explorerCollapseFolder' : 'explorerExpandFolder', {
                name: project.name,
              })}
              aria-expanded={rootExpanded}
              aria-busy={rootExpanded && loadingDirectories.has('')}
              onClick={() => setRootExpanded((value) => !value)}
            />
            <Button
              variant="ghost"
              className="!h-[var(--vds-space-9)] min-w-0 flex-1 !justify-start !px-0 !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)] !text-[var(--vds-text-tertiary)] hover:![background:transparent]"
              onClick={() => setRootExpanded((value) => !value)}
            >
              {rootExpanded ? (
                <FolderOpen className="shrink-0" size={16} />
              ) : (
                <Folder className="shrink-0" size={16} />
              )}
              <EllipsisText>{project.name}</EllipsisText>
            </Button>
          </div>
          {rootExpanded && (
            <Directory
              project={project.id}
              path=""
              revision={revision}
              expanded={expanded}
              selected={breadcrumbPath}
              dragTarget={dragTarget}
              menuPath={menu?.mode === 'context' ? menu.node.path : null}
              creation={creation}
              onToggle={(path) =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })
              }
              onSelect={choose}
              onMenu={selectMenu}
              onDrop={(source, destination) => void move(source, destination)}
              onDragTarget={setDragTarget}
              onLoadingChange={updateLoading}
            />
          )}
        </div>
      </div>
    </aside>
  )
  const toolbar = (
    <header className="flex shrink-0 items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
      <Tooltip content={collapsed ? t('explorerExpandTree') : t('explorerHideTree')} side="bottom">
        <IconButton
          variant="ghostIcon"
          size="sm"
          icon={<FolderTree />}
          label={collapsed ? t('explorerExpandTree') : t('explorerHideTree')}
          className="aria-pressed:!bg-[var(--vds-explorer-tree-active-bg)]"
          title=""
          aria-expanded={!collapsed}
          aria-pressed={!collapsed}
          aria-controls="project-explorer-tree"
          data-testid="explorer-toggle-tree"
          onClick={() => setCollapsed((value) => !value)}
        />
      </Tooltip>
      <Breadcrumb
        ref={breadcrumbRef}
        className="relative min-w-0 flex-1 overflow-hidden"
        label={t('explorerPath')}
        title={breadcrumbPath || project.path}
      >
        <BreadcrumbList
          ref={breadcrumbMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 !w-max !flex-nowrap whitespace-nowrap"
        >
          {breadcrumbParts.map((part, index, parts) => (
            <BreadcrumbItem key={`${index}-${part}`} className="shrink-0">
              {index > 0 && <BreadcrumbSeparator className="!text-[var(--vds-text-placeholder)]" />}
              {index === parts.length - 1 ? (
                <BreadcrumbPage>{part}</BreadcrumbPage>
              ) : (
                <span className="text-[var(--vds-text-placeholder)]">{part}</span>
              )}
            </BreadcrumbItem>
          ))}
        </BreadcrumbList>
        <BreadcrumbList className="!flex-nowrap overflow-hidden whitespace-nowrap">
          {visibleBreadcrumbParts.map((part, index, parts) => (
            <BreadcrumbItem
              key={`${index}-${part}`}
              className={part === null || !breadcrumbOverflow ? 'shrink-0' : 'min-w-0 shrink'}
            >
              {index > 0 && (
                <BreadcrumbSeparator className="shrink-0 !text-[var(--vds-text-placeholder)]" />
              )}
              {part === null ? (
                <BreadcrumbEllipsis className="!text-[var(--vds-text-placeholder)]" />
              ) : index === parts.length - 1 ? (
                <BreadcrumbPage className="truncate">{part}</BreadcrumbPage>
              ) : (
                <span className="truncate text-[var(--vds-text-placeholder)]">{part}</span>
              )}
            </BreadcrumbItem>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div ref={setModeControlHost} className="flex shrink-0 items-center empty:hidden" />
      {tab && currentPath && (
        <div
          data-testid="explorer-open-control"
          className="inline-flex shrink-0 items-center gap-[var(--vds-space-half)] rounded-[var(--vds-radius-4)] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-white-default)] p-[calc(var(--vds-space-half)/2)]"
        >
          <IconButton
            variant="ghostIcon"
            size="sm"
            className="[--vds-icon-button-glyph:var(--vds-icon-7)]"
            icon={
              openInTab ? (
                <ExternalLink />
              ) : window.scholarseed?.platform === 'darwin' ? (
                <img className="block size-full" src={finderIcon} alt="" />
              ) : (
                <FolderOpen />
              )
            }
            label={openInTab ? t('explorerOpenInTab') : resourceText(revealLabelKey())}
            data-testid="explorer-open-primary"
            onClick={() => (openInTab ? openNewTab() : void reveal(currentPath))}
          />
          <span
            aria-hidden="true"
            className="h-[var(--vds-space-3)] border-l border-[var(--vds-border-default)]"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghostIcon"
                size="sm"
                className="[--vds-icon-button-glyph:var(--vds-icon-7)]"
                icon={<ChevronDown />}
                label={t('explorerOpenWith')}
                data-testid="explorer-open-menu"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="!w-[var(--vds-explorer-open-menu-width)] !min-w-0 rounded-[var(--vds-radius-6)] p-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] font-[number:var(--vds-fw-regular)] !shadow-[var(--vds-shadow-2-center)]"
            >
              <DropdownMenuItem
                role="menuitemradio"
                aria-checked={!openInTab}
                className="!h-[var(--vds-control-height-standard)] !py-[var(--vds-space-2)] aria-checked:!bg-[var(--vds-brand-light-bg-default)]"
                data-testid="explorer-reveal-file"
                onSelect={() => {
                  rememberOpenInTab(false)
                  void reveal(currentPath)
                }}
              >
                {window.scholarseed?.platform === 'darwin' ? (
                  <img className="size-[var(--vds-icon-8)] shrink-0" src={finderIcon} alt="" />
                ) : (
                  <FolderOpen />
                )}
                <span className="min-w-0 flex-1 whitespace-nowrap">
                  {resourceText(revealLabelKey())}
                </span>
                {!openInTab && (
                  <Check className="size-[var(--vds-icon-8)] shrink-0 text-[var(--vds-brand-text-primary)]" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                role="menuitemradio"
                aria-checked={openInTab}
                className="!h-[var(--vds-control-height-standard)] !py-[var(--vds-space-2)] aria-checked:!bg-[var(--vds-brand-light-bg-default)]"
                data-testid="explorer-open-tab"
                onSelect={() => {
                  rememberOpenInTab(true)
                  openNewTab()
                }}
              >
                <ExternalLink />
                <span className="min-w-0 flex-1 whitespace-nowrap">{t('explorerOpenInTab')}</span>
                {openInTab && (
                  <Check className="size-[var(--vds-icon-8)] shrink-0 text-[var(--vds-brand-text-primary)]" />
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  )
  const previewPane = (
    <div
      className="flex h-full min-w-0 flex-col bg-[var(--vds-bg-gray-default)] [&_:is(.vds-markdown-header,.vds-document-toolbar,.vds-image-toolbar,.vds-pdf-tools,[data-testid=source-document-toolbar])]:min-h-[calc(var(--vds-space-7)+var(--vds-space-4)*2)] [&_:is(.vds-markdown-header,.vds-document-toolbar,.vds-image-toolbar,.vds-pdf-tools,[data-testid=source-document-toolbar])]:py-[var(--vds-space-4)] [&_:is(.vds-markdown-header,.vds-document-toolbar,.vds-image-toolbar,.vds-pdf-tools,.vds-code-actions,[data-testid=source-document-toolbar])]:bg-[var(--vds-bg-gray-default)] [&_.vds-code-actions]:py-0"
      data-testid="explorer-preview"
    >
      <div className="vds-document-view-slot relative min-h-0 flex-1 [&>.vds-document-view:not(.is-viewer-toolbar)]:grid-rows-[auto_minmax(0,1fr)]">
        {tab ? (
          <DocumentView
            key={tab.id}
            tab={tab}
            active={active}
            showBreadcrumb={false}
            modeControlHost={modeControlHost}
          />
        ) : (
          <EmptyState
            className="h-full content-center"
            variant="panel"
            icon={<File />}
            title={t('openFile')}
            description={t('chooseTreeFile')}
          />
        )}
      </div>
    </div>
  )
  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      data-testid="project-explorer"
    >
      {toolbar}
      <div className="min-h-0 flex-1">
        <ResizablePanel
          leftPanel={tree}
          rightPanel={previewPane}
          leftWidth={width}
          minLeftWidth={EXPLORER_TREE_MIN_WIDTH}
          maxLeftWidth={650}
          onWidthChangeEnd={setWidth}
          isLeftCollapsed={collapsed}
          data-testid="explorer-resizable"
        />
      </div>
      <DropdownMenu
        open={Boolean(menu)}
        onOpenChange={(open) => {
          if (!open) setMenu(null)
        }}
      >
        <DropdownMenuContent
          position={menu ? { kind: 'point', x: menu.x, y: menu.y } : undefined}
          data-testid="explorer-menu"
        >
          {menuNode?.kind === 'dir' && (
            <>
              <DropdownMenuItem onSelect={() => startName('create_document', menuNode)}>
                <FilePlusCorner strokeWidth={1.5} />
                {t('explorerNewMarkdown')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => startName('create_folder', menuNode)}>
                <FolderPlus />
                {t('explorerNewFolder')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setMenu(null)
                  return importFiles(menuDirectory)
                }}
              >
                <ArrowDownToLine strokeWidth={1.5} />
                {t('explorerImport')}
              </DropdownMenuItem>
              {menu?.mode === 'context' && <DropdownMenuSeparator />}
            </>
          )}
          {menu?.mode === 'context' && menuNode?.kind === 'file' && (
            <DropdownMenuItem
              onSelect={() => {
                choose(menuNode as ProjectTreeNode)
                setMenu(null)
              }}
            >
              <File />
              {t('openFile')}
            </DropdownMenuItem>
          )}
          {menu?.mode === 'context' && menuNode?.artifact && (
            <DropdownMenuItem
              onSelect={() => {
                void importArtifact(menuNode)
                setMenu(null)
              }}
            >
              <ArrowDownToLine strokeWidth={1.5} />
              {t('explorerImportToLibrary')}
            </DropdownMenuItem>
          )}
          {menu?.mode === 'context' && menuNode && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  act.addAiContextRef({
                    kind: menuNode.kind,
                    sourceId: menuNode.path,
                    label: menuNode.name,
                  })
                  setMenu(null)
                }}
              >
                <MessageCirclePlus />
                {resourceText('menu.addToConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void reveal(menuNode.path)
                  setMenu(null)
                }}
              >
                <ExternalLink />
                {resourceText(revealLabelKey())}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void copyPath(menuNode, false)
                  setMenu(null)
                }}
              >
                <Link />
                {resourceText('menu.copyPath')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void copyPath(menuNode, true)
                  setMenu(null)
                }}
              >
                <Copy />
                {t('explorerCopyRelative')}
              </DropdownMenuItem>
              {menuNode.path && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => startName('rename', menuNode)}>
                    <Pencil />
                    {resourceText('menu.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    destructive
                    onSelect={() => {
                      act.confirmResourceDelete(menuNode)
                      setMenu(null)
                    }}
                  >
                    <Trash2 />
                    {resourceText('menu.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={nameAction === 'rename'}
        onOpenChange={(open) => {
          if (!open) setNameAction(null)
        }}
      >
        <DialogContent data-testid="explorer-name-dialog">
          <DialogHeader>
            <DialogTitle>{resourceText('menu.rename')}</DialogTitle>
            <DialogDescription>
              {t('explorerTarget', {
                path: parentPath(selected?.path ?? '') || project.name,
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            label={t('explorerName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitName()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNameAction(null)}>
              {t('explorerCancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={Boolean(resourceNameError(name))}
              onClick={() => void submitName()}
            >
              {t('explorerConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={pathFailure !== null}
        onOpenChange={(open) => {
          if (!open) setPathFailure(null)
        }}
      >
        <DialogContent data-testid="explorer-path-failure">
          <DialogHeader>
            <DialogTitle>{t('explorerPathFailed')}</DialogTitle>
            <DialogDescription>{t('explorerPathRetry')}</DialogDescription>
          </DialogHeader>
          <p className="select-text break-all text-[length:var(--vds-font-body-lv2)]">
            {pathFailure}
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPathFailure(null)}>
              {t('explorerCancel')}
            </Button>
            <Button
              onClick={() => {
                if (pathFailure)
                  void window.scholarseed?.writeClipboard(pathFailure).then((result) => {
                    if (result.ok) setPathFailure(null)
                  })
              }}
            >
              {t('explorerRetryCopy')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
