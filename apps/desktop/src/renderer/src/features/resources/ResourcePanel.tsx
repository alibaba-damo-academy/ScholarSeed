import { IconFont } from '../../components/primitive'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  EllipsisVertical,
  FilePlus,
  Folder,
  FolderOpen,
  FolderGit2,
  FolderPlus,
  FolderTree,
  ListCollapse,
  MonitorDown,
  RotateCw
} from 'lucide-react'

import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Textarea
} from '../../components/ui'
import emptyImage from '../../assets/empty_img.webp'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { VersionHistory } from '../workbench/feature'
import { useDocumentWorkspace } from '../workbench/workspace'
import { subscribeFileEvents } from '../project/events'
import {
  fetchVersionCapability,
  searchResources,
  type ResourceSearchHit
} from './api'
import {
  refreshesResourceTree,
  RESOURCE_DRAG_MIME,
  RESOURCE_ROOT_DIRECTORY,
  resourceDropDirectory,
  validateResourceMove
} from './lifecycle'
import { resourceFileIcon } from './icons'
import { ResourceStatus } from './Indicators'
import { loadFileVersionSettings } from './settings'
import { pendingChildCount, ResourceNode, type NameDraftState } from './state'

/** 搜索防抖间隔：边打字边搜会把后端打满，也让结果闪烁。 */
const SEARCH_DEBOUNCE_MS = 260

/** 资料树节点 test id 前缀，也是创建成功后滚动定位的稳定 DOM 契约。 */
const TREE_TEST_ID_PREFIX = 'tree-'

const RESOURCE_TREE_BASE_INDENT = 8
const RESOURCE_TREE_INDENT_STEP = 20

/** MVP 资料库暂不展示本地文件名/正文搜索入口，后续恢复时打开这个开关即可。 */
const RESOURCE_TREE_SEARCH_VISIBLE = false

const RESOURCE_MATCH_LABEL: Record<
  ResourceSearchHit['matched'],
  'panel.matchName' | 'panel.matchPath' | 'panel.matchContent'
> = {
  name: 'panel.matchName',
  path: 'panel.matchPath',
  content: 'panel.matchContent'
}

/** 就地输入框：回车提交、Esc 取消、失焦提交。新建与重命名共用。 */
function NameEditor({
  value,
  suffix,
  error,
  submitting,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  suffix?: string
  error?: NameDraftState['error']
  submitting?: boolean
  onChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation('resources')
  const ref = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  useEffect(() => {
    if (error) ref.current?.focus()
  }, [error])
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-[var(--vds-space-1)] [&>.vds-field]:min-w-0">
      <Input
        ref={ref}
        unstyled
        className="vds-tree-input"
        data-testid="resource-name-input"
        disabled={submitting}
        error={error ? t(error) : undefined}
        value={value}
        onChange={(event) => {
          cancelled.current = false
          onChange(event.target.value)
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelled.current = true
            onCancel()
          }
        }}
        onBlur={() => {
          if (!cancelled.current && !submitting) onCommit()
        }}
      />
      {suffix ? (
        <span
          aria-hidden="true"
          className="self-start leading-[24px] text-[var(--vds-text-secondary)]"
          data-testid="resource-name-suffix"
        >
          {suffix}
        </span>
      ) : null}
    </span>
  )
}

