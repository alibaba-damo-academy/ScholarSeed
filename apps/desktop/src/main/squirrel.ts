// Squirrel owns installation after checkForUpdates. There is no public cancellation API.
import { randomBytes, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { readRecord, uncertainRecordWriteCode, writeRecord } from './journal.ts'
import type { QualifiedRecordConsumer } from './journal.ts'
import { commitWithActivation, type HandoffAuthorization } from './update-authorization.ts'
import { assertSquirrelArchiveSize, MAX_SQUIRREL_ARCHIVE_BYTES } from './archive.ts'

const LOOPBACK = '127.0.0.1'
const HANDOFF_TIMEOUT_MS = 10 * 60_000
const INTERACTION_HEADER = 'X-ScholarSeed-Update-Interaction'
const RECORD_MAX_BYTES = 4096
export const UPDATE_STATE_DIRECTORY = 'updates'
const HANDOFF_FILE = 'squirrel.json'

export function squirrelHandoffRecordPath(home: string): string {
  return join(home, UPDATE_STATE_DIRECTORY, HANDOFF_FILE)
}
export function validSquirrelBundleId(bundle: string): boolean {
  return typeof bundle === 'string' && /^[A-Za-z0-9.-]+$/.test(bundle)
}
export function squirrelJobLabel(bundle: string, alternate = false): string {
  if (!validSquirrelBundleId(bundle)) throw new Error('Invalid application identifier')
  return alternate ? `${bundle}.ShipIt.next` : `${bundle}.ShipIt`
}

export function consumeSquirrelHandoff(
  consumer: QualifiedRecordConsumer,
  home: string,
  expected: Buffer,
  device: string,
  inode: string
): void {
  consumer.consume(squirrelHandoffRecordPath(home), expected, device, inode)
}

export interface SquirrelArchive {
  path: string
  sha512: string
  size: number
}
export interface SquirrelHandoff {
  alternate?: true
  version: string
  buildNumber: string
  candidate: string
  at: number
  state: 'requested' | 'downloaded' | 'installing' | 'failed'
  sourcePid?: number
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
  prepared?: SquirrelNativeCapture
  binding?: SquirrelBinding
}
export function validSquirrelNativeRequest(value: unknown): value is SquirrelNativeRequest {
  if (!value || typeof value !== 'object') return false
  if (
    (value as SquirrelNativeRequest).binding !== undefined &&
    !validSquirrelBinding((value as SquirrelNativeRequest).binding)
  )
    return false
  const keys = ['source', 'target']
  if ((value as SquirrelNativeRequest).prepared !== undefined) keys.push('prepared')
  return keys.every((key) => {
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
  setFeedURL(options: { url: string; headers?: Record<string, string> }): void
  checkForUpdates(): void
  quitAndInstall(): void
}

/** A committed handoff was durably recorded as failed. */
export const SQUIRREL_HANDOFF_FAILED_EVENT = 'handoff-failed'
export type SquirrelLaunchCleanup = (outcome?: 'failed') => void

/**
 * A terminal native failure after handoff ends the launch transaction this process
 * owns; consume the launch-context discard so storage and future updates recover.
 */
export function discardOnTerminalSquirrelFailure(
  event: string,
  discard: SquirrelLaunchCleanup | undefined
): SquirrelLaunchCleanup | undefined {
  if (event !== SQUIRREL_HANDOFF_FAILED_EVENT || !discard) return discard
  discard('failed')
  return undefined
}

export function decodeSquirrelHandoff(bytes: Buffer): SquirrelHandoff {
  const value = JSON.parse(bytes.toString()) as SquirrelHandoff
  if (
    typeof value.version !== 'string' ||
    !/^[A-Za-z0-9.+_-]{1,128}$/.test(value.version) ||
    typeof value.buildNumber !== 'string' ||
    !/^[A-Za-z0-9.+_-]{1,128}$/.test(value.buildNumber) ||
    typeof value.candidate !== 'string' ||
    !value.candidate ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0 ||
    (value.alternate !== undefined && value.alternate !== true) ||
    !['requested', 'downloaded', 'installing', 'failed'].includes(value.state) ||
    (value.sourcePid !== undefined &&
      (!Number.isSafeInteger(value.sourcePid) || value.sourcePid <= 0)) ||
    (value.nativeRequest !== undefined && !validSquirrelNativeRequest(value.nativeRequest)) ||
    (value.binding !== undefined &&
      (!validSquirrelBinding(value.binding) || value.binding.candidate !== value.candidate)) ||
    (value.binding !== undefined &&
      value.nativeRequest !== undefined &&
      !sameSquirrelBinding(value.binding, value.nativeRequest.binding))
  )
    throw new Error('Invalid Squirrel handoff')
  return value
}

export function readSquirrelHandoff(path: string): SquirrelHandoff | null {
  try {
    return decodeSquirrelHandoff(readRecord(path, RECORD_MAX_BYTES))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // An unreadable record is not proof that no installation is pending.
    throw error
  }
}

function unstartedSquirrelRequest(handoff: SquirrelHandoff): boolean {
  return (
    handoff.state === 'requested' &&
    !handoff.nativeRequest &&
    validSquirrelBinding(handoff.binding) &&
    handoff.binding.candidate === handoff.candidate
  )
}

export function abandonedSquirrelRequest(
  handoff: SquirrelHandoff,
  legacyPublisherAbsent?: () => boolean
): boolean {
  if (!unstartedSquirrelRequest(handoff)) return false
  if (!handoff.sourcePid) return legacyPublisherAbsent?.() === true
  return squirrelPublisherExited(handoff.sourcePid)
}

export function squirrelPublisherExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function replaceableHandoff(prior: SquirrelHandoff, allowInteraction: boolean): boolean {
  switch (prior.state) {
    case 'installing':
      return (
        allowInteraction &&
        sameSquirrelBinding(prior.binding, prior.nativeRequest?.binding) &&
        (!prior.sourcePid || squirrelPublisherExited(prior.sourcePid))
      )
    case 'downloaded':
      return !!prior.sourcePid && squirrelPublisherExited(prior.sourcePid)
    case 'requested':
      return prior.sourcePid ? abandonedSquirrelRequest(prior) : unstartedSquirrelRequest(prior)
    case 'failed':
      return true
    default:
      return false
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

// Writers expose the exact serialized bytes before replacement, since a sync or unlock may throw.
type SquirrelRecordWrite = (handoff: SquirrelHandoff, onAttempt?: (bytes: Buffer) => void) => void
export type SquirrelRecordMutation = (operation: (write: SquirrelRecordWrite) => void) => void

export function squirrelRecordWriter(replace: (bytes: Buffer) => void): SquirrelRecordWrite {
  return (handoff, onAttempt) => {
    const bytes = Buffer.from(JSON.stringify(handoff) + '\n')
    onAttempt?.(bytes)
    replace(bytes)
  }
}

export class SquirrelSourceVerificationRetry extends Error {}

export type SquirrelSourceVerifier = (
  source: string,
  request: SquirrelNativeRequest
) => Promise<void>

export class SquirrelInstallation {
  private handedOff = false
  private downloaded = false
  private nativeFailed = false
  private binding: SquirrelBinding | undefined
  private downloadedHandoff?: SquirrelHandoff
  private detached = false
  private stopWaiting?: () => void
  private pendingVerification?: { identity: SquirrelHandoff; request: SquirrelNativeRequest }
  private running: Promise<void> | null = null
  private readonly nativeError = (error: unknown): void => {
    if (this.detached) return
    this.nativeFailed = true
    if (this.handedOff) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      this.diagnostic(
        'native-error',
        typeof code === 'number' && Number.isSafeInteger(code) ? String(code) : undefined
      )
      const terminal = this.recordFailure()
      this.diagnostic(terminal ? SQUIRREL_HANDOFF_FAILED_EVENT : 'native-outcome-unknown')
    }
  }
  private recordFailure(): boolean {
    this.nativeFailed = true
    this.pendingVerification = undefined
    try {
      let recorded = false
      this.mutateRecord((write) => {
        const handoff = readSquirrelHandoff(this.recordPath)
        if (!handoff) throw new Error('Squirrel handoff missing')
        if (!sameSquirrelBinding(handoff.binding, this.binding))
          throw new Error('Squirrel handoff changed')
        if (handoff.state === 'installing') return
        write({ ...handoff, state: 'failed' })
        recorded = true
      })
      return recorded
    } catch {
      // Keep the in-memory gate closed even if persistence fails.
      this.diagnostic('handoff-failure-write-failed')
      return false
    }
  }
  constructor(
    private readonly updater: SquirrelUpdater,
    private recordPath: string,
    private readonly diagnostic: (event: string, errorCode?: string) => void,
    private readonly timeoutMs = HANDOFF_TIMEOUT_MS,
    private readonly bindNativeRequest?: (
      identity: SquirrelHandoff,
      verifySource?: SquirrelSourceVerifier
    ) => Promise<SquirrelNativeRequest>,
    private mutateRecord: SquirrelRecordMutation = (operation) =>
      operation(squirrelRecordWriter((bytes) => writeRecord(recordPath, bytes))),
    private requiresPromotion = false
  ) {
    // A late error revokes readiness without restoring candidate replacement.
    // The durable handoff remains consumed until startup reconciles the installed build.
    updater.on('error', this.nativeError)
  }
  get committed(): boolean {
    return this.handedOff
  }
  get ready(): boolean {
    return this.downloaded && !this.nativeFailed && !this.detached
  }

  preparedCandidate(): SquirrelNativeCapture | undefined {
    if (!this.ready) return undefined
    const request = readSquirrelHandoff(this.recordPath)?.nativeRequest
    return request && sameSquirrelBinding(request.binding, this.binding)
      ? request.prepared
      : undefined
  }

  matches(
    archive: SquirrelArchive,
    identity: Pick<SquirrelHandoff, 'candidate' | 'version' | 'buildNumber'>
  ): boolean {
    if (!this.ready || !this.binding) return false
    const handoff = readSquirrelHandoff(this.recordPath)
    return (
      !!handoff &&
      handoff.state === 'downloaded' &&
      handoff.candidate === identity.candidate &&
      handoff.version === identity.version &&
      handoff.buildNumber === identity.buildNumber &&
      archive.size === this.binding.size &&
      archive.sha512.toLowerCase() === this.binding.sha512 &&
      validSquirrelNativeRequest(handoff.nativeRequest) &&
      sameSquirrelBinding(handoff.binding, this.binding) &&
      sameSquirrelBinding(handoff.nativeRequest.binding, this.binding)
    )
  }

  canRetrySourceVerification(
    archive: SquirrelArchive,
    identity: Pick<SquirrelHandoff, 'candidate' | 'version' | 'buildNumber'>
  ): boolean {
    const pending = this.pendingVerification?.identity
    return (
      !this.detached &&
      !this.nativeFailed &&
      !!pending?.binding &&
      pending.candidate === identity.candidate &&
      pending.version === identity.version &&
      pending.buildNumber === identity.buildNumber &&
      pending.binding.size === archive.size &&
      pending.binding.sha512 === archive.sha512.toLowerCase()
    )
  }

  prepare(
    archive: SquirrelArchive,
    identity: SquirrelHandoff,
    authorize: HandoffAuthorization,
    allowInteraction = false,
    mayReplaceHandoff?: (prior: SquirrelHandoff) => boolean,
    verifySource?: SquirrelSourceVerifier
  ): Promise<void> {
    if (this.detached) return Promise.reject(new Error('Squirrel handoff detached'))
    if (this.running) return this.running
    if (this.matches(archive, identity)) return Promise.resolve()
    const pending = this.pendingVerification
    const retry = pending && verifySource && this.canRetrySourceVerification(archive, identity)
    if (this.handedOff && !retry)
      return Promise.reject(new Error('Squirrel handoff already consumed'))
    this.running = (
      retry
        ? this.bindAndPublish(pending.identity, verifySource)
        : this.start(
            archive,
            identity,
            authorize,
            allowInteraction,
            mayReplaceHandoff,
            verifySource
          )
    )
      .catch((error) => {
        if (this.handedOff && !this.pendingVerification) this.nativeFailed = true
        throw error
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async bindAndPublish(
    identity: SquirrelHandoff,
    verifySource?: SquirrelSourceVerifier,
    isActive = () => true,
    onReady?: () => void
  ): Promise<void> {
    let captured: SquirrelNativeRequest | undefined
    try {
      this.diagnostic('handoff-binding-request')
      const expected = this.pendingVerification?.request
      const nativeRequest = await this.bindNativeRequest?.(
        identity,
        verifySource &&
          (async (source, request) => {
            if (expected && !isDeepStrictEqual(request, expected))
              throw new Error('Squirrel request changed before source verification retry')
            captured = request
            await verifySource(source, request)
          })
      )
      if (!isActive()) return
      if (this.detached) throw new Error('Squirrel handoff detached')
      if (
        !nativeRequest ||
        !validSquirrelNativeRequest(nativeRequest) ||
        !sameSquirrelBinding(nativeRequest.binding, identity.binding) ||
        (verifySource && !captured)
      )
        throw new Error('Squirrel request binding unavailable')
      if (this.nativeFailed) throw new Error('Squirrel native readiness revoked')
      this.mutateRecord((write) => {
        const pending = readSquirrelHandoff(this.recordPath)
        if (
          pending?.state !== 'requested' ||
          pending.sourcePid !== process.pid ||
          !sameSquirrelBinding(pending.binding, identity.binding)
        )
          throw new Error('Squirrel handoff changed during request binding')
        const downloadedHandoff: SquirrelHandoff = {
          ...identity,
          sourcePid: pending.sourcePid,
          nativeRequest,
          state: 'downloaded',
        }
        write(downloadedHandoff)
        this.downloadedHandoff = downloadedHandoff
      })
      this.pendingVerification = undefined
      this.downloaded = true
      this.diagnostic('handoff-downloaded')
      onReady?.()
    } catch (error) {
      if (!isActive()) return
      if (this.detached) throw new Error('Squirrel handoff detached')
      if (error instanceof SquirrelSourceVerificationRetry && captured && !this.nativeFailed) {
        this.pendingVerification = { identity, request: captured }
        this.diagnostic('handoff-source-verification-retry')
      } else {
        this.diagnostic('handoff-binding-failed')
        if (this.recordFailure()) this.diagnostic(SQUIRREL_HANDOFF_FAILED_EVENT)
      }
      throw error
    }
  }

  private async start(
    archive: SquirrelArchive,
    identity: SquirrelHandoff,
    authorize: HandoffAuthorization,
    allowInteraction: boolean,
    mayReplaceHandoff?: (prior: SquirrelHandoff) => boolean,
    verifySource?: SquirrelSourceVerifier
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
      if (this.detached) throw new Error('Squirrel handoff detached')
      let initializationFailed = false
      const failedInitialization = (): void => {
        initializationFailed = true
      }
      this.updater.on('error', failedInitialization)
      try {
        this.updater.setFeedURL(
          allowInteraction
            ? { url: feed.url, headers: { [INTERACTION_HEADER]: '1' } }
            : { url: feed.url }
        )
      } finally {
        this.updater.removeListener('error', failedInitialization)
      }
      if (initializationFailed) throw new Error('Squirrel initialization failed')
      let completion: Promise<void> | undefined
      await commitWithActivation(authorize, (guard) => {
        if (this.nativeFailed || this.detached) throw new Error('Squirrel initialization failed')
        this.mutateRecord((write) => {
          const prior = readSquirrelHandoff(this.recordPath)
          if (!prior && mayReplaceHandoff) throw new Error('Squirrel handoff disappeared')
          if (prior && !(replaceableHandoff(prior, allowInteraction) && mayReplaceHandoff?.(prior)))
            throw new Error('Squirrel handoff already exists')
          guard()
          write({ ...identity, state: 'requested', sourcePid: process.pid })
        })
        this.handedOff = true
        this.diagnostic('handoff-requested')
        completion = new Promise<void>((resolve, reject) => {
          let settled = false
          const cleanup = (): void => {
            settled = true
            this.stopWaiting = undefined
            clearTimeout(timer)
            this.updater.removeListener('update-downloaded', downloaded)
            this.updater.removeListener('error', failed)
            this.updater.removeListener('update-not-available', unavailable)
          }
          const failed = (): void => {
            cleanup()
            // The lifetime error listener already recorded and reported this native error.
            reject(new Error('Squirrel reported an installation error'))
          }
          const unavailable = (): void => {
            cleanup()
            this.diagnostic('handoff-candidate-unavailable')
            if (this.recordFailure()) this.diagnostic(SQUIRREL_HANDOFF_FAILED_EVENT)
            reject(new Error('Squirrel candidate unavailable'))
          }
          const downloaded = (): void => {
            // ZIP verification has its own probe and ticket deadlines. The native
            // preparation deadline must not turn a slow ticket into a terminal error.
            if (verifySource) clearTimeout(timer)
            void this.bindAndPublish(
              identity,
              verifySource,
              () => !settled,
              () => {
                cleanup()
                resolve()
              }
            ).catch((error) => {
              if (settled) return
              cleanup()
              reject(error)
            })
          }
          const timer = setTimeout(() => {
            cleanup()
            this.diagnostic('handoff-timeout')
            if (this.recordFailure()) this.diagnostic(SQUIRREL_HANDOFF_FAILED_EVENT)
            reject(new Error('Squirrel installation outcome unknown'))
          }, this.timeoutMs)
          this.updater.once('error', failed)
          this.stopWaiting = () => {
            cleanup()
            reject(new Error('Squirrel handoff detached'))
          }
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
  detach(): void {
    this.detached = true
    this.updater.removeListener('error', this.nativeError)
    this.stopWaiting?.()
  }
  promoteTo(
    recordPath: string,
    mutateRecord: SquirrelRecordMutation,
    previous: SquirrelHandoff,
    guard: () => void,
    readPublished?: () => Buffer
  ): void {
    if (!this.requiresPromotion || this.recordPath === recordPath || !this.ready)
      throw new Error('Squirrel successor is not ready for promotion')
    let attempted: Buffer | undefined
    let written = false
    try {
      mutateRecord((write) => {
        const current = readSquirrelHandoff(recordPath)
        const successor = readSquirrelHandoff(this.recordPath)
        if (
          !current ||
          current.state !== 'downloaded' ||
          current.sourcePid !== process.pid ||
          !isDeepStrictEqual(current, previous) ||
          !sameSquirrelBinding(current.binding, current.nativeRequest?.binding) ||
          !successor ||
          successor.state !== 'downloaded' ||
          successor.sourcePid !== process.pid ||
          !isDeepStrictEqual(successor, this.downloadedHandoff) ||
          !sameSquirrelBinding(successor.binding, this.binding) ||
          !sameSquirrelBinding(successor.nativeRequest?.binding, this.binding) ||
          current.alternate === successor.alternate ||
          current.candidate === successor.candidate ||
          current.binding!.requestId === successor.binding!.requestId ||
          !isDeepStrictEqual(current.nativeRequest?.target, successor.nativeRequest?.target)
        )
          throw new Error('Squirrel handoff changed before promotion')
        guard()
        write(successor, (bytes) => {
          attempted = Buffer.from(bytes)
        })
        written = true
      })
    } catch (error) {
      const code = uncertainRecordWriteCode(error)
      if (!attempted || !code || !readPublished) throw error
      // A successful rename can precede a failed directory sync or lock release.
      // Keep the selected handle only after a qualified read of its exact bytes.
      let current: Buffer
      try {
        current = readPublished()
      } catch (readError) {
        throw new AggregateError([error, readError], 'Squirrel promotion could not be confirmed')
      }
      if (!current.equals(attempted)) throw error
      written = true
      this.diagnostic('handoff-promotion-observed-after-writer-error', code)
    }
    if (!written) throw new Error('Squirrel promotion was not published')
    this.recordPath = recordPath
    this.mutateRecord = mutateRecord
    this.requiresPromotion = false
  }
  quitAndInstall(): void {
    if (!this.ready || this.requiresPromotion) throw new Error('Squirrel installation is not ready')
    try {
      this.mutateRecord((write) => {
        const handoff = readSquirrelHandoff(this.recordPath)
        if (!handoff || handoff.state !== 'downloaded')
          throw new Error('Squirrel handoff is not downloaded')
        if (!validSquirrelBinding(handoff.binding)) throw new Error('Squirrel binding missing')
        if (
          !sameSquirrelBinding(handoff.binding, this.binding) ||
          !sameSquirrelBinding(handoff.nativeRequest?.binding, this.binding)
        )
          throw new Error('Squirrel request binding changed')
        write({ ...handoff, state: 'installing', at: Date.now() })
      })
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
): Promise<({ name: string; text: string } | { name: string; error: string })[]> {
  const slots = await Promise.all(
    [false, true].map((alternate) => {
      const directory = join(cache, squirrelJobLabel(bundle, alternate))
      return shipItSlotDiagnostics(directory, alternate).catch((error: NodeJS.ErrnoException) => [
        {
          name: alternate ? 'next/diagnostics' : 'primary/diagnostics',
          error: error.code ?? error.message,
        },
      ])
    })
  )
  return slots.flat()
}

async function shipItSlotDiagnostics(directory: string, alternate: boolean) {
  let names: string[]
  try {
    if (!(await lstat(directory)).isDirectory()) return []
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
      result.push({
        name: alternate ? `next/${entry.name}` : entry.name,
        text: bytes.toString('utf8'),
      })
    } finally {
      await file.close()
    }
  }
  return result
}
