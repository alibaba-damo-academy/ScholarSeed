import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { CompilerResources } from './toolchain.ts'

const MAX_BYTES = 33 // Status byte plus the exact maintenance generation.
const DEADLINE_MS = 40_000
const TOOLCHAIN_OPERATION = 'toolchain'
const MAX_COMMAND_BYTES = 4096
const SKILL_PYTHON_OPERATION = 'skill-python'
const IDLE_OPERATION = 'quiesce_if_idle'
const UPDATE_OPERATION = 'prepare_update'
type ControlCloseReason = 'closed' | 'connection_timeout' | 'response_timeout' | 'startup_timeout'
type ControlCommand =
  | {
      operation: 'quiesce' | typeof IDLE_OPERATION | typeof UPDATE_OPERATION | 'resume' | 'exit'
      generation: string | null
    }
  | { operation: typeof TOOLCHAIN_OPERATION; ready: boolean; resources: CompilerResources | null }
  | { operation: typeof SKILL_PYTHON_OPERATION; ready: boolean }

export interface BackendConnectionDiagnostic {
  readonly schema: 1
  readonly component: 'backend-control'
  readonly attemptId: string
  readonly event:
    | 'listen_started'
    | 'listening'
    | 'peer_accepted'
    | 'authentication_timeout'
    | 'authentication_oversize'
    | 'authentication_rejected'
    | 'authenticated'
    | 'request'
    | 'response_received'
    | 'failed'
    | 'closed'
  readonly operation: ControlCommand['operation'] | null
  readonly reason: ControlCloseReason | null
  readonly authenticated: boolean
  readonly elapsedMs: number
  readonly port?: number
  readonly status?: number
  readonly stage?: 'listen' | 'socket'
  readonly code?: string
}

// Only an exact refusal receipt proves this request retained no maintenance.
export class BackendMaintenanceRejected extends Error {}

// Capability delivered only on the child's inherited stdin, never argv/env/logs.
// This main-process connection carries no renderer or HTTP request surface.
export class BackendControl {
  private readonly token = randomBytes(32)
  private server: Server | null = null
  private socket: Socket | null = null
  private candidates = new Set<Socket>()
  private stopped = false
  private used = false
  private connected: Promise<void>
  private resolveConnected!: () => void
  private rejectConnected!: (error: Error) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private header = Buffer.alloc(0)
  private chunks: Buffer[] = []
  private expected = 0
  private received = 0
  private requests: Promise<unknown> = Promise.resolve()
  private pending: {
    operation: ControlCommand['operation']
    resolve: (bytes: Buffer) => void
    reject: (error: Error) => void
  } | null = null

  private readonly attemptId = randomUUID()
  private readonly started = performance.now()

