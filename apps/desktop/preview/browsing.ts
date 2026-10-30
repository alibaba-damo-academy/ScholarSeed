import { posix } from 'node:path'
import type { PreviewFiles, PreviewFileEntry } from './files.ts'
import { PREVIEW_BROWSING } from './listing.ts'
import type { PreviewBrowsingPolicy, PreviewBrowsingRead } from './listing.ts'

export class PreviewBrowsingError extends Error {
  constructor(code: string, readonly status: number) { super(code) }
}

export interface PreviewBrowsingPage {
  entries: PreviewFileEntry[]
  total: number
  offset: number
}

function compare(left: PreviewFileEntry, right: PreviewFileEntry): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  const leftName = left.name.toLowerCase()
  const rightName = right.name.toLowerCase()
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
}

export class PreviewBrowsing {
  private readonly policy: Readonly<PreviewBrowsingPolicy>
  private readonly files: PreviewFiles
  private readonly failedPages = new Set<string>()
  private readonly pending = new Set<() => void>()
  private recovered = false
  private disposed = false

  constructor(files: PreviewFiles, policy: PreviewBrowsingPolicy = { seed: 'sample' }) {
    this.files = files
    this.policy = { ...policy }
    if (policy.seed === 'empty') {
      for (const entry of files.manifest()) files.delete(entry.path)
    }
    if (policy.seed === 'paged') {
      const seed = PREVIEW_BROWSING.seed
      const encoder = new TextEncoder()
      for (let index = 1; index <= seed.count; index++) {
        files.write(`${seed.prefix}${String(index).padStart(seed.digits, '0')}${seed.extension}`, encoder.encode(seed.text))
      }
      for (const sample of seed.nested) files.write(sample.path, encoder.encode(sample.text))
    }
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewBrowsingError(PREVIEW_BROWSING.disposed, 410)
  }

  private wait(signal?: AbortSignal): Promise<void> {
    this.active(signal)
    return new Promise((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewBrowsingError(PREVIEW_BROWSING.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_BROWSING.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  private async beforeRead(mode: PreviewBrowsingRead | undefined, failure: string, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (mode === 'failed' && !this.recovered) throw new PreviewBrowsingError(failure, 503)
    if (mode === 'delayed') await this.wait(signal)
    this.active(signal)
  }

  page(path = '', offset = 0): PreviewBrowsingPage {
    this.active()
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PreviewBrowsingError(PREVIEW_BROWSING.invalid, 422)
    const entries = this.files.list(path).sort(compare)
    const start = Math.min(offset, entries.length)
    return { entries: entries.slice(start, start + PREVIEW_BROWSING.pageSize), total: entries.length, offset: start }
  }

  async tree(path = '', offset = 0, signal?: AbortSignal): Promise<PreviewBrowsingPage> {
    this.active(signal)
    this.page(path, offset)
    const directory = posix.normalize(path) === '.' ? '' : posix.normalize(path).replace(/\/$/, '')
    const mode = offset > 0 ? this.policy.explorerMore : this.policy.explorerRead
    if (mode === 'fail-once') this.active(signal)
    else await this.beforeRead(mode, PREVIEW_BROWSING.explorerFailure, signal)
    this.active(signal)
    const page = this.page(directory, offset)
    const key = JSON.stringify([directory, page.offset])
    if (mode === 'fail-once' && page.entries.length && !this.failedPages.has(key)) {
      this.failedPages.add(key)
      throw new PreviewBrowsingError(PREVIEW_BROWSING.moreFailure, 503)
    }
    return page
  }

  async listing(signal?: AbortSignal): Promise<PreviewFileEntry[]> {
    await this.beforeRead(this.policy.listingRead, PREVIEW_BROWSING.listingFailure, signal)
    this.active(signal)
    const pending = ['']
    const entries: PreviewFileEntry[] = []
    while (pending.length) {
      const directory = pending.shift()!
      for (const entry of this.files.list(directory).sort(compare)) {
        entries.push(entry)
        if (entry.kind === 'dir') pending.push(entry.path)
      }
    }
    return entries
  }

  recover(): void {
    this.active()
    if (this.policy.listingRead !== 'failed' && this.policy.explorerRead !== 'failed') throw new PreviewBrowsingError(PREVIEW_BROWSING.recoveryUnavailable, 409)
    this.recovered = true
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
    this.failedPages.clear()
  }
}
