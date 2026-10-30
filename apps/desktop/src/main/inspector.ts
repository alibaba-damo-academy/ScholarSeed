import { BrowserWindow } from 'electron'
import type { ChromiumPipe } from './chromium'
import { createChromiumDevToolsRelay } from './chromiumdevtools'
import type { ChromiumDevToolsRelay } from './chromiumdevtools'

const DEVTOOLS_URL = 'devtools://devtools/bundled/inspector.html'
const INSPECTOR_WIDTH = 1000
const INSPECTOR_HEIGHT = 700
const INSPECTOR_PARTITION = 'scholarseed-inspector'
const MAX_ERROR_STATES = 64
const ATTACH_TIMEOUT_MS = 10_000

type RelayPipe = Pick<ChromiumPipe, 'command' | 'onEvent' | 'onClose' | 'close'>
type InspectorStatus = 'opening' | 'open' | 'closed' | 'error'

export interface InspectorState {
  targetId: string
  status: InspectorStatus
  error?: string
}

interface InspectorEntry {
  targetId: string
  relay: ChromiumDevToolsRelay
  ready: Promise<void>
  closing?: Promise<void>
  window?: BrowserWindow
  unsubscribePipe?: () => void
  unsubscribeRelay?: () => void
  closed: boolean
}

export interface ChromiumInspectorHost {
  open(targetId: string): Promise<void>
  close(targetId: string): Promise<void>
  targetDestroyed(targetId: string): Promise<void>
  inspect(targetId: string): Pick<InspectorState, 'status' | 'error'>
  dispose(): Promise<void>
}

export function createChromiumInspectorHost(pipe: RelayPipe, options: { onState?: (state: InspectorState) => void } = {}): ChromiumInspectorHost {
  const entries = new Map<string, InspectorEntry>()
  const states = new Map<string, InspectorState>()
  let disposed = false

  const publish = (state: InspectorState): void => {
    states.delete(state.targetId)
    if (state.status !== 'closed') states.set(state.targetId, state)
    let errors = [...states.values()].filter(candidate => candidate.status === 'error').length
    if (errors > MAX_ERROR_STATES) {
      for (const [targetId, candidate] of states) {
        if (candidate.status !== 'error') continue
        states.delete(targetId)
        errors -= 1
        if (errors <= MAX_ERROR_STATES) break
      }
    }
    options.onState?.(state)
  }

  const shutdown = (entry: InspectorEntry, error?: Error): Promise<void> => {
    if (entry.closing) return entry.closing
    entry.closed = true
    entry.unsubscribePipe?.()
    entry.unsubscribePipe = undefined
    entry.unsubscribeRelay?.()
    entry.unsubscribeRelay = undefined
    entry.closing = Promise.resolve().then(async () => {
      if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
      await entry.relay.stop()
      if (entries.get(entry.targetId) === entry) entries.delete(entry.targetId)
      publish(error
        ? { targetId: entry.targetId, status: 'error', error: error.message }
        : { targetId: entry.targetId, status: 'closed' })
    }).catch(failure => {
      if (entries.get(entry.targetId) === entry) entries.delete(entry.targetId)
      const reason = failure instanceof Error ? failure.message : String(failure)
      publish({ targetId: entry.targetId, status: 'error', error: reason })
      throw failure
    })
    return entry.closing
  }

  const open = (targetId: string): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Chromium inspector host is disposed'))
    if (!targetId || typeof targetId !== 'string') return Promise.reject(new Error('Chromium target is required'))
    const existing = entries.get(targetId)
    if (existing) return existing.closing ? existing.closing.then(() => open(targetId)) : existing.ready
    const entry: InspectorEntry = {
      targetId, relay: createChromiumDevToolsRelay(pipe, targetId), ready: Promise.resolve(), closed: false
    }
    entries.set(targetId, entry)
    publish({ targetId, status: 'opening' })
    entry.unsubscribePipe = pipe.onClose(reason => {
      void shutdown(entry, reason).catch(failure => console.error('[browser-inspector] Chromium shutdown failed', failure))
    })
    entry.unsubscribeRelay = entry.relay.onDisconnect(reason => {
      if (entry.closed) return
      void shutdown(entry, reason).catch(failure => console.error('[browser-inspector] frontend disconnect cleanup failed', failure))
    })
    entry.ready = (async () => {
      const { endpoint } = await entry.relay.start()
      if (entry.closed) throw new Error('Chromium target closed while opening DevTools')
      const window = new BrowserWindow({
        width: INSPECTOR_WIDTH,
        height: INSPECTOR_HEIGHT,
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: INSPECTOR_PARTITION
        }
      })
      entry.window = window
      window.setMenu(null)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-redirect', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.once('close', () => {
        void shutdown(entry).catch(failure => console.error('[browser-inspector] window cleanup failed', failure))
      })
      window.once('closed', () => {
        void shutdown(entry).catch(failure => console.error('[browser-inspector] window cleanup failed', failure))
      })
      window.webContents.once('render-process-gone', (_event, details) => {
        void shutdown(entry, new Error(`DevTools renderer exited: ${details.reason}`))
          .catch(failure => console.error('[browser-inspector] renderer cleanup failed', failure))
      })
      const url = `${DEVTOOLS_URL}?ws=${encodeURIComponent(endpoint.slice('ws://'.length))}`
      let timeout: NodeJS.Timeout | undefined
      try {
        await Promise.all([
          window.loadURL(url),
          Promise.race([
            entry.relay.waitForAttachment(),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('DevTools frontend did not attach to Chromium')), ATTACH_TIMEOUT_MS)
            })
          ])
        ])
      } finally { if (timeout) clearTimeout(timeout) }
      if (entry.closed) throw new Error('Chromium target closed while opening DevTools')
      window.show()
      publish({ targetId, status: 'open' })
    })().catch(async failure => {
      const error = failure instanceof Error ? failure : new Error(String(failure))
      await shutdown(entry, error)
      throw error
    })
    return entry.ready
  }

  const close = (targetId: string): Promise<void> => {
    const entry = entries.get(targetId)
    if (entry) return shutdown(entry)
    if (states.has(targetId)) publish({ targetId, status: 'closed' })
    return Promise.resolve()
  }

  return {
    open,
    close,
    targetDestroyed: close,
    inspect(targetId) {
      const state = states.get(targetId)
      return state ? { status: state.status, ...(state.error ? { error: state.error } : {}) } : { status: 'closed' }
    },
    async dispose() {
      disposed = true
      try { await Promise.all([...entries.values()].map(entry => shutdown(entry))) }
      finally { states.clear() }
    }
  }
}
