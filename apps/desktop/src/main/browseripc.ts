import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { BROWSER_COMMAND_CHANNEL, BROWSER_DATA_CHANNEL, BROWSER_DOWNLOAD_CHANNEL, BROWSER_ERROR, BROWSER_HISTORY_CHANNEL, BROWSER_POLICY_CHANNEL, BROWSER_SNAPSHOT_CHANNEL, parseBrowserCommand, parseBrowserDataRequest, parseBrowserDownloadRequest, parseBrowserHistoryRequest, parseBrowserPolicyRequest } from '../browser.ts'
import type { BrowserDataReply, BrowserDownloadReply, BrowserErrorCode, BrowserHistoryReply, BrowserPolicyReply, BrowserReply } from '../browser.ts'
import type { ActiveBrowserHost } from './browserhost.ts'
import type { createBrowserPolicy } from './policy.ts'
import { BROWSER_PAGE_CHANNEL, parsePageRequest } from '../browser.ts'
import type { PageReply } from '../browser.ts'

const HISTORY_DELIVERY_DRAIN_TIMEOUT_MS = 30_000

interface BrowserIpcOwners {
  enabled(): boolean
  contents(): WebContents | null
  host(): ActiveBrowserHost | null
  rendererOrigin?(): string | null
  saveAutomationEnabled?(enabled: boolean): void
  policy?(): Pick<ReturnType<typeof createBrowserPolicy>, 'snapshot' | 'set' | 'remove' | 'setAgentBrowserUse'> | null
}

const ERROR_CODES = new Set<string>(Object.values(BROWSER_ERROR))

