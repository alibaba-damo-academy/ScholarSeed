import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import '../../browser'
import type { BrowserBridge, BrowserCommand, BrowserDataRequest, BrowserFrame, BrowserFrameInput, BrowserHistoryRequest, BrowserPolicyRequest, BrowserPolicySite, BrowserSnapshot, BrowserVisit } from '../../../../browser'
import type { BrowserSettingsSection } from '../../../../navigation'
import type { BrowserOverlayBridge, BrowserOverlayEvent, BrowserOverlayModel } from '../../../../overlay'
import type { MenuAck, MenuActionResult, MenuBridge, MenuDismissReason, MenuEvent, MenuModel, MenuReply } from '../../../../menu'
import { Button, Dialog, DialogContent, DialogTitle, Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui'
import '../../design/motion.css'
import '../../styles.css'
import { Browser } from './Browser'
import { BrowserSettings } from './Settings'
import { browserFeature } from './feature'

const localization = createLocalization('zh', resources, { report: () => undefined })
const commands: BrowserCommand[] = []
const dataRequests: BrowserDataRequest[] = []
const historyRequests: BrowserHistoryRequest[] = []
const visits: BrowserVisit[] = [{ id: '12345678-1234-1234-1234-123456789abc', url: 'https://example.org/paper', title: 'Paper Example', visitedAt: Date.now() }]
const policySites: BrowserPolicySite[] = []
const policyRequests: BrowserPolicyRequest[] = []
let policyRevision = 0
let agentBrowserUseEnabled = false
const blankTitle = new URLSearchParams(window.location.search).has('blank-title')
const pendingOpen = new URLSearchParams(window.location.search).has('pending-open')
const emptyTabs = new URLSearchParams(window.location.search).has('empty-tabs')
const sidecar = new URLSearchParams(window.location.search).has('sidecar')
const fixtureTabs = new URLSearchParams(window.location.search).has('many-tabs')
  ? ['first', 'second', ...Array.from({ length: 14 }, (_, index) => `extra-${index}`)] : ['first', 'second']
const snapshot: BrowserSnapshot = {
  engine: sidecar ? 'chromium-sidecar' : undefined,
  activeTabId: pendingOpen || emptyTabs ? null : 'first', automation: { enabled: false, port: null },
  tabs: pendingOpen || emptyTabs ? [] : fixtureTabs.map(tabId => ({ tabId, title: tabId === 'first' ? (blankTitle ? 'about:blank' : 'First') : tabId === 'second' ? 'Second' : tabId, url: tabId === 'first' && blankTitle ? 'about:blank' : 'https://example.com/', loading: false, canGoBack: true, canGoForward: true, navigationError: null, devtoolsOpen: false, cdpStatus: 'disabled' }))
}
const listeners = new Set<(snapshot: BrowserSnapshot) => void>()
const menuEvents = new Set<(event: MenuEvent) => void>()
const menuRevocations = new Set<(event: MenuAck & { reason: MenuDismissReason }) => void>()
const menuResults = new Set<(result: MenuActionResult) => void>()
const menuModels: MenuModel[] = []
let menuModel: MenuModel | null = null
let menuRevision = 0
let menuSession = 0
let finishMenu: (reply: MenuReply) => void = () => undefined
const menuBridge: MenuBridge = {
  presentation: async () => ({ ok: true, revision: 1, presentation: 'native' }),
  subscribePresentation: () => () => undefined,
  seed: async request => ({ ok: true, seed: { sessionId: `menu-${++menuSession}`, revision: ++menuRevision,
    target: request.surface === 'browser-menu' && request.tabId !== null ? { kind: 'browser', tabId: request.tabId, instanceId: 'fixture-instance', navigationId: 1 } : { kind: 'browser-empty' } } }),
  publish: model => { menuModel = model; menuModels.push(model); menuRevision = model.revision; return new Promise(resolve => { finishMenu = resolve }) },
  dismiss: async reason => { if (menuModel) menuRevocations.forEach(listener => listener({ sessionId: menuModel!.sessionId, revision: menuModel!.revision, reason })); menuModel = null },
  subscribe: callback => { menuEvents.add(callback); return () => { menuEvents.delete(callback) } },
  subscribeRevoked: callback => { menuRevocations.add(callback); return () => { menuRevocations.delete(callback) } },
  subscribeResult: callback => { menuResults.add(callback); return () => { menuResults.delete(callback) } }
}
Object.assign(window, { menuModels, finishMenu: (ok: boolean) => { if (menuModel) finishMenu(ok ? { ok: true, ack: { sessionId: menuModel.sessionId, revision: menuModel.revision } } : { ok: false, error: 'menu_failed' }) },
  revokeMenu: (reason: MenuDismissReason) => menuBridge.dismiss(reason),
  menuFailure: () => {
    if (!menuModel) return
    const approved = menuModel
    void menuBridge.dismiss('action')
    menuResults.forEach(listener => listener({ sessionId: approved.sessionId, revision: approved.revision, requestId: 'failed-action', actionId: 'browser.devtools', outcome: 'failed' }))
  },
  menuAction: (actionId: string) => {
    if (!menuModel) return
    const approved = menuModel
    const item = approved.items.find(item => item.kind === 'action' && item.actionId === actionId)
    if (!item || item.kind !== 'action') return
    void menuBridge.dismiss('action')
    if (actionId === 'browser.devtools' && approved.target.kind === 'browser' && item.value.kind === 'boolean') void bridge.dispatch({ kind: 'devtools', tabId: approved.target.tabId, open: item.value.value })
    menuEvents.forEach(listener => listener({ kind: 'action', sessionId: approved.sessionId, revision: approved.revision, requestId: `request-${approved.revision}`, actionId, value: item.value }))
  }
})
const overlayEvents = new Set<(event: BrowserOverlayEvent) => void>()
const overlayModels: BrowserOverlayModel[] = []
let overlayModel: BrowserOverlayModel | null = null
let renderSuggestions: ((model: BrowserOverlayModel) => void) | undefined
let focusSuggestions: ((revision: number) => void) | undefined
let overlayFrame: HTMLIFrameElement | null = null
const overlayBridge: BrowserOverlayBridge = {
  seed: async () => 100,
  publish: async model => {
    overlayModels.push(model)
    overlayModel = model
    if (overlayFrame) { overlayFrame.hidden = false; Object.assign(overlayFrame.style, { left: `${model.bounds.x}px`, top: `${model.bounds.y}px`, width: `${model.bounds.width}px`, height: `${model.bounds.height}px` }) }
    renderSuggestions?.(model)
    return { ok: true }
  },
  dismiss: async () => { overlayBridge.dismissSync(); return { ok: true } },
  dismissSync: () => { overlayModel = null; if (overlayFrame) overlayFrame.hidden = true },
  focus: async () => { if (overlayModel && overlayFrame && !overlayFrame.hidden) focusSuggestions?.(overlayModel.revision); return { ok: true } },
  subscribe: callback => { overlayEvents.add(callback); return () => { overlayEvents.delete(callback) } }
}
Object.assign(window, {
  overlayModels,
  suggestionsReady: (callback: (model: BrowserOverlayModel) => void) => { renderSuggestions = callback; Object.assign(window, { suggestionsFixtureReady: true }); if (overlayModel) callback(overlayModel) },
  suggestionsFocusReady: (callback: (revision: number) => void) => { focusSuggestions = callback },
  emitSuggestionsFocus: (revision: number) => focusSuggestions?.(revision),
  suggestionEvent: (event: BrowserOverlayEvent) => {
    if (overlayModel?.revision !== event.revision) return
    overlayBridge.dismissSync()
    overlayEvents.forEach(listener => listener(event))
  },
  emitOverlayEvent: (event: BrowserOverlayEvent) => overlayEvents.forEach(listener => listener(event))
})
const frameListeners = new Set<(frame: BrowserFrame) => void>()
const frameResizes: Array<{ tabId: string; width: number; height: number }> = []
const frameInputs: Array<{ tabId: string; input: BrowserFrameInput }> = []
const frameAcks: Array<{ tabId: string; sequence: number }> = []
let navigationSerial = 0
let paperHistoryQueries = 0
const settingsOnly = new URLSearchParams(window.location.search).has('settings')
let reopenNavigationCount = 0
let historyReopenReplyCount = 0
const bridge: BrowserBridge = {
  page: async request => ({ ok: true, target: request.kind === 'target' ? { tabId: request.tabId, instanceId: 'fixture-instance', navigationId: 1 } : request.target }),
  frames: {
    subscribe: callback => { frameListeners.add(callback); return () => { frameListeners.delete(callback) } },
    acknowledge: async (tabId, sequence) => { frameAcks.push({ tabId, sequence }); return { ok: true } },
    resize: async (tabId, width, height) => { frameResizes.push({ tabId, width, height }); return { ok: true } },
    input: async (tabId, input) => { frameInputs.push({ tabId, input }); return { ok: true } }
  },
  snapshot: async () => ({ ok: true, snapshot }),
  history: async request => {
    historyRequests.push(request)
    if (request.kind === 'query') {
      if (new URLSearchParams(window.location.search).has('history-query-error')) return { ok: false, error: 'operation_failed' }
      if (new URLSearchParams(window.location.search).has('history-query-error-after-search') && request.query.search === 'bad') return { ok: false, error: 'operation_failed' }
      if (new URLSearchParams(window.location.search).has('history-repeat-error') && request.query.search === 'Paper' && ++paperHistoryQueries > 1) return { ok: false, error: 'operation_failed' }
      if (new URLSearchParams(window.location.search).has('slow-history') && request.query.search === 'Paper') {
        await new Promise<void>(resolve => Object.assign(window, { finishHistory: resolve }))
      }
      const items = visits.filter(visit => `${visit.title} ${visit.url}`.toLowerCase().includes((request.query.search ?? '').toLowerCase()))
      return { ok: true, page: { items: items.slice(request.query.offset, request.query.offset + request.query.limit), total: items.length } }
    }
    if (new URLSearchParams(window.location.search).has('history-action-error')) return { ok: false, error: 'operation_failed' }
    if (request.kind === 'reopen' && new URLSearchParams(window.location.search).has('pending-history-reopen')) {
      await new Promise<void>(resolve => Object.assign(window, { finishHistoryReopen: resolve }))
    }
    if (request.kind === 'delete') {
      const index = visits.findIndex(visit => visit.id === request.id)
      if (index !== -1) visits.splice(index, 1)
      return { ok: true, deleted: index !== -1 }
    }
    historyReopenReplyCount += 1
    return { ok: true, snapshot }
  },
  clearData: async request => { dataRequests.push(request); if (new URLSearchParams(window.location.search).has('data-error')) return { ok: false, error: 'operation_failed' }; if (request.kind === 'clear-all' || request.kind === 'clear-history') visits.splice(0); return { ok: true, deleted: 1 } },
  downloads: async request => ({ ok: true, settings: { directory: request.kind === 'choose-directory' ? '/chosen' : '/downloads', isDefault: request.kind !== 'choose-directory', directoryAvailable: true, askEveryTime: request.kind !== 'set-ask-every-time' || request.enabled, automaticAvailable: true } }),
  policy: async request => {
    policyRequests.push(request)
    if (request.kind === 'set-agent-use') {
      agentBrowserUseEnabled = request.enabled
      policyRevision += 1
      if (!request.enabled && new URLSearchParams(window.location.search).has('pending-agent-disable')) {
        return { ok: false, error: 'browser_history_delivery_pending' }
      }
    } else if (request.kind === 'set') {
      const current = policySites.find(site => site.origin === request.origin)
      if (current) current[request.action] = request.decision
      else policySites.push({ origin: request.origin, read: request.action === 'read' ? request.decision : 'ask', interact: request.action === 'interact' ? request.decision : 'ask' })
      policyRevision += 1
    } else if (request.kind === 'remove') {
      const index = policySites.findIndex(site => site.origin === request.origin)
      if (index !== -1) policySites.splice(index, 1)
      policyRevision += 1
    }
    return { ok: true, policy: { revision: policyRevision, agentBrowserUseEnabled, sites: structuredClone(policySites) } }
  },
  subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
  dispatch: async command => {
    commands.push(command)
    const currentNavigation = command.kind === 'navigate' ? ++navigationSerial : navigationSerial
    if (command.kind === 'open' && pendingOpen && command.input) {
      snapshot.activeTabId = 'new'
      snapshot.tabs = [{ tabId: 'new', title: '', url: '', loading: true, canGoBack: false, canGoForward: false,
        navigationError: null, devtoolsOpen: false, cdpStatus: 'disabled' }]
      listeners.forEach(listener => listener(structuredClone(snapshot)))
      await new Promise<void>(resolve => Object.assign(window, { finishOpen: resolve }))
      snapshot.tabs[0] = { ...snapshot.tabs[0], url: `https://${command.input}/`, loading: false }
      listeners.forEach(listener => listener(structuredClone(snapshot)))
      return { ok: true, snapshot: structuredClone(snapshot) }
    }
    if (command.kind === 'open' && new URLSearchParams(window.location.search).has('slow')) {
      await new Promise<void>(resolve => Object.assign(window, { finishOpen: resolve }))
    }
    if (command.kind === 'navigate' && new URLSearchParams(window.location.search).has('slow-navigation') && command.input.endsWith('/stall')) {
      await new Promise<void>(resolve => Object.assign(window, { finishNavigation: resolve }))
    }
    if (command.kind === 'navigate' && currentNavigation !== navigationSerial) return { ok: true, snapshot: structuredClone(snapshot) }
    if (command.kind === 'navigate' && command.input === 'bad:address') return { ok: false, error: 'invalid_url' }
    if (command.kind === 'automation') snapshot.automation = { enabled: command.enabled, port: command.enabled ? 1234 : null }
    if (command.kind === 'select') snapshot.activeTabId = command.tabId
    if (command.kind === 'close') { snapshot.tabs = snapshot.tabs.filter(tab => tab.tabId !== command.tabId); snapshot.activeTabId = snapshot.tabs[0]?.tabId ?? null }
    if (command.kind === 'devtools') snapshot.tabs = snapshot.tabs.map(tab => tab.tabId === command.tabId ? { ...tab, devtoolsOpen: command.open } : tab)
    if (command.kind === 'navigate' && new URLSearchParams(window.location.search).has('slow-navigation')) {
      snapshot.tabs = snapshot.tabs.map(tab => tab.tabId === command.tabId ? { ...tab, url: command.input } : tab)
    }
    const next = structuredClone(snapshot)
    listeners.forEach(listener => listener(next))
    return { ok: true, snapshot: next }
  }
}
const tooltipModels: BrowserOverlayModel[] = []
let tooltipDismissCount = 0
let finishTooltip: ((reply: { ok: true } | { ok: false; error: string }) => void) | undefined
let tooltipReply: { ok: true } | { ok: false; error: string } | undefined
const tooltipBridge: BrowserOverlayBridge = {
  seed: async () => 0,
  publish: model => { tooltipModels.push(model); return tooltipReply ? Promise.resolve(tooltipReply) : new Promise(resolve => { finishTooltip = resolve }) },
  dismiss: async () => { tooltipDismissCount += 1; return { ok: true } }, dismissSync() {}, focus: async () => ({ ok: true }), subscribe: () => () => undefined
}
Object.assign(window, { tooltipModels, finishTooltip: (ok: boolean) => { tooltipReply = ok ? { ok: true } : { ok: false, error: 'operation_failed' }; finishTooltip?.(tooltipReply) } })
Object.defineProperty(window, 'tooltipDismissCount', { get: () => tooltipDismissCount })
if (!new URLSearchParams(window.location.search).has('web')) Object.assign(window, { scholarseed: { browser: bridge, browserOverlay: overlayBridge, menu: menuBridge,
  ...(new URLSearchParams(window.location.search).has('native-tooltip') ? { browserTooltip: tooltipBridge } : {}) }, commands, dataRequests, historyRequests, policyRequests,
  frameResizes, frameInputs, frameAcks,
  emitBrowserFrame: (frame: BrowserFrame) => frameListeners.forEach(listener => listener(frame)),
  selectBrowserTab: (tabId: string) => { snapshot.activeTabId = tabId; listeners.forEach(listener => listener(structuredClone(snapshot))) }
})
Object.assign(window, { emitBrowserSnapshot: (url: string) => {
  snapshot.tabs = snapshot.tabs.map(tab => tab.tabId === snapshot.activeTabId ? { ...tab, url } : tab)
  listeners.forEach(listener => listener(structuredClone(snapshot)))
} })
Object.assign(window, { updateActiveBrowserTab: (changes: Partial<BrowserSnapshot['tabs'][number]>) => {
  snapshot.tabs = snapshot.tabs.map(tab => tab.tabId === snapshot.activeTabId ? { ...tab, ...changes } : tab)
  listeners.forEach(listener => listener(structuredClone(snapshot)))
} })

export function Fixture() {
  useTranslation('browser')
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalActions, setModalActions] = useState(0)
  const [mode, setMode] = useState<'settings' | 'browser' | 'other'>(settingsOnly ? 'settings' : 'browser')
  const [section, setSection] = useState<BrowserSettingsSection>('overview')
  Object.assign(window, { setTooltipOpen, setModalOpen, dismissSettings: () => setMode('other'), getReopenNavigationCount: () => reopenNavigationCount, getHistoryReopenReplyCount: () => historyReopenReplyCount })
  return <I18nextProvider i18n={localization}>
    <div data-testid="contribution">{browserFeature().activityItems?.map(item => item.label(localization, { hasProject: false })).join('')}</div>
    <Button onClick={() => { void localization.changeLanguage('en') }}>English</Button>
    <Button onClick={() => setModalOpen(true)}>Open priority dialog</Button>
    {mode === 'settings' ? <BrowserSettings section={section} onSection={setSection} onHistoryReopened={() => { reopenNavigationCount += 1; setMode('browser') }} />
      : mode === 'browser' ? <Browser onSettings={next => { setSection(next); setMode('settings') }} /> : <div data-testid="other-settings-page">Other settings</div>}
    <iframe ref={element => { overlayFrame = element }} hidden data-suggestions-fixture="" title="Suggestions fixture" src="./suggestions.render.fixture.html" style={{ position: 'fixed', border: 0 }} />
    <Dialog open={modalOpen} onOpenChange={setModalOpen}><DialogContent aria-label="Priority dialog"><DialogTitle>Priority dialog</DialogTitle><Button onClick={() => setModalActions(value => value + 1)}>Confirm priority action</Button><span data-testid="modal-actions">{modalActions}</span></DialogContent></Dialog>
    <Tooltip open={tooltipOpen} portalled>
      <TooltipTrigger asChild><Button>Animated overlay</Button></TooltipTrigger>
      <TooltipContent style={{ animation: 'vds-tooltip-in var(--vds-duration-fast) ease-out both paused' }}>Animated browser tooltip</TooltipContent>
    </Tooltip>
  </I18nextProvider>
}
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { unmountBrowser: () => root.unmount() })
root.render(<I18nextProvider i18n={localization}><Fixture /></I18nextProvider>)
