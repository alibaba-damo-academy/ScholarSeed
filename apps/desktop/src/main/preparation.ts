import type { LatestVersionMeta } from '../updates.ts'
import { isNewerRelease } from './version.ts'

const MINUTE_MS = 60_000
export interface PreparationPolicy {
  coalesceMs: number
  intervalMs: number
  recoveryBaseMs: number
  retryBaseMs: number
  retryMaxMs: number
  retryJitter: number
}
export const MACOS_PREPARATION_POLICY: Readonly<PreparationPolicy> = Object.freeze({
  coalesceMs: 3 * MINUTE_MS,
  intervalMs: 30 * MINUTE_MS,
  recoveryBaseMs: 5 * MINUTE_MS,
  retryBaseMs: 5 * MINUTE_MS,
  retryMaxMs: 60 * MINUTE_MS,
  retryJitter: 0.2,
})
const PREPARATION_POLICIES: Partial<Record<NodeJS.Platform, Readonly<PreparationPolicy>>> = {
  darwin: MACOS_PREPARATION_POLICY,
}
export function backgroundPreparationPolicy(
  platform: NodeJS.Platform
): Readonly<PreparationPolicy> | undefined {
  return PREPARATION_POLICIES[platform]
}
export type PreparationOrigin = 'manual' | 'background'
interface LegacyPreparationSchedule {
  notBefore: number
  failures: number
}

const ADMISSION_VERSION = 2
const BACKOFF_FACTOR = 2
export const PREPARATION_REASONS = Object.freeze({
  eligible: 'eligible',
  disabled: 'automatic-download-disabled',
  absent: 'no-candidate',
  stopped: 'stopped',
  committed: 'installation-committed',
  running: 'running',
  ready: 'already-ready',
  coalescing: 'coalescing',
  interval: 'success-interval',
  retry: 'failure-backoff',
  recovery: 'interruption-recovery',
  persistence: 'checkpoint-unavailable',
})
export interface PreparationDecision {
  reason: (typeof PREPARATION_REASONS)[keyof typeof PREPARATION_REASONS]
  at?: number
}
export interface PreparationAdmission {
  version: number
  pending: { candidate: LatestVersionMeta; since: number } | null
  inFlight: { candidateId: string; generation: number; startedAt: number } | null
  lastSuccess: { candidateId: string; at: number } | null
  retry: { at: number; failures: number }
  recovery: { at: number; interruptions: number }
}
function initialAdmission(): PreparationAdmission {
  return {
    version: ADMISSION_VERSION,
    pending: null,
    inFlight: null,
    lastSuccess: null,
    retry: { at: 0, failures: 0 },
    recovery: { at: 0, interruptions: 0 },
  }
}
function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function validAdmission(value: PreparationAdmission): boolean {
  return (
    value.version === ADMISSION_VERSION &&
    validTime(value.retry?.at) &&
    validTime(value.retry?.failures) &&
    validTime(value.recovery?.at) &&
    validTime(value.recovery?.interruptions) &&
    (value.pending === null ||
      (typeof value.pending?.candidate?.id === 'string' && validTime(value.pending.since))) &&
    (value.inFlight === null ||
      (typeof value.inFlight?.candidateId === 'string' &&
        validTime(value.inFlight.generation) &&
        validTime(value.inFlight.startedAt))) &&
    (value.lastSuccess === null ||
      (typeof value.lastSuccess?.candidateId === 'string' && validTime(value.lastSuccess.at)))
  )
}

export interface PreparationAttempt {
  candidate: LatestVersionMeta
  generation: number
  signal: AbortSignal
  isCurrent: () => boolean
  origin: PreparationOrigin
}

export interface PreparationCheckpoint {
  generation: number
  desiredRelease: LatestVersionMeta
  preparedRelease: string | null
  admission?: PreparationAdmission
}

export interface LegacyPreparationCheckpoint extends PreparationCheckpoint {
  schedule?: LegacyPreparationSchedule
}

