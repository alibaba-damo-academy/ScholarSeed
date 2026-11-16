// Read-only startup classification. None of these results authorize backend admission.
import { execFile } from 'node:child_process'
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
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  sameSquirrelBinding,
  validSquirrelBinding,
  type SquirrelHandoff,
  type SquirrelNativeRequest,
  type SquirrelNativeCapture,
} from './squirrel.ts'
import { BUILD_NUMBER_PATTERN, isNewerRelease } from './version.ts'
import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'

export const SQUIRREL_INSTALLATION_WINDOW_MS = 10 * 60_000
const NATIVE_SETTLE_TIMEOUT_MS = 5000
const NATIVE_SETTLE_INTERVAL_MS = 100
const PROBE_TIMEOUT_MS = 2000
const PROBE_MAX_BYTES = 1024 * 1024
const SHIPIT_NAME = 'ShipIt'
const SHIPIT_EXECUTABLE = ['Contents', 'Frameworks', 'Squirrel.framework', 'Resources', SHIPIT_NAME]
const SHIPIT_STATE = 'ShipItState.plist'
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

export async function squirrelHelpersAbsent(
  processes: string,
  uid: number,
  executables: readonly string[],
  canonicalize: (path: string) => Promise<string> = realpath
): Promise<boolean> {
  if (!processes.trim() || !executables.length || executables.some((path) => !isAbsolute(path)))
    return false
  for (const line of processes.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return false
    if (![0, uid].includes(Number(match[1]))) continue
    const path = match[2]
    if (executables.includes(path)) return false
    if (!isAbsolute(path)) {
      if (basename(path) === SHIPIT_NAME) return false
      continue
    }
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

export async function inspectSquirrelIdle(
  cache: string,
  bundle: string,
  application: string,
  handoff: SquirrelHandoff | null,
  verifyReplacement?: (application: string) => Promise<void>
): Promise<boolean> {
  if (process.platform !== 'darwin' || !process.getuid || !/^[A-Za-z0-9.-]+$/.test(bundle))
    return false
  const uid = process.getuid()
  const directory = join(cache, `${bundle}.ShipIt`)
  const statePath = join(directory, SHIPIT_STATE)
  const snapshot = () => {
    const identity = (path: string) => {
      const info = lstatSync(path)
      if (!info.isDirectory() || ![0, uid].includes(info.uid) || info.mode & UNSAFE_WRITE_MODE)
        throw new Error('Unsafe Squirrel cache directory')
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    const cacheIdentity = identity(cache)
    let directoryIdentity: ReturnType<typeof identity> | null = null
    try {
      directoryIdentity = identity(directory)
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
    const executables = [await realpath(join(target, ...SHIPIT_EXECUTABLE))]
    const native = handoff?.nativeRequest
    if (native) {
      if (
        native.target.path !== target ||
        !validSquirrelBinding(native.binding) ||
        !sameSquirrelBinding(handoff?.binding, native.binding) ||
        native.binding.candidate !== handoff?.candidate
      )
        return false
      // Include the bound candidate: it can own the helper during relaunch.
      const candidateHelper = join(native.source.path, ...SHIPIT_EXECUTABLE)
      executables.push(candidateHelper)
      try {
        executables.push(await realpath(candidateHelper))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const before = snapshot()
    const options = {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8' as const,
    }
    const helpersAbsent = async () => {
      const processes = await run('/bin/ps', ['-ww', '-axo', 'uid=,comm='], options)
      return squirrelHelpersAbsent(processes.stdout, uid, executables)
    }
    if (!(await helpersAbsent())) return false
    let failed: (() => Promise<boolean>) | undefined
    if (before.bytes) {
      if (!native) return false
      const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], options)
      conversion.child.stdin?.end(before.bytes)
      const request = JSON.parse((await conversion).stdout)
      if (
        request.bundleIdentifier !== bundle ||
        !sameSquirrelBinding(request.binding, native.binding) ||
        !SHIPIT_REQUEST_FLAGS.every((key) => typeof request[key] === 'boolean') ||
        (request.installationAuthorized && !request.launchAfterInstallation) ||
        resolve(fileURLToPath(request.targetBundleURL)) !== target ||
        resolve(fileURLToPath(request.updateBundleURL)) !== native.source.path
      )
        return false
      // A superseding installation has its own identity. Keep the historical
      // failure bound to the old target; never rebase that failure onto this app.
      const replacement = captureDirectory(target)
      const contents = captureDirectory(join(target, 'Contents'))
      if (verifyReplacement) await verifyReplacement(target)
      const replacementStable = () =>
        JSON.stringify(replacement) === JSON.stringify(captureDirectory(target)) &&
        JSON.stringify(contents) === JSON.stringify(captureDirectory(join(target, 'Contents')))
      failed = async () =>
        replacementStable() &&
        (await readFailure(
          request.updateBundleURL,
          target,
          native,
          verifyReplacement ? replacement : undefined
        )) &&
        replacementStable()
      if (!(await failed())) return false
    }
    // Both branches retain native records. A failed request is terminal evidence,
    // not an invitation to replay installation or delete an unresolved request.
    if (!(await helpersAbsent()) || (failed && !(await failed()))) return false
    const after = snapshot()
    return (
      before.identity === after.identity &&
      (before.bytes === null ? after.bytes === null : !!after.bytes?.equals(before.bytes))
    )
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
  handoff: SquirrelHandoff
): Promise<SquirrelNativeRequest> {
  if (!/^[A-Za-z0-9.-]+$/.test(bundle)) throw new Error('Invalid Squirrel request bundle')
  const statePath = join(cache, `${bundle}.ShipIt`, SHIPIT_STATE)
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
    state.installationAuthorized !== false
  )
    throw new Error('Squirrel request artifact binding differs')
  const source = realpathSync(fileURLToPath(state.updateBundleURL))
  const target = realpathSync(fileURLToPath(state.targetBundleURL))
  if (target !== realpathSync(application)) throw new Error('Squirrel request target differs')
  const capture = (path: string) => {
    const identity = (value: string) => {
      const info = lstatSync(value)
      if (!info.isDirectory()) throw new Error('Squirrel request is not a directory')
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    return { path, parent: identity(dirname(path)), item: identity(path) }
  }
  const nativeRequest = {
    source: capture(source),
    target: capture(target),
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
  if (
    version.stdout.trim() !== handoff.version ||
    product.build_number !== handoff.buildNumber ||
    !readNativeRecord(statePath, PROBE_MAX_BYTES).equals(bytes) ||
    JSON.stringify(nativeRequest) !==
      JSON.stringify({ source: capture(source), target: capture(target), binding: handoff.binding })
  )
    throw new Error('Squirrel request candidate changed or differs')
  return nativeRequest
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
  replacement?: SquirrelNativeCapture
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
    const options = {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8' as const,
    }
    const [target, processes] = await Promise.all([
      run(
        '/usr/bin/plutil',
        [
          '-extract',
          'targetBundleURL',
          'raw',
          '-o',
          '-',
          join(cache, `${bundle}.ShipIt`, SHIPIT_STATE),
        ],
        options
      ),
      run('/bin/ps', ['-ww', '-axo', 'uid=,comm='], options),
    ])
    const executable = await realpath(join(application, ...SHIPIT_EXECUTABLE))
    const uid = process.getuid()
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
    const status = classifySquirrelStartup(
      handoff,
      {
        application,
        executable,
        uid,
        target: target.stdout,
        processes: observed.join('\n'),
      },
      Date.now()
    )
    const active = observed.some((entry) => entry.endsWith(` ${executable}`))
    const source = await run(
      '/usr/bin/plutil',
      [
        '-extract',
        'updateBundleURL',
        'raw',
        '-o',
        '-',
        join(cache, `${bundle}.ShipIt`, SHIPIT_STATE),
      ],
      options
    )
    if (
      sameSquirrelBinding(handoff.binding, handoff.nativeRequest?.binding) &&
      (await readSquirrelFailure(source.stdout.trim(), application, handoff.nativeRequest))
    )
      return active ? 'restoring' : 'failed'
    return status
  } catch {
    // Missing/stale native state, command failure and timeout never release the handoff.
    return 'unconfirmed'
  }
}
