// Read-only startup classification. None of these results authorize backend admission.
import { execFile, execFileSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { constants as osConstants } from 'node:os'
import { isDeepStrictEqual, promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  sameSquirrelBinding,
  squirrelJobLabel,
  squirrelPublisherExited,
  validSquirrelBinding,
  type SquirrelHandoff,
  type SquirrelNativeRequest,
  type SquirrelNativeCapture,
} from './squirrel.ts'
import { BUILD_NUMBER_PATTERN, isNewerRelease } from './version.ts'
import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'
import { captureRecord, sameRecord } from './terminal.ts'

export const SQUIRREL_INSTALLATION_WINDOW_MS = 10 * 60_000
const NATIVE_SETTLE_TIMEOUT_MS = 5000
const NATIVE_SETTLE_INTERVAL_MS = 100
const PROBE_TIMEOUT_MS = 2000
const PROBE_MAX_BYTES = 1024 * 1024
const SHIPIT_NAME = 'ShipIt'
const SHIPIT_EXECUTABLE = ['Contents', 'Frameworks', 'Squirrel.framework', 'Resources', SHIPIT_NAME]
const SHIPIT_STATE = 'ShipItState.plist'
const PREPARATION_DIRECTORY = 'CandidatePreparation'

export function squirrelNativeRequestAbsent(
  cache: string,
  bundle: string,
  alternate = false
): boolean {
  if (!/^[A-Za-z0-9.-]+$/.test(bundle)) return false
  try {
    const owner = join(realpathSync(cache), squirrelJobLabel(bundle, alternate))
    try {
      const info = lstatSync(owner)
      if (
        !info.isDirectory() ||
        ![0, process.getuid!()].includes(info.uid) ||
        info.mode & UNSAFE_WRITE_MODE
      )
        return false
      lstatSync(join(owner, SHIPIT_STATE))
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  } catch {
    return false
  }
}

export function legacySquirrelPublisherAbsent(
  processes: string,
  pid: number,
  executable: string
): boolean {
  let current = false
  for (const line of processes.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return false
    const name = basename(match[2])
    if (name === SHIPIT_NAME) return false
    if (name !== basename(executable)) continue
    if (Number(match[1]) !== pid) return false
    current = true
  }
  return current
}

export function inspectLegacySquirrelPublisher(): boolean {
  try {
    const inventory = execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,comm='], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8',
    })
    return legacySquirrelPublisherAbsent(inventory, process.pid, process.execPath)
  } catch {
    return false
  }
}
const SHIPIT_REQUEST_FLAGS = [
  'installationAuthorized',
  'launchAfterInstallation',
  'useUpdateBundleName',
]
const TERMINAL_ACK = '.scholarseed-prepare.plist'
const TERMINAL_ACK_LIMIT = 4096
const UNSAFE_WRITE_MODE = 0o022
const PRODUCT_CONFIG_BYTES = 64 * 1024
const SIGNATURE_TIMEOUT_MS = 30_000
const SOURCE_PRODUCT_CONFIG = ['Contents', 'Resources', 'product.json']
const run = promisify(execFile)
export type SquirrelStartupStatus = 'installing' | 'restoring' | 'failed' | 'unconfirmed'
export type SquirrelAdmission = 'allow' | 'exit' | 'failed' | 'superseded'

export async function verifySquirrelReplacement(
  application: string,
  bundle: string,
  team: string,
  build: string
): Promise<void> {
  const options = {
    timeout: SIGNATURE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BYTES,
    encoding: 'utf8' as const,
  }
  await run(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--all-architectures', application],
    options
  )
  const identity = await run(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', application],
    options
  )
  if (
    !classifyMacosTrust(parseCodesignIdentity(identity.stdout + '\n' + identity.stderr), {
      expectedBundleId: bundle,
      expectedTeamId: team,
      metaTeamId: team,
    }).trusted
  )
    throw new Error('Superseding application signature differs')
  const product = JSON.parse(
    readNativeRecord(join(application, ...SOURCE_PRODUCT_CONFIG), PRODUCT_CONFIG_BYTES).toString()
  )
  if (!BUILD_NUMBER_PATTERN.test(build) || product.build_number !== build)
    throw new Error('Superseding application build differs')
}