export interface PreparationPersistence {
  load: () => LegacyPreparationCheckpoint | null
  save: (checkpoint: PreparationCheckpoint) => void
  failed: (error: unknown) => void
}

export class UpdatePreparation {
  private desired: LatestVersionMeta | null = null
  private generation = 0
  private worker: Promise<void> | null = null
  private controller: AbortController | null = null
  private committed = false
  private completed: string | null = null
  private stopped = false
  private paused = false
  private loaded = false
  private attemptedGeneration = -1
  private invalidatedGeneration = -1
  private observed: LatestVersionMeta | null = null
  private admission: PreparationAdmission = initialAdmission()
  private terminal: PreparationCheckpoint | null = null
  private pendingObservation: { pending: PreparationAdmission['pending'] } | null = null
  private origin: PreparationOrigin = 'manual'

  constructor(
    private readonly prepare: (attempt: PreparationAttempt) => Promise<boolean>,
    private readonly persistence?: PreparationPersistence,
    private readonly policy?: Readonly<PreparationPolicy>,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly changed?: () => void
  ) {}

  private checkpoint(
    candidate = this.desired ?? this.observed,
    generation = this.generation,
    completed = this.completed,
    admission = this.admission
  ): boolean {
    if (!candidate) return true
    try {
      this.persistence?.save({
        generation,
        desiredRelease: candidate,
        preparedRelease: completed,
        ...(this.policy ? { admission } : {}),
      })
      this.admission = admission
      this.changed?.()
      return true
    } catch (error) {
      this.persistence?.failed(error)
      return false
    }
  }

  private load(): boolean {
    if (this.loaded) return true
    const state = this.persistence?.load()
    // A checkpoint is diagnostic state, never authorization to install or restart.
    // A fresh server check must supply the candidate after every process restart.
    if (state && Number.isSafeInteger(state.generation) && state.generation >= 0)
      this.generation = state.generation
    if (this.policy && state) {
      const now = this.now()
      let admission = initialAdmission()
      if (state.admission && validAdmission(state.admission)) {
        admission = {
          ...state.admission,
          pending: state.admission.pending
            ? { ...state.admission.pending, since: Math.min(state.admission.pending.since, now) }
            : null,
          lastSuccess: state.admission.lastSuccess
            ? { ...state.admission.lastSuccess, at: Math.min(state.admission.lastSuccess.at, now) }
            : null,
          retry: {
            ...state.admission.retry,
            at: Math.min(state.admission.retry.at, now + this.policy.retryMaxMs),
          },
          recovery: {
            ...state.admission.recovery,
            at: Math.min(state.admission.recovery.at, now + this.policy.retryMaxMs),
          },
        }
        if (admission.inFlight) {
          const interruptions = admission.recovery.interruptions + 1
          admission = {
            ...admission,
            inFlight: null,
            recovery: { interruptions, at: now + this.delay(interruptions, true) },
          }
        }
      } else if (state.schedule && validTime(state.schedule.failures)) {
        if (state.schedule.failures > 0) {
          admission.retry = {
            failures: state.schedule.failures,
            at: validTime(state.schedule.notBefore)
              ? Math.min(state.schedule.notBefore, now + this.delay(state.schedule.failures))
              : now + this.delay(state.schedule.failures),
          }
        } else if (!state.preparedRelease) {
          admission.recovery = { interruptions: 1, at: now + this.policy.recoveryBaseMs }
        }
      }
      if (!this.checkpoint(state.desiredRelease, this.generation, state.preparedRelease, admission))
        return false
    }
    this.loaded = true
    return true
  }

  get candidate(): LatestVersionMeta | null {
    return this.desired
  }
  get running(): boolean {
    return this.worker !== null
  }
  get latest(): LatestVersionMeta | null {
    return this.observed
  }
  get nextBackgroundAt(): number {
    return this.decision(true).at ?? 0
  }

