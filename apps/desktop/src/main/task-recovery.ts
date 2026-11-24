import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  STARTUP_TASK_RECOVERY_MS,
  TASK_RECOVERY_OUTCOME,
  TASK_RECOVERY_STATUS,
  type TaskRecoveryOutcome,
  type TaskRecoverySnapshot,
  type TaskRecoveryStatus,
} from '../window.ts'
import { readRecord, writeJson } from './journal.ts'

export const TASK_RECOVERY_FILENAME = 'startup-task-recovery.json'
const RECORD_MAX_BYTES = 16 * 1024
const SESSION_ID_MAX_LENGTH = 1024
const RENDERER_SETTLEMENT_GRACE_MS = 1_000
const RECOVERY_RECORD = { pending: 'pending', skipped: 'skipped' } as const

interface RecoveryRecord {
  state: (typeof RECOVERY_RECORD)[keyof typeof RECOVERY_RECORD]
  sessionId: string
}

interface RecoveryClaim {
  sessionId: string
  token: string
}

export function isRecoverySessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX_LENGTH
}

function readMarker(filename: string): RecoveryRecord | null {
  try {
    const bytes = readRecord(filename, RECORD_MAX_BYTES)
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (record === null) return null
    if (record && typeof record === 'object') {
      const { sessionId, state } = record as Partial<RecoveryRecord>
      if (
        isRecoverySessionId(sessionId) &&
        (state === RECOVERY_RECORD.pending || state === RECOVERY_RECORD.skipped)
      )
        return { sessionId, state }
    }
    throw new Error('Invalid recovery marker')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class TaskRecovery {
  private readonly filename: string
  private marker: RecoveryRecord | null | undefined
  private forceHome = false
  private attempted = false
  private prepared:
    (RecoveryClaim & { epoch: number; previousSkippedSessionId: string | null }) | null = null
  private active: RecoveryClaim | null = null
  private readonly attemptListeners = new Set<(token: string | null) => void>()

  constructor(
    profile: string,
    private readonly log: (message: string) => void
  ) {
    this.filename = join(profile, TASK_RECOVERY_FILENAME)
    try {
      this.marker = readMarker(this.filename)
      this.forceHome = this.marker?.state === RECOVERY_RECORD.pending
    } catch (error) {
      this.log(`marker read failed: ${String(error)}`)
    }
  }

  status(sessionId: string | null): TaskRecoveryStatus {
    // The first renderer to see an interrupted launch stays home, then the
    // durable skip applies only to that task on subsequent launches.
    if (this.forceHome && !this.active && this.marker?.state === RECOVERY_RECORD.pending) {
      this.write({ sessionId: this.marker.sessionId, state: RECOVERY_RECORD.skipped })
    }
    if (
      this.forceHome ||
      this.marker === undefined ||
      (sessionId !== null && this.skippedSessionId() === sessionId)
    )
      return TASK_RECOVERY_STATUS.home
    return this.attempted ? TASK_RECOVERY_STATUS.attempted : TASK_RECOVERY_STATUS.eligible
  }

  snapshot(sessionId: string | null): TaskRecoverySnapshot {
    const status = this.status(sessionId)
    return {
      status,
      skippedSessionId: this.skippedSessionId(),
      needsManualAcknowledgement: this.forceHome || this.marker === undefined,
      ...(this.prepared?.sessionId === sessionId ? { preparedToken: this.prepared.token } : {}),
    }
  }

  prepare(sessionId: unknown, epoch: number): void {
    if (this.prepared) {
      if (this.prepared.epoch !== epoch) this.reopenHome(this.prepared.token)
      return
    }
    if (
      !isRecoverySessionId(sessionId) ||
      this.forceHome ||
      this.attempted ||
      this.marker === undefined ||
      (this.marker?.state === RECOVERY_RECORD.skipped && this.marker.sessionId === sessionId)
    )
      return
    const previousSkippedSessionId = this.marker?.sessionId ?? null
    if (this.write({ sessionId, state: RECOVERY_RECORD.pending })) {
      this.prepared = { sessionId, token: randomUUID(), epoch, previousSkippedSessionId }
    }
  }

  begin(sessionId: string): string | null {
    const prepared = this.prepared
    if (!prepared || prepared.sessionId !== sessionId) return null
    this.attempted = true
    this.prepared = null
    this.active = { sessionId, token: prepared.token }
    for (const listener of this.attemptListeners) listener(prepared.token)
    this.log('started')
    return prepared.token
  }

  pendingToken(): string | null {
    return this.active?.token ?? null
  }

  reopenToken(): string | null {
    return this.pendingToken() ?? this.prepared?.token ?? null
  }

  subscribeAttempt(listener: (token: string | null) => void): () => void {
    this.attemptListeners.add(listener)
    return () => this.attemptListeners.delete(listener)
  }

  finish(token: string, outcome: TaskRecoveryOutcome): boolean {
    const claim = this.active ?? this.prepared
    if (
      !claim ||
      claim.token !== token ||
      (!this.active && outcome !== TASK_RECOVERY_OUTCOME.skipped)
    )
      return false
    this.attempted = true
    this.active = null
    this.prepared = null
    for (const listener of this.attemptListeners) listener(null)
    const written = this.write(
      outcome === TASK_RECOVERY_OUTCOME.restored
        ? null
        : { sessionId: claim.sessionId, state: RECOVERY_RECORD.skipped }
    )
    if (written) this.log(outcome)
    return written
  }

  reopenHome(token: string): boolean {
    if (this.reopenToken() !== token) return false
    this.finish(token, TASK_RECOVERY_OUTCOME.skipped)
    this.forceHome = true
    return true
  }

  manualOpened(sessionId: string): boolean {
    if (this.active || this.prepared) return false
    if (
      this.marker === null ||
      (this.marker?.state === RECOVERY_RECORD.skipped && this.marker.sessionId !== sessionId)
    ) {
      this.forceHome = false
      return true
    }
    // If a different task was opened, retain suppression while its location is saved.
    const written = this.write(
      this.marker && this.marker.sessionId !== sessionId
        ? { sessionId: this.marker.sessionId, state: RECOVERY_RECORD.skipped }
        : null
    )
    if (written) {
      this.forceHome = false
      this.log('manual open acknowledged')
    }
    return written
  }

  private skippedSessionId(): string | null {
    return this.marker?.state === RECOVERY_RECORD.skipped
      ? this.marker.sessionId
      : (this.prepared?.previousSkippedSessionId ?? null)
  }

  private write(marker: RecoveryRecord | null): boolean {
    try {
      writeJson(this.filename, marker)
      this.marker = marker
      return true
    } catch (error) {
      this.forceHome = true
      this.log(`marker write failed: ${String(error)}`)
      return false
    }
  }
}

interface RecoveryFallback {
  canPresent(): boolean
  prompt(signal: AbortSignal): Promise<boolean>
  reopen(): Promise<void>
  log(message: string): void
}

export function installTaskRecoveryFallback(
  window: BrowserWindow,
  recovery: TaskRecovery,
  { canPresent, prompt, reopen, log }: RecoveryFallback
): () => void {
  const contents = window.webContents
  let dialog: AbortController | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let offered = false
  let deferredOffer: boolean | null = null
  let waitingForRendererExit = false
  let reopenJob: ReturnType<typeof setImmediate> | null = null

  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }

  const scheduleReopen = (): void => {
    // Give Electron's renderer-exit handlers the rest of this turn to retire the old document.
    reopenJob = setImmediate(() => {
      reopenJob = null
      if (!canPresent()) {
        log('native recovery reopen skipped: window presentation unavailable')
        return
      }
      log('reopening the renderer at home')
      void reopen().catch((error: unknown) => log(`native recovery failed: ${String(error)}`))
    })
  }

  const offer = async (watchdogExpired = false): Promise<void> => {
    const token = watchdogExpired ? recovery.pendingToken() : recovery.reopenToken()
    if (!token || offered || !canPresent()) return
    // An unparented macOS message box blocks main and cannot be aborted.
    // Wait for the user to bring the workbench back before presenting its sheet.
    if (!window.isVisible() || window.isMinimized()) {
      if (deferredOffer === null) log('native recovery prompt deferred: window hidden or minimized')
      deferredOffer ??= watchdogExpired
      clearWatchdog()
      return
    }
    deferredOffer = null
    offered = true
    clearWatchdog()
    const controller = new AbortController()
    dialog = controller
    try {
      if (watchdogExpired) log('renderer did not settle before the recovery watchdog')
      const confirmed = await prompt(controller.signal)
      dialog = null
      if (!confirmed || controller.signal.aborted || !canPresent() || !recovery.reopenHome(token))
        return
      if (contents.isCrashed()) {
        scheduleReopen()
      } else {
        waitingForRendererExit = true
        contents.forcefullyCrashRenderer()
      }
    } catch (error) {
      waitingForRendererExit = false
      log(`native recovery failed: ${String(error)}`)
    } finally {
      dialog = null
    }
  }

  const unsubscribe = recovery.subscribeAttempt((token) => {
    clearWatchdog()
    if (!token) {
      deferredOffer = null
      dialog?.abort()
      return
    }
    // Electron may report a hang only after native input. Let the renderer
    // settle its own deadline first, then offer recovery from main.
    watchdog = setTimeout(
      () => void offer(true),
      STARTUP_TASK_RECOVERY_MS + RENDERER_SETTLEMENT_GRACE_MS
    )
  })

  const retire = (): void => {
    clearWatchdog()
    deferredOffer = null
    waitingForRendererExit = false
    if (reopenJob) clearImmediate(reopenJob)
    reopenJob = null
    dialog?.abort()
    const token = recovery.reopenToken()
    if (token) recovery.reopenHome(token)
  }
  const presentDeferred = (): void => {
    if (deferredOffer !== null) void offer(deferredOffer)
  }
  window.on('unresponsive', () => void offer())
  window.on('show', presentDeferred)
  window.on('restore', presentDeferred)
  window.once('closed', () => {
    unsubscribe()
    retire()
  })
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) retire()
  })
  return () => {
    if (!waitingForRendererExit) {
      void offer()
      return
    }
    waitingForRendererExit = false
    scheduleReopen()
  }
}
