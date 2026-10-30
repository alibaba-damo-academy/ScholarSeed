// Squirrel owns installation after checkForUpdates. There is no public cancellation API.
import { randomBytes, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { EventEmitter } from 'node:events'
import { readRecord, writeJson } from './journal.ts'
import { commitWithActivation, type HandoffAuthorization } from './update-authorization.ts'

const LOOPBACK = '127.0.0.1'
const HANDOFF_TIMEOUT_MS = 10 * 60_000
const RECORD_MAX_BYTES = 4096

// The pinned Squirrel version buffers downloads in NSData. CFData can round a
// download above 1 GiB up to a 2 GiB allocation, which Electron rejects fatally.
// Reject before native handoff instead of relying on recoverable native errors.
export const MAX_SQUIRREL_ARCHIVE_BYTES = 1024 ** 3 - 1
export function assertSquirrelArchiveSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SQUIRREL_ARCHIVE_BYTES)
    throw new Error('Squirrel archive must be smaller than 1 GiB')
}

export interface SquirrelArchive {
  path: string
  sha512: string
  size: number
}
export interface SquirrelHandoff {
  version: string
  buildNumber: string
  candidate: string
  at: number
  state: 'requested' | 'downloaded' | 'installing' | 'failed'
  nativeRequest?: SquirrelNativeRequest
  binding?: SquirrelBinding
}
export interface SquirrelBinding {
  schema: 1
  requestId: string
  candidate: string
  sha512: string
  size: number
}
export function validSquirrelBinding(value: unknown): value is SquirrelBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as SquirrelBinding
  return (
    Object.keys(binding).length === 5 &&
    binding.schema === 1 &&
    typeof binding.requestId === 'string' &&
    /^[a-f0-9]{64}$/.test(binding.requestId) &&
    typeof binding.candidate === 'string' &&
    binding.candidate.length > 0 &&
    binding.candidate.length <= 512 &&
    typeof binding.sha512 === 'string' &&
    /^[a-f0-9]{128}$/.test(binding.sha512) &&
    Number.isSafeInteger(binding.size) &&
    binding.size > 0 &&
    binding.size <= MAX_SQUIRREL_ARCHIVE_BYTES
  )
}
export function sameSquirrelBinding(left: unknown, right: unknown): boolean {
  return (
    validSquirrelBinding(left) &&
    validSquirrelBinding(right) &&
    (['schema', 'requestId', 'candidate', 'sha512', 'size'] as const).every(
      (key) => left[key] === right[key]
    )
  )
}
export interface SquirrelNativeCapture {
  path: string
  parent: { dev: number; ino: number; uid: number }
  item: { dev: number; ino: number; uid: number }
}
export interface SquirrelNativeRequest {
  source: SquirrelNativeCapture
  target: SquirrelNativeCapture
  binding?: SquirrelBinding
}
export function validSquirrelNativeRequest(value: unknown): value is SquirrelNativeRequest {
  if (!value || typeof value !== 'object') return false
  if (
    (value as SquirrelNativeRequest).binding !== undefined &&
    !validSquirrelBinding((value as SquirrelNativeRequest).binding)
  )
    return false
  return ['source', 'target'].every((key) => {
    const capture = (value as Record<string, SquirrelNativeCapture>)[key]
    return (
      capture &&
      typeof capture.path === 'string' &&
      capture.path.startsWith('/') &&
      ['parent', 'item'].every((part) => {
        const identity = capture[part as 'parent' | 'item']
        return (
          identity &&
          ['dev', 'ino', 'uid'].every(
            (field) =>
              Number.isSafeInteger(identity[field as keyof typeof identity]) &&
              identity[field as keyof typeof identity] >= 0
          )
        )
      })
    )
  })
}
export interface SquirrelUpdater extends Pick<EventEmitter, 'on' | 'once' | 'removeListener'> {
  setFeedURL(options: { url: string }): void
  checkForUpdates(): void
  quitAndInstall(): void
}

/** Diagnostic event emitted once a committed handoff reports a terminal native failure. */
export const SQUIRREL_NATIVE_ERROR_EVENT = 'native-error'
export type SquirrelLaunchCleanup = (outcome?: 'failed') => void

/**
 * A terminal native failure after handoff ends the launch transaction this process
 * owns; consume the launch-context discard so storage and future updates recover.
 */