export function registerBrowserIpc(ipc: Pick<IpcMain, 'handle'>, owners: BrowserIpcOwners): void {
  let dataClearInProgress = false
  let historyPolicyTransitionInProgress = false
  let automationTask: Promise<void> = Promise.resolve()
  const scheduleAutomation = <T>(action: () => Promise<T>): Promise<T> => {
    const task = automationTask.then(action)
    automationTask = task.then(() => undefined, () => undefined)
    return task
  }
  const validateSender = (event: IpcMainInvokeEvent) => {
    const contents = owners.contents()
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error(BROWSER_ERROR.invalidSender)
    }
  }
  const read = (host = owners.host()): BrowserReply => {
    if (!host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    return { ok: true, snapshot: host.snapshot() }
  }
  const errorCode = (error: unknown): BrowserErrorCode => error instanceof Error && ERROR_CODES.has(error.message)
    ? error.message as BrowserErrorCode : BROWSER_ERROR.operationFailed
  ipc.handle(BROWSER_PAGE_CHANNEL, async (event, ...args: unknown[]): Promise<PageReply> => {
    try {
      validateSender(event)
      if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      if (dataClearInProgress) throw new Error(BROWSER_ERROR.cdpBusy)
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const request = parsePageRequest(args[0])
      const host = owners.host()
      if (!host) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
      const reply = await host.ui.page(request)
      if (!owners.enabled()) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
      if (owners.host() !== host) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
      validateSender(event)
      return reply
    } catch (error) { return { ok: false, error: errorCode(error) } }
  })
  ipc.handle(BROWSER_SNAPSHOT_CHANNEL, (event, ...args: unknown[]): BrowserReply => {
    validateSender(event)
    if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    if (args.length) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    return read()
  })
  ipc.handle(BROWSER_COMMAND_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserReply> => {
    validateSender(event)
    if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    try {
      if (dataClearInProgress) throw new Error(BROWSER_ERROR.cdpBusy)
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const command = parseBrowserCommand(args[0])
      const host = owners.host()
      if (!host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      if (command.kind === 'automation') {
        await scheduleAutomation(async () => {
          if (dataClearInProgress) throw new Error(BROWSER_ERROR.cdpBusy)
          if (owners.host() !== host) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
          if (command.enabled) await host.automation.start()
          else await host.automation.stop()
          if (owners.host() !== host) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
          try { owners.saveAutomationEnabled?.(command.enabled) }
          catch (error) {
            if (command.enabled) await host.automation.stop()
            throw error
          }
        })
      } else if (command.kind === 'copy-endpoint') host.automation.copyEndpoint()
      else await host.ui.dispatch(command)
      if (owners.host() !== host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      return read(host)
    } catch (error) {
      return { ok: false, error: errorCode(error) }
    }
  })
  ipc.handle(BROWSER_HISTORY_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserHistoryReply> => {
    validateSender(event)
    if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    try {
      if (dataClearInProgress) throw new Error(BROWSER_ERROR.cdpBusy)
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const request = parseBrowserHistoryRequest(args[0])
      const host = owners.host()
      if (!host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      if (request.kind === 'query') return { ok: true, page: host.ui.queryHistory(request.query) }
      if (request.kind === 'delete') {
        const deleted = await host.ui.deleteHistory(request.id)
        return owners.host() === host ? { ok: true, deleted } : { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      }
      const snapshot = await host.ui.reopenHistory(request.id)
      return owners.host() === host ? { ok: true, snapshot } : { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    } catch (error) { return { ok: false, error: errorCode(error) } }
  })
  ipc.handle(BROWSER_DATA_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserDataReply> => {
    validateSender(event)
    if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    try {
      if (dataClearInProgress) throw new Error(BROWSER_ERROR.cdpBusy)
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const request = parseBrowserDataRequest(args[0])
      const host = owners.host()
      if (!host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      dataClearInProgress = true
      try {
        await automationTask
        const historyOnly = request.kind === 'clear-history'
          || request.kind === 'clear-selected' && request.types.length === 1 && request.types[0] === 'history'
        const deleted = await host.ui.clearData(request, historyOnly ? undefined : () => host.automation.stop())
        return owners.host() === host ? { ok: true, deleted } : { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      } finally { dataClearInProgress = false }
    } catch (error) { return { ok: false, error: errorCode(error) } }
  })
  ipc.handle(BROWSER_DOWNLOAD_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserDownloadReply> => {
    validateSender(event)
    if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    try {
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const request = parseBrowserDownloadRequest(args[0])
      const host = owners.host()
      if (!host) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      if (request.kind === 'choose-directory') {
        const settings = await host.ui.chooseDownloadDirectory()
        return owners.host() === host ? { ok: true, settings } : { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      }
      if (request.kind === 'reset-directory') return { ok: true, settings: host.ui.resetDownloadDirectory() }
      if (request.kind === 'set-ask-every-time') return { ok: true, settings: host.ui.setAskEveryTime(request.enabled) }
      return { ok: true, settings: host.ui.downloadSettings() }
    } catch (error) { return { ok: false, error: errorCode(error) } }
  })
  ipc.handle(BROWSER_POLICY_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserPolicyReply> => {
    try {
      validateSender(event)
      if (!owners.enabled()) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      const contents = owners.contents()
      const expectedOrigin = owners.rendererOrigin?.()
      if (!contents || !expectedOrigin || new URL(contents.getURL()).origin !== expectedOrigin) throw new Error(BROWSER_ERROR.invalidSender)
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const request = parseBrowserPolicyRequest(args[0])
      const policy = owners.policy?.()
      if (!policy) throw new Error(BROWSER_ERROR.policyUnavailable)
      if (request.kind === 'set-agent-use') {
        if (historyPolicyTransitionInProgress) throw new Error(BROWSER_ERROR.historyDeliveryPending)
        historyPolicyTransitionInProgress = true
        const host = owners.host()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), HISTORY_DELIVERY_DRAIN_TIMEOUT_MS)
        try {
          if (!request.enabled) {
            policy.setAgentBrowserUse(false)
            host?.historyAgent.revokeAll()
          }
          try { await host?.historyAgent.waitForLeases(undefined, controller.signal) }
          catch { throw new Error(BROWSER_ERROR.historyDeliveryPending) }
          if (owners.host() !== host) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
          if (request.enabled) policy.setAgentBrowserUse(true)
        } finally { clearTimeout(timer); historyPolicyTransitionInProgress = false }
      }
      else if (request.kind === 'set') policy.set(request.origin, request.action, request.decision)
      else if (request.kind === 'remove') policy.remove(request.origin)
      return { ok: true, policy: policy.snapshot() }
    } catch (error) { return { ok: false, error: errorCode(error) } }
  })
}
