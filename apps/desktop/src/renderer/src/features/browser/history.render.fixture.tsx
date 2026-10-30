import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { BROWSER_ERROR, type BrowserBridge, type BrowserDataReply, type BrowserHistoryReply, type BrowserHistoryRequest } from '../../../../browser'
import type { BrowserSettingsSection } from '../../../../navigation'
import '../../browser'
import '../../styles.css'
import { Button, ToastProvider } from '../../components/ui'
import { SettingsSurface } from '../../navigation'
import { StoreProvider, useApp } from '../../store'
import { AccountPanel } from '../../components/business/AccountPanel'
import { BrowserSettings } from './Settings'

const localization = createLocalization('zh', resources, { report: () => undefined })
const requests: BrowserHistoryRequest[] = []
const pending: { request: BrowserHistoryRequest; resolve: (reply: BrowserHistoryReply) => void }[] = []
const clears: ((reply: BrowserDataReply) => void)[] = []
const bridge: BrowserBridge = {
  ...window.scholarseed.browser,
  snapshot: async () => ({ ok: true, snapshot: { tabs: [], activeTabId: null, automation: { enabled: false, port: null } } }),
  subscribe: () => () => undefined,
  history: (request: BrowserHistoryRequest) => {
    requests.push(request)
    return new Promise<BrowserHistoryReply>(resolve => pending.push({ request, resolve }))
  },
  clearData: () => new Promise<BrowserDataReply>(resolve => clears.push(resolve)),
  downloads: async () => ({ ok: false, error: BROWSER_ERROR.operationFailed }),
  policy: async () => ({ ok: false, error: BROWSER_ERROR.policyUnavailable })
}
Object.assign(window.scholarseed, { browser: bridge })

function Fixture(): React.JSX.Element {
  const [section, setSection] = useState<BrowserSettingsSection>('overview')
  const [open, setOpen] = useState(true)
  const surface = useRef(new SettingsSurface(true))
  const initialized = useRef(false)
  if (!initialized.current) { initialized.current = true; surface.current.project({ accountSettingsPage: 'browser', browserSettingsSection: section }) }
  const [reopened, setReopened] = useState(0)
  const current = surface.current.capture()
  const navigate = (next: BrowserSettingsSection) => { surface.current.project({ accountSettingsPage: 'browser', browserSettingsSection: next }); setSection(next) }
  Object.assign(window, {
    historyRequests: requests,
    historyPending: pending,
    historyClears: clears,
    historyNavigate: navigate,
    historyClose: () => { surface.current.project({ accountSettingsPage: null }); setOpen(false) },
    historyOpen: () => { surface.current.project({ accountSettingsPage: 'browser', browserSettingsSection: section }); setOpen(true) },
    historyRetire: () => { surface.current.project({ accountSettingsPage: null }) },
    historyResolve: (index: number, reply: BrowserHistoryReply) => pending[index].resolve(reply),
    historyClearResolve: (index: number, reply: BrowserDataReply) => clears[index](reply)
  })
  return <I18nextProvider i18n={localization}>
    <Button onClick={() => navigate(section === 'overview' ? 'history' : 'overview')}>Switch section</Button>
    <Button onClick={() => { void localization.changeLanguage('en') }}>English</Button>
    <span data-testid="reopened-count">{reopened}</span>
    {open && <BrowserSettings section={section} onSection={navigate} isSurfaceCurrent={current}
      onHistoryReopened={() => setReopened(current => current + 1)} />}
  </I18nextProvider>
}
let capturedStoreSurface = () => false
function StoreFixture(): React.JSX.Element {
  const { state, act, set, composerDraft } = useApp()
  const [closed, setClosed] = useState(0)
  useEffect(() => { act.openSettings('browser') }, [act])
  Object.assign(window, {
    historyRequests: requests,
    historyStoreOpen: (section: BrowserSettingsSection = 'overview') => act.openSettings('browser', section),
    historyStoreClose: () => act.openSettings(null),
    historyStorePatch: (patch: Parameters<typeof set>[0]) => set(patch),
    historyStoreDraft: () => composerDraft.getSnapshot(),
    historyStoreCapture: () => { capturedStoreSurface = act.captureSettingsSurface() },
    historyStoreIsCapturedCurrent: () => capturedStoreSurface(),
    historyStoreCloseAndResolve: (index: number) => { act.openSettings(null); pending[index].resolve({ ok: true }) },
    historyStoreRoundtripAndResolve: (index: number) => { act.openSettings(null); act.openSettings('browser'); pending[index].resolve({ ok: true }) },
    historyResolve: (index: number, reply: BrowserHistoryReply) => pending[index].resolve(reply)
  })
  return <>
    <output data-testid="store-view">{state.mainView}</output>
    <output data-testid="store-section">{state.browserSettingsSection ?? 'null'}</output>
    <output data-testid="store-close-count">{closed}</output>
    {state.accountSettingsPage && <AccountPanel embedded page={state.accountSettingsPage} browserSettingsSection={state.browserSettingsSection}
      isBrowserSettingsCurrent={act.captureSettingsSurface()} onPage={act.openSettings}
      onClose={() => { setClosed(value => value + 1); act.openSettings(null) }} onLogin={() => undefined} onLogout={async () => ({ ok: true, data: { local_cleared: true } })} />}
  </>
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(window.location.search).has('store')
  ? <I18nextProvider i18n={localization}><ToastProvider><StoreProvider assistantSources={[]}><StoreFixture /></StoreProvider></ToastProvider></I18nextProvider>
  : <Fixture />)
