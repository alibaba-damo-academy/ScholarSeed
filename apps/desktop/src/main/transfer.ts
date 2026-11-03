// Windows process handoff transport. Privileged operations and archive trust live
// in the fixed native helper, not in a shell command or renderer bridge.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { ComponentDiagnostics, ComponentTimer, COMPONENT_TIMING } from './timing.ts'
import { commitWithActivation, type HandoffAuthorization } from './update-authorization.ts'

const POLICY = Object.freeze({
  schema: 1,
  current: 'current',
  helper: 'handoff.exe',
  externalDirectory: 'ScholarSeedUpdates',
  requestPrefix: 'request-',
  timeout: 30 * 60_000,
  acknowledgementTimeout: 30_000,
  closeTimeout: 5_000,
  copyRetryMs: 100,
  eventBytes: 16 * 1024,
  sidSubauthorityMaximum: 0xffffffff,
})
export const NATIVE_UPDATE_LOG_FILE = 'native-update.log'
export interface ComponentProgress {
  kind: string
  phase: 'checking' | 'extracting' | 'publishing' | 'complete' | 'reused'
  files: number
  totalFiles: number
  bytes: number
  totalBytes: number
}
export function componentProgress(value: unknown): ComponentProgress {
  const p = value as ComponentProgress
  if (
    !p ||
    typeof p.kind !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(p.kind) ||
    !['checking', 'extracting', 'publishing', 'complete', 'reused'].includes(p.phase) ||
    ![p.files, p.totalFiles, p.bytes, p.totalBytes].every(
      (n) => Number.isSafeInteger(n) && n >= 0
    ) ||
    p.files > p.totalFiles ||
    p.bytes > p.totalBytes
  )
    throw new Error('Invalid Windows component progress')
  return p
}
type Operation = 'group' | 'prepare' | 'apply' | 'inspect'
interface Event {
  event: 'progress' | 'ready' | 'authorized' | 'started' | 'complete' | 'cancelled' | 'error'
  message?: string
  progress?: ComponentProgress
  packageSha256?: string
  packageBytes?: number
  principalSid?: string
  runtimeReady?: boolean
}
export interface TransferOptions {
  operation: Operation
  application: string
  packagePath?: string
  releaseEnvelope?: unknown
  restartArgs?: string[]
  /** Resolved by Desktop's active Home owner; native code must not guess Home. */
  diagnosticFile?: string
  signal?: AbortSignal
  log?: (message: string) => void
  onProgress?: (progress: ComponentProgress) => void
}

export function transferRequest(options: TransferOptions, root: string) {
  return {
    schema: POLICY.schema,
    operation: options.operation,
    root,
    packagePath: options.packagePath,
    releaseEnvelope: options.releaseEnvelope,
    mainPid: process.pid,
    restartArgs: options.restartArgs ?? [],
    diagnosticFile: options.operation === 'apply' ? options.diagnosticFile : undefined,
  }
}
export interface WindowsTransfer {
  readonly principalSid: string | undefined
  readonly runtimeReady: boolean | undefined
  /** Acquire a fresh grant after native preparation, immediately before commit. */
  start(authorize?: HandoffAuthorization): Promise<void>
  /** Only releases a handoff that has not been committed. */
  close(): Promise<void>
}

/** The coordinator may still be alive; callers must not resume or allow another attempt. */
export class WindowsHandoffExitUnconfirmed extends Error {
  constructor(options?: ErrorOptions) {
    super('Windows handoff cancellation exit is unconfirmed', options)
  }
}

export class WindowsHandoffCancelled extends Error {
  constructor() {
    super('Windows update elevation was cancelled')
  }
}

/** Ordered protocol reader. An unexpected event fails rather than skipping it. */
export class TransferEvents {
  private queue: Event[] = []
  private failure: Error | null = null
  private pending: { resolve: (event: Event) => void; reject: (error: Error) => void } | null = null

  constructor(private readonly onProgress?: (progress: ComponentProgress) => void) {}

