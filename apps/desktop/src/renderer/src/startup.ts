export const STARTUP_TASK_RECOVERY_MS = 15_000

export type StartupTaskRecoveryOutcome = 'restored' | 'skipped' | 'failed' | 'timeout'

export class StartupTaskRecovery {
  private readonly controller = new AbortController()
  private readonly deadline: number
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly settled: (outcome: StartupTaskRecoveryOutcome) => void,
    private readonly now: () => number = () => performance.now()
  ) {
    this.deadline = this.now() + STARTUP_TASK_RECOVERY_MS
    this.timer = setTimeout(() => this.finish('timeout'), STARTUP_TASK_RECOVERY_MS)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get current(): boolean {
    return !this.signal.aborted && this.now() < this.deadline
  }

  finish(outcome: StartupTaskRecoveryOutcome): void {
    if (this.signal.aborted) return
    const result = outcome === 'restored' && !this.current ? 'timeout' : outcome
    clearTimeout(this.timer)
    this.controller.abort()
    this.settled(result)
  }
}