export function squirrelLaunchSuperseded(
  build: string,
  expected: { sourceBuild?: string; targetBuild: string }
): boolean {
  return (
    BUILD_NUMBER_PATTERN.test(build) &&
    BUILD_NUMBER_PATTERN.test(expected.sourceBuild ?? '') &&
    BUILD_NUMBER_PATTERN.test(expected.targetBuild) &&
    build > expected.sourceBuild! &&
    build > expected.targetBuild
  )
}

function squirrelProcessPaths(
  processes: string,
  uid: number,
  executables: readonly string[],
  refuseUnboundHelpers = false
): Set<string> | null {
  if (!processes.trim() || !executables.length || executables.some((path) => !isAbsolute(path)))
    return null
  const paths = new Set<string>()
  for (const line of processes.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return null
    if (![0, uid].includes(Number(match[1]))) continue
    const path = match[2]
    if (refuseUnboundHelpers && basename(path) === SHIPIT_NAME) return null
    if (executables.includes(path)) return null
    if (!isAbsolute(path)) {
      if (basename(path) === SHIPIT_NAME) return null
      continue
    }
    paths.add(path)
  }
  return paths
}

export async function squirrelHelpersAbsent(
  processes: string,
  uid: number,
  executables: readonly string[],
  canonicalize: (path: string) => Promise<string> = realpath,
  refuseUnboundHelpers = false
): Promise<boolean> {
  const paths = squirrelProcessPaths(processes, uid, executables, refuseUnboundHelpers)
  if (!paths) return false
  for (const path of paths) {
    try {
      const canonical = await canonicalize(path)
      if (!isAbsolute(canonical) || executables.includes(canonical)) return false
    } catch {
      // A vanished or unreadable helper cannot be classified as another app's.
      if (basename(path) === SHIPIT_NAME) return false
    }
  }
  return true
}