export function discardOnTerminalSquirrelFailure(
  event: string,
  discard: SquirrelLaunchCleanup | undefined
): SquirrelLaunchCleanup | undefined {
  if (event !== SQUIRREL_NATIVE_ERROR_EVENT || !discard) return discard
  discard('failed')
  return undefined
}

export function readSquirrelHandoff(path: string): SquirrelHandoff | null {
  try {
    const value = JSON.parse(readRecord(path, RECORD_MAX_BYTES).toString()) as SquirrelHandoff
    if (
      typeof value.version !== 'string' ||
      !/^[A-Za-z0-9.+_-]{1,128}$/.test(value.version) ||
      typeof value.buildNumber !== 'string' ||
      !/^[A-Za-z0-9.+_-]{1,128}$/.test(value.buildNumber) ||
      typeof value.candidate !== 'string' ||
      !value.candidate ||
      !Number.isSafeInteger(value.at) ||
      value.at < 0 ||
      !['requested', 'downloaded', 'installing', 'failed'].includes(value.state) ||
      (value.nativeRequest !== undefined && !validSquirrelNativeRequest(value.nativeRequest)) ||
      (value.binding !== undefined &&
        (!validSquirrelBinding(value.binding) || value.binding.candidate !== value.candidate)) ||
      (value.binding !== undefined &&
        value.nativeRequest !== undefined &&
        !sameSquirrelBinding(value.binding, value.nativeRequest.binding))
    )
      throw new Error('Invalid Squirrel handoff')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // An unreadable record is not proof that no installation is pending.
    throw error
  }
}

/** Serve a verified, pinned archive only to the capability supplied to Squirrel. */
export async function squirrelFeed(
  archive: SquirrelArchive,
  binding?: SquirrelBinding
): Promise<{
  url: string
  close: () => Promise<void>
}> {
  assertSquirrelArchiveSize(archive.size)
  if (
    binding &&
    (!validSquirrelBinding(binding) ||
      binding.size !== archive.size ||
      binding.sha512 !== archive.sha512.toLowerCase())
  )
    throw new Error('Squirrel feed binding differs from the verified ZIP')
  const file = await open(archive.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const workers = new Set<Promise<void>>()
  const streams = new Set<ReturnType<typeof file.createReadStream>>()
  const token = randomBytes(32).toString('hex')
  const feedPath = `/${token}/feed`
  const zipPath = `/${token}/application.zip`
  let host = ''
  const server = createServer((request, response) => {
    if (
      request.method !== 'GET' ||
      request.headers.host !== host ||
      request.headers.origin ||
      ![feedPath, zipPath].includes(request.url ?? '')
    ) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === feedPath) {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          url: `http://${host}${zipPath}`,
          name: binding && JSON.stringify(binding),
        })
      )
      return
    }
    // Ignore Range and send a complete 200 response. Every transfer verifies all bytes.
    const source = file.createReadStream({ start: 0, autoClose: false })
    streams.add(source)
    const hash = createHash('sha512')
    let size = 0
    let last: Buffer | undefined
    const verified = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > archive.size) return callback(new Error('Squirrel archive grew'))
        hash.update(chunk)
        if (last) this.push(last)
        last = chunk
        callback()
      },
      flush(callback) {
        if (size !== archive.size || hash.digest('hex') !== archive.sha512.toLowerCase())
          return callback(new Error('Squirrel archive changed'))
        // Withhold the final bytes until verification, including with Content-Length.
        if (last) this.push(last)
        callback()
      },
    })
    response.setHeader('Content-Type', 'application/zip')
    response.setHeader('Content-Length', archive.size)
    const work = pipeline(source, verified, response)
      .catch(() => response.destroy())
      .then(() => {
        streams.delete(source)
        workers.delete(work)
      })
    workers.add(work)
  })
  const close = async (): Promise<void> => {
    server.closeAllConnections()
    for (const stream of streams) stream.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.allSettled([...workers])
    await file.close()
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== archive.size || archive.size <= 0)
      throw new Error('Invalid Squirrel archive')
    const hash = createHash('sha512')
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false }))
      hash.update(chunk)
    if (hash.digest('hex') !== archive.sha512.toLowerCase())
      throw new Error('Squirrel archive digest differs')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LOOPBACK, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Squirrel feed unavailable')
    host = `${LOOPBACK}:${address.port}`
    return { url: `http://${host}${feedPath}`, close }
  } catch (error) {
    await close()
    throw error
  }
}

