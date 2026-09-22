import type { OnboardingGroup } from '../../../../onboarding.ts'

export interface GuideRequest { group: OnboardingGroup; force?: boolean; projectId?: string; documentId?: string }
export interface GuideStep {
  id: string
  targets: readonly string[]
  extra?: readonly string[]
  before?: (signal: AbortSignal) => void | Promise<void>
  setup?: (signal: AbortSignal) => void | Promise<void>
  after?: (signal: AbortSignal) => void | Promise<void>
}
export interface GuideSnapshot {
  request: GuideRequest | null
  steps: readonly GuideStep[]
  index: number
  ready: boolean
  center: boolean
}
export interface GuidePort {
  seen(group: OnboardingGroup): boolean
  markSeen(group: OnboardingGroup): void
  valid(request: GuideRequest): boolean
  blocked(): boolean
  steps(group: OnboardingGroup): GuideStep[]
  prepare(step: GuideStep, signal: AbortSignal): Promise<boolean>
  cleanup(): void
  unavailable(): void
}
const EMPTY: GuideSnapshot = { request: null, steps: [], index: 0, ready: false, center: false }

/** One serial queue. Failed preconditions never consume the persisted first-use flag. */
export class GuideEngine {
  private state = EMPTY
  private queue: GuideRequest[] = []
  private listeners = new Set<() => void>()
  private flight: AbortController | null = null
  private advancing = false
  constructor(private port: GuidePort) {}
  snapshot = (): GuideSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<GuideSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  enqueue(request: GuideRequest): void {
    if (!request.force && (this.state.request?.force || this.state.center)) return
    if (this.state.request?.group === request.group || this.queue.some(item => item.group === request.group)) return
    this.queue.push(request)
  }
  async drain(): Promise<void> {
    if (this.state.request || this.state.center || this.port.blocked()) return
    const request = this.queue.shift()
    if (!request) return
    if ((!request.force && this.port.seen(request.group)) || !this.port.valid(request)) return this.drain()
    this.flight = new AbortController()
    this.publish({ request, steps: this.port.steps(request.group), index: 0, ready: false })
    await this.enter()
  }
  private async enter(): Promise<void> {
    const flight = this.flight, request = this.state.request
    if (!flight || !request) return
    if (!this.port.valid(request)) { this.cancel(); return }
    const step = this.state.steps[this.state.index]
    if (!step) { this.cancel(); return }
    this.publish({ ready: false })
    try {
      await step.before?.(flight.signal)
      if (flight.signal.aborted) return
      await step.setup?.(flight.signal)
      if (flight.signal.aborted) return
      const available = await this.port.prepare(step, flight.signal)
      if (flight.signal.aborted) return
      if (!this.port.valid(request)) { this.cancel(); return }
      if (!available) {
        // Missing real UI is skipped, never replaced with a mock control.
        const steps = this.state.steps.filter(item => item !== step)
        if (!steps.length || this.state.index >= steps.length) {
          this.port.unavailable()
          this.cancel()
          return
        }
        this.publish({ steps })
        await this.enter()
        return
      }
      this.port.markSeen(request.group)
      this.publish({ ready: true })
    } catch (error) {
      if (flight.signal.aborted) return
      this.port.unavailable()
      this.cancel()
      console.error('[onboarding] step failed', error)
    }
  }
  async next(): Promise<void> {
    if (!this.state.ready || !this.state.request || this.advancing) return
    this.advancing = true
    const flight = this.flight
    try {
      if (!flight) return
      await this.state.steps[this.state.index]?.after?.(flight.signal)
      if (flight?.signal.aborted) return
      if (this.state.index === this.state.steps.length - 1) this.finish()
      else { this.publish({ index: this.state.index + 1 }); await this.enter() }
    } catch (error) {
      if (!flight?.signal.aborted) {
        this.port.unavailable()
        this.cancel()
        console.error('[onboarding] step completion failed', error)
      }
    } finally { this.advancing = false }
  }
  finish(): void {
    const request = this.state.request
    if (!request || !this.state.ready) return
    this.port.markSeen(request.group)
    this.cancel()
  }
  cancel(): void {
    this.flight?.abort()
    this.flight = null
    this.port.cleanup()
    this.publish({ ...EMPTY, center: this.state.center })
  }
  openCenter(): void { this.cancel(); this.queue = []; this.publish({ center: true }) }
  closeCenter(): void { this.publish({ center: false }) }
  replay(request: GuideRequest): void {
    this.cancel()
    this.queue = [{ ...request, force: true }]
    this.publish({ center: false })
  }
  dispose(): void { this.flight?.abort(); this.queue = []; this.port.cleanup() }
}
