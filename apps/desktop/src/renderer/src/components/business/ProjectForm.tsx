import React from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { createManagedProject, Project, removeProject, renameProject } from '../../api'
import { PROJECT_NAME_MAX } from '../../contracts/content'
import { Icon } from '../../icons'
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
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormControl,
  FormField,
  FormLabel,
  FormMessage,
  Input,
  Label
} from '../ui'

// ProjectForm.tsx — 新建 / 编辑项目弹窗 (PRD 2.1.8)。
//   新建：只填项目显示名（必填）→ 创建。后端在工作区容器根下生成 MANAGED 目录，
//         用户不再选择本机文件夹（proposal 47 §4：容器根是项目的家，不是项目本身）。
//   编辑：可改显示名 + 只读源文件夹 + 「本版本一个项目只能挂靠一个文件夹」 → 移除项目 / 保存
//
// 「移除项目」只把项目从书深摘掉，**不动本机文件**；这一点必须在 UI 上写明，否则用户会
// 以为点下去连论文一起删了。

const OVERLAY_CLASS_NAME = 'project-form-scrim'
const CONFIRM_OVERLAY_CLASS_NAME = 'project-form-scrim z-[var(--vds-z-dialog-nested-overlay)]'
const DIALOG_CLASS_NAME = 'project-form-dialog w-[min(520px,calc(100vw-48px))]'
const CONFIRM_DIALOG_CLASS_NAME = 'project-form-dialog z-[var(--vds-z-dialog-nested)] w-[min(360px,calc(100vw-48px))]'

export interface ProjectFormTarget {
  mode: 'create' | 'edit'
  project?: Project
}

/** 编辑态显示名缺失时回落到源文件夹名（取路径最后一段）。 */
function displayName(project?: Project): string {
  if (project?.name) return project.name
  const segments = (project?.path ?? '').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

export function ProjectForm({
  target,
  onClose,
  onDone
}: {
  target: ProjectFormTarget
  onClose: () => void
  onDone: (message: string, created?: Project) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const editing = target.mode === 'edit'
  const [name, setName] = React.useState(editing ? displayName(target.project) : '')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<{ messageKey: 'project.required' | 'project.createFailed' | 'project.saveFailed' | 'project.removeFailed' } | { text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)

  const create = async (): Promise<void> => {
    const next = name.trim()
    if (!next) {
      setError({ messageKey: 'project.required' })
      return
    }
    setBusy(true)
    setError(null)
    const created = await createManagedProject(next)
    if (!created) {
      setBusy(false)
      setError({ messageKey: 'project.createFailed' })
      return
    }
    setBusy(false)
    await onDone(t('project.created', { name: created.name }), created)
  }

  const save = async (): Promise<void> => {
    const path = target.project?.path
    if (!path) return
    const next = name.trim()
    if (!next) {
      setError({ messageKey: 'project.required' })
      return
    }
    setBusy(true)
    const result = await renameProject(path, next)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ? { text: result.error } : { messageKey: 'project.saveFailed' })
      return
    }
    await onDone(t('project.renamed', { name: next }))
  }

  const remove = async (): Promise<void> => {
    const path = target.project?.path
    if (!path) return
    setBusy(true)
    const result = await removeProject(path)
    setBusy(false)
    if (!result.ok) {
      setConfirmRemove(false)
      setError(result.error ? { text: result.error } : { messageKey: 'project.removeFailed' })
      return
    }
    await onDone(t('project.removed', { name: target.project?.name ?? '' }))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-label={t(editing ? 'project.edit' : 'project.new')}
        className={DIALOG_CLASS_NAME}
        data-testid={editing ? 'project-edit-modal' : 'project-new-modal'}
        overlayClassName={OVERLAY_CLASS_NAME}
      >
        <DialogHeader>
          <DialogTitle>{t(editing ? 'project.edit' : 'project.new')}</DialogTitle>
        </DialogHeader>

        {editing ? (
          <>
            <div className="flex items-center [gap:8px] [padding:8px_10px] [border:1px_solid_var(--border-soft)] [border-radius:8px] [background:var(--bg)] [color:var(--text-2)]">
              <Icon name="folder" size={15} />
              <Input
                value={name}
                maxLength={PROJECT_NAME_MAX}
                data-testid="project-edit-name"
                unstyled
                className="min-w-0 flex-1 border-0 bg-transparent p-[var(--vds-space-0)] font-[inherit] text-[12.5px] text-[var(--text)] outline-none"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Label>{t('project.source')}</Label>
            <DialogDescription>{t('project.sourceHint')}</DialogDescription>
            <div className="break-all [padding:8px_10px] [border-radius:8px] [background:var(--bg-3)] [font-family:var(--font-mono)] [font-size:10.5px] [color:var(--text-2)]">{target.project?.path}</div>
          </>
        ) : (
          <FormField id="project-name" className="gap-[var(--vds-space-2)]">
            <div className="flex items-baseline justify-between gap-[var(--vds-space-2)]">
              <FormLabel required>{t('project.name')}</FormLabel>
              <span className="text-[length:var(--vds-font-caption)] tabular-nums text-[var(--vds-text-tertiary)]">
                {name.length}/{PROJECT_NAME_MAX}
              </span>
            </div>
            <FormControl invalid={Boolean(error)}>
              <Input
                value={name}
                maxLength={PROJECT_NAME_MAX}
                placeholder={t('project.placeholder')}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value)
                  if (error) setError(null)
                }}
              />
            </FormControl>
            {error && (
              <FormMessage>
                {'messageKey' in error ? t(error.messageKey) : error.text}
              </FormMessage>
            )}
          </FormField>
        )}

        {editing && error && (
          <Alert
            tone="error"
            description={'messageKey' in error ? t(error.messageKey) : error.text}
          />
        )}

        <DialogFooter className="mt-[var(--vds-space-4)]">
          {editing && (
            <Button
              type="button"
              data-testid="project-remove"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              size="sm"
              variant="danger"
            >
              {t('project.removeTitle')}
            </Button>
          )}
          <Button type="button" onClick={onClose} disabled={busy} variant="outline">{t('project.cancel')}</Button>
          <Button
            type="button"
            data-testid={editing ? 'project-save' : 'project-create'}
            disabled={busy}
            onClick={() => void (editing ? save() : create())}
          >
            {t(busy ? 'project.busy' : editing ? 'project.save' : 'project.create')}
          </Button>
        </DialogFooter>

        {confirmRemove && (
          <AlertDialog open onOpenChange={(open) => !open && setConfirmRemove(false)}>
            <AlertDialogContent
              aria-label={t('project.removeTitle')}
              className={CONFIRM_DIALOG_CLASS_NAME}
              overlayClassName={CONFIRM_OVERLAY_CLASS_NAME}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>{t('project.removeTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans t={t} ns="components" i18nKey="project.confirm" values={{ name: target.project?.name ?? '' }} components={{ b: <b /> }} />
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Alert tone="warning" description={t('project.safety')} />
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>{t('project.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="project-remove-confirm"
                  disabled={busy}
                  onClick={() => void remove()}
                  variant="danger"
                >
                  {t(busy ? 'project.removing' : 'project.remove')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </DialogContent>
    </Dialog>
  )
}
