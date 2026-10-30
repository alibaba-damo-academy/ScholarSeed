import { samePageTarget } from '../../../../browser.ts'
import type { BrowserBridge } from '../../../../browser.ts'

export function subscribeBrowserReveal(
  bridge: Pick<BrowserBridge, 'subscribeReveal' | 'page'>,
  currentSession: () => string | null,
  reveal: () => void,
): () => void {
  let active = true
  let generation = 0
  const unsubscribe = bridge.subscribeReveal?.(request => {
    const captured = ++generation
    if (!bridge.page || request.sessionId !== currentSession()) return
    void bridge.page({ kind: 'target', tabId: request.target.tabId }).then(reply => {
      if (active && captured === generation && request.sessionId === currentSession()
        && reply.ok && samePageTarget(reply.target, request.target)) reveal()
    }).catch(error => console.error('Browser reveal failed', error))
  })
  return () => { active = false; generation += 1; unsubscribe?.() }
}