export class SquirrelInstallation {
  private handedOff = false
  private downloaded = false
  private nativeFailed = false
  private binding: SquirrelBinding | undefined
  private running: Promise<void> | null = null
  private readonly nativeError = (): void => {
    this.nativeFailed = true
    if (this.handedOff) {
      const terminal = this.recordFailure()
      this.diagnostic(terminal ? SQUIRREL_NATIVE_ERROR_EVENT : 'native-outcome-unknown')
    }
  }
  private recordFailure(): boolean {
    this.nativeFailed = true
    try {
      const handoff = readSquirrelHandoff(this.recordPath)
      if (!handoff) throw new Error('Squirrel handoff missing')
      if (!sameSquirrelBinding(handoff.binding, this.binding))
        throw new Error('Squirrel handoff changed')
      if (handoff.state === 'installing') return false
      writeJson(this.recordPath, { ...handoff, state: 'failed' })
      return true
    } catch {
      // Keep the in-memory gate closed even if persistence fails.
      this.diagnostic('handoff-failure-write-failed')
      return false
    }
  }
  constructor(
    private readonly updater: SquirrelUpdater,
    private readonly recordPath: string,
    private readonly diagnostic: (event: string) => void,
    private readonly timeoutMs = HANDOFF_TIMEOUT_MS,
    private readonly bindNativeRequest?: (
      identity: SquirrelHandoff
    ) => Promise<SquirrelNativeRequest>
  ) {
    // A late error revokes readiness without restoring candidate replacement.
    // The durable handoff remains consumed until startup reconciles the installed build.
    updater.on('error', this.nativeError)
  }
  get committed(): boolean {
    return this.handedOff
  }
  get ready(): boolean {
    return this.downloaded && !this.nativeFailed
  }

