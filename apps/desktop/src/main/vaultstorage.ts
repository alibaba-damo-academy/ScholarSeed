import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { pythonExecutablePath } from '../../runtime/python.cjs'
import { BROWSER_ERROR } from '../browser.ts'

const VERSION = 1
const PREFIX_BYTES = 4
const BOOTSTRAP_HEADER_BYTES = 16 * 1024
const PAYLOAD_HARD_CAP_BYTES = 64 * 1024 * 1024
const CONTROL_DEADLINE_MS = 30_000
const HELPER_STOP_DEADLINE_MS = 1000
const MAX_IDENTIFIER = 128
const DIGEST = /^[a-f0-9]{64}$/
const FILE_ID = /^[a-f0-9]{1,32}$/
const IDENTIFIER = /^[A-Za-z0-9_-]+$/
const MODULE = 'service.cli.browser'
const STORE_KINDS = ['vault', 'downloads'] as const
const RESPONSE_COMMON = ['version', 'requestId', 'payloadLength']
const RESPONSE_FIELDS = {
  handshake: new Set([...RESPONSE_COMMON, 'sessionId', 'profileId', 'budgets']),
  read: new Set([...RESPONSE_COMMON, 'digest', 'token', 'operationId', 'sequence']),
  terminal: new Set([
    ...RESPONSE_COMMON,
    'operationId',
    'sequence',
    'verb',
    'outcome',
    'result',
    'durability',
    'resultPresence',
  ]),
  error: new Set([...RESPONSE_COMMON, 'code']),
}
const ERROR_CODES = new Set([
  'invalid',
  'conflict',
  'unknown',
  'quota',
  'unavailable',
  'busy',
  'result_retired',
])
const OUTCOMES = new Set(['committed', 'aborted', 'nochange'])
const DURABILITIES = new Set(['namespace-synced', 'file-flushed'])
const UTF8 = new TextDecoder('utf-8', { fatal: true })
export const STORE_QUEUE_LIMIT = 16
const STORE_ERROR = {
  busy: 'browser_storage_busy',
  revoked: 'browser_storage_unavailable',
} as const

export type StoreKind = (typeof STORE_KINDS)[number]
interface StoreBudgets {
  readonly version: typeof VERSION
  readonly headerBytes: number
  readonly payloadBytes: Readonly<Record<StoreKind, number>>
}
export interface StorageLaunchProjection {
  readonly python: string
  readonly cwd: string
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly profileId: string
}
export interface StoreObservation {
  bytes: Buffer
  digest: string | null
  token: string
  operationId: string
  sequence: number
}
export interface StoreTerminal {
  operationId: string
  sequence: number
  verb: 'replace' | 'remove'
  outcome: 'committed' | 'aborted' | 'nochange'
  resultPresence: 'present' | 'absent'
  result: { digest: string | null; identity: [string, string] | null }
  durability: 'namespace-synced' | 'file-flushed'
}
export interface StorageHelper {
  readonly exited: Promise<void>
  handshake(): Promise<void>
  read(kind: StoreKind): Promise<StoreObservation>
  replace(kind: StoreKind, observation: StoreObservation, bytes: Buffer): Promise<StoreTerminal>
  removeConfirmed(kind: StoreKind, observation: StoreObservation): Promise<StoreTerminal>
  inspect(kind: StoreKind, operationId: string, sequence: number): Promise<StoreTerminal>
  budget(kind: StoreKind): number
  close(): void
}
export interface StorePort {
  readonly kind: StoreKind
  readonly generation: number
  readonly budget: number
  current(): boolean
  read(current?: () => boolean): Promise<StoreObservation>
  replace(
    observation: StoreObservation,
    bytes: Buffer,
    current?: () => boolean
  ): Promise<StoreTerminal>
  removeConfirmed(observation: StoreObservation, current?: () => boolean): Promise<StoreTerminal>
  inspect(operationId: string, sequence: number, current?: () => boolean): Promise<StoreTerminal>
}
export interface StorageBackend {
  readonly ready: Promise<boolean>
  readonly stopping: boolean
  readonly storageLaunch: StorageLaunchProjection | null
}
export type StorageStatus =
  { available: true } | { available: false; code: typeof BROWSER_ERROR.desktopBridgeUnavailable }
interface ConsumerDependencies {
  enabled: boolean | undefined
  current(): boolean
  ensureBackend(): Promise<boolean>
  backend(): StorageBackend | null
  createHelper(projection: StorageLaunchProjection): StorageHelper
  publish(available: boolean): void
}

