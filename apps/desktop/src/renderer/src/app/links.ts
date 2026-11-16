import type { BrowserBridge } from '../../../browser.ts'
import { BROWSER_ERROR } from '../../../browser.ts'

interface WebPageOptions {
  preserveProject: true
  browserPageId: string | undefined
  browserPageOwned: true
}

export function webPageErrorKey(error: unknown) {
  return error instanceof Error && error.message === BROWSER_ERROR.permissionDenied
    ? 'browser:errors.permission_denied'
    : 'browser:errors.operation_failed'
}

export async function openWebPage(
  url: string,
  actions: {
    available: boolean
    dispatch: BrowserBridge['dispatch']
    reveal: (options: WebPageOptions) => void
  }
): Promise<void> {
  if (!actions.available) {
    throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
  }
  const reply = await actions.dispatch({ kind: 'open', input: url })
  if (!reply.ok) throw new Error(reply.error)
  actions.reveal({
    preserveProject: true,
    browserPageId: reply.snapshot.activeTabId ?? undefined,
    browserPageOwned: true,
  })
}
