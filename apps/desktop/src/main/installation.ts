import { randomUUID } from 'node:crypto'

import type { UpdateInstallation, UpdateInstallStep, UpdateProgress } from '../updates.ts'

export interface InstallationDiagnostic {
  phase: 'macos-install'
  event: 'step-start' | 'step-end' | 'cancel-requested' | 'preparation-result'
  updateId: string
  elapsedMs: number
  step?: UpdateInstallStep
  stepElapsedMs?: number
  timeoutMs?: number
  application?: UpdateInstallation['application']
  cancelling?: boolean
  result?: 'handoff' | 'manual' | 'cancelled' | 'failed'
}

/** One macOS preparation attempt. Only the renderer's clock ticks; main owns every transition. */
export class InstallationProgress {
  readonly updateId = randomUUID()
  private readonly startedAt = Date.now()
  private current: UpdateInstallation | undefined
  private readonly onAbort = (): void => {
    this.record('cancel-requested')
    if (this.current) this.publish({ ...this.current, cancelling: true })
  }

  constructor(
    private readonly onProgress: (progress: UpdateProgress) => void,
    readonly signal?: AbortSignal,
    private readonly diagnostic?: (event: InstallationDiagnostic) => void
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  step(
    step: UpdateInstallStep,
    timeoutMs?: number,
    application?: UpdateInstallation['application']
  ): void {
    // Cleanup must still run after cancellation. No new preparation work may start.
    if (step !== 'cleanup') this.signal?.throwIfAborted()
    if (this.current) this.record('step-end')
    this.publish({
      step,
      startedAt: this.startedAt,
      stepStartedAt: Date.now(),
      timeoutMs,
      application,
      cancelling: this.signal?.aborted ?? false,
    })
    this.record('step-start')
  }

  finish(result: NonNullable<InstallationDiagnostic['result']>): void {
    this.record('preparation-result', result)
  }

  private record(
    event: InstallationDiagnostic['event'],
    result?: InstallationDiagnostic['result']
  ): void {
    const now = Date.now()
    this.diagnostic?.({
      phase: 'macos-install',
      event,
      result,
      updateId: this.updateId,
      elapsedMs: now - this.startedAt,
      step: this.current?.step,
      stepElapsedMs: this.current ? now - this.current.stepStartedAt : undefined,
      timeoutMs: this.current?.timeoutMs,
      application: this.current?.application,
      cancelling: this.signal?.aborted ?? false,
    })
  }

  dispose(): void {
    this.signal?.removeEventListener('abort', this.onAbort)
  }

  private publish(installation: UpdateInstallation): void {
    this.current = installation
    this.onProgress({
      phase: 'installing',
      install_stage:
        installation.step === 'restarting'
          ? 'restarting'
          : installation.step === 'copying' || installation.application === 'staged'
            ? 'copying'
            : 'preparing',
      installation,
    })
  }
}