  push(line: string): void {
    try {
      if (Buffer.byteLength(line) > POLICY.eventBytes)
        throw new Error('Handoff event exceeds limit')
      const event = JSON.parse(line) as Event
      if (
        !event ||
        !['progress', 'ready', 'authorized', 'started', 'complete', 'cancelled', 'error'].includes(
          event.event
        )
      )
        throw new Error('Invalid Windows handoff event')
      if (event.event === 'cancelled') throw new WindowsHandoffCancelled()
      if (event.event === 'error') throw new Error(`Windows handoff: ${event.message || 'failed'}`)
      if (this.failure) return
      if (event.event === 'progress') {
        const progress = componentProgress(event.progress)
        this.onProgress?.(progress)
        return
      }
      if (this.pending) {
        const pending = this.pending
        this.pending = null
        pending.resolve(event)
      } else {
        if (this.queue.length >= 4) throw new Error('Unexpected Windows handoff event stream')
        this.queue.push(event)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  fail(error: Error): void {
    this.failure ??= error
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.reject(this.failure)
    }
  }

  assertOpen(): void {
    if (this.failure) throw this.failure
    if (this.queue.length) throw new Error('Unexpected Windows handoff event before commit')
  }

  async expect(expected: Event['event']): Promise<Event> {
    const queued = this.queue.shift()
    if (!queued && this.failure) throw this.failure
    if (this.pending) throw new Error('Concurrent Windows handoff protocol read')
    const event =
      queued ??
      (await new Promise<Event>((resolve, reject) => {
        this.pending = { resolve, reject }
      }))
    if (event.event !== expected)
      throw new Error(`Windows handoff expected ${expected}, received ${event.event}`)
    return event
  }
}

function command(child: ChildProcessWithoutNullStreams, value: 'start' | 'commit'): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify({ command: value })}\n`, (error) =>
      error ? reject(error) : resolve()
    )
  })
}

export async function prepareWindowsTransfer(options: TransferOptions): Promise<WindowsTransfer> {
  if (process.platform !== 'win32') throw new Error('Windows handoff is Windows only')
  if (basename(options.application).toLowerCase() !== POLICY.current)
    throw new Error('Windows handoff requires the current application directory')
  const root = dirname(options.application)
  const local = process.env.LOCALAPPDATA
  if (!local) throw new Error('LOCALAPPDATA is unavailable for Windows handoff')
  const cache = join(local, POLICY.externalDirectory)
  const inside = relative(root, cache)
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
    throw new Error('Windows handoff cache must be outside the installation root')
  const timing = new ComponentTimer(
    { kind: COMPONENT_TIMING.transfer, version: options.operation },
    options.operation,
    options.log
  )
  let end = timing.start(COMPONENT_TIMING.copy)
  const executable = join(cache, POLICY.helper)
  const request = join(cache, `${POLICY.requestPrefix}${randomUUID()}.json`)
  const temporary = join(cache, `.${POLICY.helper}.${randomUUID()}`)
  let child: ChildProcessWithoutNullStreams
  try {
    await mkdir(cache, { recursive: true })
    await copyFile(join(options.application, 'resources', 'handoff', POLICY.helper), temporary)
    const deadline = Date.now() + POLICY.closeTimeout
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        await rename(temporary, executable)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || Date.now() >= deadline)
          throw error
        // An old coordinator may have just started this new application. It
        // releases the fixed cached executable when its restart call returns.
        await new Promise((resolve) => setTimeout(resolve, POLICY.copyRetryMs))
      }
    }
    end()
    end = timing.start(COMPONENT_TIMING.request)
    await writeFile(request, JSON.stringify(transferRequest(options, root)), { flag: 'wx' })
    options.signal?.throwIfAborted()
    end()
    end = timing.start(COMPONENT_TIMING.spawn)
    child = spawn(executable, ['--request', request], {
      cwd: cache,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    end()
  } catch (error) {
    timing.finish(true)
    await rm(request, { force: true })
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
  const events = new TransferEvents(options.onProgress)
  let committed = false
  let principalSid: string | undefined
  let runtimeReady: boolean | undefined
  let closed = false
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => events.push(line))
  child.on('error', (error) => events.fail(error))
  child.stdin.on('error', (error) => events.fail(error))
  // The helper emits bounded protocol errors on stdout. Keep stderr out of UI
  // protocol parsing, but retain diagnostics for failed preparation.
  const diagnostics = new ComponentDiagnostics(POLICY.eventBytes, options.log)
  child.stderr.on('data', (chunk) => diagnostics.push(chunk))
  child.stderr.once('end', () => diagnostics.finish())
  const exited = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      timing.finish(code !== 0)
      events.fail(new Error(`Windows handoff exited (${code ?? signal})`))
      lines.close()
      resolve()
      void rm(request, { force: true }).catch((error) =>
        options.log?.(`[runtime] handoff cleanup failed: ${String(error)}\n`)
      )
    })
  })
  const cancel = () => {
    if (committed) return
    events.fail(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('Windows handoff cancelled')
    )
    child.stdin.end()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    if (!committed) {
      events.fail(new Error('Windows handoff timed out before commit'))
      child.stdin.end()
    }
  }, POLICY.timeout)
  const detach = () => {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (committed) return Promise.resolve()
    if (closing) return closing
    closed = true
    detach()
    child.stdin.end()
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new WindowsHandoffExitUnconfirmed())
            }, POLICY.closeTimeout)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })()
    return closing
  }

  try {
    end = timing.start(COMPONENT_TIMING.ready)
    await events.expect('ready')
    end()
  } catch (error) {
    options.log?.(`[runtime] handoff preparation failed: ${String(error)}\n`)
    try {
      await close()
    } catch (cleanup) {
      if (cleanup instanceof WindowsHandoffExitUnconfirmed)
        throw new WindowsHandoffExitUnconfirmed({ cause: error })
      throw cleanup
    }
    throw error
  }
  return {
    get runtimeReady() {
      return runtimeReady
    },
    get principalSid() {
      return principalSid
    },
    async start(authorize = async () => () => {}) {
      if (closed || committed) throw new Error('Windows handoff is no longer available')
      options.signal?.throwIfAborted()
      end = timing.start(COMPONENT_TIMING.authorize)
      await command(child, 'start')
      await events.expect('authorized')
      end()
      options.signal?.throwIfAborted()
      let committedCommand: Promise<void> | undefined
      await commitWithActivation(authorize, (guard) => {
        options.signal?.throwIfAborted()
        if (closed || committed) throw new Error('Windows handoff is no longer available')
        events.assertOpen()
        guard()
        // Once commit is sent, the coordinator owns recovery/restart. A lost ACK
        // must never start a second backend while the privileged updater is alive.
        committed = true
        detach()
        end = timing.start(COMPONENT_TIMING.commit)
        committedCommand = command(child, 'commit')
      })
      let acknowledgement: ReturnType<typeof setTimeout> | undefined
      try {
        await committedCommand
        const acknowledgementEvent = await Promise.race([
          events.expect(options.operation === 'apply' ? 'started' : 'complete'),
          new Promise<never>((_, reject) => {
            acknowledgement = setTimeout(
              () => reject(new Error('Windows handoff acknowledgement timed out')),
              options.operation === 'apply' ? POLICY.acknowledgementTimeout : POLICY.timeout
            )
          }),
        ])
        end()
        end = timing.start(COMPONENT_TIMING.exit)
        if (options.operation === 'inspect') {
          const inspected = inspectionResult(acknowledgementEvent)
          runtimeReady = inspected.ready
          principalSid = inspected.principalSid
        } else if (options.operation !== 'apply') {
          principalSid = validatedToolPrincipal(acknowledgementEvent.principalSid)
        }
      } catch (error) {
        if (options.operation !== 'apply') {
          await exited
          throw error
        }
        options.log?.(`[update] handoff committed; acknowledgement unavailable: ${String(error)}\n`)
      } finally {
        clearTimeout(acknowledgement)
      }
      if (options.operation !== 'apply') await exited
      else child.unref()
    },
    close,
  }
}

export async function prepareWindowsRuntime(
  application: string,
  log: (message: string) => void,
  signal?: AbortSignal,
  onProgress?: (progress: ComponentProgress) => void
): Promise<string> {
  const principal = await prepareWindowsToolGroup(application, log, signal)
  const transfer = await prepareWindowsTransfer({
    operation: 'prepare',
    application,
    log,
    signal,
    onProgress,
  })
  try {
    await transfer.start()
    if (validatedToolPrincipal(transfer.principalSid) !== principal)
      throw new Error('Windows sandbox group changed during runtime preparation')
  } finally {
    await transfer.close()
  }
  return principal
}

export function validatedToolPrincipal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    /^S-1-5-21-(0|[1-9]\d*)-(0|[1-9]\d*)-(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(value)?.[0] !== value ||
    value
      .split('-')
      .slice(4)
      .some((part) => Number(part) > POLICY.sidSubauthorityMaximum)
  )
    throw new Error('Windows sandbox group result is invalid')
  return value
}

export async function prepareWindowsToolGroup(
  application: string,
  log: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const transfer = await prepareWindowsTransfer({ operation: 'group', application, log, signal })
  try {
    await transfer.start()
    return validatedToolPrincipal(transfer.principalSid)
  } finally {
    await transfer.close()
  }
}

export function inspectionResult(event: { runtimeReady?: unknown; principalSid?: unknown }): {
  ready: boolean
  principalSid?: string
} {
  if (typeof event.runtimeReady !== 'boolean') throw new Error('Invalid runtime inspection result')
  if (!event.runtimeReady) {
    if (event.principalSid !== undefined)
      throw new Error('Unready runtime inspection returned a principal')
    return { ready: false }
  }
  return { ready: true, principalSid: validatedToolPrincipal(event.principalSid) }
}

export async function inspectWindowsRuntime(
  application: string,
  log: (message: string) => void,
  signal?: AbortSignal
): Promise<string | undefined> {
  const transfer = await prepareWindowsTransfer({ operation: 'inspect', application, log, signal })
  try {
    await transfer.start()
    return transfer.runtimeReady ? validatedToolPrincipal(transfer.principalSid) : undefined
  } finally {
    await transfer.close()
  }
}
