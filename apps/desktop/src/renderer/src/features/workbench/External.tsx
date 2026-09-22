import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronDown } from 'lucide-react'

import { openPathWith, openSystemPath, type OpenWithApp } from '../../api'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useToast
} from '../../components/ui'
import { listOpenWithApps, revealInFinder, revealLabelKey, type OpenContext } from '../../fileOpen'
import { resolveRevealTarget } from '../resources/api'
import {
  useWorkspaceController,
  type DocumentSession,
  type DocumentWorkspace
} from './workspace'

type ExternalOpenError = {
  key: 'dock.notProject' | 'dock.resolveSave' | 'dock.notSaved' | 'dock.resolvePath' | 'dock.openFailed' | 'dock.desktopUnavailable'
  detail?: string
}

interface ExternalOpenResult {
  ok: boolean
  path?: string
  error?: ExternalOpenError
}

export function canOpenDocumentExternally(session: DocumentSession | null | undefined): session is DocumentSession {
  return Boolean(session?.source.kind === 'project'
    && (session.viewer === 'office' || (!session.capabilities.can_edit && session.viewer === 'spreadsheet')))
}

function ExternalApplicationIcon({ application }: { application?: OpenWithApp }): React.JSX.Element {
  if (!application?.icon) return <AppWindow />
  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-[var(--vds-icon-7)] shrink-0"
      src={application.icon}
    />
  )
}

async function saveDocumentIfNeeded(
  workspace: DocumentWorkspace,
  session: DocumentSession
): Promise<ExternalOpenResult> {
  if (session.source.kind !== 'project') return { ok: false, error: { key: 'dock.notProject' } }
  if (session.dirty && !await workspace.save(session.id)) {
    return { ok: false, error: { key: 'dock.resolveSave' } }
  }
  const current = workspace.getSnapshot().sessions[session.id]
  if (!current || current.dirty || current.saveState !== 'clean') {
    return { ok: false, error: { key: 'dock.notSaved' } }
  }
  return { ok: true }
}

async function prepareDocumentExternalPath(
  workspace: DocumentWorkspace,
  session: DocumentSession
): Promise<ExternalOpenResult> {
  if (session.source.kind !== 'project') return { ok: false, error: { key: 'dock.notProject' } }
  const saved = await saveDocumentIfNeeded(workspace, session)
  if (!saved.ok) return saved
  const resolved = await resolveRevealTarget(session.source.path, session.source.project)
  if (!resolved.ok || !resolved.absolute) return { ok: false, error: { key: 'dock.resolvePath', detail: resolved.error } }
  return { ok: true, path: resolved.absolute }
}

async function openDocumentExternally(
  workspace: DocumentWorkspace,
  session: DocumentSession
): Promise<ExternalOpenResult> {
  const prepared = await prepareDocumentExternalPath(workspace, session)
  if (!prepared.ok || !prepared.path) return prepared
  const opened = await openSystemPath(prepared.path)
  return opened.ok ? { ok: true } : { ok: false, error: opened.applicationFailure?.code === 'desktop_bridge_unavailable'
    ? { key: 'dock.desktopUnavailable' }
    : { key: 'dock.openFailed', detail: opened.error } }
}

async function openDocumentWithApplication(
  workspace: DocumentWorkspace,
  session: DocumentSession,
  application: OpenWithApp
): Promise<ExternalOpenResult> {
  const prepared = await prepareDocumentExternalPath(workspace, session)
  if (!prepared.ok || !prepared.path) return prepared
  const opened = await openPathWith(prepared.path, application.path)
  return opened.ok
    ? { ok: true }
    : { ok: false, error: { key: 'dock.openFailed', detail: opened.error } }
}

async function saveDocumentCopy(
  workspace: DocumentWorkspace,
  session: DocumentSession
): Promise<ExternalOpenResult> {
  const saved = await saveDocumentIfNeeded(workspace, session)
  if (!saved.ok) return saved
  const current = workspace.getSnapshot().sessions[session.id]
  if (!current) return { ok: false, error: { key: 'dock.notSaved' } }
  const result = await window.scholarseed.saveFileCopy({
    bytes: current.bytes,
    suggestedName: session.source.path.split('/').at(-1) ?? session.title
  })
  return result.ok || result.canceled
    ? { ok: true }
    : { ok: false, error: { key: 'dock.openFailed', detail: result.error } }
}

