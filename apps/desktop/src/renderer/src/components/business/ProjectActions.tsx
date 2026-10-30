import React from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Folder, MoreHorizontal, MoreVertical, Pencil, Pin, PinOff } from 'lucide-react'

import type { Project } from '../../api'
import { listProjects, revealSystemPath } from '../../api'
import { PROJECT_NAME_MAX } from '../../contracts/content'
import { renameProject, setProjectArchived } from '../../features/project/api'
import { useApp } from '../../store'
import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  useToast,
} from '../ui'

/**
 * 项目管理操作（重命名 / 在访达中显示 / 归档）的唯一实现。
 *
 * 左上角项目下拉与首页项目卡片共用同一份菜单、文案、图标与弹窗，避免两个
 * 表面各写一份后校验规则或确认流程分叉。弹窗挂在全局宿主
 * （`ProjectManageDialogs`），因此从工作台里的下拉发起也能完成重命名与归档。
 */

/** 「在访达中显示」按平台换文案：macOS 是访达，Windows 是资源管理器。 */
const REVEAL_LABEL_KEYS = {
  darwin: 'home.menu.revealDarwin',
  win32: 'home.menu.revealWin32',
} as const
const REVEAL_LABEL_FALLBACK_KEY = 'home.menu.revealFallback'

export type ProjectRevealLabelKey =
  (typeof REVEAL_LABEL_KEYS)[keyof typeof REVEAL_LABEL_KEYS] | typeof REVEAL_LABEL_FALLBACK_KEY

export function projectRevealLabelKey(): ProjectRevealLabelKey {
  const platform = window.scholarseed?.platform
  return REVEAL_LABEL_KEYS[platform as keyof typeof REVEAL_LABEL_KEYS] ?? REVEAL_LABEL_FALLBACK_KEY
}

/** 后端错误码 → 用户能看懂的提示。按码分支不按文案。 */
const PROJECT_ERROR_KEYS = {
  name_required: 'errors.name_required',
  name_too_long: 'errors.name_too_long',
  unknown_project: 'errors.unknown_project',
  cannot_archive_current_project: 'errors.cannot_archive_current_project',
} as const

/**
 * 单个项目的「…」管理菜单。触发器形态由调用方定（行内悬浮 / 卡片右上角），
 * 菜单本体与三个操作在这里唯一持有。`onAction` 让外层浮层在选择后收起来。
 *
 * 侧向展开时菜单顶边对齐自己的触发器行，归属由调用方行的选中态高亮表达
 * （触发器 `aria-expanded` 驱动），不做面板级收容——收容会把菜单推到别的
 * 行旁边，多项目时反而看不出操作对象。
 */
