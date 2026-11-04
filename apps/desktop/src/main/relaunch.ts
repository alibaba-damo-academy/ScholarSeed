// Squirrel/launchd 不保留 argv 或环境变量；只交接存储选择和显式本机 CDP 端口。
import { createHash } from 'node:crypto'
import { realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DomainNative } from '../../native/domains.cjs'
import { acquireDirectoryWriter } from './writer.ts'
import { isValidAbsoluteRoot } from './storage-record.ts'
import { writeJson, writeRecord } from './journal.ts'
import type { QualifiedRecordConsumer } from './journal.ts'
import { explicitUpdateDebugPort, isValidDebugPort } from './debuglaunch.ts'
import { BUILD_NUMBER_PATTERN } from './version.ts'

const CONTEXT_DIRECTORY = '.scholarseed-update-launch'
const CONTEXT_FILE = 'context.json'
const LEGACY_SCHEMA = 1
const SCHEMA = 2
const LEGACY_IDENTITY = /^posix:[a-f0-9]{16}:[a-f0-9]{16}$/
const PERSISTENT_IDENTITY = /^darwin:[a-f0-9]{32}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{8}$/
const MAX_BYTES = 16 * 1024
const PROFILE_SWITCH = '--user-data-dir'
const CONTEXT_LOCK = 'context-write'
const KEYS = [
  'schema',
  'uid',
  'application',
  'bundleId',
  'sourceBuild',
  'targetBuild',
  'candidate',
  'at',
  'home',
  'userData',
  'workspace',
  'identities',
] as const

export interface UpdateLaunchContext {
  schema: number
  uid: number
  application: string
  bundleId: string
  sourceBuild: string
  targetBuild: string
  candidate: string
  at: number
  home: string
  userData: string
  workspace: string
  identities: string[]
  debugPort?: number
}
export interface LaunchIdentity {
  uid: number
  application: string
  bundleId: string
  build: string
}
export interface ObservedUpdateLaunch {
  context: UpdateLaunchContext
  complete(): void
  verify(): void
}
export function applicationBundle(executable: string): string {
  return realpathSync(dirname(dirname(dirname(executable))))
}
export function updateLaunchDirectory(coordinator: string, application: string): string {
  // Coordination must remain outside data roots; this fixed OS-account sibling is its own domain.
  return join(
    dirname(coordinator),
    CONTEXT_DIRECTORY,
    createHash('sha256').update(application).digest('hex')
  )
}
export function updateLaunchContextPath(coordinator: string, application: string): string {
  return join(updateLaunchDirectory(coordinator, application), CONTEXT_FILE)
}
export function acquireUpdateLaunchRecordLock(native: DomainNative, pin: unknown): unknown {
  return native.acquireAt(pin, CONTEXT_LOCK, true)
}
export function consumeUpdateLaunchContext(
  consumer: QualifiedRecordConsumer,
  coordinator: string,
  application: string,
  expected: Buffer,
  device: string,
  inode: string
): void {
  consumer.consume(updateLaunchContextPath(coordinator, application), expected, device, inode)
}
function directoryIdentity(native: DomainNative, path: string, schema = SCHEMA): string {
  const pin = native.pin(path, false)
  try {
    const id =
      schema === LEGACY_SCHEMA ? native.lineage(pin).at(-1) : native.persistentIdentity?.(pin)
    const pattern = schema === LEGACY_SCHEMA ? LEGACY_IDENTITY : PERSISTENT_IDENTITY
    if (!id || !pattern.test(id))
      throw new Error('Update launch directory has no supported identity')
    return id
  } finally {
    native.release(pin)
  }
}

