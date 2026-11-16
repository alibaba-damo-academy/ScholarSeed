import { useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { EllipsisVertical } from 'lucide-react'
import {
  appsForFile,
  openPathWith,
  openSystemPath,
  revealSystemPath,
  resolveSessionReferenceLocation,
  type OpenWithApp,
} from '../../api'
import { ComposerAttachments, type LocalReference } from '../../components/primitive/Attachments'
import { writeClipboard } from '../../components/primitive/clipboard'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useToast,
} from '../../components/ui'
import { revealLabelKey } from '../../fileOpen'
import { resolveDocumentLocation } from '../workbench/api'

export async function attachmentOriginal(ref: LocalReference, sessionId?: string): Promise<string> {
  if (
    ref.type === 'file' &&
    (ref.previewSource?.kind === 'literature' || ref.previewSource?.kind === 'project')
  ) {
    const location = await resolveDocumentLocation(ref.previewSource)
    if (!location.ok || !location.absolute)
      throw new Error(location.error || 'session_attachment_not_found')
    return location.absolute
  }
  if (!sessionId) throw new Error('session_attachment_not_found')
  const result = await resolveSessionReferenceLocation(sessionId, ref.referenceId || ref.id)
  if (!result.ok || !result.path) throw new Error(result.error || 'session_attachment_not_found')
  if (result.path !== ref.path || result.kind !== ref.type)
    throw new Error('session_attachment_forbidden')
  if (!(await window.scholarseed?.addAuthorizedRoot('session', result.path)))
    throw new Error('session_attachment_forbidden')
  return result.path
}

function AttachmentMenu({
  reference,
  sessionId,
  onImport,
  canImport,
}: {
  reference: LocalReference
  sessionId?: string
  onImport?: (ref: LocalReference) => void
  canImport: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['assistant', 'resources'])
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [apps, setApps] = useState<OpenWithApp[]>([])
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const run = async (
    action: (path: string) => Promise<{ ok: boolean; canceled?: boolean }>
  ): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const result = await action(await attachmentOriginal(reference, sessionId))
      if (!result.ok && !result.canceled) throw new Error('attachment_action_failed')
      if (result.ok) toast({ title: t('attachments.actionSucceeded'), tone: 'success' })
    } catch {
      toast({ title: t('attachments.actionFailed'), tone: 'error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const loadApps = async (): Promise<void> => {
    const request = ++generation.current
    setApps([])
    setLoading(true)
    try {
      const path = await attachmentOriginal(reference, sessionId)
      const candidates = window.scholarseed?.platform === 'darwin' ? await appsForFile(path) : []
      if (request === generation.current) setApps(candidates)
    } catch {
      if (request === generation.current)
        toast({ title: t('attachments.actionFailed'), tone: 'error' })
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && reference.type === 'file') void loadApps()
        if (!open) ++generation.current
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          unstyled
          className="inline-flex size-[var(--vds-space-6)] items-center justify-center rounded-[var(--vds-radius-2)] bg-transparent text-[var(--vds-text-secondary)] hover:bg-[var(--vds-bg-white-hover-transparent)]"
          aria-label={t('attachments.actions', { title: reference.title })}
          disabled={busy}
          icon={<EllipsisVertical size={12} strokeWidth={1.5} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {onImport && (
          <DropdownMenuItem
            disabled={!sessionId || busy || !canImport}
            onSelect={() => onImport(reference)}
          >
            {t('attachments.save')}
          </DropdownMenuItem>
        )}
        {reference.type === 'file' && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger openOnHover>{t('images.openWith')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem disabled={busy} onSelect={() => void run(openSystemPath)}>
                  {t('attachments.defaultApplication')}
                </DropdownMenuItem>
                {loading ? (
                  <DropdownMenuItem disabled>{t('images.loadingApps')}</DropdownMenuItem>
                ) : (
                  apps.map((application) => (
                    <DropdownMenuItem
                      key={application.path}
                      disabled={busy}
                      onSelect={() => void run((path) => openPathWith(path, application.path))}
                    >
                      {application.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() =>
                void run((path) =>
                  window.scholarseed.saveFileCopy({
                    sourcePath: path,
                    suggestedName: reference.fileName || reference.title,
                  })
                )
              }
            >
              {t('attachments.saveAs')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          disabled={busy}
          onSelect={() =>
            void run(async (path) => {
              await writeClipboard(path)
              return { ok: true }
            })
          }
        >
          {t('attachments.copyPath')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={() =>
            void run(reference.type === 'directory' ? openSystemPath : revealSystemPath)
          }
        >
          {t(revealLabelKey())}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AttachmentFiles({
  sessionId,
  onImport,
  onOpen,
  canImport = true,
  showActions = Boolean(onImport),
  importable,
  ...props
}: Omit<ComponentProps<typeof ComposerAttachments>, 'renderActions' | 'onOpenDirectory'> & {
  sessionId?: string
  onImport?: (ref: LocalReference) => void
  canImport?: boolean
  showActions?: boolean
  importable?: (ref: LocalReference) => boolean
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  return (
    <ComposerAttachments
      {...props}
      onOpen={onOpen ? (target) => onOpen({ ...target, sessionId }) : undefined}
      onOpenDirectory={(ref) => {
        void attachmentOriginal(ref, sessionId)
          .then(openSystemPath)
          .then((result) => {
            if (!result.ok) throw new Error('attachment_action_failed')
          })
          .catch(() => toast({ title: t('attachments.actionFailed'), tone: 'error' }))
      }}
      renderActions={
        showActions
          ? (ref) => (
              <AttachmentMenu
                reference={ref}
                sessionId={sessionId}
                onImport={importable?.(ref) === false ? undefined : onImport}
                canImport={canImport}
              />
            )
          : undefined
      }
    />
  )
}