export function createStorageConsumer(dependencies: ConsumerDependencies) {
  let helper: StorageHelper | null = null
  let owner: StorageBackend | null = null
  let generation = 0
  let available = false
  let closed = false
  let queued = 0
  let draining = false
  let drainPromise: Promise<void> | null = null
  const activations = new Set<Promise<void>>()
  const exits = new Set<Promise<void>>()
  let tail: Promise<unknown> = Promise.resolve()
  const live = (expected: number, backend?: StorageBackend | null): boolean =>
    dependencies.enabled === true &&
    !closed &&
    !draining &&
    generation === expected &&
    dependencies.current() &&
    (backend === undefined ||
      (backend !== null && dependencies.backend() === backend && !backend.stopping))
  const retire = (): void => {
    const previouslyAvailable = available
    generation++
    available = false
    owner = null
    const retiring = helper
    helper = null
    retiring?.close()
    if (previouslyAvailable) dependencies.publish(false)
  }
  return {
    bind(kind: StoreKind): StorePort | null {
      if (!available || !live(generation, owner) || !helper || !STORE_KINDS.includes(kind))
        return null
      const expected = generation
      const backend = owner
      const owned = helper
      const current = () => available && helper === owned && live(expected, backend)
      const schedule = <Result>(
        operation: () => Promise<Result>,
        caller: () => boolean = () => true
      ): Promise<Result> => {
        if (!current() || !caller()) return Promise.reject(new Error(STORE_ERROR.revoked))
        if (queued >= STORE_QUEUE_LIMIT) return Promise.reject(new Error(STORE_ERROR.busy))
        queued++
        const result = tail.then(async () => {
          if (!current() || !caller()) throw new Error(STORE_ERROR.revoked)
          const value = await operation()
          if (!current() || !caller()) throw new Error(STORE_ERROR.revoked)
          return value
        })
        tail = result
          .catch(() => undefined)
          .finally(() => {
            queued--
          })
        return result
      }
      return Object.freeze({
        kind,
        generation: expected,
        budget: owned.budget(kind),
        current,
        read: (caller?: () => boolean) => schedule(() => owned.read(kind), caller),
        replace: (observed: StoreObservation, bytes: Buffer, caller?: () => boolean) => {
          const ciphertext = Buffer.from(bytes)
          return schedule(() => owned.replace(kind, observed, ciphertext), caller).finally(() =>
            ciphertext.fill(0)
          )
        },
        removeConfirmed: (observed: StoreObservation, caller?: () => boolean) =>
          schedule(() => owned.removeConfirmed(kind, observed), caller),
        inspect: (operationId: string, sequence: number, caller?: () => boolean) =>
          schedule(() => owned.inspect(kind, operationId, sequence), caller),
      })
    },
    available: () => available && live(generation, owner),
    status: (): StorageStatus =>
      available && live(generation, owner)
        ? { available: true }
        : { available: false, code: BROWSER_ERROR.desktopBridgeUnavailable },
    async activate(): Promise<void> {
      if (!live(generation)) return
      retire()
      const expected = generation
      let finishActivation!: () => void
      const activation = new Promise<void>((resolve) => {
        finishActivation = resolve
      })
      activations.add(activation)
      let owned: StorageHelper | null = null
      const release = (): void => {
        if (!owned) return
        const releasing = owned
        owned = null
        if (helper === releasing) {
          helper = null
          releasing.close()
        }
      }
      try {
        const ensured = await dependencies.ensureBackend()
        if (!ensured || !live(expected)) return
        const backend = dependencies.backend()
        if (!live(expected, backend) || !backend) return
        const ready = await backend.ready
        if (!ready || !live(expected, backend) || !backend.storageLaunch) {
          if (live(expected)) dependencies.publish(false)
          return
        }
        owned = dependencies.createHelper(backend.storageLaunch)
        helper = owned
        const launched = owned
        exits.add(launched.exited)
        void launched.exited.then(
          () => {
            exits.delete(launched.exited)
            if (helper === launched && live(expected, backend)) {
              retire()
            }
          },
          () => {
            // Preserve failed exit evidence; draining must not infer process death.
            if (helper === launched) retire()
          }
        )
        await owned.handshake()
        if (!live(expected, backend)) {
          release()
          return
        }
        await owned.read('vault')
        if (!live(expected, backend)) {
          release()
          return
        }
        await owned.read('downloads')
        if (!live(expected, backend)) {
          release()
          return
        }
        owner = backend
        available = true
        dependencies.publish(true)
      } catch {
        release()
        if (live(expected)) dependencies.publish(false)
      } finally {
        activations.delete(activation)
        finishActivation()
      }
    },
    revoke: retire,
    drain(): Promise<void> {
      if (drainPromise) return drainPromise
      draining = true
      retire()
      // Revocation blocks new work before observing these sets. In-flight
      // activation rechecks live before spawning, so it cannot add a late helper.
      drainPromise = (async () => {
        const results = await Promise.allSettled([...activations, tail, ...exits])
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            STORE_ERROR.revoked
          )
        draining = false
        drainPromise = null
      })()
      return drainPromise
    },
    close(): void {
      if (closed) return
      closed = true
      retire()
    },
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER &&
    IDENTIFIER.test(value)
  )
}
function digest(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && DIGEST.test(value))
}
function boundedBudgets(value: unknown): StoreBudgets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const budgets = value as Record<string, unknown>
  if (
    Object.keys(budgets).length !== 3 ||
    budgets.version !== VERSION ||
    !Number.isSafeInteger(budgets.headerBytes) ||
    Number(budgets.headerBytes) < 1 ||
    Number(budgets.headerBytes) > BOOTSTRAP_HEADER_BYTES ||
    !budgets.payloadBytes ||
    typeof budgets.payloadBytes !== 'object' ||
    Array.isArray(budgets.payloadBytes)
  )
    return null
  const payload = budgets.payloadBytes as Record<string, unknown>
  if (
    Object.keys(payload).length !== STORE_KINDS.length ||
    STORE_KINDS.some(
      (kind) =>
        !Object.hasOwn(payload, kind) ||
        !Number.isSafeInteger(payload[kind]) ||
        Number(payload[kind]) < 1 ||
        Number(payload[kind]) > PAYLOAD_HARD_CAP_BYTES
    )
  )
    return null
  return Object.freeze({
    version: VERSION,
    headerBytes: Number(budgets.headerBytes),
    payloadBytes: Object.freeze(
      Object.fromEntries(STORE_KINDS.map((kind) => [kind, Number(payload[kind])])) as Record<
        StoreKind,
        number
      >
    ),
  })
}
function strictJson(bytes: Buffer): Record<string, unknown> {
  const source = UTF8.decode(bytes)
  const value: unknown = JSON.parse(source)
  let position = 0
  const whitespace = (): void => {
    while (/\s/.test(source[position] ?? '') && position < source.length) position++
  }
  const string = (): string => {
    const start = position++
    while (position < source.length) {
      const character = source[position++]
      if (character === '\\') position++
      else if (character === '"') return JSON.parse(source.slice(start, position)) as string
    }
    throw new Error('browser_storage_invalid')
  }
  const scan = (): void => {
    whitespace()
    const character = source[position]
    if (character === '{') {
      position++
      whitespace()
      const keys = new Set<string>()
      while (source[position] !== '}') {
        const key = string()
        if (keys.has(key)) throw new Error('browser_storage_invalid')
        keys.add(key)
        whitespace()
        position++
        scan()
        whitespace()
        if (source[position] !== ',') break
        position++
        whitespace()
      }
      position++
    } else if (character === '[') {
      position++
      whitespace()
      while (source[position] !== ']') {
        scan()
        whitespace()
        if (source[position] !== ',') break
        position++
      }
      position++
    } else if (character === '"') string()
    else while (position < source.length && !/[\s,}\]]/.test(source[position])) position++
  }
  scan()
  whitespace()
  if (position !== source.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('browser_storage_invalid')
  return value as Record<string, unknown>
}

