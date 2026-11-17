import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import '../../styles.css'
import { DocumentWorkspace, DocumentWorkspaceContext, useDocumentWorkspace } from './workspace'
import { HtmlDocument } from './HtmlDocument'
import { DOCUMENT_LOAD_FAILURE_KIND } from './api'
import { Toaster, ToastProvider } from '../../components/ui'
import { DocumentExternalOpen } from './External'
import { useDocumentFailureText } from './failure'

const localization = createLocalization(
  new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh',
  resources,
  { report: () => undefined }
)
let revision = 0
let fail = false
const raw = `<h1>Static report</h1><style>h1 {color: green} body {background-image:url('https://blocked.invalid/css')}</style><script>parent.document.body.dataset.compromised='yes'</script><meta http-equiv="refresh" content="0;url=https://blocked.invalid/redirect"><img src="https://blocked.invalid/image"><a href="https://blocked.invalid/link">blocked link</a><iframe src="https://blocked.invalid/frame"></iframe><p>Revision `
const workspace = new DocumentWorkspace({
  load: async (source) =>
    fail
      ? {
          kind: DOCUMENT_LOAD_FAILURE_KIND,
          code: 'permission_denied',
          message: 'authorization revoked',
          retryable: true,
          status: 403,
        }
      : {
          documentId: 'html-report',
          source,
          viewer: 'code',
          processor: null,
          capabilities: {
            can_preview: true,
            can_edit: true,
            can_save: true,
            can_select: true,
            can_annotate: false,
            can_version: false,
            can_diff: false,
            pending: [],
          },
          revision: String(++revision),
          mediaType: 'text/html',
          bytes: new TextEncoder().encode(raw + revision + '</p>'),
        },
  commit: async () => ({ ok: true, revision: 'saved' }),
})
const tabId = await workspace.open(
  {
    kind: 'session-artifact',
    sessionId: 'session',
    artifactId: 'report',
    path: 'report.html',
    absolutePath: '/authorized/report.html',
  },
  'source'
)
const sessionId = workspace.getSnapshot().tabs[tabId].sessionId
Object.assign(window, {
  failHtmlRead: () => {
    fail = true
  },
})
export function Fixture(): React.JSX.Element {
  const session = useDocumentWorkspace().sessions[sessionId]
  const failureText = useDocumentFailureText()
  return (
    <div className="h-screen">
      <output data-testid="permission-failure">
        {failureText({
          kind: DOCUMENT_LOAD_FAILURE_KIND,
          code: 'read_permission_denied',
          message: 'read_permission_denied',
          retryable: true,
          status: 403,
        })}
      </output>
      <output data-testid="generic-read-failure">
        {failureText({
          kind: DOCUMENT_LOAD_FAILURE_KIND,
          code: 'read_failed',
          message: 'read_failed',
          retryable: true,
          status: 500,
        })}
      </output>
      <HtmlDocument
        sessionId={sessionId}
        source={<pre>{session.text}</pre>}
        toolbarActions={<DocumentExternalOpen session={session} />}
      />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <DocumentWorkspaceContext.Provider value={workspace}>
      <ToastProvider>
        <Fixture />
        <Toaster />
      </ToastProvider>
    </DocumentWorkspaceContext.Provider>
  </I18nextProvider>
)