/** 资料树递归渲染。缩进按层级线性增加，与原型一致。 */
function TreeRow({
  node,
  depth,
  dragSource,
  dropTarget,
  setDragSource,
  setDropTarget
}: {
  node: ResourceNode
  depth: number
  dragSource: string | null
  dropTarget: string | null
  setDragSource: (path: string | null) => void
  setDropTarget: (path: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation('resources')
  const { state, set, act } = useApp()
  const resource = state.resource
  const expanded = resource.expanded[node.path] ?? false
  const selected = resource.selected === node.path
  const renaming =
    resource.nameDraft?.mode === 'rename' &&
    resource.nameDraft.target === node.path
  const creatingHere =
    node.kind === 'dir' &&
    resource.nameDraft !== null &&
    resource.nameDraft.mode !== 'rename' &&
    resource.nameDraft.target === node.path
  const linked = node.origin === 'link'
  const linkRoot = node.linkRoot?.mountPath === node.path
  const canDrag = !linkRoot
  const FileIcon = resourceFileIcon(node.name)
  const pending = pendingChildCount(node)
  const menuOpen = resource.nodeMenu?.path === node.path
  const [createOpen, setCreateOpen] = useState(false)

  const open = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (node.kind === 'dir') {
      // 展开可能要向后端续取更深的层级，所以交给 store 动作而不是本地翻标志。
      void act.toggleResourceDir(node.path)
      return
    }
    if (event.detail > 1) return
    act.openResourceFile(node.path)
  }

  return (
    <>
      <div
        className={`vds-tree-row ${typeof node.count === 'number' ? '' : '!pr-[var(--vds-space-1)]'} ${node.kind === 'dir' ? 'hover:!pr-[calc(var(--vds-control-height-sm)*2+var(--vds-space-1)*2.5)] focus-within:!pr-[calc(var(--vds-control-height-sm)*2+var(--vds-space-1)*2.5)] has-[[aria-pressed=true]]:!pr-[calc(var(--vds-control-height-sm)*2+var(--vds-space-1)*2.5)]' : 'hover:!pr-[calc(var(--vds-control-height-sm)+var(--vds-space-1)*2)] focus-within:!pr-[calc(var(--vds-control-height-sm)+var(--vds-space-1)*2)] has-[[aria-pressed=true]]:!pr-[calc(var(--vds-control-height-sm)+var(--vds-space-1)*2)]'}${selected ? ' is-selected' : ''}${linked ? ' is-linked' : ''}${dragSource === node.path ? ' opacity-50' : ''}${dropTarget === node.path && node.kind === 'dir' ? ' !bg-[var(--vds-accent-light-bg-default)] ring-2 ring-inset ring-[var(--vds-accent-light-border)]' : ''}${renaming && resource.nameDraft?.error ? ' !h-auto min-h-[26px] items-start py-1' : ''}`}
        style={{
          paddingLeft:
            RESOURCE_TREE_BASE_INDENT + depth * RESOURCE_TREE_INDENT_STEP
        }}
        data-testid={`tree-${node.path}`}
        draggable={canDrag && !renaming}
        onClick={open}
        onDragStart={(event) => {
          if (!canDrag) {
            event.preventDefault()
            return
          }
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(RESOURCE_DRAG_MIME, node.path)
          setDragSource(node.path)
          setDropTarget(null)
        }}
        onDragEnd={() => {
          setDragSource(null)
          setDropTarget(null)
        }}
        onDragOver={(event) => {
          const source =
            dragSource || event.dataTransfer.getData(RESOURCE_DRAG_MIME)
          const targetDir = resourceDropDirectory(
            resource.tree,
            node.path,
            node.kind
          )
          if (targetDir === null || !source) return
          event.preventDefault()
          event.stopPropagation()
          const validDrop = validateResourceMove(
            resource.tree,
            source,
            targetDir
          ).ok
          event.dataTransfer.dropEffect = validDrop ? 'move' : 'none'
          setDropTarget(validDrop ? targetDir : null)
        }}
        onDragLeave={(event) => {
          const targetDir = resourceDropDirectory(
            resource.tree,
            node.path,
            node.kind
          )
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            if (dropTarget === targetDir) setDropTarget(null)
          }
        }}
        onDrop={(event) => {
          const targetDir = resourceDropDirectory(
            resource.tree,
            node.path,
            node.kind
          )
          if (targetDir === null) return
          event.preventDefault()
          event.stopPropagation()
          const source =
            dragSource || event.dataTransfer.getData(RESOURCE_DRAG_MIME)
          setDragSource(null)
          setDropTarget(null)
          if (
            !source ||
            !validateResourceMove(resource.tree, source, targetDir).ok
          ) {
            act.noticeResource('error', { key: 'panel.invalidDrop' })
            return
          }
          void act.moveResourceNode(source, targetDir)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          act.openResourceMenu({
            path: node.path,
            name: node.name,
            kind: node.kind,
            origin: node.origin,
            linkRoot: node.linkRoot,
            x: event.clientX,
            y: event.clientY
          })
        }}
      >
        {node.kind === 'dir' ? (
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        ) : (
          <span className="vds-tree-spacer" />
        )}
        {node.kind === 'dir' && node.gitRepository ? (
          <span
            className="vds-tree-icon"
            data-testid={`tree-icon-${node.path}`}
            data-icon="folder-git"
            title={t('panel.gitRepository')}
          >
            <FolderGit2 />
          </span>
        ) : node.kind === 'dir' && !linkRoot ? (
          <span
            className="vds-tree-icon"
            data-testid={`tree-icon-${node.path}`}
            data-icon={expanded ? 'folder-open' : 'folder'}
          >
            {expanded ? <FolderOpen /> : <Folder />}
          </span>
        ) : linkRoot ? (
          <span
            className="vds-tree-icon"
            data-testid={`tree-icon-${node.path}`}
            data-icon="link"
          >
            <Icon name="link" size={16} />
          </span>
        ) : (
          <span
            className="vds-tree-icon"
            data-testid={`tree-icon-${node.path}`}
            data-icon="file"
          >
            <FileIcon />
          </span>
        )}
        {renaming ? (
          <NameEditor
            value={resource.nameDraft?.value ?? ''}
            suffix={resource.nameDraft?.suffix || undefined}
            error={resource.nameDraft?.error}
            submitting={resource.nameDraft?.submitting}
            onChange={act.setResourceNameDraft}
            onCommit={act.commitResourceNameDraft}
            onCancel={act.cancelResourceNameDraft}
          />
        ) : (
          <span
            className="vds-tree-name"
            title={
              linked ? t('panel.linkedName', { name: node.name }) : node.name
            }
          >
            {node.name}
          </span>
        )}
        {!renaming && node.gitRepository && (
          <Badge
            className="shrink-0"
            size="sm"
            tone="neutral"
            title={t('panel.gitRepository')}
            data-testid={`tree-git-${node.path}`}
          >
            {t('panel.gitLabel')}
          </Badge>
        )}
        {!renaming && node.gitRepository && linkRoot && (
          <Icon name="link" size={16} />
        )}
        {!renaming && typeof node.count === 'number' && (
          <span className="vds-tree-count">{node.count}</span>
        )}
        {!renaming && node.kind === 'file' && <ResourceStatus node={node} />}
        {node.kind === 'dir' && !renaming && (
          <DropdownMenu onOpenChange={setCreateOpen} open={createOpen}>
            <DropdownMenuTrigger asChild>
              <IconButton
                aria-pressed={createOpen}
                className="vds-tree-create"
                data-testid={`tree-create-${node.path}`}
                icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                label={t('panel.createIn', { name: node.name })}
                size="sm"
                type="button"
                variant="ghostIcon"
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              aria-label={t('panel.createIn', { name: node.name })}
              className="w-[188px]"
            >
              <DropdownMenuItem
                data-testid={`tree-import-${node.path}`}
                onSelect={() => {
                  set({
                    resource: {
                      ...resource,
                      importDialog: { phase: 'select', targetDir: node.path }
                    }
                  })
                }}
              >
                <MonitorDown />
                <span>{t('panel.importLocal')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`tree-new-doc-${node.path}`}
                onSelect={() => {
                  act.requestResourceCreate('create_document', node.path)
                }}
              >
                <FilePlus />
                <span>{t('panel.newDocument')}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid={`tree-new-folder-${node.path}`}
                onSelect={() => {
                  act.requestResourceCreate('create_folder', node.path)
                }}
              >
                <FolderPlus />
                <span>{t('panel.newFolder')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <IconButton
          aria-pressed={menuOpen}
          className={`vds-tree-more ${node.kind === 'file' ? '!right-[var(--vds-space-1)]' : '!right-[calc(var(--vds-space-1)+var(--vds-control-height-sm)+var(--vds-space-1)/2)]'}`}
          data-testid={`tree-more-${node.path}`}
          icon={<EllipsisVertical />}
          label={t('panel.more', { name: node.name })}
          size="sm"
          type="button"
          variant="ghostIcon"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            act.openResourceMenu({
              path: node.path,
              name: node.name,
              kind: node.kind,
              origin: node.origin,
              linkRoot: node.linkRoot,
              x: rect.right,
              y: rect.bottom,
              anchor: { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top, width: rect.width }
            })
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      </div>

      {/* 在该目录下新建时，就地显示一行输入框，位置即最终位置。 */}
      {creatingHere && (
        <div
          className={`vds-tree-row${resource.nameDraft?.error ? ' !h-auto min-h-[26px] items-start py-1' : ''}`}
          style={{
            paddingLeft:
              RESOURCE_TREE_BASE_INDENT +
              (depth + 1) * RESOURCE_TREE_INDENT_STEP
          }}
        >
          <span className="vds-tree-spacer" />
          <Icon
            name={
              resource.nameDraft?.mode === 'create_folder' ? 'folder' : 'doc'
            }
            size={13}
          />
          <NameEditor
            value={resource.nameDraft?.value ?? ''}
            suffix={resource.nameDraft?.suffix || undefined}
            error={resource.nameDraft?.error}
            submitting={resource.nameDraft?.submitting}
            onChange={act.setResourceNameDraft}
            onCommit={act.commitResourceNameDraft}
            onCancel={act.cancelResourceNameDraft}
          />
        </div>
      )}

      {node.kind === 'dir' &&
        expanded &&
        node.children?.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            dragSource={dragSource}
            dropTarget={dropTarget}
            setDragSource={setDragSource}
            setDropTarget={setDropTarget}
          />
        ))}

      {/* 这一层还有没取回来的条目：给一个继续取的入口，否则那些文件在界面上等于不存在。 */}
      {node.kind === 'dir' &&
        expanded &&
        pending > 0 &&
        (node.children?.length ?? 0) > 0 && (
          <LoadMoreRow
            depth={depth + 1}
            pending={pending}
            onClick={() => void act.loadMoreResourceChildren(node.path)}
          />
        )}
    </>
  )
}

/**
 * 「还有更多」行：省略号 + 右侧剩余条数。
 *
 * 条数放右侧徽标位（和其它树行的条目数同一个位置），而不是塞进行内文字或
 * `title`：侧栏窄，写全会被截成半句话；而原生 `title` 的显示延迟是系统级的，
 * 想知道还剩多少得等一秒——设计系统也因此禁止用 `title` 代替 Tooltip。
 */
function LoadMoreRow({
  depth,
  pending,
  onClick
}: {
  depth: number
  pending: number
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation('resources')
  return (
    <div
      className="vds-tree-row is-load-more"
      style={{
        paddingLeft:
          RESOURCE_TREE_BASE_INDENT + depth * RESOURCE_TREE_INDENT_STEP
      }}
      data-testid={`tree-load-more-${depth}`}
      role="button"
      tabIndex={0}
      aria-label={t('panel.loadMore', { count: pending })}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick()
      }}
    >
      <span className="vds-tree-spacer" />
      <span className="vds-tree-name">…</span>
      <span className="vds-tree-count">{pending}</span>
    </div>
  )
}

