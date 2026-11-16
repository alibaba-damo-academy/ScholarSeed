import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserBridge } from '../../../../browser'
import { Alert, Spinner } from '../../components/ui'
import type { FeatureModule } from '../../contracts/features'
import { Browser } from './Browser'
import { useApp } from '../../store'
import { subscribeBrowserReveal } from './reveal'
import { browserPageTitle, subscribeBrowserPages } from './title'
import { BrowserPages } from './pages'

const owners = new WeakMap<BrowserBridge, BrowserPages>()
function browserPages(): BrowserPages {
  const bridge = window.scholarseed.browser
  let pages = owners.get(bridge)
  if (!pages) {
    pages = new BrowserPages(bridge)
    owners.set(bridge, pages)
  }
  return pages
}

function BrowserNavigation(): null {
  const { state, act, set } = useApp()
  const hasBrowserTab = state.tabs.some((tab) => tab.kind === 'browser')
  const observedPages = useRef(new Set<string>())
  const previousTabs = useRef(state.tabs)
  useEffect(() => {
    const retained = new Set(state.tabs.map((tab) => tab.id))
    for (const tab of previousTabs.current) {
      if (tab.kind === 'browser' && !retained.has(tab.id))
        void browserPages()
          .release(tab.id, tab.browserPageOwned ? tab.browserPageId : undefined)
          .catch((error) => console.error('Browser page close failed', error))
    }
    previousTabs.current = state.tabs
  }, [state.tabs])
  useEffect(() => {
    if (!hasBrowserTab) {
      browserPages().remember()
      return
    }
    return subscribeBrowserPages(window.scholarseed.browser, (snapshot) => {
      browserPages().remember(snapshot)
      const available = new Set(snapshot.tabs.map((page) => page.tabId))
      for (const tab of current.current.state.tabs) {
        if (
          tab.kind === 'browser' &&
          tab.browserPageId &&
          observedPages.current.has(tab.browserPageId) &&
          !available.has(tab.browserPageId)
        ) {
          browserPages().forget(tab.id)
          current.current.act.closeWorkbenchTab(tab.id)
        }
      }
      observedPages.current = available
      const activePage = snapshot.tabs.find((page) => page.tabId === snapshot.activeTabId)
      const sourceTab = activePage?.openerTabId
        ? current.current.state.tabs.find(
            (tab) => tab.kind === 'browser' && tab.browserPageId === activePage.openerTabId
          )
        : undefined
      if (
        activePage &&
        sourceTab?.id === current.current.state.activeTab &&
        !current.current.state.tabs.some((tab) => tab.browserPageId === activePage.tabId)
      ) {
        current.current.act.openWorkbenchView('browser', {
          preserveProject: true,
          browserPageId: activePage.tabId,
          browserPageOwned: true,
        })
      }
      set((current) => {
        const tabs = current.tabs.map((tab) => {
          if (tab.kind !== 'browser' || !tab.browserPageId) return tab
          const page = snapshot.tabs.find((page) => page.tabId === tab.browserPageId)
          const pageTitle = browserPageTitle(snapshot, tab.browserPageId)
          return pageTitle !== tab.pageTitle || page?.favicon !== tab.favicon
            ? { ...tab, pageTitle, favicon: page?.favicon }
            : tab
        })
        return tabs.every((tab, index) => tab === current.tabs[index]) ? current : { tabs }
      })
    })
  }, [hasBrowserTab, set])
  const current = useRef({ state, act })
  current.current = { state, act }
  useEffect(
    () =>
      subscribeBrowserReveal(
        window.scholarseed.browser,
        () => current.current.state.aiPanel.sessionId,
        (browserPageId) =>
          current.current.act.openWorkbenchView('browser', { preserveProject: true, browserPageId })
      ),
    []
  )
  return null
}

function BrowserViewer({ tabId, active }: { tabId?: string; active: boolean }): React.JSX.Element {
  const { act, set, state } = useApp()
  const { t } = useTranslation('browser')
  const [failed, setFailed] = useState(false)
  const tab = state.tabs.find((tab) => tab.id === tabId)
  const pageId = tab?.browserPageId
  const pageOwned = tab?.browserPageOwned
  useEffect(() => {
    if (!tabId) return
    if (pageId) {
      if (pageOwned) browserPages().own(tabId, pageId)
      return
    }
    if (!active) return
    setFailed(false)
    let current = true
    void browserPages()
      .acquire(tabId)
      .then((browserPageId) => {
        if (!current) return
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, browserPageId, browserPageOwned: true } : tab
          ),
        }))
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
    }
  }, [tabId, pageId, pageOwned, active, set])
  if (failed) return <Alert tone="error" title={t('errors.operation_failed')} />
  if (!pageId) return <Spinner aria-label={t('title')} />
  return (
    <Browser
      key={pageId}
      pageId={pageId}
      initialSnapshot={browserPages().snapshotFor(pageId)}
      selected={active}
      onSettings={(section) => act.openSettings('browser', section)}
    />
  )
}

export function browserFeature(): FeatureModule {
  return {
    id: 'browser',
    viewerPlugins: [
      {
        kind: 'browser',
        conversationLayout: 'native-floating',
        render: (props) => <BrowserViewer tabId={props.tabId} active={props.active} />,
      },
    ],
    globalSurfaces: [{ id: 'browser-navigation', render: () => <BrowserNavigation /> }],
  }
}
