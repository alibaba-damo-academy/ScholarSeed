import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

const FRAME_DELIMITER = 0
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const INITIAL_FRAME_BYTES = 4096
const COMMAND_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 5_000
const PROFILE_PREFIX = 'scholarseed-chromium-'
const PROFILE_REMOVAL_RETRIES = 3
const PROFILE_REMOVAL_RETRY_DELAY_MS = 100

export interface ChromiumMessage {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export const CHROMIUM_PROTOCOL_MESSAGES = {
  commandFailed: 'Chromium command failed',
  methodUnavailable: (method: string) => `Method ${method} is unavailable on a page DevTools relay`,
  methodControlled: (method: string) => `Method ${method} is controlled by browser settings`,
} as const

export class ChromiumProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
  }
}

interface PipeOptions {
  commandTimeoutMs?: number
  exitTimeoutMs?: number
  profileDirectory?: string
}

export interface ChromiumLaunchOptions {
  executablePath: string
  trustedRoot: string
  profile:
    { kind: 'persistent'; directory: string } | { kind: 'temporary'; parentDirectory: string }
  commandTimeoutMs?: number
  exitTimeoutMs?: number
}

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

export async function trustedChromiumExecutable(
  executablePath: string,
  trustedRoot: string
): Promise<string> {
  if (!isAbsolute(executablePath) || !isAbsolute(trustedRoot))
    throw new Error('Chromium paths must be absolute')
  const [root, executable, metadata] = await Promise.all([
    realpath(trustedRoot),
    realpath(executablePath),
    lstat(executablePath),
  ])
  const withinRoot = relative(root, executable)
  if (
    !withinRoot ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error('Chromium executable is outside the trusted resource root')
  }
  if (!metadata.isFile()) throw new Error('Chromium executable must be a regular file')
  if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) {
    throw new Error('Chromium executable must be an .exe on Windows')
  }
  if (process.platform !== 'win32' && !(metadata.mode & 0o111)) {
    throw new Error('Chromium executable is not executable')
  }
  return executable
}

export class ChromiumPipe {
  private readonly writer: Writable
  private readonly reader: Readable
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Set<(message: ChromiumMessage) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly commandTimeoutMs: number
  private readonly exitTimeoutMs: number
  private readonly profileDirectory?: string
  private readonly exited: Promise<void>
  private resolveExit!: () => void
  private cleanup?: Promise<void>
  private cleanupError?: Error
  private closing?: Promise<void>
  private frameBuffer = Buffer.alloc(0)
  private frameBytes = 0
  private nextId = 1
  private stopped = false
  private processExited = false

  constructor(
    private readonly child: ChildProcess,
    options: PipeOptions = {}
  ) {
    const writer = child.stdio[3]
    const reader = child.stdio[4]
    if (!writer || !('write' in writer) || !reader || typeof reader.on !== 'function') {
      throw new Error('Chromium debugging pipe requires child fd 3 and fd 4')
    }
    this.writer = writer as Writable
    this.reader = reader as Readable
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
    this.exitTimeoutMs = options.exitTimeoutMs ?? EXIT_TIMEOUT_MS
    this.profileDirectory = options.profileDirectory
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    reader.on('data', (chunk: Buffer) => this.read(chunk))
    reader.on('error', (error) => this.fail(error))
    reader.on('end', () => this.fail(new Error('Chromium debugging pipe ended')))
    reader.on('close', () => this.fail(new Error('Chromium debugging pipe closed')))
    writer.on('error', (error) => this.fail(error))
    child.once('error', (error) => {
      this.stop(error)
      if (!child.pid) this.markExited(error)
    })
    child.once('exit', (code, signal) =>
      this.markExited(new Error(`Chromium exited (code ${code}, signal ${signal})`))
    )
    if (child.exitCode !== null || child.signalCode !== null)
      this.markExited(new Error('Chromium already exited'))
  }