  constructor(
    private readonly diagnostic: (event: BackendConnectionDiagnostic) => void = () => {}
  ) {
    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve
      this.rejectConnected = reject
    })
    void this.connected.catch(() => {})
  }

  private report(
    event: BackendConnectionDiagnostic['event'],
    reason: ControlCloseReason | null = null,
    details: Pick<BackendConnectionDiagnostic, 'port' | 'status' | 'stage' | 'code'> = {}
  ): void {
    try {
      this.diagnostic(
        Object.freeze({
          ...details,
          schema: 1,
          component: 'backend-control',
          attemptId: this.attemptId,
          event,
          operation: this.pending?.operation ?? null,
          reason,
          authenticated: this.used,
          elapsedMs: Math.max(0, Math.floor(performance.now() - this.started)),
        })
      )
    } catch {
      /* Observation cannot change control authority. */
    }
  }

  async listen(): Promise<Buffer> {
    if (this.server || this.stopped) throw new Error('private backend control unavailable')
    this.report('listen_started')
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    server.on('error', (error) => {
      this.failure('listen', error)
      this.close()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('private backend listener unavailable')
    this.report('listening', null, { port: address.port })
    server.unref()
    return Buffer.from(
      JSON.stringify({ version: 1, port: address.port, token: this.token.toString('hex') }) + '\n'
    )
  }

  // Bound connection establishment when the first request needs the channel.
  launched(): void {
    if (!this.socket && !this.stopped && !this.timer)
      this.timer = setTimeout(() => this.close('connection_timeout'), DEADLINE_MS)
  }

  private accept(socket: Socket): void {
    if (this.used || this.stopped || this.candidates.size >= 8) {
      socket.destroy()
      return
    }
    this.report('peer_accepted')
    this.candidates.add(socket)
    socket.unref()
    socket.setTimeout(10_000, () => {
      this.report('authentication_timeout')
      socket.destroy()
    })
    let greeting = Buffer.alloc(0)
    const authenticate = (chunk: Buffer): void => {
      greeting = Buffer.concat([greeting, chunk])
      if (greeting.length > 256) {
        this.report('authentication_oversize')
        greeting.fill(0)
        socket.destroy()
        return
      }
      const end = greeting.indexOf(10)
      if (end < 0) return
      try {
        if (end !== greeting.length - 1 || this.used || this.stopped) throw new Error()
        const expected = Buffer.from(JSON.stringify({ token: this.token.toString('hex') }) + '\n')
        const authenticated =
          greeting.length === expected.length && timingSafeEqual(greeting, expected)
        expected.fill(0)
        if (!authenticated) throw new Error()
        greeting.fill(0)
        this.token.fill(0)
        this.used = true
        this.socket = socket
        this.candidates.delete(socket)
        for (const other of this.candidates) other.destroy()
        this.candidates.clear()
        this.server?.close()
        socket.setTimeout(0)
        socket.removeListener('data', authenticate)
        socket.on('data', (bytes: Buffer) => this.receive(bytes))
        socket.on('close', () => this.close())
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        socket.write('ready\n')
        this.report('authenticated')
        this.resolveConnected()
      } catch {
        this.report('authentication_rejected')
        greeting.fill(0)
        socket.destroy()
      }
    }
    socket.on('error', (error) => {
      this.failure('socket', error)
      if (this.socket === socket) this.close()
      else socket.destroy()
    })
    socket.on('close', () => {
      greeting.fill(0)
      this.candidates.delete(socket)
    })
    socket.on('data', authenticate)
  }

  private receive(input: Buffer): void {
    if (!this.pending || this.stopped) {
      this.close()
      return
    }
    if (!this.expected) {
      const count = Math.min(4 - this.header.length, input.length)
      this.header = Buffer.concat([this.header, input.subarray(0, count)])
      input = input.subarray(count)
      if (this.header.length < 4) return
      this.expected = this.header.readUInt32BE()
      if (!this.expected || this.expected > MAX_BYTES) {
        this.close()
        return
      }
    }
    if (this.received + input.length > this.expected) {
      this.close()
      return
    }
    this.chunks.push(Buffer.from(input))
    this.received += input.length
    if (this.received !== this.expected) return
    const response = Buffer.concat(this.chunks, this.expected)
    const pending = this.pending
    this.report('response_received', null, { status: response[0] })
    this.pending = null
    this.resetFrame()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (response[0] !== 1) {
      const knownRefusal =
        response.length === 1 &&
        response[0] === 0 &&
        (pending.operation === 'quiesce' ||
          pending.operation === IDLE_OPERATION ||
          pending.operation === UPDATE_OPERATION)
      response.fill(0)
      if (knownRefusal)
        pending.reject(new BackendMaintenanceRejected('private backend maintenance refused'))
      else {
        this.close()
        pending.reject(new Error('private backend request outcome unavailable'))
      }
    } else pending.resolve(response)
  }

  protected request(command: ControlCommand): Promise<Buffer> {
    if (Buffer.byteLength(JSON.stringify(command) + '\n', 'utf8') > MAX_COMMAND_BYTES) {
      this.close()
      return Promise.reject(new Error('private backend command too large'))
    }
    const response = this.requests.then(() => this.send(command))
    this.requests = response.catch(() => undefined)
    return response
  }

  private async send(command: ControlCommand): Promise<Buffer> {
    // Startup owns the toolchain connection wait through its health budget and
    // closes this channel on failure/exit. A cold child may still be importing
    // or qualifying storage; it has not begun a control operation yet.
    if (command.operation !== TOOLCHAIN_OPERATION && command.operation !== SKILL_PYTHON_OPERATION)
      this.launched()
    await this.connected
    if (this.stopped || !this.socket || this.pending)
      throw new Error('private backend control unavailable')
    return new Promise((resolve, reject) => {
      this.pending = { operation: command.operation, resolve, reject }
      this.report('request')
      this.timer = setTimeout(() => this.close('response_timeout'), DEADLINE_MS)
      this.socket!.write(JSON.stringify(command) + '\n', (error) => {
        if (error) this.close()
      })
    })
  }

  async quiesce(): Promise<string> {
    return this.maintenance('quiesce')
  }

  async quiesceIfIdle(): Promise<string> {
    return this.maintenance(IDLE_OPERATION)
  }

  async prepareUpdate(): Promise<string> {
    return this.maintenance(UPDATE_OPERATION)
  }

  private async maintenance(
    operation: 'quiesce' | typeof IDLE_OPERATION | typeof UPDATE_OPERATION
  ): Promise<string> {
    const response = await this.request({ operation, generation: null })
    try {
      const generation = response.subarray(1).toString('ascii')
      if (
        response.length !== 33 ||
        !/^[a-f0-9]{32}$/.test(generation) ||
        !response.subarray(1).equals(Buffer.from(generation, 'ascii'))
      ) {
        this.close()
        throw new Error('private backend maintenance invalid')
      }
      return generation
    } finally {
      response.fill(0)
    }
  }

  async resume(generation: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(generation))
      throw new Error('invalid backend maintenance generation')
    const response = await this.request({ operation: 'resume', generation })
    const valid = response.length === 1
    response.fill(0)
    if (!valid) {
      this.close()
      throw new Error('private backend resume invalid')
    }
  }

  private resetFrame(): void {
    for (const chunk of this.chunks) chunk.fill(0)
    this.chunks = []
    this.header = Buffer.alloc(0)
    this.expected = 0
    this.received = 0
  }

  async toolchain(ready: boolean, resources: CompilerResources | null = null): Promise<void> {
    if (ready !== (resources !== null)) throw new Error('invalid toolchain preparation receipt')
    await this.preparation(TOOLCHAIN_OPERATION, ready, resources)
  }

  async skillPython(ready: boolean): Promise<void> {
    await this.preparation(SKILL_PYTHON_OPERATION, ready)
  }

  private async preparation(
    operation: typeof TOOLCHAIN_OPERATION | typeof SKILL_PYTHON_OPERATION,
    ready: boolean,
    resources: CompilerResources | null = null
  ): Promise<void> {
    const response = await this.request(
      operation === TOOLCHAIN_OPERATION
        ? {
            operation,
            ready,
            resources: resources
              ? { ...resources, fontDirectories: [...resources.fontDirectories] }
              : null,
          }
        : { operation, ready }
    )
    const valid = response.length === 1 && response[0] === 1
    response.fill(0)
    if (!valid) {
      this.close()
      throw new Error('private backend preparation receipt invalid')
    }
  }

  private failure(stage: 'listen' | 'socket', error: Error): void {
    const code = (error as NodeJS.ErrnoException).code
    // No exception message, stack, bootstrap or peer-supplied bytes.
    this.report('failed', null, {
      stage,
      code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown',
    })
  }

  close(reason: ControlCloseReason = 'closed'): void {
    if (this.stopped) return
    this.report('closed', reason)
    this.stopped = true
    this.token.fill(0)
    if (this.timer) clearTimeout(this.timer)
    this.server?.close()
    for (const candidate of this.candidates) candidate.destroy()
    this.candidates.clear()
    this.socket?.destroy()
    this.resetFrame()
    const error = new Error(`private backend control closed (${reason})`)
    this.rejectConnected(error)
    this.pending?.reject(error)
    this.pending = null
  }
}

