import React from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Info } from 'lucide-react'

import type { Project } from '../../api'
import { adoptProject, createManagedProject } from '../../api'
import { PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX } from '../../contracts/content'
import { previewProjectDirectory, renameProject as updateProject } from '../../features/project/api'
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
  FormControl,
  FormField,
  FormLabel,
  FormMessage,
  Input,
  IconButton,
  Tooltip,
  Textarea,
} from '../ui'

const OVERLAY_CLASS_NAME = 'project-form-scrim'
const CONFIRM_OVERLAY_CLASS_NAME = 'project-form-scrim !z-[var(--vds-z-dialog-nested-overlay)]'
const DIALOG_CLASS_NAME = 'project-form-dialog w-[min(520px,calc(100vw-48px))]'
const CONFIRM_DIALOG_CLASS_NAME =
  'project-form-dialog !z-[var(--vds-z-dialog-nested)] w-[min(360px,calc(100vw-48px))]'
const FIELD_LABEL_CLASS_NAME =
  'text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]'
const FIELD_INPUT_CLASS_NAME =
  '!px-[var(--vds-space-3)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)]'

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
  onDone,
  heading,
  introduction,
  footerLeading,
  pending = false,
  onCancel,
}: {
  target: ProjectFormTarget
  heading?: string
  introduction?: string
  footerLeading?: React.ReactNode | ((busy: boolean) => React.ReactNode)
  pending?: boolean
  onCancel?: () => void
  onClose: () => void
  onDone: (message: string, created?: Project) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: layoutText } = useTranslation('layout')
  const editing = target.mode === 'edit'
  const [name, setName] = React.useState(editing ? displayName(target.project) : '')
  const [description, setDescription] = React.useState(target.project?.description ?? '')
  const [folder, setFolder] = React.useState<string | null>(null)
  const [defaultFolder, setDefaultFolder] = React.useState<string | null>(null)
  const [confirmFolder, setConfirmFolder] = React.useState(false)
  const createdProject = React.useRef<Project | null>(null)
  const [saving, setBusy] = React.useState(false)
  const busy = saving || pending
  const [error, setError] = React.useState<
    | {
        messageKey: 'project.required' | 'project.createFailed' | 'project.saveFailed'
      }
    | { text: string }
    | null
  >(null)
  React.useEffect(() => {
    if (editing || folder) return
    let active = true
    void previewProjectDirectory(name).then((result) => {
      if (active) setDefaultFolder(result?.root ?? null)
    })
    return () => {
      active = false
    }
  }, [editing, folder, name])
  const displayedFolder = editing
    ? (target.project?.path ?? '')
    : (folder ?? defaultFolder ?? layoutText('defaultFolder'))

  const create = async (): Promise<void> => {
    const next = name.trim()
    if (!next) {
      setError({ messageKey: 'project.required' })
      return
    }
    if (busy) return
    setBusy(true)
    setError(null)
    const created =
      createdProject.current ??
      (await (folder ? adoptProject(folder, next) : createManagedProject(next)))
    if (!created) {
      setBusy(false)
      setError({ messageKey: 'project.createFailed' })
      return
    }
    createdProject.current = created
    const createdName = folder ? next : created.name
    if (description.trim() || created.name !== createdName) {
      const metadata = await updateProject(created.id, createdName, {
        description: description.trim(),
      })
      if (!metadata.ok) {
        setBusy(false)
        setError({ messageKey: 'project.saveFailed' })
        return
      }
    }
    try {
      await onDone(t('project.created', { name: createdName }), {
        ...created,
        name: createdName,
        description: description.trim(),
      })
    } catch {
      setError({ messageKey: 'project.createFailed' })
    } finally {
      setBusy(false)
    }
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
    const result = await updateProject(target.project!.id, next, {
      description: description.trim(),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ? { text: result.error } : { messageKey: 'project.saveFailed' })
      return
    }
    await onDone(t('project.renamed', { name: next }))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        aria-label={heading ?? t(editing ? 'project.edit' : 'project.new')}
        className={DIALOG_CLASS_NAME}
        data-testid={editing ? 'project-edit-modal' : 'project-new-modal'}
        overlayClassName={OVERLAY_CLASS_NAME}
      >
        <DialogHeader>
          <DialogTitle>{heading ?? t(editing ? 'project.edit' : 'project.new')}</DialogTitle>
          {introduction && <DialogDescription>{introduction}</DialogDescription>}
        </DialogHeader>
        <div className="grid min-w-0 gap-[var(--vds-space-3)] font-[family-name:var(--vds-font-main)]">
          <FormField id="project-name" className="!gap-[var(--vds-space-2)]">
            <div className="flex items-baseline justify-between gap-[var(--vds-space-2)]">
              <FormLabel required className={FIELD_LABEL_CLASS_NAME}>
                {t('project.nameLabel')}
              </FormLabel>
            </div>
            <div className="relative min-w-0">
              <FormControl invalid={Boolean(error)}>
                <Input
                  size="md"
                  className={`${FIELD_INPUT_CLASS_NAME} !pr-[calc(var(--vds-space-10)+var(--vds-space-4))]`}
                  aria-describedby="project-name-count"
                  value={name}
                  data-testid={editing ? 'project-edit-name' : 'project-create-name'}
                  disabled={busy || Boolean(createdProject.current)}
                  maxLength={PROJECT_NAME_MAX}
                  placeholder={t('project.placeholder')}
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value)
                    if (error) setError(null)
                  }}
                />
              </FormControl>
              <span
                id="project-name-count"
                className="pointer-events-none absolute right-[var(--vds-space-3)] top-1/2 -translate-y-1/2 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] tabular-nums text-[var(--vds-text-placeholder)]"
              >
                {name.length}/{PROJECT_NAME_MAX}
              </span>
            </div>
            {error && (
              <FormMessage>{'messageKey' in error ? t(error.messageKey) : error.text}</FormMessage>
            )}
          </FormField>

          <FormField id="project-description" className="!gap-[var(--vds-space-2)]">
            <FormLabel className={FIELD_LABEL_CLASS_NAME}>
              {t('project.descriptionLabel')}
            </FormLabel>
            <div className="relative min-w-0">
              <FormControl>
                <Textarea
                  className="!h-[var(--vds-project-form-description-height)] !min-h-[var(--vds-project-form-description-height)] resize-none !px-[var(--vds-space-3)] !pt-[calc(var(--vds-space-1)+var(--vds-border-width-1))] !pb-[var(--vds-space-6)] !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)]"
                  value={description}
                  maxLength={PROJECT_DESCRIPTION_MAX}
                  aria-describedby="project-description-count"
                  placeholder={layoutText('descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </FormControl>
              <span
                id="project-description-count"
                className="pointer-events-none absolute right-[var(--vds-space-3)] bottom-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] tabular-nums text-[var(--vds-text-placeholder)]"
              >
                {description.length}/{PROJECT_DESCRIPTION_MAX}
              </span>
            </div>
          </FormField>

          <FormField id="project-folder" className="!gap-[var(--vds-space-2)]">
            <div className="flex items-center gap-[var(--vds-space-1)]">
              <FormLabel className={FIELD_LABEL_CLASS_NAME}>{t('project.folderLabel')}</FormLabel>
              <Tooltip content={layoutText('rootHint')}>
                <IconButton
                  variant="ghost"
                  size="xs"
                  className="!size-[var(--vds-icon-8)] !min-w-0 !p-0 !text-[var(--vds-icon-outline-default)] [&_svg]:!size-[var(--vds-icon-8)]"
                  label={layoutText('rootHint')}
                  icon={<Info />}
                />
              </Tooltip>
            </div>
            <div className="flex items-center gap-[var(--vds-space-2)]">
              <div className="min-w-0 flex-1">
                <FormControl>
                  <Input
                    size="md"
                    className={FIELD_INPUT_CLASS_NAME}
                    disabled
                    value={displayedFolder}
                    title={displayedFolder}
                  />
                </FormControl>
              </div>
              {!editing && (
                <Button
                  variant="outline"
                  size="sm"
                  className="!h-[var(--vds-control-height-md)] shrink-0 !gap-[calc(var(--vds-space-1)+var(--vds-space-half))] !border-[var(--vds-divider-default)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)]"
                  disabled={busy || Boolean(createdProject.current)}
                  onClick={() => {
                    void window.scholarseed
                      .pickDir()
                      .then((selected) => {
                        if (selected) setFolder(selected)
                      })
                      .catch(() => setError({ messageKey: 'project.createFailed' }))
                  }}
                >
                  <Folder />
                  {layoutText('chooseFolder')}
                </Button>
              )}
            </div>
          </FormField>
        </div>

        <AlertDialog open={confirmFolder} onOpenChange={setConfirmFolder}>
          <AlertDialogPortal>
            <AlertDialogContent
              showCloseButton
              overlayClassName={CONFIRM_OVERLAY_CLASS_NAME}
              className={CONFIRM_DIALOG_CLASS_NAME}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>{layoutText('trustFolder')}</AlertDialogTitle>
                <AlertDialogDescription>{layoutText('trustFolderHint')}</AlertDialogDescription>
              </AlertDialogHeader>
              <p className="break-all">{folder}</p>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('project.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmFolder(false)
                    void create()
                  }}
                >
                  {layoutText('trustCreate')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialogPortal>
        </AlertDialog>

        {editing && error && (
          <Alert
            tone="error"
            description={'messageKey' in error ? t(error.messageKey) : error.text}
          />
        )}

        <DialogFooter>
          {footerLeading && (
            <div className="mr-auto">
              {typeof footerLeading === 'function' ? footerLeading(busy) : footerLeading}
            </div>
          )}
          <Button type="button" onClick={onCancel ?? onClose} disabled={busy} variant="outline">
            {t('project.cancel')}
          </Button>
          <Button
            type="button"
            data-testid={editing ? 'project-save' : 'project-create'}
            disabled={busy}
            onClick={() => {
              if (!editing && folder && name.trim() && !createdProject.current)
                setConfirmFolder(true)
              else void (editing ? save() : create())
            }}
          >
            {t(busy ? 'project.busy' : editing ? 'project.save' : 'project.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
