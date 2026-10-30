import type { EventEmitter } from 'node:events'
import { BROWSER_ERROR, PAGE_ZOOM_DEFAULT, PAGE_ZOOM_FACTORS, parseFindQuery } from '../browser.ts'
import type { FindQuery, FindState, PrintResult } from '../browser.ts'

const FAILURE_CODES = {
  printFailed: 'print_failed',
} as const

const PRINT_CANCELED_REASON = 'Print job canceled'
interface PageContents extends Pick<EventEmitter, 'on' | 'removeListener'> {
  isDestroyed(): boolean
  setZoomMode(mode: 'isolated'): void
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  findInPage(text: string, options: { forward: boolean; findNext: boolean }): number
  stopFindInPage(action: 'clearSelection'): void
  print(options: { silent: false }, callback: (success: boolean, reason: string) => void): void
}
interface PageOptions {
  contents: PageContents
  current(): number | null
  acquirePrint(): (() => void) | null
  zoom?: number
}
export interface PageActions {
  find(query: FindQuery, publish: (state: FindState) => void): void
  stopFind(): void
  zoom(): number
  setZoom(factor: number): number
  print(): Promise<PrintResult>
  invalidate(): void
  crash(): void
  dispose(): void
}
export function pageFindShortcut(
  input: {
    type: string
    key: string
    control: boolean
    meta: boolean
    alt: boolean
    shift: boolean
    isComposing?: boolean
  },
  platform: NodeJS.Platform
): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isComposing &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === 'f' &&
    (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)
  )
}
export function createPageActions(options: PageOptions): PageActions {
  const { contents } = options
  let disposed = false
  let generation = 0
  let querySequence = 0
  let disposePrint: (() => void) | null = null
  let search: {
    requestId: number
    text: string
    generation: number
    epoch: number
    querySequence: number
    publish(state: FindState): void
  } | null = null
  const current = (): number => {
    const epoch = options.current()
    if (disposed || contents.isDestroyed() || epoch === null)
      throw new Error(BROWSER_ERROR.targetClosed)
    return epoch
  }
  const stop = (): void => {
    search = null
    if (!disposed && !contents.isDestroyed()) contents.stopFindInPage('clearSelection')
  }
  const found = (
    _event: unknown,
    result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
  ): void => {
    const pending = search
    if (
      !pending ||
      disposed ||
      contents.isDestroyed() ||
      options.current() !== pending.epoch ||
      generation !== pending.generation ||
      result.requestId !== pending.requestId
    )
      return
    pending.publish({
      querySequence: pending.querySequence,
      requestId: pending.requestId,
      phase: 'ready',
      ordinal: result.activeMatchOrdinal,
      count: result.matches,
      final: result.finalUpdate,
    })
  }
  contents.setZoomMode('isolated')
  contents.setZoomFactor(options.zoom ?? PAGE_ZOOM_DEFAULT)
  contents.on('found-in-page', found)
  return {
    find(input, publish) {
      const query = parseFindQuery(input)
      const epoch = current()
      if (query.querySequence <= querySequence) throw new Error(BROWSER_ERROR.invalidCommand)
      querySequence = query.querySequence
      if (!query.text) {
        stop()
        publish({ querySequence, requestId: 0, phase: 'empty', ordinal: 0, count: 0, final: true })
        return
      }
      const newSession = search?.text !== query.text
      search = null
      const requestId = contents.findInPage(query.text, {
        forward: query.direction === 'forward',
        findNext: newSession,
      })
      search = { requestId, text: query.text, generation, epoch, querySequence, publish }
      publish({ querySequence, requestId, phase: 'searching', ordinal: 0, count: 0, final: false })
    },
    stopFind() {
      stop()
      querySequence = 0
    },
    zoom: () => contents.getZoomFactor(),
    setZoom(factor) {
      current()
      if (!PAGE_ZOOM_FACTORS.some((value) => value === factor))
        throw new Error(BROWSER_ERROR.invalidCommand)
      contents.setZoomFactor(factor)
      return contents.getZoomFactor()
    },
    print() {
      return new Promise((resolve, reject) => {
        const epoch = current()
        const expected = generation
        const release = options.acquirePrint()
        if (!release) {
          reject(new Error(BROWSER_ERROR.printBusy))
          return
        }
        let pending = true
        const finish = (): boolean => {
          if (!pending) return false
          pending = false
          disposePrint = null
          release()
          return true
        }
        disposePrint = () => {
          if (finish()) reject(new Error(BROWSER_ERROR.targetClosed))
        }
        try {
          contents.print({ silent: false }, (success, reason) => {
            if (!finish()) return
            if (
              disposed ||
              contents.isDestroyed() ||
              generation !== expected ||
              options.current() !== epoch
            ) {
              reject(new Error(BROWSER_ERROR.targetClosed))
              return
            }
            resolve(
              success
                ? { status: 'success' }
                : reason === PRINT_CANCELED_REASON
                  ? { status: 'canceled' }
                  : { status: 'failed', error: FAILURE_CODES.printFailed }
            )
          })
        } catch {
          if (finish()) resolve({ status: 'failed', error: FAILURE_CODES.printFailed })
        }
      })
    },
    invalidate() {
      generation += 1
      stop()
      querySequence = 0
    },
    crash() {
      generation += 1
      search = null
      querySequence = 0
      disposePrint?.()
    },
    dispose() {
      if (disposed) return
      generation += 1
      stop()
      disposed = true
      disposePrint?.()
      contents.removeListener('found-in-page', found)
    },
  }
}