export class FixedStorageHelper implements StorageHelper {
  readonly exited: Promise<void>
  private readonly process: ChildProcessWithoutNullStreams
  private session: string | null = null
  private budgets: StoreBudgets | null = null
  private closed = false
  private chunks = Buffer.alloc(0)
  private header: Record<string, unknown> | null = null
  private pending: {
    id: string
    verb: string
    terminal: boolean
    kind?: StoreKind
    resolve(value: { header: Record<string, unknown>; bytes: Buffer }): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  } | null = null
  constructor(private readonly projection: StorageLaunchProjection) {
    if (!DIGEST.test(projection.profileId) || !projection.python || !projection.cwd)
      throw new Error('browser_storage_unavailable')
    this.process = spawn(pythonExecutablePath(projection.python), ['-B', '-m', MODULE], {
      cwd: projection.cwd,
      env: { ...projection.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => {
      this.process.once('exit', () => resolve())
      this.process.once('error', () => resolve())
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.process.stderr.on('data', () => undefined)
    this.process.on('error', () => this.close())
    this.process.on('exit', () => this.close())
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('browser_storage_unknown'))
    }
    this.process.stdin.destroy()
    this.process.stdout.destroy()
    this.process.stderr.destroy()
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill()
      const escalation = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null)
          this.process.kill('SIGKILL')
      }, HELPER_STOP_DEADLINE_MS)
      void this.exited.then(() => clearTimeout(escalation))
    }
    this.chunks = Buffer.alloc(0)
    this.header = null
    this.session = null
    this.budgets = null
  }
  private receive(chunk: Buffer): void {
    try {
      const pending = this.pending
      if (!pending || this.closed) throw new Error('browser_storage_invalid')
      const maximum = pending.kind ? (this.budgets?.payloadBytes[pending.kind] ?? 0) : 0
      const headerBudget = this.budgets?.headerBytes ?? BOOTSTRAP_HEADER_BYTES
      if (this.chunks.length + chunk.length > maximum + headerBudget + PREFIX_BYTES)
        throw new Error('browser_storage_quota')
      this.chunks = Buffer.concat([this.chunks, chunk])
      if (!this.header) {
        if (this.chunks.length < PREFIX_BYTES) return
        const length = this.chunks.readUInt32BE()
        if (!length || length > headerBudget) throw new Error('browser_storage_invalid')
        if (this.chunks.length < PREFIX_BYTES + length) return
        const header = strictJson(this.chunks.subarray(PREFIX_BYTES, PREFIX_BYTES + length))
        const schema =
          header.code !== undefined
            ? RESPONSE_FIELDS.error
            : pending.verb === 'handshake'
              ? RESPONSE_FIELDS.handshake
              : pending.terminal
                ? RESPONSE_FIELDS.terminal
                : RESPONSE_FIELDS.read
        if (
          Object.keys(header).length !== schema.size ||
          Object.keys(header).some((key) => !schema.has(key)) ||
          header.version !== VERSION ||
          header.requestId !== pending.id ||
          !Number.isSafeInteger(header.payloadLength) ||
          Number(header.payloadLength) < 0 ||
          Number(header.payloadLength) > maximum
        )
          throw new Error('browser_storage_invalid')
        this.header = header
        this.chunks = this.chunks.subarray(PREFIX_BYTES + length)
      }
      const length = Number(this.header.payloadLength)
      if (this.chunks.length < length) return
      if (this.chunks.length !== length) throw new Error('browser_storage_invalid')
      const header = this.header
      const bytes = this.chunks
      if (
        header.code !== undefined &&
        (typeof header.code !== 'string' || !ERROR_CODES.has(header.code) || bytes.length)
      )
        throw new Error('browser_storage_invalid')
      this.header = null
      this.chunks = Buffer.alloc(0)
      this.pending = null
      clearTimeout(pending.timer)
      if (header.code !== undefined) {
        pending.reject(new Error(`browser_storage_${String(header.code)}`))
      } else pending.resolve({ header, bytes })
    } catch {
      this.close()
    }
  }
  private request(
    verb: string,
    fields: Record<string, unknown> = {},
    bytes: Buffer = Buffer.alloc(0)
  ) {
    if (this.closed || this.pending) return Promise.reject(new Error('browser_storage_unavailable'))
    const id = randomBytes(32).toString('hex')
    const kind = fields.kind as StoreKind | undefined
    if (
      (kind && !STORE_KINDS.includes(kind)) ||
      bytes.length > (kind ? (this.budgets?.payloadBytes[kind] ?? 0) : 0)
    )
      return Promise.reject(new Error('browser_storage_quota'))
    const header = Buffer.from(
      JSON.stringify({
        version: VERSION,
        requestId: id,
        verb,
        profileId: this.projection.profileId,
        payloadLength: bytes.length,
        ...(this.session ? { sessionId: this.session } : {}),
        ...fields,
      }),
      'utf8'
    )
    if (header.length > (this.budgets?.headerBytes ?? BOOTSTRAP_HEADER_BYTES))
      return Promise.reject(new Error('browser_storage_quota'))
    const prefix = Buffer.alloc(PREFIX_BYTES)
    prefix.writeUInt32BE(header.length)
    return new Promise<{ header: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), CONTROL_DEADLINE_MS)
      this.pending = {
        id,
        verb,
        kind,
        terminal: verb === 'replace' || verb === 'remove' || fields.operationId !== undefined,
        resolve,
        reject,
        timer,
      }
      this.process.stdin.write(Buffer.concat([prefix, header, bytes]), (error) => {
        if (error) this.close()
      })
    })
  }
  async handshake(): Promise<void> {
    const { header, bytes } = await this.request('handshake')
    const budgets = boundedBudgets(header.budgets)
    if (
      !identifier(header.sessionId) ||
      header.profileId !== this.projection.profileId ||
      bytes.length ||
      !budgets
    ) {
      this.close()
      throw new Error('browser_storage_invalid')
    }
    this.session = header.sessionId
    this.budgets = budgets
  }
  budget(kind: StoreKind): number {
    return this.budgets?.payloadBytes[kind] ?? 0
  }
  async read(kind: StoreKind): Promise<StoreObservation> {
    if (!this.session) throw new Error('browser_storage_unavailable')
    const { header, bytes } = await this.request('read', { kind })
    if (
      !digest(header.digest) ||
      !identifier(header.token) ||
      !identifier(header.operationId) ||
      !Number.isSafeInteger(header.sequence) ||
      Number(header.sequence) < 1 ||
      (header.digest === null && bytes.length) ||
      (header.digest !== null && createHash('sha256').update(bytes).digest('hex') !== header.digest)
    ) {
      this.close()
      throw new Error('browser_storage_invalid')
    }
    return {
      bytes,
      digest: header.digest,
      token: header.token,
      operationId: header.operationId,
      sequence: Number(header.sequence),
    }
  }
  async replace(kind: StoreKind, observation: StoreObservation, bytes: Buffer) {
    return this.mutate('replace', kind, observation, bytes)
  }
  async removeConfirmed(kind: StoreKind, observation: StoreObservation) {
    return this.mutate('remove', kind, observation)
  }
  async inspect(kind: StoreKind, operationId: string, sequence: number): Promise<StoreTerminal> {
    if (
      !this.session ||
      !identifier(operationId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      throw new Error('browser_storage_invalid')
    const response = await this.request('read', { kind, operationId, sequence })
    return this.terminal(response, operationId, sequence)
  }
  private terminal(
    response: { header: Record<string, unknown>; bytes: Buffer },
    operationId: string,
    sequence: number
  ): StoreTerminal {
    const { header, bytes } = response
    const result = header.result as Record<string, unknown> | null
    if (
      bytes.length ||
      header.operationId !== operationId ||
      header.sequence !== sequence ||
      typeof header.outcome !== 'string' ||
      !OUTCOMES.has(header.outcome) ||
      typeof header.durability !== 'string' ||
      !DURABILITIES.has(header.durability) ||
      typeof header.verb !== 'string' ||
      !['replace', 'remove'].includes(header.verb) ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.keys(result).length !== 2 ||
      !('identity' in result) ||
      !('digest' in result) ||
      !digest(result.digest) ||
      (header.resultPresence === 'absent'
        ? result.digest !== null || result.identity !== null
        : header.resultPresence !== 'present' ||
          result.digest === null ||
          !Array.isArray(result.identity) ||
          result.identity.length !== 2 ||
          result.identity.some((part) => typeof part !== 'string' || !FILE_ID.test(part)))
    ) {
      this.close()
      throw new Error('browser_storage_invalid')
    }
    return header as unknown as StoreTerminal
  }
  private async mutate(
    verb: 'replace' | 'remove',
    kind: StoreKind,
    observed: StoreObservation,
    bytes: Buffer = Buffer.alloc(0)
  ) {
    if (!this.session || !digest(observed.digest) || !identifier(observed.token))
      throw new Error('browser_storage_invalid')
    const response = await this.request(
      verb,
      {
        kind,
        expectedDigest: observed.digest,
        token: observed.token,
        ...(verb === 'remove' ? { confirmDigest: observed.digest } : {}),
      },
      bytes
    )
    const terminal = this.terminal(response, observed.operationId, observed.sequence)
    if (
      terminal.verb !== verb ||
      (terminal.outcome !== 'aborted' &&
        (verb === 'remove'
          ? terminal.resultPresence !== 'absent'
          : terminal.result.digest !== createHash('sha256').update(bytes).digest('hex')))
    ) {
      this.close()
      throw new Error('browser_storage_invalid')
    }
    return terminal
  }
}