/**
 * 资料库侧栏（对齐原型截图）：
 * 标题行 + 全网搜索卡 + 资料搜索 + 导入本地文件 + 文件树。
 */
export function ResourcePanel(): React.JSX.Element {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, set, act } = useApp()
  const resource = state.resource
  const project = state.homeSelectedProjectId
  const [dragSource, setDragSource] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [discoveryOpen, setDiscoveryOpen] = useState(true)
  const [resourceActionsOpen, setResourceActionsOpen] = useState(false)
  const [migrationRequired, setMigrationRequired] = useState(false)
  const documents = useDocumentWorkspace()
  const historySession = Object.values(documents.sessions).find(
    (session) =>
      session.source.kind === 'project' &&
      session.source.project === resource.historyTarget?.project &&
      session.source.path === resource.historyTarget?.path
  )

  useEffect(() => {
    let active = true
    void loadFileVersionSettings().then((settings) => {
      if (active && settings) setMigrationRequired(settings.migration_required)
    })
    return () => {
      active = false
    }
  }, [project, resource.tree, state.accountSettingsPage])

  // 进入资料库、切项目、或树还没装过时，拉真实目录树。
  //
  // 也把 `loadState === 'idle'` 当作触发条件：只盯 `project` 的话，任何把
  // resource 切片重置回 INITIAL 的路径（截图场景、切到其它视图再回来）都会
  // 留下一棵空树且永不重拉，表现为「项目明明有文件却显示还没有资料」。
  useEffect(() => {
    if (resource.loadState === 'idle') {
      void act.reloadResourceTree()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.loadState])

  useEffect(() => {
    void act.reloadResourceTree()
    // 只关心项目切换；把 resource 整体入依赖会自激发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  // Agent 终态、归档重试与其他非 Content 写路径通过这个单调 revision
  // 宣告资源账本已经变化。只监听 Content 文件事件会停在终态前的 drift 快照，
  // 直到用户手动刷新；revision 必须真正消费，不能只在 store 里空转。
  useEffect(() => {
    if (state.resourceRevision > 0) void act.reloadResourceTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resourceRevision])

  // 访达/其他程序改了文件也要反映出来（PRD「本地文件同步」的反向一半）。
  // 只重取树、不做局部拼接：树本来就是磁盘的投影，局部合并会引入第二套真相；
  // 后端已经做了去抖归并与自写抑制，所以这里不会被自己的写入激活。
  useEffect(() => {
    // project 为 null 表示「当前项目」，后端按默认项目解析，这里传空串即可。
    return subscribeFileEvents(project ?? '', (event) => {
      // 仅资料库根（resources/）的事件才重取树；其余根为何被忽略见 refreshesResourceTree。
      if (!refreshesResourceTree(event)) return
      void (async () => {
        if (
          event.source === 'external' &&
          event.kind !== 'rescan' &&
          event.path
        ) {
          await fetchVersionCapability(project ?? '', event.path)
        }
        await act.reloadResourceTree()
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  // 资料搜索（PRD「资料搜索」）：防抖后打后端，空关键词回到树视图。
  useEffect(() => {
    const keyword = resource.filterText.trim()
    if (!keyword) {
      if (resource.searchHits !== null) {
        set((current) => ({
          resource: { ...current.resource, searchHits: null }
        }))
      }
      return
    }
    const timer = window.setTimeout(() => {
      void searchResources(keyword, project).then((hits) => {
        set((current) => ({
          resource: { ...current.resource, searchHits: hits ?? [] }
        }))
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.filterText, project])

  // 新建成功只定位树节点，不代替用户打开文档。
  useEffect(() => {
    if (!resource.selected) return
    const selector = `[data-testid="${CSS.escape(`${TREE_TEST_ID_PREFIX}${resource.selected}`)}"]`
    document
      .querySelector<HTMLElement>(selector)
      ?.scrollIntoView({ block: 'nearest' })
  }, [resource.selected, resource.tree])

  const searching = resource.searchHits !== null
  const hasExpandedDirs = Object.values(resource.expanded).some(Boolean)

  const rootNameEditor =
    resource.nameDraft !== null &&
    resource.nameDraft.mode !== 'rename' &&
    resource.nameDraft.target === '' ? (
      <div
        className={`vds-tree-row${resource.nameDraft.error ? ' !h-auto min-h-[26px] items-start py-1' : ''}`}
        style={{ paddingLeft: RESOURCE_TREE_BASE_INDENT }}
      >
        <span className="vds-tree-spacer" />
        <Icon
          name={resource.nameDraft.mode === 'create_folder' ? 'folder' : 'doc'}
          size={13}
        />
        <NameEditor
          value={resource.nameDraft.value}
          suffix={resource.nameDraft.suffix || undefined}
          error={resource.nameDraft.error}
          submitting={resource.nameDraft.submitting}
          onChange={act.setResourceNameDraft}
          onCommit={act.commitResourceNameDraft}
          onCancel={act.cancelResourceNameDraft}
        />
      </div>
    ) : null

  const treeBody = ((): React.JSX.Element => {
    if (searching) {
      const hits = resource.searchHits ?? []
      if (hits.length === 0) {
        return (
          <div className="vds-tree-empty">
            {t('panel.noMatches', { query: resource.filterText })}
          </div>
        )
      }
      return (
        <>
          {hits.map((hit) => (
            <div
              key={`${hit.path}:${hit.matched}`}
              className="vds-search-hit"
              data-testid={`hit-${hit.path}`}
              onClick={() => {
                if (hit.reveal) act.revealResourceFile(hit.path, hit.reveal)
                else act.openResourceFile(hit.path)
              }}
            >
              <div className="vds-search-hit-head">
                <Icon name="doc" size={12} />
                <span className="vds-search-hit-name">{hit.name}</span>
                <span className="vds-search-hit-kind">
                  {t(RESOURCE_MATCH_LABEL[hit.matched])}
                </span>
              </div>
              <div className="vds-search-hit-sub">
                {hit.snippet || hit.path}
              </div>
            </div>
          ))}
        </>
      )
    }
    if (resource.loadState === 'loading' && resource.tree.length === 0) {
      return <div className="vds-tree-empty">{t('panel.loading')}</div>
    }
    if (resource.loadState === 'error') {
      return <div className="vds-tree-empty">{t('panel.loadFailed')}</div>
    }
    if (resource.tree.length === 0) {
      if (rootNameEditor) return rootNameEditor
      // 空文件夹引导（PRD「空文件夹引导」）：给出可直接点的两条出路。
      return (
        <div
          className="flex flex-col items-center px-1 pb-4 pt-8 text-center"
          data-testid="resource-empty-guide"
        >
          <img
            alt=""
            aria-hidden="true"
            className="mb-3 h-[88px] w-[120px] object-contain"
            src={emptyImage}
          />
          <p className="m-0 text-[12px] font-normal leading-[18px] text-[var(--vds-text-secondary)]">
            {t('panel.empty')}
          </p>
          <Button
            className="mt-3"
            onClick={() =>
              set({
                resource: {
                  ...resource,
                  importDialog: { phase: 'select', targetDir: '' }
                }
              })
            }
            variant="outline"
          >
            {t('panel.import')}
          </Button>
        </div>
      )
    }
    return (
      <>
        {/* 根级新建：输入行落在树顶部。 */}
        {rootNameEditor}
        {resource.tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            dragSource={dragSource}
            dropTarget={dropTarget}
            setDragSource={setDragSource}
            setDropTarget={setDropTarget}
          />
        ))}
        {resource.rootTotal > resource.tree.length && (
          <LoadMoreRow
            depth={0}
            pending={resource.rootTotal - resource.tree.length}
            onClick={() => void act.loadMoreResourceChildren('')}
          />
        )}
      </>
    )
  })()

  return (
    <div
      className="vds-module-panel-body vds-resource-panel"
      data-testid="resource-panel" data-ob="resources"
    >
      <div className="vds-panel-head">
        <h2 className="m-0 px-1 font-['Source_Han_Serif_CN','Noto_Serif_SC','Noto_Serif_CJK_SC','Songti_SC',serif] text-[16px] font-semibold leading-[24px] tracking-normal text-[color-mix(in_srgb,var(--vds-text-8)_59%,var(--vds-text-9))] dark:text-[var(--vds-text-primary)]">
          {t('panel.title')}
        </h2>
      </div>

      <Collapsible
        className="mx-1 grid gap-2 border-0 bg-transparent p-0 shadow-none"
        data-ob="resource-discovery"
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
      >
        <CollapsibleTrigger asChild>
          <Button data-ob="resource-discovery-toggle"
            unstyled
            className="!min-h-0 !rounded-none !border-0 !bg-transparent !p-0 flex h-5 w-full items-center justify-between px-1 text-left font-['PingFang_SC'] text-[14px] font-normal leading-5 tracking-normal !text-[var(--vds-text-10)] shadow-none transition-colors hover:!bg-transparent hover:!text-[var(--vds-text-10)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-ring)]"
          >
            <span className="flex shrink-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-grid size-4 shrink-0 place-items-center text-[var(--vds-text-tertiary)] transition-transform duration-150 data-[state=closed]:-rotate-90"
                data-state={discoveryOpen ? 'open' : 'closed'}
              >
                <Icon name="chevron-down" size={16} />
              </span>
              <span className="font-normal">{t('panel.discover')}</span>
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-0 bg-transparent p-0 text-[var(--vds-text-secondary)] shadow-none">
          {/* 资料库只提供全网搜索；学术检索属于文献库。 */}
          <div className="flex h-[76px] max-h-[280px] self-stretch items-start gap-2 rounded-[12px] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-3 shadow-none">
            <Textarea
              unstyled
              className="min-h-0 flex-1 resize-none border-0 bg-transparent p-0 font-['PingFang_SC'] text-[14px] font-normal leading-5 text-[var(--vds-text-primary)] outline-none placeholder:font-['PingFang_SC'] placeholder:text-[14px] placeholder:font-normal placeholder:text-[var(--vds-text-5)]"
              placeholder={t('panel.searchWeb')}
              rows={2}
              value={resource.searchText}
              onChange={(event) =>
                set({
                  resource: { ...resource, searchText: event.target.value }
                })
              }
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter' ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return
                event.preventDefault()
                const query = resource.searchText.trim()
                if (query) act.startWebSearch(query)
              }}
            />
            <div className="flex h-full shrink-0 items-end">
              <Button
                aria-label={t('panel.startSearch')}
                className="!size-6 !min-h-0 !min-w-0 !p-0"
                icon={<ArrowRight size={14} strokeWidth={1.8} />}
                size="sm"
                data-testid="resource-ai-search-go"
                disabled={!resource.searchText.trim()}
                onClick={() => act.startWebSearch(resource.searchText)}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {RESOURCE_TREE_SEARCH_VISIBLE ? (
        <div className="vds-tree-search">
          <Icon name="search" size={12} />
          <Input
            unstyled
            type="search"
            placeholder={t('panel.searchFiles')}
            data-testid="resource-search"
            value={resource.filterText}
            onChange={(event) =>
              set({ resource: { ...resource, filterText: event.target.value } })
            }
          />
        </div>
      ) : null}

      {migrationRequired && (
        <Alert tone="warning" className="mx-2">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t('treeStatus.migration')}</span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="tree-confirm-policy"
              onClick={() => act.openSettings('files')}
            >
              {t('treeStatus.confirmSettings')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="vds-tree-head mb-3">
          <span className="flex items-center gap-2 font-['PingFang_SC'] text-[14px] font-normal leading-5 tracking-normal text-[var(--vds-text-10)]">
            <FolderTree
              className="text-[var(--vds-text-tertiary)]"
              size={16}
              strokeWidth={1.8}
            />
            {searching
              ? t('panel.results', {
                  count: (resource.searchHits ?? []).length
                })
              : t('panel.tree')}
          </span>
          <div className="vds-tree-actions">
            <IconButton
              variant="ghostIcon"
              size="sm"
              label={uiText('refresh')}
              title={uiText('refresh')}
              data-testid="resource-refresh"
              icon={<RotateCw size={14} strokeWidth={1.8} />}
              onClick={() => void act.reloadResourceTree()}
            />
            <IconButton
              variant="ghostIcon"
              size="sm"
              label={t('panel.collapseAll')}
              title={t('panel.collapseAll')}
              data-testid="resource-collapse-all"
              // 没有展开的目录时点了也没反应，禁用比无声无息更诚实。
              disabled={!hasExpandedDirs}
              icon={<ListCollapse size={13} strokeWidth={1.8} />}
              onClick={act.collapseAllResourceDirs}
            />
            <DropdownMenu
              open={resourceActionsOpen}
              onOpenChange={setResourceActionsOpen}
            >
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="ghostIcon"
                  size="sm"
                  label={t('panel.create')}
                  title={t('panel.create')}
                  aria-pressed={resourceActionsOpen}
                  data-testid="resource-add"
                  icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                aria-label={t('panel.actions')}
                className="w-[188px]"
              >
                <DropdownMenuItem
                  data-testid="resource-import"
                  onSelect={() => {
                    set({
                      resource: {
                        ...resource,
                        importDialog: { phase: 'select', targetDir: '' }
                      }
                    })
                  }}
                >
                  <MonitorDown />
                  <span>{t('panel.importLocal')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="resource-new-doc"
                  onSelect={() => {
                    act.requestResourceCreate('create_document', '')
                  }}
                >
                  <FilePlus />
                  <span>{t('panel.newDocument')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="resource-new-folder"
                  onSelect={() => {
                    act.requestResourceCreate('create_folder', '')
                  }}
                >
                  <FolderPlus />
                  <span>{t('panel.newFolder')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          className={`vds-tree${dropTarget === RESOURCE_ROOT_DIRECTORY ? " relative after:pointer-events-none after:absolute after:inset-0 after:z-[var(--vds-z-content)] after:rounded-[var(--vds-radius-4)] after:ring-2 after:ring-inset after:ring-[var(--vds-accent-light-border)] after:content-['']" : ''}`}
          data-drop-active={
            dropTarget === RESOURCE_ROOT_DIRECTORY ? 'true' : 'false'
          }
          data-testid="resource-tree-root"
          onDragOver={(event) => {
            const source =
              dragSource || event.dataTransfer.getData(RESOURCE_DRAG_MIME)
            if (!source) return
            event.preventDefault()
            const validDrop = validateResourceMove(
              resource.tree,
              source,
              RESOURCE_ROOT_DIRECTORY
            ).ok
            event.dataTransfer.dropEffect = validDrop ? 'move' : 'none'
            setDropTarget(validDrop ? RESOURCE_ROOT_DIRECTORY : null)
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              if (dropTarget === RESOURCE_ROOT_DIRECTORY) setDropTarget(null)
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            const source =
              dragSource || event.dataTransfer.getData(RESOURCE_DRAG_MIME)
            setDragSource(null)
            setDropTarget(null)
            if (
              !source ||
              !validateResourceMove(
                resource.tree,
                source,
                RESOURCE_ROOT_DIRECTORY
              ).ok
            ) {
              act.noticeResource('error', { key: 'panel.invalidDrop' })
              return
            }
            void act.moveResourceNode(source, RESOURCE_ROOT_DIRECTORY)
          }}
        >
          {treeBody}
        </div>
      </div>
      {resource.historyTarget?.project === state.homeSelectedProjectId && (
        <VersionHistory
          session={historySession}
          file={resource.historyTarget}
          open={true}
          onOpenChange={(open) => {
            if (!open) act.closeResourceHistory()
          }}
        />
      )}
    </div>
  )
}