function removeUpdateLaunch(
  native: DomainNative,
  coordinator: string,
  directory: string,
  expected: Buffer,
  replacement?: Buffer
): void {
  const writer = acquireDirectoryWriter(native, coordinator, directory)
  try {
    const pin = native.pin(directory, false)
    try {
      const lock = native.acquireAt(pin, CONTEXT_LOCK, true)
      try {
        const current = native.readAt(pin, CONTEXT_FILE, MAX_BYTES)
        if (current && !current.equals(expected))
          throw new Error('Mac update launch context changed')
        if (current && replacement) writeRecord(join(directory, CONTEXT_FILE), replacement)
        else rmSync(join(directory, CONTEXT_FILE), { force: true })
      } finally {
        native.release(lock)
      }
    } finally {
      native.release(pin)
    }
  } finally {
    writer.close()
  }
}
export function decodeUpdateLaunch(bytes: Buffer): UpdateLaunchContext {
  const record = JSON.parse(bytes.toString('utf8')) as UpdateLaunchContext
  if (
    !record ||
    Object.keys(record).some(
      (key) => !KEYS.includes(key as (typeof KEYS)[number]) && key !== 'debugPort'
    ) ||
    KEYS.some((key) => !Object.hasOwn(record, key)) ||
    (record.schema !== SCHEMA && record.schema !== LEGACY_SCHEMA) ||
    (Object.hasOwn(record, 'debugPort') && !isValidDebugPort(record.debugPort)) ||
    !Number.isSafeInteger(record.uid) ||
    record.uid < 0 ||
    !Number.isSafeInteger(record.at) ||
    record.at < 0 ||
    ![record.sourceBuild, record.targetBuild].every((build) => /^\d{12}$/.test(build)) ||
    typeof record.bundleId !== 'string' ||
    !record.bundleId ||
    typeof record.candidate !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(record.candidate) ||
    ![record.application, record.home, record.userData, record.workspace].every(
      (path) => typeof path === 'string' && isValidAbsoluteRoot(path, 'darwin')
    ) ||
    !Array.isArray(record.identities) ||
    record.identities.length !== 3 ||
    record.identities.some(
      (id) =>
        typeof id !== 'string' ||
        !(record.schema === LEGACY_SCHEMA ? LEGACY_IDENTITY : PERSISTENT_IDENTITY).test(id)
    )
  )
    throw new Error('Invalid Mac update launch context')
  return record
}
export function persistUpdateLaunch(
  native: DomainNative,
  coordinator: string,
  identity: LaunchIdentity,
  selection: { home: string; userData: string; workspace: string },
  targetBuild: string,
  candidate: string,
  now = Date.now(),
  argv: readonly string[] = process.argv
): (outcome?: 'failed') => void {
  const directory = updateLaunchDirectory(coordinator, identity.application)
  const writer = acquireDirectoryWriter(native, coordinator, directory)
  let published: Buffer | undefined
  let replaced: Buffer | undefined
  try {
    const record: UpdateLaunchContext = {
      schema: SCHEMA,
      uid: identity.uid,
      application: identity.application,
      bundleId: identity.bundleId,
      sourceBuild: identity.build,
      targetBuild,
      candidate,
      at: now,
      home: selection.home,
      userData: selection.userData,
      workspace: selection.workspace,
      identities: [selection.home, selection.userData, selection.workspace].map((path) =>
        directoryIdentity(native, path)
      ),
    }
    const debugPort = explicitUpdateDebugPort(argv)
    if (debugPort !== undefined) record.debugPort = debugPort
    const data = Buffer.from(JSON.stringify(record))
    decodeUpdateLaunch(data)
    if (data.length > MAX_BYTES) throw new Error('Mac update launch context too large')
    const pin = native.pin(directory, false)
    try {
      const lock = native.acquireAt(pin, CONTEXT_LOCK, true)
      try {
        const pending = native.readAt(pin, CONTEXT_FILE, MAX_BYTES)
        if (pending) {
          const previous = decodeUpdateLaunch(pending)
          const sameStorage =
            previous.uid === record.uid &&
            previous.application === record.application &&
            previous.bundleId === record.bundleId &&
            previous.home === record.home &&
            previous.userData === record.userData &&
            previous.workspace === record.workspace &&
            previous.identities.every(
              (id, index) =>
                id ===
                directoryIdentity(
                  native,
                  [record.home, record.userData, record.workspace][index],
                  previous.schema
                )
            )
          if (!sameStorage) throw new Error('Mac update launch identity or storage differs')
          if (
            previous.sourceBuild === record.sourceBuild &&
            previous.targetBuild === record.targetBuild &&
            previous.candidate === record.candidate &&
            previous.debugPort === record.debugPort
          ) {
            // Cancelling a retry retains the original publication. A proved
            // terminal native failure ends that exact transaction instead.
            return (outcome) => {
              if (outcome === 'failed') removeUpdateLaunch(native, coordinator, directory, pending)
            }
          }
          // The running installed build has fulfilled the previous target. Its
          // readiness acknowledgement may still be outstanding; publish the next
          // authorized handoff atomically, retaining compare-before-delete fencing.
          // An unresolved source-side handoff is never retired based on age.
          if (
            previous.targetBuild <= previous.sourceBuild ||
            record.sourceBuild < previous.targetBuild ||
            record.targetBuild <= record.sourceBuild
          )
            throw new Error('Mac update launch context already pending')
          replaced = pending
        }
        // createAt deliberately retains partial files after failure. Publish only a flushed,
        // complete temporary record through the existing atomic journal primitive.
        writeJson(join(directory, CONTEXT_FILE), record)
        published = native.readAt(pin, CONTEXT_FILE, MAX_BYTES) ?? undefined
        if (!published) throw new Error('Mac update launch context not published')
      } finally {
        native.release(lock)
      }
    } finally {
      native.release(pin)
    }
  } finally {
    writer.close()
  }
  // Neither cancellation nor terminal failure of the next update acknowledges
  // the previous launch's readiness. Restore its exact publication if still ours.
  return () => removeUpdateLaunch(native, coordinator, directory, published!, replaced)
}