async function squirrelHelperPaths(executable: string, source?: string): Promise<string[]> {
  const executables = [executable]
  if (source) {
    // The bound candidate can own the helper during relaunch.
    const candidateHelper = join(source, ...SHIPIT_EXECUTABLE)
    executables.push(candidateHelper)
    try {
      executables.push(await realpath(candidateHelper))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return executables
}

export async function inspectSquirrelIdle(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff | null,
  verifyReplacement?: (application: string) => Promise<void>,
  terminalRequest: boolean | 'restored' = false,
  orphanedLaunch?: {
    candidate: string
    alternate?: boolean
    observedLaunch(source: string, target: string, alternate: boolean): boolean
  }
): Promise<boolean> {
  if (process.platform !== 'darwin' || !process.getuid || !/^[A-Za-z0-9.-]+$/.test(bundle))
    return false
  const uid = process.getuid()
  const alternate = handoff?.alternate ?? orphanedLaunch?.alternate ?? false
  const directory = join(cache, squirrelJobLabel(bundle, alternate))
  const snapshot = (owner = directory) => {
    const identity = (path: string) => {
      const info = lstatSync(path)
      if (!info.isDirectory() || ![0, uid].includes(info.uid) || info.mode & UNSAFE_WRITE_MODE)
        throw new Error('Unsafe Squirrel cache directory')
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    const cacheIdentity = identity(cache)
    let directoryIdentity: ReturnType<typeof identity> | null = null
    try {
      directoryIdentity = identity(owner)
      const statePath = join(owner, SHIPIT_STATE)
      const state = lstatSync(statePath)
      const bytes = readNativeRecord(statePath, PROBE_MAX_BYTES)
      return {
        identity: JSON.stringify({
          cacheIdentity,
          directoryIdentity,
          state: {
            dev: state.dev,
            ino: state.ino,
            uid: state.uid,
            mode: state.mode,
            size: state.size,
            mtime: state.mtimeMs,
            ctime: state.ctimeMs,
          },
        }),
        bytes,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { identity: JSON.stringify({ cacheIdentity, directoryIdentity }), bytes: null }
    }
  }
  try {
    if ((await realpath(cache)) !== cache) return false
    const target = await realpath(application)
    if (target !== application) return false
    const replacement = captureDirectory(target)
    const contents = captureDirectory(join(target, 'Contents'))
    const replacementStable = () =>
      isDeepStrictEqual(replacement, captureDirectory(target)) &&
      isDeepStrictEqual(contents, captureDirectory(join(target, 'Contents')))
    if (!handoff && orphanedLaunch && orphanedLaunch.alternate === undefined) {
      const slots = [false, true].map((slot) => {
        const owner = join(cache, squirrelJobLabel(bundle, slot))
        return { slot, owner, before: snapshot(owner) }
      })
      const occupied = slots.filter(({ before }) => before.bytes)
      // Both slots inspect the same signed installation. Keep the signature
      // result scoped to this observation and recheck its directory identities.
      let verification: Promise<void> | undefined
      const verifyOnce = verifyReplacement
        ? () => (verification ??= verifyReplacement(target))
        : undefined
      // With no handoff, both slots must stay stable. The historical empty-state
      // path remains available when neither contains a native request.
      const outcomes = await Promise.all(
        (occupied.length ? occupied : slots.slice(0, 1)).map(({ slot }) =>
          inspectSquirrelIdle(
            cache,
            bundle,
            application,
            null,
            verifyOnce,
            terminalRequest,
            occupied.length ? { ...orphanedLaunch, alternate: slot } : undefined
          )
        )
      )
      return (
        outcomes.filter(Boolean).length === 1 &&
        replacementStable() &&
        slots.every(({ owner, before }) => isDeepStrictEqual(before, snapshot(owner)))
      )
    }
    const native = handoff?.nativeRequest
    if (
      native &&
      (native.target.path !== target ||
        dirname(dirname(native.source.path)) !== directory ||
        !validSquirrelBinding(native.binding) ||
        !sameSquirrelBinding(handoff?.binding, native.binding) ||
        native.binding.candidate !== handoff?.candidate)
    )
      return false
    const executables = await squirrelHelperPaths(
      await realpath(join(target, ...SHIPIT_EXECUTABLE)),
      native?.source.path
    )
    const before = snapshot()
    if ((terminalRequest || orphanedLaunch) && !before.bytes) return false
    const options = {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8' as const,
    }
    const helpersAbsent = async () => {
      const processes = await run('/bin/ps', ['-ww', '-axo', 'uid=,comm='], options)
      // Without a bound candidate, a user/root ShipIt may belong to this update.
      return squirrelHelpersAbsent(processes.stdout, uid, executables, undefined, handoff === null)
    }
    if (!(await helpersAbsent())) return false
    if (verifyReplacement) await verifyReplacement(target)
    let terminal: (() => boolean | Promise<boolean>) | undefined
    if (before.bytes) {
      if (!native && !orphanedLaunch) return false
      const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], options)
      conversion.child.stdin?.end(before.bytes)
      const request = JSON.parse((await conversion).stdout)
      const source = resolve(fileURLToPath(request.updateBundleURL))
      if (
        request.bundleIdentifier !== bundle ||
        dirname(dirname(source)) !== directory ||
        !validSquirrelBinding(request.binding) ||
        !SHIPIT_REQUEST_FLAGS.every((key) => typeof request[key] === 'boolean') ||
        resolve(fileURLToPath(request.targetBundleURL)) !== target
      )
        return false
      if (native) {
        if (
          !sameSquirrelBinding(request.binding, native.binding) ||
          source !== native.source.path ||
          (terminalRequest &&
            (request.installationAuthorized !== (terminalRequest === 'restored') ||
              request.launchAfterInstallation !== (terminalRequest === 'restored'))) ||
          (request.installationAuthorized && !request.launchAfterInstallation)
        )
          return false
        // Keep the historical failure bound to the original target.
        terminal = () =>
          readFailure(
            request.updateBundleURL,
            target,
            native,
            verifyReplacement ? replacement : undefined,
            terminalRequest === true ? osConstants.errno.ECANCELED : undefined
          )
      } else {
        if (
          !orphanedLaunch ||
          !request.installationAuthorized ||
          !request.launchAfterInstallation ||
          request.binding.candidate !== orphanedLaunch.candidate
        )
          return false
        terminal = () => orphanedLaunch.observedLaunch(source, target, alternate)
      }
      if (!replacementStable() || !(await terminal()) || !replacementStable()) return false
    }
    // Both branches retain native records. A failed request is terminal evidence,
    // not an invitation to replay installation or delete an unresolved request.
    if (!(await helpersAbsent()) || (terminal && !(await terminal()))) return false
    const after = snapshot()
    return (
      before.identity === after.identity &&
      replacementStable() &&
      (before.bytes === null ? after.bytes === null : !!after.bytes?.equals(before.bytes))
    )
  } catch {
    return false
  }
}

/** An exited source can be replaced only after its unauthorized request reached native cancellation. */
export async function inspectCancelledSquirrelPreparation(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff
): Promise<(() => boolean) | null> {
  if (!['requested', 'downloaded'].includes(handoff.state)) return null
  return inspectTerminalSquirrelRequest(cache, bundle, application, handoff, 'cancelled')
}

export async function inspectRestoredSquirrelInstallation(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff,
  legacyPublisherAbsent?: () => boolean
): Promise<(() => boolean) | null> {
  if (handoff.state !== 'installing') return null
  return inspectTerminalSquirrelRequest(
    cache,
    bundle,
    application,
    handoff,
    'restored',
    legacyPublisherAbsent
  )
}

async function inspectTerminalSquirrelRequest(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff,
  terminalRequest: 'cancelled' | 'restored',
  legacyPublisherAbsent?: () => boolean
): Promise<(() => boolean) | null> {
  const { sourcePid } = handoff
  if (process.platform !== 'darwin' || !process.getuid || !/^[A-Za-z0-9.-]+$/.test(bundle))
    return null
  const owner = join(cache, squirrelJobLabel(bundle, handoff.alternate))
  const publisherExited = () =>
    sourcePid === undefined
      ? legacyPublisherAbsent?.() === true
      : squirrelPublisherExited(sourcePid)
  try {
    if (!publisherExited()) return null
    // A process can exit after ShipIt received the request but before the
    // downloaded event let Desktop persist its capture.
    const nativeRequest =
      handoff.state === 'requested' && !handoff.nativeRequest
        ? await bindSquirrelRequest(cache, bundle, application, handoff)
        : handoff.nativeRequest
    if (!nativeRequest || dirname(dirname(nativeRequest.source.path)) !== owner) return null
    const uid = process.getuid()
    const owners = [0, uid]
    const statePath = join(owner, SHIPIT_STATE)
    const ackPath = join(dirname(nativeRequest.source.path), TERMINAL_ACK)
    const state = captureRecord(statePath, PROBE_MAX_BYTES, owners)
    const ack = captureRecord(ackPath, TERMINAL_ACK_LIMIT, owners)
    const ownerIdentity = captureDirectory(owner)
    const contents = captureDirectory(join(application, 'Contents'))
    const bound = { ...handoff, nativeRequest }
    const requiredRequest = terminalRequest === 'cancelled' ? true : terminalRequest
    if (!(await inspectSquirrelIdle(cache, bundle, application, bound, undefined, requiredRequest)))
      return null
    const current = (): boolean => {
      try {
        return (
          publisherExited() &&
          squirrelCaptureMatches(ownerIdentity, captureDirectory(owner)) &&
          [cache, owner, dirname(nativeRequest.source.path)].every(
            (path) => (lstatSync(path).mode & UNSAFE_WRITE_MODE) === 0
          ) &&
          squirrelCaptureMatches(contents, captureDirectory(contents.path)) &&
          sameRecord(statePath, state, PROBE_MAX_BYTES, owners) &&
          sameRecord(ackPath, ack, TERMINAL_ACK_LIMIT, owners) &&
          squirrelCaptureMatches(
            nativeRequest.source,
            captureDirectory(nativeRequest.source.path)
          ) &&
          squirrelCaptureMatches(nativeRequest.target, captureDirectory(application))
        )
      } catch {
        return false
      }
    }
    if (!current()) return null
    if (terminalRequest === 'cancelled') return current
    return () => restoredHelpersAbsent(application, nativeRequest.source.path, uid) && current()
  } catch {
    return null
  }
}

// Only a committed retry runs this second process check synchronously under the handoff lock.
function restoredHelpersAbsent(application: string, source: string, uid: number): boolean {
  try {
    const candidate = join(source, ...SHIPIT_EXECUTABLE)
    const helpers = [realpathSync.native(join(application, ...SHIPIT_EXECUTABLE)), candidate]
    try {
      helpers.push(realpathSync.native(candidate))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const processes = execFileSync('/bin/ps', ['-ww', '-axo', 'uid=,comm='], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8',
    })
    const paths = squirrelProcessPaths(processes, uid, helpers)
    if (!paths) return false
    for (const path of paths) {
      try {
        if (helpers.includes(realpathSync.native(path))) return false
      } catch {
        if (basename(path) === SHIPIT_NAME) return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function squirrelAdmission(
  current: { version: string; buildNumber: string },
  handoff: SquirrelHandoff | null,
  status: SquirrelStartupStatus
): SquirrelAdmission {
  if (!handoff) return 'allow'
  const newer = isNewerRelease(current, handoff)
  if (newer === false) return 'allow'
  return newer === true &&
    status === 'failed' &&
    validSquirrelBinding(handoff.binding) &&
    handoff.binding.candidate === handoff.candidate
    ? 'failed'
    : 'exit'
}

function readNativeRecord(path: string, limit: number): Buffer {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const before = fstatSync(descriptor)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0, process.getuid!()].includes(before.uid) ||
      (before.mode & UNSAFE_WRITE_MODE) !== 0 ||
      before.size <= 0 ||
      before.size > limit
    )
      throw new Error('Unsafe native request record')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(descriptor)
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Native request changed during read')
    return bytes.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

export async function bindSquirrelRequest(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff,
  applicationSupport?: string
): Promise<SquirrelNativeRequest> {
  if (!/^[A-Za-z0-9.-]+$/.test(bundle)) throw new Error('Invalid Squirrel request bundle')
  const owner = join(realpathSync(cache), squirrelJobLabel(bundle, handoff.alternate))
  const ownerInfo = lstatSync(owner)
  if (
    !ownerInfo.isDirectory() ||
    ![0, process.getuid!()].includes(ownerInfo.uid) ||
    ownerInfo.mode & UNSAFE_WRITE_MODE
  )
    throw new Error('Unsafe Squirrel request directory')
  const statePath = join(owner, SHIPIT_STATE)
  const bytes = readNativeRecord(statePath, PROBE_MAX_BYTES)
  const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BYTES,
    encoding: 'utf8',
  })
  conversion.child.stdin?.end(bytes)
  const state = JSON.parse((await conversion).stdout)
  if (
    !validSquirrelBinding(handoff.binding) ||
    handoff.binding.candidate !== handoff.candidate ||
    !sameSquirrelBinding(state.binding, handoff.binding) ||
    state.bundleIdentifier !== bundle ||
    state.launchAfterInstallation !== false ||
    state.installationAuthorized !== false
  )
    throw new Error('Squirrel request artifact binding differs')
  const source = realpathSync(fileURLToPath(state.updateBundleURL))
  const target = realpathSync(fileURLToPath(state.targetBundleURL))
  if (
    dirname(dirname(source)) !== owner ||
    source !== resolve(fileURLToPath(state.updateBundleURL))
  )
    throw new Error('Squirrel request source differs')
  if (target !== realpathSync(application)) throw new Error('Squirrel request target differs')
  const nativeRequest = {
    source: captureDirectory(source),
    target: captureDirectory(target),
    binding: handoff.binding,
  }
  const product = JSON.parse(
    readNativeRecord(join(source, ...SOURCE_PRODUCT_CONFIG), PRODUCT_CONFIG_BYTES).toString()
  )
  const versionResult = run(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', '-'],
    {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: TERMINAL_ACK_LIMIT,
      encoding: 'utf8',
    }
  )
  versionResult.child.stdin?.end(
    readNativeRecord(join(source, 'Contents', 'Info.plist'), PRODUCT_CONFIG_BYTES)
  )
  const version = await versionResult
  const prepared = applicationSupport
    ? await readPreparedCandidate(applicationSupport, bundle, nativeRequest, handoff.alternate)
    : undefined
  const currentOwner = lstatSync(owner)
  if (
    version.stdout.trim() !== handoff.version ||
    product.build_number !== handoff.buildNumber ||
    currentOwner.dev !== ownerInfo.dev ||
    currentOwner.ino !== ownerInfo.ino ||
    currentOwner.uid !== ownerInfo.uid ||
    currentOwner.mode !== ownerInfo.mode ||
    !readNativeRecord(statePath, PROBE_MAX_BYTES).equals(bytes) ||
    !squirrelCaptureMatches(nativeRequest.source, captureDirectory(source)) ||
    !squirrelCaptureMatches(nativeRequest.target, captureDirectory(target))
  )
    throw new Error('Squirrel request candidate changed or differs')
  return prepared ? { ...nativeRequest, prepared } : nativeRequest
}

function squirrelCaptureMatches(
  expected: SquirrelNativeCapture,
  actual: SquirrelNativeCapture
): boolean {
  return (
    expected.path === actual.path &&
    (['parent', 'item'] as const).every((part) =>
      (['dev', 'ino', 'uid'] as const).every(
        (field) => expected[part]?.[field] === actual[part][field]
      )
    )
  )
}

async function readPreparedCandidate(
  support: string,
  bundle: string,
  request: SquirrelNativeRequest,
  alternate = false
): Promise<SquirrelNativeCapture | undefined> {
  try {
    const owner = join(realpathSync(support), squirrelJobLabel(bundle, alternate))
    const directory = join(owner, PREPARATION_DIRECTORY)
    for (const path of [owner, directory]) {
      const info = lstatSync(path)
      if (!info.isDirectory() || info.uid !== process.getuid!() || info.mode & UNSAFE_WRITE_MODE)
        return undefined
    }
    const bytes = readNativeRecord(join(directory, 'journal.plist'), PROBE_MAX_BYTES)
    const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8',
    })
    conversion.child.stdin?.end(bytes)
    const { schema, record } = JSON.parse((await conversion).stdout)
    if (
      schema !== '1' ||
      record?.state !== 'ready' ||
      record.failure ||
      record.ownership ||
      !sameSquirrelBinding(record.binding, request.binding) ||
      !squirrelCaptureMatches(record.source, request.source) ||
      !squirrelCaptureMatches(record.target, request.target)
    )
      return undefined
    const candidate = captureDirectory(realpathSync(record.candidate.path))
    if (alternate && dirname(dirname(candidate.path)) !== directory) return undefined
    return squirrelCaptureMatches(record.candidate, candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

export function squirrelPreparedDevice(
  prepared: SquirrelNativeCapture | undefined
): number | undefined {
  try {
    if (prepared && squirrelCaptureMatches(prepared, captureDirectory(realpathSync(prepared.path))))
      return prepared.item.dev
  } catch {
    // The native copy has changed. Keep the conservative space check.
  }
  return undefined
}

function captureDirectory(path: string): SquirrelNativeCapture {
  const identity = (value: string) => {
    const info = lstatSync(value)
    // /Applications can be admin-group writable. Its exact identity, rather
    // than a private-cache permission policy, binds the replacement namespace.
    if (!info.isDirectory() || ![0, process.getuid!()].includes(info.uid))
      throw new Error('Unsafe Squirrel directory')
    return { dev: info.dev, ino: info.ino, uid: info.uid }
  }
  return { path, parent: identity(dirname(path)), item: identity(path) }
}

export async function readSquirrelFailure(
  source: string,
  application: string,
  expected?: SquirrelNativeRequest
): Promise<boolean> {
  return readFailure(source, application, expected)
}

async function readFailure(
  source: string,
  application: string,
  expected?: SquirrelNativeRequest,
  replacement?: SquirrelNativeCapture,
  failureCode?: number
): Promise<boolean> {
  let descriptor: number | undefined
  try {
    if (!expected || !validSquirrelBinding(expected.binding)) return false
    const path = fileURLToPath(source)
    const parent = realpathSync(dirname(path))
    const sourcePath = join(parent, basename(path))
    const targetPath = realpathSync(application)
    const identity = (value: string) => {
      const info = lstatSync(value)
      if (!info.isDirectory()) throw new Error('Invalid native acknowledgement identity')
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    const capture = (value: string) => ({
      path: value,
      parent: identity(dirname(value)),
      item: identity(value),
    })
    const expectedSource = capture(sourcePath)
    const expectedTarget = capture(targetPath)
    const parentInfo = lstatSync(parent)
    if (
      (parentInfo.mode & UNSAFE_WRITE_MODE) !== 0 ||
      ![0, process.getuid!()].includes(parentInfo.uid)
    )
      return false
    descriptor = openSync(
      join(parent, TERMINAL_ACK),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const before = fstatSync(descriptor)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0, process.getuid!()].includes(before.uid) ||
      (before.mode & UNSAFE_WRITE_MODE) !== 0 ||
      before.size <= 0 ||
      before.size > TERMINAL_ACK_LIMIT
    )
      return false
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const bytes = buffer.subarray(0, length)
    const after = fstatSync(descriptor)
    if (
      bytes.length !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return false
    const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: TERMINAL_ACK_LIMIT,
      encoding: 'utf8',
    })
    conversion.child.stdin?.end(bytes)
    const result = await conversion
    const record = JSON.parse(result.stdout)
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
    const matches = (observed: typeof expectedSource, expected: typeof expectedSource) =>
      observed?.path === expected.path &&
      ['parent', 'item'].every((key) => {
        const part = key as 'parent' | 'item'
        return (
          observed[part]?.dev === expected[part].dev &&
          observed[part]?.ino === expected[part].ino &&
          observed[part]?.uid === expected[part].uid
        )
      })
    return (
      record.schema === 1 &&
      record.ready === false &&
      Number.isSafeInteger(record.code) &&
      record.code !== 0 &&
      (failureCode === undefined || record.code === failureCode) &&
      sameSquirrelBinding(record.binding, expected.binding) &&
      matches(record.source, expectedSource) &&
      (replacement
        ? matches(expectedTarget, replacement) &&
          expectedTarget.path === expected.target.path &&
          same(expectedTarget.parent, expected.target.parent)
        : matches(record.target, expectedTarget)) &&
      matches(record.source, expected.source) &&
      matches(record.target, expected.target) &&
      same(expectedSource, capture(sourcePath)) &&
      same(expectedTarget, capture(targetPath))
    )
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
interface InstallationEvidence {
  application: string
  executable: string
  uid: number
  target: string
  processes: string
}

/** Evidence only changes the notice; version reconciliation owns successful admission. */
export function classifySquirrelStartup(
  handoff: SquirrelHandoff,
  evidence: InstallationEvidence,
  now: number
): SquirrelStartupStatus {
  if (handoff.state === 'failed')
    return validSquirrelBinding(handoff.binding) && handoff.binding.candidate === handoff.candidate
      ? 'failed'
      : 'unconfirmed'
  const age = now - handoff.at
  if (
    !['installing', 'downloaded'].includes(handoff.state) ||
    !Number.isSafeInteger(age) ||
    age < 0 ||
    age > SQUIRREL_INSTALLATION_WINDOW_MS
  )
    return 'unconfirmed'
  try {
    if (resolve(fileURLToPath(evidence.target.trim())) !== resolve(evidence.application))
      return 'unconfirmed'
  } catch {
    return 'unconfirmed'
  }
  const active = evidence.processes.split(/\r?\n/).some((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return (
      match !== null &&
      [0, evidence.uid].includes(Number(match[1])) &&
      match[2] === evidence.executable
    )
  })
  return active ? 'installing' : 'unconfirmed'
}

/** Wait for the launching native helper to exit; absence still grants nothing. */
export async function settleSquirrelStartup(
  probe: () => Promise<SquirrelStartupStatus>
): Promise<SquirrelStartupStatus> {
  const deadline = performance.now() + NATIVE_SETTLE_TIMEOUT_MS
  let status = await probe()
  while (['installing', 'restoring'].includes(status) && performance.now() < deadline) {
    await delay(NATIVE_SETTLE_INTERVAL_MS)
    status = await probe()
  }
  return status
}

export async function inspectSquirrelStartup(
  handoff: SquirrelHandoff,
  cache: string,
  bundle: string,
  application: string
): Promise<SquirrelStartupStatus> {
  if (handoff.state === 'failed')
    return validSquirrelBinding(handoff.binding) && handoff.binding.candidate === handoff.candidate
      ? 'failed'
      : 'unconfirmed'
  if (
    validSquirrelBinding(handoff.binding) &&
    handoff.binding.candidate === handoff.candidate &&
    ['requested', 'downloaded'].includes(handoff.state)
  )
    return 'failed'
  if (process.platform !== 'darwin' || !process.getuid || !/^[A-Za-z0-9.-]+$/.test(bundle))
    return 'unconfirmed'
  try {
    const directory = join(cache, squirrelJobLabel(bundle, handoff.alternate))
    const statePath = join(directory, SHIPIT_STATE)
    if (handoff.nativeRequest && dirname(dirname(handoff.nativeRequest.source.path)) !== directory)
      return 'unconfirmed'
    const options = {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8' as const,
    }
    const bytes = readNativeRecord(statePath, PROBE_MAX_BYTES)
    const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], options)
    conversion.child.stdin?.end(bytes)
    const [state, processes] = await Promise.all([
      conversion,
      run('/bin/ps', ['-ww', '-axo', 'uid=,comm='], options),
    ])
    const executable = await realpath(join(application, ...SHIPIT_EXECUTABLE))
    const uid = process.getuid()
    const request = JSON.parse(state.stdout)
    const native = handoff.nativeRequest
    if (
      request.bundleIdentifier !== bundle ||
      (native &&
        (((native.binding || request.binding) &&
          !sameSquirrelBinding(native.binding, request.binding)) ||
          resolve(fileURLToPath(request.updateBundleURL)) !== native.source.path ||
          resolve(fileURLToPath(request.targetBundleURL)) !== native.target.path)) ||
      !readNativeRecord(statePath, PROBE_MAX_BYTES).equals(bytes)
    )
      return 'unconfirmed'
    if (
      native &&
      sameSquirrelBinding(handoff.binding, native.binding) &&
      (await readSquirrelFailure(request.updateBundleURL, application, native))
    ) {
      const executables = await squirrelHelperPaths(executable, native.source.path)
      return (await squirrelHelpersAbsent(processes.stdout, uid, executables))
        ? 'failed'
        : 'restoring'
    }
    const candidates = processes.stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      return match && [0, uid].includes(Number(match[1])) && match[2].endsWith('/ShipIt')
        ? [{ uid: Number(match[1]), path: match[2] }]
        : []
    })
    const canonical = await Promise.allSettled(
      candidates.map(async (candidate) => `${candidate.uid} ${await realpath(candidate.path)}`)
    )
    const observed = canonical.flatMap((entry) =>
      entry.status === 'fulfilled' ? [entry.value] : []
    )
    return classifySquirrelStartup(
      handoff,
      {
        application,
        executable,
        uid,
        target: request.targetBundleURL,
        processes: observed.join('\n'),
      },
      Date.now()
    )
  } catch {
    // Missing/stale native state, command failure and timeout never release the handoff.
    return 'unconfirmed'
  }
}
