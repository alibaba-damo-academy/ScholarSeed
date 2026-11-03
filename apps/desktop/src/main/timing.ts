import { StringDecoder } from 'node:string_decoder'

// Windows component diagnostics; never used to decide trust, reuse or progress.
export const COMPONENT_TIMING = Object.freeze({
  prefix: '[component-timing]',
  lineage: 'lineage',
  receipt: 'receipt',
  inventory: 'inventory',
  entry: 'entry',
  open: 'open',
  close: 'close',
  paths: 'paths',
  transfer: 'transfer',
  inspect: 'inspect',
  copy: 'copy',
  request: 'request',
  spawn: 'spawn',
  ready: 'ready',
  authorize: 'authorize',
  commit: 'commit',
  exit: 'exit',
  runtime: 'runtime',
  startup: 'startup',
  manifest: 'manifest',
  helper: 'helper',
  download: 'download',
  reuse: 'reuse',
  reused: 'reused',
  retained: 'retained',
  archive: 'archive',
  headers: 'headers',
  read: 'read',
  write: 'write',
  hash: 'hash',
  sync: 'sync',
  publish: 'publish',
  passed: 'passed',
  failed: 'failed',
  desktop: 'desktop',
  runtimePreparation: 'runtime-preparation',
  backendReady: 'backend-ready',
})
let timingSequence = 0
export interface ComponentTiming {
  kind: string
  version: string
  operation: string
  pid: number
  status: string
  last_phase: string
  elapsed_ms: number
  files: number
  bytes: number
  metrics: Record<string, { calls: number; elapsed_ms: number }>
}
export class ComponentTimer {
  private readonly attempt = ++timingSequence
  readonly event: ComponentTiming
  private readonly started = performance.now()
  private readonly pending = new Set<() => void>()
  private ended = false
  constructor(
    component: { kind: string; version: string },
    operation: string,
    private readonly log: (message: string) => void = console.error
  ) {
    this.event = {
      kind: component.kind,
      version: component.version,
      operation,
      pid: process.pid,
      status: COMPONENT_TIMING.passed,
      last_phase: '',
      elapsed_ms: 0,
      files: 0,
      bytes: 0,
      metrics: {},
    }
    this.progress('started')
  }
  private progress(event: string, phase?: string, phaseElapsedMs?: number): void {
    // Only coarse startup phases emit events; component timings remain aggregated.
    if (this.event.operation !== COMPONENT_TIMING.startup) return
    try {
      this.log(
        `${COMPONENT_TIMING.prefix} ${JSON.stringify({
          kind: this.event.kind,
          version: this.event.version,
          operation: this.event.operation,
          pid: process.pid,
          attempt: this.attempt,
          event,
          status: this.event.status,
          phase,
          elapsed_ms: performance.now() - this.started,
          phase_elapsed_ms: phaseElapsedMs,
        })}\n`
      )
    } catch {
      /* diagnostics must not affect startup */
    }
  }
  start(phase: string): () => void {
    this.event.last_phase = phase
    const started = performance.now()
    this.progress('phase-started', phase)
    let ended = false
    const finish = () => {
      if (ended) return
      ended = true
      this.pending.delete(finish)
      const value = this.event.metrics[phase] ?? { calls: 0, elapsed_ms: 0 }
      value.calls++
      value.elapsed_ms += performance.now() - started
      this.event.metrics[phase] = value
      this.progress('phase-finished', phase, performance.now() - started)
    }
    this.pending.add(finish)
    return finish
  }
  finish(failed: boolean): void {
    if (this.ended) return
    this.ended = true
    if (failed) this.event.status = COMPONENT_TIMING.failed
    for (const end of this.pending) end()
    this.event.elapsed_ms = performance.now() - this.started
    // A diagnostic sink failure must not change component installation behavior.
    try {
      this.log(
        `${COMPONENT_TIMING.prefix} ${JSON.stringify({
          ...this.event,
          attempt: this.attempt,
          event: 'finished',
        })}\n`
      )
    } catch {
      /* best effort diagnostics */
    }
  }
}

/** Bound each diagnostic line, not an OS pipe chunk containing many lines. */
export class ComponentDiagnostics {
  private readonly decoder = new StringDecoder('utf8')
  private partial = ''
  private oversized = false
  constructor(
    private readonly limit: number,
    private readonly log?: (line: string) => void
  ) {}
  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk))
  }
  finish(): void {
    this.consume(this.decoder.end())
    if (this.partial || this.oversized) this.consume('\n')
  }
  private consume(text: string): void {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      const part = text.slice(start, newline < 0 ? undefined : newline)
      if (!this.oversized) {
        if (Buffer.byteLength(this.partial) + Buffer.byteLength(part) > this.limit) {
          this.partial = ''
          this.oversized = true
        } else this.partial += part
      }
      if (newline < 0) return
      try {
        this.log?.(
          `[runtime] ${this.oversized ? '[oversized diagnostic omitted]' : this.partial}\n`
        )
      } catch {
        /* diagnostic sinks cannot affect the handoff */
      }
      this.partial = ''
      this.oversized = false
      start = newline + 1
    }
  }
}
