export const PREVIEW_ARCHIVE = {
  delayMs: 2_000,
  writeFailure: 'preview_archive_write_unavailable',
  readFailure: 'preview_archive_read_unavailable',
  projectReadFailure: 'preview_archive_project_read_unavailable',
  recoveryPath: '/__preview/archives/recover',
  recoveryUnavailable: 'preview_archive_recovery_unavailable',
  historyFailure: 'preview_archive_history_unavailable',
  disposed: 'preview_archive_disposed',
} as const

export interface PreviewArchivePolicy {
  seed: 'sample' | 'empty'
  read: 'normal' | 'delayed' | 'failed'
  projectRead?: 'normal' | 'delayed' | 'failed' | 'fail-once'
  history: 'normal' | 'delayed' | 'failed' | 'empty'
  write: 'normal' | 'delayed' | 'fail-once'
}

export class PreviewArchiveError extends Error {
  readonly status: number
  constructor(code: string, status: number) { super(code); this.status = status }
}

export class PreviewArchive {
  readonly policy: PreviewArchivePolicy
  private disposed = false
  private failed = false
  private projectFailed = false
  private projectsRecovered = false
  private readonly pending = new Set<() => void>()

  constructor(policy: PreviewArchivePolicy) { this.policy = { ...policy } }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewArchiveError(PREVIEW_ARCHIVE.disposed, 410)
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewArchiveError(PREVIEW_ARCHIVE.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_ARCHIVE.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.active(signal)
  }

  async read(history = false, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    const mode = history ? this.policy.history : this.policy.read
    if (mode === 'failed') throw new PreviewArchiveError(history ? PREVIEW_ARCHIVE.historyFailure : PREVIEW_ARCHIVE.readFailure, 503)
    if (mode === 'delayed') await this.delay(signal)
  }

  async write(signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (this.policy.write === 'fail-once' && !this.failed) {
      this.failed = true
      throw new PreviewArchiveError(PREVIEW_ARCHIVE.writeFailure, 503)
    }
    if (this.policy.write === 'delayed') await this.delay(signal)
  }

  async readProjects(signal?: AbortSignal): Promise<void> {
    this.active(signal)
    const mode = this.projectsRecovered ? 'normal' : this.policy.projectRead ?? this.policy.read
    if (mode === 'failed' || (mode === 'fail-once' && !this.projectFailed)) {
      this.projectFailed = true
      throw new PreviewArchiveError(PREVIEW_ARCHIVE.projectReadFailure, 503)
    }
    if (mode === 'delayed') await this.delay(signal)
    this.active(signal)
  }

  recoverProjects(): void {
    this.active()
    if (this.policy.projectRead !== 'failed') throw new PreviewArchiveError(PREVIEW_ARCHIVE.recoveryUnavailable, 409)
    this.projectsRecovered = true
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
