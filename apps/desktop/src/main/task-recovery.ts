import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  STARTUP_TASK_RECOVERY_MS,
  TASK_RECOVERY_OUTCOME,
  TASK_RECOVERY_STATUS,
  type TaskRecoveryOutcome,
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
  private active: { token: string; sessionId: string } | null = null
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
      (this.marker?.state === RECOVERY_RECORD.skipped && this.marker.sessionId === sessionId)
    )
      return TASK_RECOVERY_STATUS.home
    return this.attempted ? TASK_RECOVERY_STATUS.attempted : TASK_RECOVERY_STATUS.eligible
  }

  begin(sessionId: string): string | null {
    if (this.status(sessionId) !== TASK_RECOVERY_STATUS.eligible) return null
    this.attempted = true
    if (!this.write({ sessionId, state: RECOVERY_RECORD.pending })) return null
    const token = randomUUID()
    this.active = { sessionId, token }
    for (const listener of this.attemptListeners) listener(token)
    this.log('started')
    return token
  }

  pendingToken(): string | null {
    return this.active?.token ?? null
  }

  subscribeAttempt(listener: (token: string | null) => void): () => void {
    this.attemptListeners.add(listener)
    return () => this.attemptListeners.delete(listener)
  }

  finish(token: string, outcome: TaskRecoveryOutcome): boolean {
    const active = this.active
    if (!active || active.token !== token) return false
    this.active = null
    for (const listener of this.attemptListeners) listener(null)
    const written = this.write(
      outcome === TASK_RECOVERY_OUTCOME.restored
        ? null
        : { sessionId: active.sessionId, state: RECOVERY_RECORD.skipped }
    )
    if (written) this.log(outcome)
    return written
  }

  reopenHome(token: string): boolean {
    if (this.pendingToken() !== token) return false
    this.forceHome = true
    this.finish(token, TASK_RECOVERY_OUTCOME.skipped)
    return true
  }

  manualOpened(sessionId: string): boolean {
    if (this.active) return false
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
      if (!canPresent()) return
      log('reopening the renderer at home')
      void reopen().catch((error: unknown) => log(`native recovery failed: ${String(error)}`))
    })
  }

  const offer = async (watchdogExpired = false): Promise<void> => {
    const token = recovery.pendingToken()
    if (!token || offered || !canPresent()) return
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
    waitingForRendererExit = false
    if (reopenJob) clearImmediate(reopenJob)
    reopenJob = null
    dialog?.abort()
    const token = recovery.pendingToken()
    if (token) recovery.reopenHome(token)
  }
  window.on('unresponsive', () => void offer())
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
