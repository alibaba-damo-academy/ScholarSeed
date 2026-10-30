import type { AgentPage } from './agent.ts'
import type { ChromiumTargets } from './chromiumtarget.ts'

type MessageListener = (event: Electron.Event, method: string, params: Record<string, unknown>, sessionId: string) => void
type DetachListener = (event: Electron.Event, reason: string) => void

export interface ChromiumAgentPage extends AgentPage {
  dispose(): void
}

export function createChromiumAgentPage(targets: ChromiumTargets, targetId: string): ChromiumAgentPage {
  const sessionId = targets.agentPageSession(targetId)
  let title = targets.listTargets().find(info => info.targetId === targetId)?.title ?? ''
  let detached = false
  const messageListeners = new Set<MessageListener>()
  const detachListeners = new Set<DetachListener>()
  let removePageListener: () => void = () => undefined
  let removeTargetListener: () => void = () => undefined

  const detach = (reason: string): void => {
    if (detached) return
    detached = true
    removePageListener()
    removeTargetListener()
    messageListeners.clear()
    for (const listener of detachListeners) {
      try { listener({} as Electron.Event, reason) }
      catch (error) { console.error('[browser-chromium] Agent detach listener failed', error) }
    }
    detachListeners.clear()
  }
  const attached = (): boolean => {
    if (detached) return false
    let currentSessionId: string | undefined
    try {
      currentSessionId = targets.agentPageSession(targetId)
    } catch { currentSessionId = undefined }
    if (currentSessionId === sessionId) return true
    detach('target_changed')
    return false
  }

  removePageListener = targets.onAgentPageEvent(event => {
    if (event.targetId !== targetId || !attached()) return
    for (const listener of messageListeners) {
      try { listener({} as Electron.Event, event.method, event.params, sessionId) }
      catch (error) { console.error('[browser-chromium] Agent message listener failed', error) }
    }
  })
  removeTargetListener = targets.onTarget(event => {
    if (event.info.targetId !== targetId || detached) return
    if (event.kind === 'detached' || event.kind === 'destroyed') {
      detach(event.kind)
      return
    }
    if (attached()) title = event.info.title
  })

  const debuggerSession: AgentPage['debugger'] = {
    async sendCommand(method, params = {}) {
      if (!attached()) throw new Error('Chromium Agent page detached')
      const result = await targets.agentCommand(targetId, method, params)
      if (!attached()) throw new Error('Chromium Agent page changed during command')
      return result
    },
    isAttached: attached,
    on(event, listener) {
      if (event === 'message') messageListeners.add(listener as MessageListener)
      else detachListeners.add(listener as DetachListener)
    },
    removeListener(event, listener) {
      if (event === 'message') messageListeners.delete(listener as MessageListener)
      else detachListeners.delete(listener as DetachListener)
    }
  }

  return {
    debugger: debuggerSession,
    isDestroyed: () => !attached(),
    isLoadingMainFrame: () => {
      if (!attached()) return true
      try { return targets.agentPageState(targetId).loading }
      catch { detach('target_changed'); return true }
    },
    getTitle: () => {
      if (attached()) title = targets.listTargets().find(info => info.targetId === targetId)?.title ?? title
      return title
    },
    dispose: () => detach('disposed')
  }
}