export interface BackendControlEvent {
  readonly stage: 'quiesce' | 'prepare-update' | 'resume'
  readonly event: 'started' | 'finished'
  readonly result: 'started' | 'ok' | 'failed'
  readonly errorCode:
    | ''
    | 'quiesce_refused'
    | 'quiesce_unknown'
    | 'prepare_update_refused'
    | 'prepare_update_unknown'
    | 'resume_unknown'
  readonly elapsedMs: number
}

type MaintenanceControl = Pick<BackendControl, 'quiesce' | 'prepareUpdate' | 'resume'>

// Report only closed categories. Observer failure must not change transaction
// authority or hide the original failure.
export function observeBackendControl(
  control: MaintenanceControl,
  observe: (event: BackendControlEvent) => void
): MaintenanceControl {
  const emit = (event: BackendControlEvent): void => {
    try {
      observe(Object.freeze(event))
    } catch {
      /* diagnostics are not authority */
    }
  }
  const run = async <T>(
    stage: BackendControlEvent['stage'],
    operation: () => Promise<T>
  ): Promise<T> => {
    const started = performance.now()
    emit({ stage, event: 'started', result: 'started', errorCode: '', elapsedMs: 0 })
    try {
      const value = await operation()
      emit({
        stage,
        event: 'finished',
        result: 'ok',
        errorCode: '',
        elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
      })
      return value
    } catch (error) {
      const refused = error instanceof BackendMaintenanceRejected
      let errorCode: BackendControlEvent['errorCode']
      if (stage === 'resume') {
        errorCode = 'resume_unknown'
      } else if (stage === 'prepare-update') {
        errorCode = refused ? 'prepare_update_refused' : 'prepare_update_unknown'
      } else {
        errorCode = refused ? 'quiesce_refused' : 'quiesce_unknown'
      }
      emit({
        stage,
        event: 'finished',
        result: 'failed',
        errorCode,
        elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
      })
      throw error
    }
  }
  return {
    quiesce: () => run('quiesce', () => control.quiesce()),
    prepareUpdate: () => run('prepare-update', () => control.prepareUpdate()),
    resume: (generation) => run('resume', () => control.resume(generation)),
  }
}