export function DocumentExternalOpen({ session }: { session: DocumentSession }): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const { toast } = useToast()
  const workspace = useWorkspaceController()
  const [externalOpening, setExternalOpening] = useState(false)
  const [externalApps, setExternalApps] = useState<OpenWithApp[] | null>(null)
  const [externalAppsLoading, setExternalAppsLoading] = useState(false)
  const [externalContext, setExternalContext] = useState<OpenContext | null>(null)
  const defaultExternalApp = externalApps?.find((application) => application.isDefault) ?? externalApps?.[0]

  const reportExternalResult = (result: ExternalOpenResult): void => {
    if (!result.ok) {
      const detail = result.error?.detail ? ` ${result.error.detail}` : ''
      toast({ title: `${t(result.error?.key ?? 'dock.openFailed')}${detail}`, tone: 'error' })
    }
  }
  const runExternalAction = async (action: () => Promise<ExternalOpenResult>): Promise<void> => {
    setExternalOpening(true)
    try {
      reportExternalResult(await action())
    } catch (error) {
      toast({ title: `${t('dock.openFailed')} ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    } finally {
      setExternalOpening(false)
    }
  }
  const loadExternalApps = async (): Promise<void> => {
    if (session.source.kind !== 'project') return
    setExternalAppsLoading(true)
    try {
      const resolved = await resolveRevealTarget(session.source.path, session.source.project)
      if (!resolved.ok || !resolved.absolute) {
        setExternalContext(null)
        setExternalApps([])
        reportExternalResult({ ok: false, error: { key: 'dock.resolvePath', detail: resolved.error } })
        return
      }
      const context = {
        absolute: resolved.absolute,
        relative: session.source.path,
        title: session.source.path.split('/').at(-1) ?? session.title
      }
      setExternalContext(context)
      setExternalApps(await listOpenWithApps(context))
    } catch (error) {
      setExternalContext(null)
      setExternalApps([])
      toast({ title: `${t('dock.openFailed')} ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    } finally {
      setExternalAppsLoading(false)
    }
  }

  useEffect(() => {
    if (canOpenDocumentExternally(session)) void loadExternalApps()
  }, [session.id])

  if (!canOpenDocumentExternally(session)) return null
  return (
    <div className="inline-flex shrink-0" data-testid="external-open-split-button">
      <Button
        className="rounded-r-none"
        data-testid={session.viewer === 'office' ? 'office-open-external' : 'spreadsheet-open-external'}
        disabled={externalOpening || session.saveState === 'saving'}
        icon={<ExternalApplicationIcon application={defaultExternalApp} />}
        loading={externalOpening}
        size="sm"
        variant="outline"
        onClick={() => void runExternalAction(() => openDocumentExternally(workspace, session))}
      >
        {t('dock.openExternal')}
      </Button>
      <DropdownMenu onOpenChange={(open) => { if (open) void loadExternalApps() }}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={t('dock.openWith')}
            className="w-[var(--vds-control-height-sm)] rounded-l-none border-l-0 p-0"
            data-testid="external-open-menu"
            disabled={externalOpening || session.saveState === 'saving'}
            icon={<ChevronDown />}
            size="sm"
            variant="outline"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={`${PRODUCT_MENU_CONTENT_CLASS} !w-56 !rounded-[var(--vds-radius-6)] !p-[var(--vds-space-2)]`}>
          {externalAppsLoading && (
            <div className="px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
              {t('dock.openAppsLoading')}
            </div>
          )}
          {!externalAppsLoading && externalApps?.map((application) => (
            <DropdownMenuItem
              className={application.isDefault ? 'bg-[var(--vds-other-overlay-1)]' : undefined}
              key={application.path}
              onSelect={() => void runExternalAction(() => openDocumentWithApplication(workspace, session, application))}
            >
              <ExternalApplicationIcon application={application} />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{application.name}</span>
            </DropdownMenuItem>
          ))}
          {!externalAppsLoading && externalApps?.length === 0 && (
            <div className="px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
              {t('dock.openAppsEmpty')}
            </div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!externalContext} onSelect={() => { if (externalContext) revealInFinder(externalContext) }}>
            {t(revealLabelKey())}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void runExternalAction(() => saveDocumentCopy(workspace, session))}>
            {t('dock.saveAsExternal')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
