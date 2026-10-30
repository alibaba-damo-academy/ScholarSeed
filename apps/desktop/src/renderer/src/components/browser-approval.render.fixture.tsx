import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import '../browser'
import '../styles.css'
import { Button, ToastProvider } from './ui'
import { PendingHilDock } from './business/Stream'
import { StoreProvider, useApp } from '../store'
import type { BrowserSnapshot } from '../../../browser'
import type { ConvItem, Thread } from '../model'
import { DEFAULT_RENDERER_PREFERENCES } from '../../../preferences'

const localization = createLocalization('zh', resources, { report: () => undefined })
const approvalRequests: Array<{ sessionId: string; requestId: string; decision: string }> = []
const historyApprovalRequests: Array<{ sessionId: string; requestId: string; decision: string }> = []
let rejectNextApproval = false
const snapshot: BrowserSnapshot = {
  activeTabId: 'tab-test', automation: { enabled: false, port: null },
  tabs: [{ tabId: 'tab-test', title: 'Test page', url: 'https://example.org/', loading: false, canGoBack: false, canGoForward: false, navigationError: null, devtoolsOpen: false, cdpStatus: 'disabled' }]
}
Object.assign(window, { scholarseed: {
  ...window.scholarseed,
  browserEnabled: window.scholarseed.browserEnabled,
  preferences: DEFAULT_RENDERER_PREFERENCES,
  getApiBase: () => '',
  respondBrowserApproval: async (request: { sessionId: string; requestId: string; decision: string }) => {
    if (rejectNextApproval) {
      rejectNextApproval = false
      throw new Error('IPC unavailable')
    }
    approvalRequests.push(request)
    return { ok: true, interaction: { state: 'resolved', decision: request.decision } }
  },
  respondBrowserHistoryApproval: async (request: { sessionId: string; requestId: string; decision: string }) => {
    historyApprovalRequests.push(request)
    return { ok: true, interaction: { state: 'resolved', decision: request.decision } }
  },
  browser: {
    snapshot: async () => ({ ok: true, snapshot }),
    subscribe: () => () => undefined
  }
} })
Object.assign(window, { approvalRequests, historyApprovalRequests, rejectApprovalOnce: () => { rejectNextApproval = true } })

let requestNumber = 0
function Fixture(): React.JSX.Element {
  const { set } = useApp()
  const open = (): void => {
    requestNumber += 1
    const item: ConvItem = {
      kind: 'hil', requestId: `request-${requestNumber}`, hilKind: 'browser_approval',
      browserApproval: { tabId: 'tab-test', proofId: 'main-proof', targetInstanceId: 'instance-test', targetGeneration: 3, tabTitle: 'Test page', tabUrl: 'https://example.org/', origin: 'https://example.org', action: 'read', intent: 'Read page', expiresAt: Date.now() + 60_000 },
      startedAt: Date.now(), turnId: 'turn-test'
    }
    const thread: Thread = { id: 'session-test', title: 'Test task', sessionId: 'session-test', lastSeq: 0, conversation: [item] }
    set({ activeSession: 'session-test', threads: { 'session-test': thread } })
  }
  const openHistory = (): void => {
    requestNumber += 1
    const item: ConvItem = {
      kind: 'hil', requestId: `history-request-${requestNumber}`, hilKind: 'browser_history_approval',
      browserHistoryApproval: { proofId: 'history-proof', queryDigest: 'a'.repeat(64), historyRevision: 3,
        search: 'research', offset: 2, limit: 10, intent: 'Find a paper', expiresAt: Date.now() + 60_000 },
      startedAt: Date.now(), turnId: 'turn-test'
    }
    const thread: Thread = { id: 'session-test', title: 'Test task', sessionId: 'session-test', lastSeq: 0, conversation: [item] }
    set({ activeSession: 'session-test', threads: { 'session-test': thread } })
  }
  return <div className="flex h-screen min-h-0 flex-col"><div className="flex-none"><Button onClick={open}>Open approval</Button><Button onClick={openHistory}>Open history approval</Button></div><PendingHilDock /><div className="flex-none"><Button disabled>Composer</Button></div></div>
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}><ToastProvider><StoreProvider assistantSources={[]}><Fixture /></StoreProvider></ToastProvider></I18nextProvider>
)
