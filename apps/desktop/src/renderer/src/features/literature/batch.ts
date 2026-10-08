import type { LiteratureDetail, LiteratureUpdate } from '../../contracts/literature'
import {
  classifyPaperMetaFailure,
  paperMetaFields,
  requiresConfirmation,
  selectPaperMetaQuery,
  type PaperMetaPayload,
  type PaperMetaQuery,
  type PaperMetaFailureLike
} from './metadata.ts'

export const METADATA_REQUEST_INTERVAL_MS = 1000
export const METADATA_BATCH_STATUS = {
  pending: 'pending', running: 'running', success: 'success', missing: 'missing',
  failed: 'failed', quota: 'quota', skipped: 'skipped', deferred: 'deferred', cancelled: 'cancelled'
} as const
export type MetadataStatus = typeof METADATA_BATCH_STATUS[keyof typeof METADATA_BATCH_STATUS]
export type MetadataOutcome = Exclude<MetadataStatus, 'pending' | 'running' | 'deferred' | 'cancelled'>
export interface MetadataEntry { id: string; title: string; status: MetadataStatus }
export interface MetadataSnapshot {
  running: boolean
  cancelling: boolean
  projectId?: string
  entries: readonly MetadataEntry[]
}
export interface MetadataPorts {
  get(id: string, projectId?: string): Promise<Pick<LiteratureDetail, 'doi' | 'arxiv' | 'title'>>
  fetch(query: PaperMetaQuery): Promise<PaperMetaPayload>
  save(id: string, update: LiteratureUpdate, projectId?: string): Promise<unknown>
}
export const METADATA_RETRY_STATUSES: ReadonlySet<MetadataStatus> = new Set([
  METADATA_BATCH_STATUS.failed, METADATA_BATCH_STATUS.quota,
  METADATA_BATCH_STATUS.deferred, METADATA_BATCH_STATUS.cancelled
])

export async function synchronizeMetadata(id: string, projectId: string | undefined, ports: MetadataPorts): Promise<MetadataOutcome> {
  const item = await ports.get(id, projectId)
  const query = selectPaperMetaQuery(item)
  if (!query || requiresConfirmation(query.dimension)) return METADATA_BATCH_STATUS.skipped
  const payload = await ports.fetch(query)
  const fields = paperMetaFields(payload)
  if (!Object.keys(fields).length) return METADATA_BATCH_STATUS.missing
  await ports.save(id, { fields, ...(payload.bib_type ? { bib_type: payload.bib_type } : {}) }, projectId)
  return METADATA_BATCH_STATUS.success
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function metadataFailure(reason: unknown): PaperMetaFailureLike | null {
  if (!(reason instanceof Object) || !('failure' in reason)) return null
  const failure = reason.failure
  if (!(failure instanceof Object) || !('code' in failure) || !('status' in failure)) return null
  return typeof failure.code === 'string' && typeof failure.status === 'number'
    ? { code: failure.code, status: failure.status } : null
}

export class MetadataBatchStore {
  private snapshot: MetadataSnapshot = { running: false, cancelling: false, entries: [] }
  private readonly listeners = new Set<() => void>()
  private active: Promise<void> | null = null
  private controller = new AbortController()

  constructor(
    private readonly process: (entry: MetadataEntry, projectId?: string) => Promise<MetadataOutcome>,
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = pause
  ) {}

  getSnapshot = (): MetadataSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(entries: readonly Pick<MetadataEntry, 'id' | 'title'>[], projectId?: string): Promise<void> {
    if (this.active) return this.active
    const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    this.snapshot = { running: true, cancelling: false, projectId,
      entries: unique.map((entry) => ({ ...entry, status: METADATA_BATCH_STATUS.pending })) }
    return this.execute()
  }

  retry(): Promise<void> {
    if (this.active) return this.active
    this.snapshot = { ...this.snapshot, running: true, cancelling: false,
      entries: this.snapshot.entries.map((entry) => METADATA_RETRY_STATUSES.has(entry.status)
        ? { ...entry, status: METADATA_BATCH_STATUS.pending } : entry) }
    return this.execute()
  }

  cancel(): void {
    if (!this.snapshot.running) return
    this.snapshot = { ...this.snapshot, cancelling: true }
    this.controller.abort()
    this.emit()
  }

  private execute(): Promise<void> {
    this.controller = new AbortController()
    const execution = this.drive()
    this.active = execution
    this.emit()
    void execution.finally(() => {
      this.active = null
      this.snapshot = { ...this.snapshot, running: false }
      this.emit()
    })
    return execution
  }

  private async drive(): Promise<void> {
    const pending = this.snapshot.entries.filter((entry) => entry.status === METADATA_BATCH_STATUS.pending)
    let quota = false
    let processed = false
    for (const entry of pending) {
      if (processed && !quota && !this.controller.signal.aborted) {
        await this.wait(METADATA_REQUEST_INTERVAL_MS, this.controller.signal)
      }
      if (this.controller.signal.aborted || quota) {
        this.setStatus(entry.id, quota ? METADATA_BATCH_STATUS.deferred : METADATA_BATCH_STATUS.cancelled)
        continue
      }
      this.setStatus(entry.id, METADATA_BATCH_STATUS.running)
      let outcome: MetadataOutcome
      try {
        outcome = await this.process(entry, this.snapshot.projectId)
      } catch (reason) {
        const kind = classifyPaperMetaFailure(metadataFailure(reason))
        outcome = kind === 'missing' ? METADATA_BATCH_STATUS.missing
          : kind === 'quota' ? METADATA_BATCH_STATUS.quota : METADATA_BATCH_STATUS.failed
      }
      this.setStatus(entry.id, outcome)
      quota = outcome === METADATA_BATCH_STATUS.quota
      processed = true
    }
  }

  private setStatus(id: string, status: MetadataStatus): void {
    this.snapshot = { ...this.snapshot, entries: this.snapshot.entries.map((entry) => entry.id === id ? { ...entry, status } : entry) }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