  observe(candidate: LatestVersionMeta): void {
    if (this.stopped || this.committed) return
    if (!this.load() || !this.flushTerminal()) return
    if (
      this.observed &&
      isNewerRelease(
        { version: this.observed.version, buildNumber: this.observed.build_number },
        { version: candidate.version, buildNumber: candidate.build_number }
      ) !== true
    ) {
      this.flushObservation()
      return
    }
    this.observed = candidate
    if (this.policy) {
      const pending =
        this.completed === candidate.id || (this.desired?.id === candidate.id && this.worker)
          ? this.admission.pending
          : {
              candidate,
              since:
                this.pendingObservation?.pending?.since ??
                this.admission.pending?.since ??
                this.now(),
            }
      this.pendingObservation = { pending }
      this.flushObservation()
    }
  }

  private flushObservation(): boolean {
    if (!this.pendingObservation) return true
    if (
      !this.checkpoint(undefined, undefined, undefined, {
        ...this.admission,
        pending: this.pendingObservation.pending,
      })
    )
      return false
    this.pendingObservation = null
    return true
  }

  decision(enabled: boolean): PreparationDecision {
    if (!enabled) return { reason: PREPARATION_REASONS.disabled }
    if (!this.load() || !this.flushTerminal() || !this.flushObservation())
      return { reason: PREPARATION_REASONS.persistence }
    if (this.stopped) return { reason: PREPARATION_REASONS.stopped }
    if (this.committed) return { reason: PREPARATION_REASONS.committed }
    if (this.worker) return { reason: PREPARATION_REASONS.running }
    if (!this.observed) return { reason: PREPARATION_REASONS.absent }
    if (this.completed === this.observed.id) return { reason: PREPARATION_REASONS.ready }
    let decision: PreparationDecision = { reason: PREPARATION_REASONS.eligible, at: this.now() }
    if (this.policy) {
      const gates: PreparationDecision[] = [
        { reason: PREPARATION_REASONS.retry, at: this.admission.retry.at },
        { reason: PREPARATION_REASONS.recovery, at: this.admission.recovery.at },
      ]
      if (this.completed) {
        if (this.admission.pending)
          gates.push({
            reason: PREPARATION_REASONS.coalescing,
            at: this.admission.pending.since + this.policy.coalesceMs,
          })
        if (this.admission.lastSuccess)
          gates.push({
            reason: PREPARATION_REASONS.interval,
            at: this.admission.lastSuccess.at + this.policy.intervalMs,
          })
      }
      for (const gate of gates) if ((gate.at ?? 0) > (decision.at ?? 0)) decision = gate
    }
    return decision
  }

  background(enabled: boolean): boolean {
    if (this.decision(enabled).reason !== PREPARATION_REASONS.eligible) return false
    const candidate = this.observed
    if (!enabled || !candidate || this.stopped || this.committed || this.worker) return false
    if (this.desired?.id === candidate.id) {
      if (this.completed === candidate.id) return false
      this.paused = false
      this.retry('background')
      return this.running
    }
    this.paused = false
    return this.offer(candidate, 'background')
  }

  private delay(count: number, recovery = false): number {
    if (!this.policy) return 0
    const first = recovery ? this.policy.recoveryBaseMs : this.policy.retryBaseMs
    const exponent = Math.min(count - 1, Math.ceil(Math.log2(this.policy.retryMaxMs / first)))
    const base = Math.min(this.policy.retryMaxMs, first * BACKOFF_FACTOR ** exponent)
    return Math.ceil(
      Math.min(
        this.policy.retryMaxMs,
        base * (1 + (recovery ? 0 : this.policy.retryJitter * this.random()))
      )
    )
  }

  private begin(candidate: LatestVersionMeta, generation: number): boolean {
    if (!this.load() || !this.flushTerminal() || !this.flushObservation()) return false
    const admission = this.policy
      ? {
          ...this.admission,
          pending:
            this.admission.pending?.candidate.id === candidate.id ? null : this.admission.pending,
          inFlight: { candidateId: candidate.id, generation, startedAt: this.now() },
        }
      : this.admission
    return this.checkpoint(candidate, generation, null, admission)
  }

