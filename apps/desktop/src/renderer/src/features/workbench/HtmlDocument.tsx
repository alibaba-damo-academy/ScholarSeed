import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Ellipsis } from 'lucide-react'
import { BrowserToolbar } from '../../components/business/BrowserToolbar'
import {
  Alert,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  useToast,
} from '../../components/ui'
import { resolveDocumentLocation } from './api'
import { HTML_PREVIEW_MAX_BYTES } from './html'
import { staticHtml } from './markup'
import { useDocumentWorkspace, useWorkspaceController } from './workspace'

export function HtmlDocument({
  sessionId,
  source,
  toolbarActions,
}: {
  sessionId: string
  source: ReactNode
  toolbarActions?: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('browser')
  const { toast } = useToast()
  const workspace = useWorkspaceController()
  const session = useDocumentWorkspace().sessions[sessionId]
  const documentSource = session?.source
  const [sourceMode, setSourceMode] = useState(false)
  const [address, setAddress] = useState(session?.source.path ?? '')
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(false)
  const content = session?.text ?? ''
  const oversized = Boolean(session && session.bytes.byteLength > HTML_PREVIEW_MAX_BYTES)
  const rendered = useMemo(() => (oversized ? '' : staticHtml(content)), [content, oversized])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!documentSource) return
    let active = true
    setAddress(
      documentSource.kind === 'session-artifact'
        ? (documentSource.absolutePath ?? documentSource.path)
        : documentSource.path
    )
    if (documentSource.kind === 'project' || documentSource.kind === 'literature') {
      void resolveDocumentLocation(documentSource).then((result) => {
        if (active && result.ok && result.absolute) setAddress(result.absolute)
      })
    }
    return () => {
      active = false
    }
  }, [documentSource])
  const refresh = async (): Promise<void> => {
    if (busy.current || !session || session.dirty) return
    busy.current = true
    setPending(true)
    setFailure(null)
    try {
      const ok = await workspace.reload(sessionId)
      if (!ok && mounted.current) {
        const reason = workspace.getSnapshot().sessions[sessionId]?.loadFailure?.message
        setFailure(reason ? t('html.readFailure', { reason }) : t('html.refreshFailure'))
      }
    } catch (error) {
      if (mounted.current)
        setFailure(
          t('html.readFailure', { reason: error instanceof Error ? error.message : String(error) })
        )
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  if (!session) return <EmptyState title={t('html.missing')} />
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="html-document">
      <BrowserToolbar reload={() => void refresh()} reloadDisabled={pending || session.dirty}>
        <div className="min-w-0 flex-1">
          <Input aria-label={t('html.path')} readOnly value={address} />
        </div>
        {toolbarActions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('moreFeatures')} variant="ghost" icon={<Ellipsis />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setSourceMode((value) => !value)}>
              {t(sourceMode ? 'html.returnPage' : 'html.viewSource')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard
                  .writeText(address)
                  .then(() => toast({ title: t('html.pathCopied'), tone: 'success' }))
                  .catch((error) => setFailure(t('html.readFailure', { reason: String(error) })))
              }}
            >
              {t('html.copyPath')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </BrowserToolbar>
      {failure && <Alert tone="error" title={failure} description={t('html.reopen')} />}
      {sourceMode ? (
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="html-source">
          {source}
        </div>
      ) : oversized ? (
        <EmptyState title={t('html.tooLarge')} />
      ) : (
        <iframe
          title={session.title}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={rendered}
          className="min-h-0 w-full flex-1 border-0"
          data-testid="html-preview"
        />
      )}
    </div>
  )
}