  onEvent(listener: (message: ChromiumMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    if (this.stopped)
      queueMicrotask(() => {
        if (this.closeListeners.has(listener)) listener(new Error('Chromium pipe is closed'))
      })
    return () => this.closeListeners.delete(listener)
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<unknown> {
    if (this.stopped || this.closing) return Promise.reject(new Error('Chromium pipe is closed'))
    return this.send(method, params, sessionId)
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const id = this.nextId++
    const frame = Buffer.from(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
    )
    if (frame.length > MAX_FRAME_BYTES)
      return Promise.reject(new Error('Chromium command exceeds frame limit'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chromium command ${method} timed out`))
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.writer.write(frame, (error) => {
        if (!error) return
        const command = this.pending.get(id)
        if (!command) return
        clearTimeout(command.timeout)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private read(chunk: Buffer): void {
    if (this.stopped) return
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf(FRAME_DELIMITER, start)
      const boundary = end === -1 ? chunk.length : end
      const part = chunk.subarray(start, boundary)
      if (this.frameBytes + part.length > MAX_FRAME_BYTES) {
        this.fail(new Error('Chromium debugging frame exceeds limit'))
        return
      }
      if (part.length) {
        const required = this.frameBytes + part.length
        if (required > this.frameBuffer.length) {
          const capacity = Math.min(
            MAX_FRAME_BYTES,
            Math.max(required, INITIAL_FRAME_BYTES, this.frameBuffer.length * 2)
          )
          const expanded = Buffer.allocUnsafe(capacity)
          this.frameBuffer.copy(expanded, 0, 0, this.frameBytes)
          this.frameBuffer = expanded
        }
        part.copy(this.frameBuffer, this.frameBytes)
        this.frameBytes = required
      }
      if (end === -1) return
      const frame = this.frameBuffer.subarray(0, this.frameBytes)
      this.frameBuffer = Buffer.alloc(0)
      this.frameBytes = 0
      start = end + 1
      try {
        const message = JSON.parse(frame.toString('utf8')) as {
          id?: number
          result?: unknown
          error?: { message?: string; code?: number; data?: unknown }
          method?: string
          params?: Record<string, unknown>
          sessionId?: string
        }
        if (typeof message.id === 'number') {
          const command = this.pending.get(message.id)
          if (!command) continue
          clearTimeout(command.timeout)
          this.pending.delete(message.id)
          if (message.error)
            command.reject(
              new ChromiumProtocolError(
                message.error.message ?? 'Chromium CDP error',
                message.error.code ?? -32000,
                message.error.data
              )
            )
          else command.resolve(message.result)
        } else if (typeof message.method === 'string') {
          const event = {
            method: message.method,
            params: message.params ?? {},
            sessionId: message.sessionId,
          }
          for (const listener of this.listeners) listener(event)
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Invalid Chromium debugging frame'))
        return
      }
      if (this.stopped) return
    }
  }

  private stop(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.frameBuffer = Buffer.alloc(0)
    this.frameBytes = 0
    for (const command of this.pending.values()) {
      clearTimeout(command.timeout)
      command.reject(error)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) listener(error)
  }

  private fail(error: Error): void {
    this.stop(error)
    if (!this.processExited) this.child.kill()
  }

  private markExited(error: Error): void {
    if (this.processExited) return
    this.stop(error)
    this.processExited = true
    this.resolveExit()
    if (this.profileDirectory) {
      this.cleanup = rm(this.profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: PROFILE_REMOVAL_RETRIES,
        retryDelay: PROFILE_REMOVAL_RETRY_DELAY_MS,
      }).catch((error) => {
        this.cleanupError =
          error instanceof Error ? error : new Error('Chromium profile cleanup failed')
        console.error('[browser-chromium] profile cleanup failed', this.cleanupError)
      })
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    if (!this.stopped) {
      try {
        await this.send('Browser.close', {})
      } catch {
        this.child.kill()
      }
    } else if (!this.processExited) {
      this.child.kill()
    }
    if (!this.processExited && !(await this.waitForExit())) this.child.kill()
    const exited = this.processExited || (await this.waitForExit())
    if (!exited) throw new Error('Chromium did not exit; profile retained')
    await this.cleanup
    if (this.cleanupError) throw this.cleanupError
  }

  private async waitForExit(): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.exitTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

export async function launchChromiumPipe(options: ChromiumLaunchOptions): Promise<ChromiumPipe> {
  const executable = await trustedChromiumExecutable(options.executablePath, options.trustedRoot)
  const profile = options.profile
  if (!profile || (profile.kind !== 'persistent' && profile.kind !== 'temporary')) {
    throw new Error('Chromium profile ownership must be explicit')
  }
  let profileDirectory: string
  let temporaryProfileDirectory: string | undefined
  if (profile.kind === 'persistent') {
    if (typeof profile.directory !== 'string' || !isAbsolute(profile.directory)) {
      throw new Error('Persistent Chromium profile directory must be absolute')
    }
    const metadata = await lstat(profile.directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Persistent Chromium profile must be a regular directory')
    }
    profileDirectory = await realpath(profile.directory)
    if (profileDirectory === parse(profileDirectory).root) {
      throw new Error('Persistent Chromium profile cannot be a filesystem root')
    }
  } else {
    if (typeof profile.parentDirectory !== 'string' || !isAbsolute(profile.parentDirectory)) {
      throw new Error('Temporary Chromium profile parent must be absolute')
    }
    const metadata = await stat(profile.parentDirectory)
    if (!metadata.isDirectory())
      throw new Error('Temporary Chromium profile parent must be a directory')
    temporaryProfileDirectory = await mkdtemp(
      join(await realpath(profile.parentDirectory), PROFILE_PREFIX)
    )
    profileDirectory = temporaryProfileDirectory
  }
  let child: ChildProcess
  try {
    child = spawn(
      executable,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-pipe',
        `--user-data-dir=${profileDirectory}`,
        'about:blank',
      ],
      { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    if (temporaryProfileDirectory)
      await rm(temporaryProfileDirectory, { recursive: true, force: true })
    throw error
  }
  const pipe = new ChromiumPipe(child, {
    commandTimeoutMs: options.commandTimeoutMs,
    exitTimeoutMs: options.exitTimeoutMs,
    profileDirectory: temporaryProfileDirectory,
  })
  try {
    await pipe.command('Browser.getVersion')
    await pipe.command('Browser.setDownloadBehavior', { behavior: 'deny' })
    return pipe
  } catch (error) {
    try {
      await pipe.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Chromium startup and shutdown failed')
    }
    throw error
  }
}