  private finish(ready: boolean, candidate: LatestVersionMeta, generation: number): void {
    if (!this.policy) {
      if (ready && this.checkpoint(candidate, generation, candidate.id))
        this.completed = candidate.id
      return
    }
    let admission = this.admission
    if (this.policy) {
      const failures = admission.retry.failures + 1
      admission = {
        ...admission,
        inFlight: null,
        ...(ready
          ? {
              lastSuccess: { candidateId: candidate.id, at: this.now() },
              retry: { at: 0, failures: 0 },
              recovery: { at: 0, interruptions: 0 },
              pending: admission.pending?.candidate.id === candidate.id ? null : admission.pending,
            }
          : { retry: { failures, at: this.now() + this.delay(failures) } }),
      }
    }
    this.terminal = {
      desiredRelease: candidate,
      generation,
      preparedRelease: ready ? candidate.id : null,
      ...(this.policy ? { admission } : {}),
    }
    this.flushTerminal()
  }

  private flushTerminal(): boolean {
    const terminal = this.terminal
    if (!terminal) return true
    if (
      !this.checkpoint(
        terminal.desiredRelease,
        terminal.generation,
        terminal.preparedRelease,
        terminal.admission ?? this.admission
      )
    )
      return false
    this.completed =
      this.generation === terminal.generation && this.invalidatedGeneration !== terminal.generation
        ? terminal.preparedRelease
        : null
    this.terminal = null
    return true
  }

  private interrupted(candidate: LatestVersionMeta, generation: number): void {
    if (this.terminal) {
      this.flushTerminal()
      return
    }
    if (!this.policy || this.admission.inFlight?.generation !== generation) return
    const interruptions = this.admission.recovery.interruptions + 1
    this.checkpoint(undefined, undefined, undefined, {
      ...this.admission,
      inFlight: null,
      pending: this.admission.pending ?? { candidate, since: this.admission.inFlight.startedAt },
      recovery: {
        interruptions,
        at: interruptions > 1 ? this.now() + this.delay(interruptions - 1, true) : 0,
      },
    })
  }

  offer(candidate: LatestVersionMeta, origin: PreparationOrigin = 'manual'): boolean {
    if (this.committed || this.stopped) return false
    if (this.desired) {
      const newer = isNewerRelease(
        { version: this.desired.version, buildNumber: this.desired.build_number },
        { version: candidate.version, buildNumber: candidate.build_number }
      )
      if (newer !== true) return false
    }
    if (!this.load()) return false
    this.observe(candidate)
    if (!this.begin(candidate, this.generation + 1)) return false
    this.origin = origin
    this.desired = candidate
    this.generation += 1
    this.completed = null
    this.controller?.abort()
    this.start()
    return true
  }

  request(candidate: LatestVersionMeta): boolean {
    if (this.stopped || this.committed) return false
    if (this.desired?.id !== candidate.id) {
      if (!this.offer(candidate)) return false
    } else if (!this.worker && !this.retry()) return false
    this.paused = false
    this.origin = 'manual'
    this.start()
    return true
  }

  adopt(candidate: LatestVersionMeta): void {
    if ((this.desired && !this.policy) || this.worker || this.stopped || this.committed) return
    if (!this.load() || !this.flushTerminal()) return
    if (this.desired?.id === candidate.id && this.completed === candidate.id) return
    if (!this.checkpoint(candidate, this.generation, candidate.id)) return
    this.desired = candidate
    this.completed = candidate.id
  }

  async pause(): Promise<void> {
    this.flushTerminal()
    this.paused = true
    // A completed receipt still belongs to its original generation. Keep its
    // connection-loss callback current while pausing only future preparation.
    if (this.completed !== this.desired?.id && this.terminal?.preparedRelease !== this.desired?.id)
      this.generation += 1
    this.controller?.abort()
    await this.settled()
    if (this.desired && this.admission.inFlight)
      this.interrupted(this.desired, this.admission.inFlight.generation)
  }

