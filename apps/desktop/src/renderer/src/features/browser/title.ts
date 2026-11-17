import type { BrowserBridge, BrowserSnapshot } from '../../../../browser'

const BLANK_PAGE = 'about:blank'

export function browserPageTitle(snapshot: BrowserSnapshot, tabId = snapshot.activeTabId): string {
  const active = snapshot.tabs.find((tab) => tab.tabId === tabId)
  return !active || active.url === BLANK_PAGE ? '' : active.title.trim() || active.url
}

export function subscribeBrowserTitle(
  bridge: Pick<BrowserBridge, 'subscribe' | 'snapshot'>,
  publish: (title: string) => void
): () => void {
  return subscribeBrowserPages(bridge, (snapshot) => publish(browserPageTitle(snapshot)))
}

export function subscribeBrowserPages(
  bridge: Pick<BrowserBridge, 'subscribe' | 'snapshot'>,
  publish: (snapshot: BrowserSnapshot) => void
): () => void {
  let active = true
  let revision = 0
  const unsubscribe = bridge.subscribe((snapshot) => {
    revision += 1
    if (active) publish(snapshot)
  })
  const captured = revision
  void bridge
    .snapshot()
    .then((reply) => {
      if (active && revision === captured && reply.ok) publish(reply.snapshot)
    })
    .catch((error) => console.error('Browser title snapshot failed', error))
  return () => {
    active = false
    unsubscribe()
  }
}
