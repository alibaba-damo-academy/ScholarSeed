// Read-only startup classification. None of these results authorize backend admission.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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
} from './squirrel.ts'
import { BUILD_NUMBER_PATTERN, isNewerRelease } from './version.ts'

export const SQUIRREL_INSTALLATION_WINDOW_MS = 10 * 60_000
const NATIVE_SETTLE_TIMEOUT_MS = 5000
const NATIVE_SETTLE_INTERVAL_MS = 100
const PROBE_TIMEOUT_MS = 2000
const PROBE_MAX_BYTES = 1024 * 1024
const SHIPIT_EXECUTABLE = ['Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt']
const SHIPIT_STATE = 'ShipItState.plist'
const TERMINAL_ACK = '.scholarseed-prepare.plist'
const TERMINAL_ACK_LIMIT = 4096
const UNSAFE_WRITE_MODE = 0o022
const PRODUCT_CONFIG_BYTES = 64 * 1024
const SOURCE_PRODUCT_CONFIG = ['Contents', 'Resources', 'product.json']
const run = promisify(execFile)
export type SquirrelStartupStatus = 'installing' | 'failed' | 'unconfirmed'
export type SquirrelAdmission = 'allow' | 'exit' | 'failed' | 'superseded'

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

export function squirrelHelpersAbsent(processes: string, uid: number): boolean {
  if (!processes.trim()) return false
  return processes.split(/\r?\n/).every((line) => {
    if (!line.trim()) return true
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return false
    return ![0, uid].includes(Number(match[1])) || basename(match[2]) !== 'ShipIt'
  })
}

export async function inspectSquirrelIdle(cache: string, bundle: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !process.getuid || !/^[A-Za-z0-9.-]+$/.test(bundle))
    return false
  const uid = process.getuid()
  const directory = join(cache, `${bundle}.ShipIt`)
  const absent = () => {
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
      lstatSync(join(directory, SHIPIT_STATE))
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return JSON.stringify({ cacheIdentity, directoryIdentity })
    }
  }
  try {
    if ((await realpath(cache)) !== cache) return false
    const before = absent()
    if (!before) return false
    const processes = await run('/bin/ps', ['-ww', '-axo', 'uid=,comm='], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      encoding: 'utf8',
    })
    return squirrelHelpersAbsent(processes.stdout, uid) && absent() === before
  } catch {
    return false
  }
}

export function squirrelAdmission(
  current: { version: string; buildNumber: string },
  handoff: SquirrelHandoff | null,
  status: SquirrelStartupStatus
): SquirrelAdmission {
  if (!handoff || isNewerRelease(current, handoff) === false) return 'allow'
  return status === 'failed' ? 'failed' : 'exit'
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

export async function readSquirrelFailure(
  source: string,
  application: string,
  expected?: SquirrelNativeRequest
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
      sameSquirrelBinding(record.binding, expected.binding) &&
      matches(record.source, expectedSource) &&
      matches(record.target, expectedTarget) &&
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
  while (status === 'installing' && performance.now() < deadline) {
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
    if (status !== 'unconfirmed' || observed.some((entry) => entry.endsWith(` ${executable}`)))
      return status
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
    if (!sameSquirrelBinding(handoff.binding, handoff.nativeRequest?.binding)) return 'unconfirmed'
    return (await readSquirrelFailure(source.stdout.trim(), application, handoff.nativeRequest))
      ? 'failed'
      : 'unconfirmed'
  } catch {
    // Missing/stale native state, command failure and timeout never release the handoff.
    return 'unconfirmed'
  }
}
