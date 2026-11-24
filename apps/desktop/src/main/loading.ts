import type { BrowserWindow } from 'electron'
import { STARTUP_BUDGET_STEADY_MS } from './startupmarker.ts'

/** End a pending startup wait when its window can no longer host the Workbench. */
export async function waitForStartupWindow<T>(
  signal: AbortSignal,
  start: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const operation = new Promise<T>((resolve) => resolve(start()))
    const value = await Promise.race([cancelled, operation])
    signal.throwIfAborted()
    return value
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** The first main-frame load and first paint share one budget, independently of Serve. */
export async function loadStartupWindow(
  window: Pick<BrowserWindow, 'once' | 'removeListener'>,
  lifetime: AbortSignal,
  load: (signal: AbortSignal) => Promise<void>,
  onPainted: () => void
): Promise<void> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([lifetime, deadline.signal])
  const expiresAt = performance.now() + STARTUP_BUDGET_STEADY_MS
  const expire = (): void =>
    deadline.abort(
      new Error(
        `Main window navigation did not load and paint within ${STARTUP_BUDGET_STEADY_MS} ms`
      )
    )
  let onReady!: () => void
  const painted = new Promise<void>((resolve, reject) => {
    onReady = () => {
      if (performance.now() >= expiresAt) expire()
      if (signal.aborted) return
      try {
        onPainted()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    window.once('ready-to-show', onReady)
  })
  const timer = setTimeout(expire, STARTUP_BUDGET_STEADY_MS)
  try {
    await waitForStartupWindow(signal, async () => {
      const navigation = new Promise<void>((resolve) => resolve(load(signal)))
      await Promise.all([navigation, painted])
    })
    if (performance.now() >= expiresAt) expire()
    signal.throwIfAborted()
  } catch (error) {
    deadline.abort(error)
    throw error
  } finally {
    clearTimeout(timer)
    window.removeListener('ready-to-show', onReady)
  }
}