  prepare(
    archive: SquirrelArchive,
    identity: SquirrelHandoff,
    authorize: HandoffAuthorization
  ): Promise<void> {
    if (this.running) return this.running
    if (this.handedOff) return Promise.reject(new Error('Squirrel handoff already consumed'))
    this.running = this.start(archive, identity, authorize)
      .catch((error) => {
        if (this.handedOff) this.nativeFailed = true
        throw error
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }
  private async start(
    archive: SquirrelArchive,
    identity: SquirrelHandoff,
    authorize: HandoffAuthorization
  ): Promise<void> {
    this.nativeFailed = false
    identity = {
      ...identity,
      binding: {
        schema: 1,
        requestId: randomBytes(32).toString('hex'),
        candidate: identity.candidate,
        sha512: archive.sha512.toLowerCase(),
        size: archive.size,
      },
    }
    const feed = await squirrelFeed(archive, identity.binding)
    this.binding = identity.binding
    try {
      let initializationFailed = false
      const failedInitialization = (): void => {
        initializationFailed = true
      }
      this.updater.on('error', failedInitialization)
      try {
        this.updater.setFeedURL({ url: feed.url })
      } finally {
        this.updater.removeListener('error', failedInitialization)
      }
      if (initializationFailed) throw new Error('Squirrel initialization failed')
      let completion: Promise<void> | undefined
      await commitWithActivation(authorize, (guard) => {
        if (this.nativeFailed) throw new Error('Squirrel initialization failed')
        guard()
        writeJson(this.recordPath, { ...identity, state: 'requested' })
        this.handedOff = true
        this.diagnostic('handoff-requested')
        completion = new Promise<void>((resolve, reject) => {
          let settled = false
          const cleanup = (): void => {
            settled = true
            clearTimeout(timer)
            this.updater.removeListener('update-downloaded', downloaded)
            this.updater.removeListener('error', failed)
            this.updater.removeListener('update-not-available', unavailable)
          }
          const failed = (): void => {
            cleanup()
            if (this.recordFailure()) this.diagnostic(SQUIRREL_NATIVE_ERROR_EVENT)
            reject(new Error('Squirrel installation outcome unknown'))
          }
          const unavailable = (): void => {
            cleanup()
            if (this.recordFailure()) this.diagnostic(SQUIRREL_NATIVE_ERROR_EVENT)
            reject(new Error('Squirrel candidate unavailable'))
          }
          const downloaded = (): void => {
            void (async () => {
              const nativeRequest = await this.bindNativeRequest?.(identity)
              if (settled) return
              if (
                !nativeRequest ||
                !validSquirrelNativeRequest(nativeRequest) ||
                !sameSquirrelBinding(nativeRequest.binding, identity.binding)
              )
                throw new Error('Squirrel request binding unavailable')
              if (this.nativeFailed) throw new Error('Squirrel native readiness revoked')
              const pending = readSquirrelHandoff(this.recordPath)
              if (
                pending?.state !== 'requested' ||
                !sameSquirrelBinding(pending.binding, identity.binding)
              )
                throw new Error('Squirrel handoff changed during request binding')
              writeJson(this.recordPath, { ...identity, nativeRequest, state: 'downloaded' })
              this.downloaded = true
              this.diagnostic('handoff-downloaded')
              cleanup()
              resolve()
            })().catch((error) => {
              if (settled) return
              cleanup()
              if (this.recordFailure()) this.diagnostic(SQUIRREL_NATIVE_ERROR_EVENT)
              reject(error)
            })
          }
          const timer = setTimeout(failed, this.timeoutMs)
          this.updater.once('error', failed)
          this.updater.once('update-not-available', unavailable)
          this.updater.once('update-downloaded', downloaded)
          try {
            this.updater.checkForUpdates()
          } catch (error) {
            this.recordFailure()
            cleanup()
            reject(error)
          }
        })
      })
      await completion
    } finally {
      await feed.close()
    }
    if (!this.ready) throw new Error('Squirrel installation outcome unknown')
  }
  dispose(): void {
    if (this.handedOff) throw new Error('Cannot dispose a consumed Squirrel handoff')
    this.updater.removeListener('error', this.nativeError)
  }
  quitAndInstall(): void {
    if (!this.ready) throw new Error('Squirrel installation is not ready')
    try {
      const handoff = readSquirrelHandoff(this.recordPath)
      if (!handoff || handoff.state !== 'downloaded')
        throw new Error('Squirrel handoff is not downloaded')
      if (!validSquirrelBinding(handoff.binding)) throw new Error('Squirrel binding missing')
      if (
        !sameSquirrelBinding(handoff.binding, this.binding) ||
        !sameSquirrelBinding(handoff.nativeRequest?.binding, this.binding)
      )
        throw new Error('Squirrel request binding changed')
      writeJson(this.recordPath, { ...handoff, state: 'installing', at: Date.now() })
      this.diagnostic('quit-and-install')
      this.updater.quitAndInstall()
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }
}

const SHIPIT_LOG_BYTES = 64 * 1024
const SHIPIT_LOG_FILES = 4
const collectedLogs = new Map<string, string>()

/** Copy only bounded log tails, never modify Squirrel's cache or installation state. */
export async function shipItDiagnostics(
  cache: string,
  bundle: string
): Promise<{ name: string; text: string }[]> {
  if (!/^[A-Za-z0-9.-]+$/.test(bundle)) throw new Error('Invalid application identifier')
  const directory = join(cache, `${bundle}.ShipIt`)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const candidates = await Promise.all(
    names
      .filter(
        (name) =>
          name === 'Squirrel_timing.log' ||
          /^ShipIt_(stdout|stderr)\.log(?:\.(?:[1-9][0-9]?|100))?$/.test(name)
      )
      .map(async (name) => {
        try {
          const info = await lstat(join(directory, name))
          return info.isFile() ? { name, mtime: info.mtimeMs } : null
        } catch {
          return null
        }
      })
  )
  const result: { name: string; text: string }[] = []
  for (const entry of candidates
    .filter((item) => item !== null)
    .sort(
      (a, b) =>
        Number(b.name === 'Squirrel_timing.log') - Number(a.name === 'Squirrel_timing.log') ||
        b.mtime - a.mtime
    )
    .slice(0, SHIPIT_LOG_FILES)) {
    const file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile()) continue
      const buffer = Buffer.alloc(Math.min(info.size, SHIPIT_LOG_BYTES))
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, info.size - buffer.length)
      )
      const bytes = buffer.subarray(0, bytesRead)
      const key = join(directory, entry.name)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (collectedLogs.get(key) === digest) continue
      collectedLogs.set(key, digest)
      result.push({ name: entry.name, text: bytes.toString('utf8') })
    } finally {
      await file.close()
    }
  }
  return result
}
