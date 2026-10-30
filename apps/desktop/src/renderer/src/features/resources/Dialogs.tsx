import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'

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
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui'
import { useApp } from '../../store'
import { systemTrashKey } from '../../trash'
import { hasDirtyProjectPath, useDocumentWorkspace } from '../workbench/workspace'
import { validateResourceMove } from './lifecycle'
import { RESOURCE_CREATE_NAME_LIMIT, type ResourceNode } from './state'

/** 绝对路径没有单词边界，必须允许在任意字符处折行，否则会顶穿弹窗宽度。 */
const PATH_TEXT_CLASS_NAME = '[overflow-wrap:anywhere]'

export function CreateDialog(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, act } = useApp()
  const draft = state.resource.nameDraft
  const input = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const creating = draft !== null && draft.mode !== 'rename'
  useEffect(() => {
    if (creating) input.current?.select()
  }, [creating, draft?.mode, draft?.target])
  useEffect(() => {
    if (creating && draft?.error) input.current?.focus()
  }, [creating, draft?.error])
  if (!creating || !draft) return null
  const folder = draft.mode === 'create_folder'
  const label = folder ? t('creation.folderName') : t('creation.documentName')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !draft.submitting) act.cancelResourceNameDraft()
      }}
    >
      <DialogContent
        data-testid="resource-create-dialog"
        aria-label={folder ? t('panel.newFolder') : t('panel.newDocument')}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{folder ? t('panel.newFolder') : t('panel.newDocument')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-[var(--vds-space-2)]">
          <Label htmlFor={inputId}>
            {label}
            <span
              aria-hidden="true"
              className="ml-[var(--vds-space-1)] text-[var(--vds-error-text-primary)]"
            >
              *
            </span>
          </Label>
          <div className="flex items-start gap-[var(--vds-space-2)]">
            <div className="relative min-w-0 flex-1">
              <Input
                id={inputId}
                ref={input}
                required
                size="standard"
                maxLength={RESOURCE_CREATE_NAME_LIMIT}
                className="pr-[var(--vds-space-12)]"
                data-testid="resource-name-input"
                value={draft.value}
                placeholder={
                  folder ? t('creation.folderPlaceholder') : t('creation.documentPlaceholder')
                }
                disabled={draft.submitting}
                error={draft.error ? t(draft.error) : undefined}
                onChange={(event) => act.setResourceNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    act.commitResourceNameDraft()
                  }
                }}
              />
              <span
                aria-hidden="true"
                data-testid="resource-name-count"
                className="pointer-events-none absolute right-[var(--vds-space-3)] top-0 flex h-[var(--vds-control-height-standard)] items-center text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]"
              >
                {draft.value.length}/{RESOURCE_CREATE_NAME_LIMIT}
              </span>
            </div>
            {draft.suffix && (
              <span
                data-testid="resource-name-suffix"
                className="flex h-[var(--vds-control-height-standard)] items-center text-[var(--vds-text-secondary)]"
              >
                {draft.suffix}
              </span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={draft.submitting}
            onClick={act.cancelResourceNameDraft}
          >
            {uiText('cancel')}
          </Button>
          <Button
            disabled={draft.submitting || !draft.value.trim()}
            loading={draft.submitting}
            onClick={() => act.commitResourceNameDraft()}
          >
            {uiText('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 关联目录内新建会修改外部源目录，执行前必须取得用户明确确认。 */
export function LinkedCreateConfirm(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, act } = useApp()
  const pending = state.resource.linkedCreateConfirm
  if (!pending) return null

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) act.cancelLinkedResourceCreate()
      }}
    >
      <AlertDialogContent
        aria-label={t('linkedCreate.label')}
        data-testid="resource-linked-create-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('linkedCreate.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            <Trans
              ns="resources"
              i18nKey="linkedCreate.description"
              values={{ name: pending.directoryName }}
              components={{ name: <strong /> }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Alert tone="warning">
          <AlertDescription truncate={false}>
            {pending.mode === 'create_folder'
              ? t('linkedCreate.folderWarning')
              : t('linkedCreate.documentWarning')}
          </AlertDescription>
        </Alert>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="resource-linked-create-cancel"
            onClick={act.cancelLinkedResourceCreate}
          >
            {uiText('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="resource-linked-create-continue"
            onClick={act.confirmLinkedResourceCreate}
          >
            {t('linkedCreate.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * 删除确认（PRD「删除」：删除前明确提示该操作会同步影响本地文件）。
 *
 * 文案明确说明走系统废纸篓 —— 用户需要知道这不是永久删除，可以恢复。
 */
export function DeleteConfirm(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const trash = uiText(systemTrashKey())
  const { state, act } = useApp()
  const documents = useDocumentWorkspace()
  const target = state.resource.deleteConfirm
  if (!target) return null
  const hasUnsavedChanges = hasDirtyProjectPath(
    Object.values(documents.sessions),
    state.homeSelectedProjectId,
    target.path
  )

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) act.cancelResourceDelete()
      }}
    >
      <AlertDialogContent data-testid="resource-delete-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target.kind === 'dir' ? t('delete.folderTitle') : t('delete.fileTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target.kind === 'dir' ? (
              <Trans
                ns="resources"
                i18nKey="delete.folderDescription"
                values={{ name: target.name }}
                components={{ name: <strong /> }}
              />
            ) : (
              <Trans
                ns="resources"
                i18nKey="delete.fileDescription"
                values={{ name: target.name }}
                components={{ name: <strong /> }}
              />
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Alert tone="warning">
          <AlertDescription truncate={false}>
            {hasUnsavedChanges
              ? t('delete.unsavedWarning', { trash })
              : t('delete.warning', { trash })}
          </AlertDescription>
        </Alert>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="resource-delete-cancel"
            onClick={act.cancelResourceDelete}
          >
            {uiText('cancel')}
          </AlertDialogCancel>
          <Button
            variant="danger"
            data-testid="resource-delete-go"
            onClick={() => void act.deleteResourceNode()}
          >
            {t('delete.action', { trash })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 取消关联只撤销挂载与授权，绝不删除或移动外部源文件。 */
export function UnlinkConfirm(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, act } = useApp()
  const target = state.resource.unlinkConfirm
  if (!target) return null

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) act.cancelResourceUnlink()
      }}
    >
      <AlertDialogContent data-testid="resource-unlink-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('unlink.title', { name: target.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            <Trans
              ns="resources"
              i18nKey="unlink.description"
              values={{ path: target.mountPath }}
              components={{ path: <span className={PATH_TEXT_CLASS_NAME} /> }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Alert tone="warning">
          <AlertDescription truncate={false}>
            <Trans
              ns="resources"
              i18nKey="unlink.warning"
              values={{ path: target.sourcePath }}
              components={{ path: <span className={PATH_TEXT_CLASS_NAME} /> }}
            />
          </AlertDescription>
        </Alert>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={act.cancelResourceUnlink}>
            {uiText('cancel')}
          </AlertDialogCancel>
          <Button
            variant="danger"
            data-testid="resource-unlink-go"
            onClick={() => void act.unlinkResourceRoot()}
          >
            {t('menu.unlink')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * 反方向关联 (先子后父) 的选择弹窗。
 *
 * 后端对「新源是已生效子关联的父目录」回 `source_covers_links` 而非硬拒绝; 这里把
 * 选择交给用户: 取代子关联并挂载父目录 (原子撤销子关联, **不删除源文件**), 或不挂载、
 * 直接打开已有子关联。取消则什么都不做。被覆盖的子关联凭已加载的关联根推出。
 */
export function LinkSupersedeConfirm(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, act } = useApp()
  const pending = state.resource.linkSupersedeConfirm
  if (!pending) return null

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) act.cancelLinkSupersede()
      }}
    >
      <AlertDialogContent
        aria-label={t('linkSupersede.label')}
        data-testid="resource-link-supersede-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('linkSupersede.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('linkSupersede.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div
          className="mt-[var(--vds-resource-dialog-content-margin-top)] rounded-[var(--vds-resource-dialog-content-radius)] border border-[var(--vds-border-default)] p-[var(--vds-resource-dialog-content-padding)]"
          data-testid="resource-link-supersede-covered-box"
        >
          <div className="text-[length:var(--vds-resource-dialog-title-font-size)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
            {t('linkSupersede.coveredLabel', { count: pending.covered.length })}
          </div>
          <ul
            className="mt-[var(--vds-resource-dialog-list-margin-top)] list-disc pl-[var(--vds-resource-dialog-list-padding-inline-start)] text-[length:var(--vds-resource-dialog-list-font-size)] text-[var(--vds-text-secondary)]"
            data-testid="resource-link-supersede-covered"
          >
            {pending.covered.map((child) => (
              <li className="break-all" key={child.rootId}>
                {child.name}
              </li>
            ))}
          </ul>
        </div>
        <Alert tone="warning">
          <AlertDescription truncate={false}>{t('linkSupersede.warning')}</AlertDescription>
        </Alert>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="resource-link-supersede-cancel"
            onClick={act.cancelLinkSupersede}
          >
            {uiText('cancel')}
          </AlertDialogCancel>
          <Button
            data-testid="resource-link-supersede-open"
            variant="outline"
            onClick={() => void act.openCoveredLinkAndCancel()}
          >
            {t('linkSupersede.openExistingAction')}
          </Button>
          <Button
            data-testid="resource-link-supersede-go"
            variant="danger"
            onClick={() => void act.confirmLinkSupersede()}
          >
            {t('linkSupersede.mountAction')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 把资料树摊平成可选的目录列表，供移动目标选择。 */
function flattenDirs(nodes: ResourceNode[], depth = 0): { path: string; label: string }[] {
  const rows: { path: string; label: string }[] = []
  for (const node of nodes) {
    if (node.kind !== 'dir') continue
    rows.push({ path: node.path, label: `${'　'.repeat(depth)}${node.name}` })
    if (node.children?.length) rows.push(...flattenDirs(node.children, depth + 1))
  }
  return rows
}

/**
 * 移动资料（PRD「移动资料」）。
 *
 * 拖拽是树内主入口；目标选择器保留为键盘操作与深层目录的等价入口。
 */
export function MoveDialog(): React.JSX.Element | null {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, act } = useApp()
  const dialog = state.resource.moveDialog
  const [target, setTarget] = useState('')

  useEffect(() => setTarget(''), [dialog?.path])

  const options = useMemo(() => {
    if (!dialog) return []
    return flattenDirs(state.resource.tree).filter(
      (row) => validateResourceMove(state.resource.tree, dialog.path, row.path).ok
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog?.path, state.resource.tree])

  useEffect(() => {
    if (!dialog) return
    const rootAllowed = validateResourceMove(state.resource.tree, dialog.path, '').ok
    if (!rootAllowed && !options.some((option) => option.path === target)) {
      setTarget(options[0]?.path ?? '')
    }
  }, [dialog, options, state.resource.tree, target])

  if (!dialog) return null

  const rootAllowed = validateResourceMove(state.resource.tree, dialog.path, '').ok

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) act.closeResourceMoveDialog()
      }}
    >
      <DialogContent data-testid="resource-move-dialog">
        <DialogHeader>
          <DialogTitle>{t('move.title', { name: dialog.name })}</DialogTitle>
          <DialogDescription>{t('move.description')}</DialogDescription>
        </DialogHeader>
        <Select
          id="vds-move-target"
          label={t('move.target')}
          data-testid="resource-move-target"
          value={target}
          onValueChange={setTarget}
        >
          <SelectTrigger className="w-full" data-testid="resource-move-target-trigger">
            <SelectValue placeholder={t('move.empty')}>
              {target === '' && rootAllowed
                ? t('move.root')
                : options.find((row) => row.path === target)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {rootAllowed || options.length ? (
              <>
                {rootAllowed ? <SelectItem value="">{t('move.root')}</SelectItem> : null}
                {options.map((row) => (
                  <SelectItem key={row.path} value={row.path}>
                    {row.label}
                  </SelectItem>
                ))}
              </>
            ) : (
              <EmptyState
                variant="compact"
                icon={<FolderOpen />}
                data-testid="resource-move-target-empty"
                title={t('move.empty')}
              />
            )}
          </SelectContent>
        </Select>
        <Alert tone="warning">
          <AlertDescription truncate={false}>{t('move.warning')}</AlertDescription>
        </Alert>
        <DialogFooter>
          <DialogClose onClick={act.closeResourceMoveDialog}>{uiText('cancel')}</DialogClose>
          <Button
            data-testid="resource-move-go"
            disabled={!validateResourceMove(state.resource.tree, dialog.path, target).ok}
            onClick={() => void act.moveResourceNode(dialog.path, target)}
          >
            {t('move.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
