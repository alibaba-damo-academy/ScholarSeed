export const STARTUP_CHANNEL = 'scholarseed:startup'
export const STARTUP_RETRY_CHANNEL = 'scholarseed:startup-retry'
export const STARTUP_PHASE = {
  preparing: 'preparing',
  connecting: 'connecting',
  ready: 'ready',
  failed: 'failed',
} as const

export interface StartupSnapshot {
  generation: number
  revision: number
  phase: (typeof STARTUP_PHASE)[keyof typeof STARTUP_PHASE]
  apiBase: string | null
  error: string | null
  retryable: boolean
}

export const INITIAL_STARTUP: StartupSnapshot = {
  generation: 0,
  revision: 0,
  phase: STARTUP_PHASE.preparing,
  apiBase: null,
  error: null,
  retryable: false,
}

export class StartupState {
  private value: StartupSnapshot = INITIAL_STARTUP

  constructor(private readonly publish: (snapshot: StartupSnapshot) => void) {}

  snapshot(): StartupSnapshot {
    return this.value
  }

  begin(): number {
    this.update({
      generation: this.value.generation + 1,
      phase: STARTUP_PHASE.connecting,
      apiBase: null,
      error: null,
      retryable: false,
    })
    return this.value.generation
  }

  complete(generation: number, apiBase: string): void {
    if (generation !== this.value.generation) return
    const endpoint = new URL(apiBase)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
      throw new Error('startup_endpoint_invalid')
    this.update({ phase: STARTUP_PHASE.ready, apiBase, error: null, retryable: false })
  }

  fail(generation: number, error: string, retryable = true): void {
    if (generation !== this.value.generation) return
    this.update({ phase: STARTUP_PHASE.failed, apiBase: null, error, retryable })
  }

  private update(patch: Partial<StartupSnapshot>): void {
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 }
    this.publish(this.value)
  }
}
