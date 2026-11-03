import { BROWSER_ERROR } from '../browser.ts'
import type { BrowserSnapshot } from '../browser.ts'
import type { AgentBrowserPort } from './agent.ts'
import type { BrowserRegistry } from './browser.ts'
import type { CdpBroker } from './cdp.ts'

export type BrowserUiPort = Pick<
  BrowserRegistry,
  | 'page'
  | 'dispatch'
  | 'queryHistory'
  | 'deleteHistory'
  | 'reopenHistory'
  | 'clearData'
  | 'downloadSettings'
  | 'chooseDownloadDirectory'
  | 'resetDownloadDirectory'
  | 'setAskEveryTime'
>

export type BrowserAgentHostPort = AgentBrowserPort &
  Pick<BrowserRegistry, 'onAgentTargetInvalidated' | 'createAgentTarget' | 'closeAgentTarget'>

export interface ActiveBrowserHost {
  readonly ui: BrowserUiPort
  readonly agent: BrowserAgentHostPort
  readonly search: Pick<
    BrowserRegistry,
    | 'createSearchTarget'
    | 'takeSearchRedirect'
    | 'agentTarget'
    | 'prepareSearchForm'
    | 'executeSearchForm'
  >
  readonly historyAgent: BrowserRegistry['historyAgent']
  readonly automation: Pick<CdpBroker, 'start' | 'stop' | 'copyEndpoint' | 'syncTargets'>
  snapshot(): BrowserSnapshot
  setApiBase(base: string): Promise<void>
  dispose(): Promise<void>
}

export function createLegacyBrowserHost(
  registry: BrowserRegistry,
  broker: CdpBroker,
  automation: () => BrowserSnapshot['automation']
): ActiveBrowserHost {
  let disposed = false
  let disposeTask: Promise<void> | null = null
  const pendingStarts = new Set<Promise<unknown>>()
  const assertActive = () => {
    if (disposed) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
  }
  return {
    ui: registry,
    agent: registry,
    search: registry,
    historyAgent: registry.historyAgent,
    automation: {
      start() {
        assertActive()
        const task = broker.start()
        pendingStarts.add(task)
        void task.then(
          () => pendingStarts.delete(task),
          () => pendingStarts.delete(task)
        )
        return task
      },
      stop: () => broker.stop(),
      copyEndpoint() {
        assertActive()
        broker.copyEndpoint()
      },
      syncTargets() {
        assertActive()
        return broker.syncTargets()
      },
    },
    snapshot: () => ({ ...registry.snapshot(), automation: automation() }),
    setApiBase: (base) => {
      assertActive()
      return registry.setApiBase(base)
    },
    dispose() {
      if (disposeTask) return disposeTask
      disposed = true
      disposeTask = (async () => {
        try {
          await Promise.allSettled([...pendingStarts])
          await broker.stop()
        } finally {
          await registry.dispose()
        }
      })()
      return disposeTask
    },
  }
}