/** Native readAt refuses links/unsafe ownership. No path selection happens before validation. */
export function observeUpdateLaunch(
  native: DomainNative,
  coordinator: string,
  identity: LaunchIdentity
): ObservedUpdateLaunch | null {
  const directory = updateLaunchDirectory(coordinator, identity.application)
  let pin: unknown
  try {
    pin = native.pin(directory, false)
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_LEASE_MISSING') return null
    throw error
  }
  let data: Buffer | null
  try {
    data = native.readAt(pin, CONTEXT_FILE, MAX_BYTES)
  } finally {
    native.release(pin)
  }
  if (!data) return null
  const context = decodeUpdateLaunch(data)
  if (
    context.uid !== identity.uid ||
    context.application !== identity.application ||
    context.bundleId !== identity.bundleId
  )
    throw new Error('Mac update launch identity differs')
  const complete = () => removeUpdateLaunch(native, coordinator, directory, data)
  return {
    context,
    complete,
    verify: () => {
      const current = native.pin(directory, false)
      try {
        if (!native.readAt(current, CONTEXT_FILE, MAX_BYTES)?.equals(data))
          throw new Error('Mac update launch context changed')
      } finally {
        native.release(current)
      }
      const roots = [context.home, context.userData, context.workspace]
      if (
        roots.some(
          (path, index) =>
            directoryIdentity(native, path, context.schema) !== context.identities[index]
        )
      )
        throw new Error('Mac update launch directory was replaced')
    },
  }
}

export function restoreUpdateLaunch(
  native: DomainNative,
  coordinator: string,
  identity: LaunchIdentity,
  explicit: { home?: string; userData?: string; workspace?: string },
  pending?: ObservedUpdateLaunch,
  admission?: 'superseded'
): { context: UpdateLaunchContext; complete: () => void } | null {
  const observed = pending ?? observeUpdateLaunch(native, coordinator, identity)
  if (!observed) return null
  const { context, complete } = observed
  const superseded =
    admission === 'superseded' &&
    BUILD_NUMBER_PATTERN.test(identity.build) &&
    identity.build > context.sourceBuild &&
    identity.build > context.targetBuild
  const hasExplicitSelection = !!(explicit.home || explicit.userData || explicit.workspace)
  if (
    (explicit.home && explicit.home !== context.home) ||
    (explicit.userData && explicit.userData !== context.userData) ||
    (explicit.workspace && explicit.workspace !== context.workspace) ||
    (hasExplicitSelection &&
      identity.build !== context.sourceBuild &&
      identity.build !== context.targetBuild &&
      !superseded)
  ) {
    throw new Error('Pending Mac update launch selection differs')
  }
  const sourceRecovery = identity.build === context.sourceBuild
  if (!sourceRecovery && identity.build !== context.targetBuild && !superseded)
    throw new Error('Pending Mac update launch build differs')
  observed.verify()
  return { context, complete: sourceRecovery ? () => {} : complete }
}

export function explicitUpdateProfile(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === PROFILE_SWITCH) return argv[index + 1]
    if (argv[index].startsWith(`${PROFILE_SWITCH}=`))
      return argv[index].slice(PROFILE_SWITCH.length + 1)
  }
  return undefined
}