  resume(origin: PreparationOrigin = 'manual'): void {
    if (!this.paused) return
    if (this.policy && this.desired && this.completed !== this.desired.id && !this.worker) {
      if (!this.begin(this.desired, this.generation + 1)) return
      this.generation += 1
    }
    this.paused = false
    this.origin = origin
    this.start()
  }

  /** A policy change revokes candidates, including lower-version replacement barriers. */
  async reset(): Promise<void> {
    if (this.committed || this.stopped) throw new Error('Preparation cannot change after handoff')
    this.paused = true
    this.generation += 1
    this.controller?.abort()
    await this.settled()
    this.desired = null
    this.observed = null
    this.completed = null
    this.terminal = null
    this.pendingObservation = null
    this.admission = initialAdmission()
    this.loaded = true
    this.paused = false
    this.changed?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.controller?.abort()
    await this.settled()
    if (this.desired && this.admission.inFlight)
      this.interrupted(this.desired, this.admission.inFlight.generation)
  }

  retry(origin: PreparationOrigin = 'manual'): boolean {
    if (!this.stopped && !this.committed && !this.worker && this.desired) {
      if (!this.begin(this.desired, this.generation + 1)) return false
      this.origin = origin
      this.completed = null
      this.generation += 1
      this.start()
      return true
    }
    return false
  }

  // A native preparation receipt lives only as long as its owning connection.
  // Invalidation may race the prepare promise's completion, so block this
  // generation as well as clearing completed. Only retry/new intent advances it.
  invalidate(id: string, generation: number): boolean {
    if (this.stopped || this.committed || this.desired?.id !== id || this.generation !== generation)
      return false
    this.invalidatedGeneration = generation
    this.completed = null
    if (this.terminal?.generation === generation)
      this.terminal = { ...this.terminal, preparedRelease: null }
    this.controller?.abort()
    this.checkpoint()
    return true
  }

  /** Pin the prepared release synchronously when the user requests restart. */
  claim(candidate: LatestVersionMeta): boolean {
    this.adopt(candidate)
    if (this.policy) this.paused = false
    else this.resume()
    return this.commit(candidate.id)
  }

  commit(id: string): boolean {
    if (
      this.committed ||
      this.stopped ||
      this.paused ||
      this.worker ||
      this.desired?.id !== id ||
      this.completed !== id
    )
      return false
    this.committed = true
    this.changed?.()
    return true
  }

  release(): void {
    this.committed = false
    this.changed?.()
  }

  async settled(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (!signal) return
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      while (this.worker) await Promise.race([this.worker, cancelled])
      signal?.throwIfAborted()
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }

  private start(): void {
    if (
      this.stopped ||
      this.paused ||
      this.worker ||
      this.generation === this.invalidatedGeneration ||
      !this.desired ||
      this.completed === this.desired.id
    )
      return
    // Schedule after assigning worker, including for synchronous prepare implementations.
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.persistence?.failed(error)
      })
      .finally(() => {
        this.worker = null
        // A new offer can arrive between drain's last await and this finalizer.
        // Only a new generation restarts here; a failure never spins a retry loop.
        if (this.generation !== this.attemptedGeneration) this.start()
        this.changed?.()
      })
  }

  private async drain(): Promise<void> {
    while (
      !this.stopped &&
      !this.paused &&
      this.desired &&
      !this.committed &&
      this.generation !== this.invalidatedGeneration
    ) {
      const candidate = this.desired
      const generation = this.generation
      this.attemptedGeneration = generation
      const controller = new AbortController()
      this.controller = controller
      const isCurrent = (): boolean =>
        generation === this.generation &&
        generation !== this.invalidatedGeneration &&
        !controller.signal.aborted
      let ready = false
      try {
        ready = await this.prepare({
          candidate,
          generation,
          signal: controller.signal,
          isCurrent,
          origin: this.origin,
        })
      } finally {
        if (this.controller === controller) this.controller = null
        if (isCurrent()) this.finish(ready, candidate, generation)
        else this.interrupted(candidate, generation)
      }
      if (!isCurrent()) continue
      return
    }
  }
}