export function ProjectActionsMenu({
  project,
  idPrefix,
  triggerClassName,
  triggerTestId,
  triggerOrientation = 'horizontal',
  side = 'bottom',
  horizontalAnchorRef,
  sideOffset,
  onAction,
}: {
  project: Project
  idPrefix: string
  triggerClassName: string
  triggerTestId: string
  triggerOrientation?: 'horizontal' | 'vertical'
  side?: 'bottom' | 'right'
  horizontalAnchorRef?: React.RefObject<HTMLElement | null>
  sideOffset?: number | `--${string}`
  onAction?: () => void
}): React.JSX.Element {
  const { set } = useApp()
  const { t: layoutText } = useTranslation('layout')
  const { t } = useTranslation('components')
  const { t: projectText } = useTranslation('project')
  const { toast } = useToast()
  const label = t('home.menu.label', { name: project.name })

  const reveal = async (): Promise<void> => {
    const result = await revealSystemPath(project.path)
    if (!result.ok) {
      toast({
        title: projectText('errors.reveal_unavailable', { path: project.path }),
        tone: 'error',
      })
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          className={triggerClassName}
          data-testid={triggerTestId}
          icon={
            triggerOrientation === 'vertical' ? (
              <MoreVertical size={16} strokeWidth={1.6} />
            ) : (
              <MoreHorizontal size={16} strokeWidth={1.6} />
            )
          }
          label={label}
          size="sm"
          variant="ghostIcon"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        horizontalAnchorRef={horizontalAnchorRef}
        side={side}
        sideOffset={sideOffset}
      >
        <DropdownMenuItem
          data-testid={`${idPrefix}pin-${project.id}`}
          onSelect={() => {
            onAction?.()
            void renameProject(project.id, project.name, { pinned: !project.pinned }).then(
              async (result) => {
                if (!result.ok) {
                  toast({ title: layoutText('saveFailed'), tone: 'error' })
                  return
                }
                const listing = await listProjects()
                if (listing) set({ projects: listing.projects })
              }
            )
          }}
        >
          {project.pinned ? <PinOff /> : <Pin />}
          {layoutText(project.pinned ? 'unpin' : 'pin')}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`${idPrefix}rename-${project.id}`}
          onSelect={() => {
            onAction?.()
            set({ projectForm: { mode: 'edit', project } })
          }}
        >
          <Pencil size={14} strokeWidth={1.6} />
          {layoutText('editProject')}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`${idPrefix}reveal-${project.id}`}
          onSelect={() => {
            onAction?.()
            void reveal()
          }}
        >
          <Folder size={14} strokeWidth={1.6} />
          {t(projectRevealLabelKey())}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={`${idPrefix}archive-${project.id}`}
          onSelect={() => {
            onAction?.()
            set({ projectArchive: { id: project.id, name: project.name } })
          }}
        >
          <Archive size={14} strokeWidth={1.6} />
          {t('home.menu.archive')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 重命名 / 归档弹窗的全局宿主（App 挂载）。
 *
 * 目标来自 store（`projectRename` / `projectArchive`），任意表面都能发起；
 * 成功后回写全局项目列表，首页卡片、下拉与顶栏标题随之同步。
 */
export function ProjectManageDialogs(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('components')
  const { t: projectText } = useTranslation('project')
  const { toast } = useToast()
  const [renameDraft, setRenameDraft] = React.useState('')
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const [renameBusy, setRenameBusy] = React.useState(false)
  const [archiveBusy, setArchiveBusy] = React.useState(false)
  const archivePending = React.useRef(false)

  const renameTarget = state.projectRename
  const archiveTarget = state.projectArchive

  React.useEffect(() => {
    if (!renameTarget) return
    setRenameDraft(renameTarget.name)
    setRenameError(null)
  }, [renameTarget])

  const projectErrorText = React.useCallback(
    (code: string): string =>
      Object.prototype.hasOwnProperty.call(PROJECT_ERROR_KEYS, code)
        ? projectText(PROJECT_ERROR_KEYS[code as keyof typeof PROJECT_ERROR_KEYS], {
            max: PROJECT_NAME_MAX,
          })
        : projectText('notices.unknown', { code }),
    [projectText]
  )

  const refreshProjects = React.useCallback(async (): Promise<void> => {
    const listing = await listProjects()
    if (listing) {
      set({
        projects: listing.projects,
        defaultWorkspacePath: listing.default || state.defaultWorkspacePath,
      })
    }
  }, [set, state.defaultWorkspacePath])

  const submitRename = async (): Promise<void> => {
    if (!renameTarget) return
    const name = renameDraft.trim()
    if (!name) {
      setRenameError('name_required')
      return
    }
    setRenameBusy(true)
    const result = await renameProject(renameTarget.id, name)
    setRenameBusy(false)
    if (!result.ok) {
      setRenameError(result.error ?? 'unknown_project')
      return
    }
    set({ projectRename: null })
    toast({ title: projectText('notices.renamed'), tone: 'success' })
    await refreshProjects()
  }

  const archiveProject = async (): Promise<void> => {
    if (!archiveTarget || archivePending.current) return
    const archivedProjectId = archiveTarget.id
    const wasCurrentProject = state.homeSelectedProjectId === archivedProjectId
    archivePending.current = true
    setArchiveBusy(true)
    try {
      const result = await setProjectArchived(archivedProjectId, true)
      if (!result.ok) {
        toast({
          title: projectErrorText(result.error ?? 'unknown_project'),
          tone: 'error',
        })
        return
      }
      set({ projectArchive: null })
      toast({ title: projectText('notices.archived'), tone: 'success' })
      await refreshProjects()
      // 归档后项目从默认列表消失，继续停留在它的工作台会指向一个不可选中的项目。
      if (wasCurrentProject) act.openWorkbenchView('home')
    } finally {
      archivePending.current = false
      setArchiveBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) set({ projectRename: null })
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('home.rename.title')}</DialogTitle>
            <DialogDescription>{t('home.rename.description')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            className="vds-input"
            data-testid="home-rename-input"
            maxLength={PROJECT_NAME_MAX}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename()
              if (event.key === 'Escape' && !renameBusy) {
                set({ projectRename: null })
              }
            }}
          />
          {renameError ? <Alert tone="error" title={projectErrorText(renameError)} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => set({ projectRename: null })}>
              {t('home.rename.cancel')}
            </Button>
            <Button
              data-testid="home-rename-submit"
              disabled={renameBusy}
              onClick={() => void submitRename()}
            >
              {t('home.rename.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open && !archivePending.current) set({ projectArchive: null })
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {projectText('archive.title', {
                  name: archiveTarget?.name ?? '',
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>{projectText('archive.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={archiveBusy}>
                {projectText('archive.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="home-archive-confirm"
                disabled={archiveBusy}
                onClick={(event) => {
                  event.preventDefault()
                  void archiveProject()
                }}
              >
                {projectText('archive.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </>
  )
}
