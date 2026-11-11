import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'
import { decodeUpdateLaunch, updateLaunchContextPath } from './relaunch.ts'
import type { UpdateLaunchContext } from './relaunch.ts'
import {
  decodeSquirrelHandoff,
  sameSquirrelBinding,
  validSquirrelBinding,
  squirrelHandoffRecordPath,
  type SquirrelNativeCapture,
} from './squirrel.ts'

export const TERMINAL_PROTOCOL = Object.freeze({
  schema: 1,
  timeoutMs: 30_000,
  outputBytes: 64 * 1024,
})
const INSPECTION_SCHEMA = TERMINAL_PROTOCOL.schema
const CONTEXT_BYTES = 16 * 1024
const HANDOFF_BYTES = 4096
const PRODUCT_BYTES = 64 * 1024
export const TERMINAL_RECORD_LIMITS = Object.freeze({
  context: CONTEXT_BYTES,
  handoff: HANDOFF_BYTES,
  product: PRODUCT_BYTES,
})
const OUTPUT_BYTES = TERMINAL_PROTOCOL.outputBytes
const PROCESS_TIMEOUT_MS = TERMINAL_PROTOCOL.timeoutMs
const UNSAFE_WRITE_MODE = 0o022
const HASH_PATTERN = /^[a-f0-9]{64}$/
const TEAM_PATTERN = /^[A-Z0-9]{10}$/
const PRODUCT_FILE = ['Contents', 'Resources', 'product.json']
export const DISTRIBUTION_LANE = 'distribution'
const NATIVE_OBSERVATION_KIND = 'terminal-failure-observation'
const ORPHAN_OBSERVATION_KIND = 'orphan-preparation-observation'
const RECORD_FIELDS = [
  'sha256',
  'device',
  'inode',
  'uid',
  'size',
  'mode',
  'modified',
  'changed',
] as const
const EXECUTION_REQUIREMENTS = [
  'native-locks',
  'product-maintenance',
  'source-family-exit',
  'durable-compare-consume',
] as const
const run = promisify(execFile)

export interface TerminalRecoveryOptions {
  application: string
  coordinator: string
  handoff: string
  nativeState: string
  preparation: string
  cleanup: string
  toolDirectory: string
  expectedTeam: string
  selection?: RepairRoots
}
export type RepairSelection = Omit<UpdateLaunchContext, 'at'>
export type RepairRoots = Pick<RepairSelection, 'home' | 'userData' | 'workspace'>
const REPAIR_ROOTS = ['home', 'userData', 'workspace'] as const

export function sameRepairSelection(first: RepairRoots, second: RepairRoots): boolean {
  return REPAIR_ROOTS.every((key) => first[key] === second[key])
}

export interface TerminalRecoveryDependencies {
  platform: NodeJS.Platform
  uid: number
  verifyApplication(application: string, bundle: string, team: string): Promise<void>
  probe(options: TerminalRecoveryOptions, request: Record<string, unknown>): Promise<unknown>
  selection?: RepairSelection
}

type InspectionErrorCode =
  | 'unsupported_platform'
  | 'invalid_scope'
  | 'unsafe_record'
  | 'invalid_records'
  | 'source_identity_differs'
  | 'signature_refused'
  | 'native_preflight_refused'
  | 'native_evidence_differs'
  | 'evidence_changed'

export class RecoveryInspectionError extends Error {
  readonly code: InspectionErrorCode

  constructor(code: InspectionErrorCode) {
    super(code)
    this.name = 'RecoveryInspectionError'
    this.code = code
  }
}

export interface RecordSnapshot {
  sha256: string
  device: string
  inode: string
  uid: number
  size: number
  mode: number
  modified: string
  changed: string
}

export interface CapturedRecord {
  bytes: Buffer
  snapshot: RecordSnapshot
}

function reject(code: InspectionErrorCode): never {
  throw new RecoveryInspectionError(code)
}

function object(
  value: unknown,
  code: InspectionErrorCode = 'invalid_records'
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  return value as Record<string, unknown>
}

function absolute(path: string): string {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.includes('\0')
  )
    reject('invalid_scope')
  return path
}

function canonicalDirectory(path: string): void {
  if (realpathSync.native(path) !== path || !lstatSync(path).isDirectory()) reject('invalid_scope')
}

export function captureRecord(
  path: string,
  limit: number,
  owners: readonly number[]
): CapturedRecord {
  absolute(path)
  canonicalDirectory(dirname(path))
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !owners.includes(Number(before.uid)) ||
      Number(before.mode) & UNSAFE_WRITE_MODE ||
      before.size <= 0n ||
      before.size > BigInt(limit)
    )
      reject('unsafe_record')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(descriptor, { bigint: true })
    const located = lstatSync(path, { bigint: true })
    if (
      BigInt(length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      located.isSymbolicLink() ||
      located.dev !== before.dev ||
      located.ino !== before.ino
    )
      reject('evidence_changed')
    const content = bytes.subarray(0, length)
    return {
      bytes: content,
      snapshot: {
        sha256: createHash('sha256').update(content).digest('hex'),
        device: String(before.dev),
        inode: String(before.ino),
        uid: Number(before.uid),
        size: length,
        mode: Number(before.mode),
        modified: String(before.mtimeNs),
        changed: String(before.ctimeNs),
      },
    }
  } finally {
    closeSync(descriptor)
  }
}

export function sameRecord(
  path: string,
  expected: CapturedRecord,
  limit: number,
  owners: readonly number[]
): boolean {
  const observed = captureRecord(path, limit, owners)
  return (
    RECORD_FIELDS.every((field) => observed.snapshot[field] === expected.snapshot[field]) &&
    observed.bytes.equals(expected.bytes)
  )
}

function sameCapture(expected: SquirrelNativeCapture, value: unknown): boolean {
  const observed = object(value, 'native_evidence_differs')
  const contents = object(observed.contents, 'native_evidence_differs')
  if (
    !['dev', 'ino', 'uid'].every(
      (field) => Number.isSafeInteger(contents[field]) && Number(contents[field]) >= 0
    )
  )
    return false
  return (
    observed.path === expected.path &&
    ['parent', 'item'].every((part) => {
      const identity = object(observed[part], 'native_evidence_differs')
      const wanted = expected[part as 'parent' | 'item']
      return ['dev', 'ino', 'uid'].every(
        (field) => identity[field] === wanted[field as keyof typeof wanted]
      )
    })
  )
}

export function assertTerminalSignatureIdentity(
  output: string,
  bundle: string,
  team: string
): void {
  const verdict = classifyMacosTrust(parseCodesignIdentity(output), {
    expectedBundleId: bundle,
    expectedTeamId: team,
    metaTeamId: team,
  })
  if (!verdict.trusted) reject('signature_refused')
}

export async function verifyApplication(
  application: string,
  bundle: string,
  team: string
): Promise<void> {
  await run(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--all-architectures', application],
    { timeout: PROCESS_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES }
  )
  const result = await run('/usr/bin/codesign', ['--display', '--verbose=4', application], {
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: OUTPUT_BYTES,
  })
  assertTerminalSignatureIdentity(result.stdout + '\n' + result.stderr, bundle, team)
}

export function orphanSource(
  options: Pick<TerminalRecoveryOptions, 'nativeState' | 'application'>,
  expected: unknown,
  uid: number
): string {
  const record = expected ? object(expected, 'native_evidence_differs') : null
  let bytes: Buffer
  if (record) {
    if (record.kind !== ORPHAN_OBSERVATION_KIND || typeof record.stateBytes !== 'string')
      reject('native_evidence_differs')
    bytes = Buffer.from(record.stateBytes, 'base64')
    if (
      !bytes.length ||
      bytes.length > PRODUCT_BYTES ||
      bytes.toString('base64') !== record.stateBytes
    )
      reject('native_evidence_differs')
  } else bytes = captureRecord(options.nativeState, PRODUCT_BYTES, [uid]).bytes
  const state = object(JSON.parse(bytes.toString('utf8')))
  if (
    state.installationAuthorized !== false ||
    state.launchAfterInstallation !== false ||
    typeof state.updateBundleURL !== 'string' ||
    typeof state.targetBundleURL !== 'string' ||
    !validSquirrelBinding(state.binding) ||
    realpathSync.native(fileURLToPath(String(state.targetBundleURL))) !== options.application
  )
    reject('invalid_records')
  return absolute(realpathSync.native(fileURLToPath(state.updateBundleURL)))
}

function validateRecoveryScope(
  options: TerminalRecoveryOptions,
  runtime: TerminalRecoveryDependencies
): void {
  if (runtime.platform !== 'darwin' || !Number.isSafeInteger(runtime.uid) || runtime.uid < 0)
    reject('unsupported_platform')
  for (const key of [
    'application',
    'coordinator',
    'handoff',
    'nativeState',
    'preparation',
    'cleanup',
    'toolDirectory',
  ] as const)
    absolute(options[key])
  if (!TEAM_PATTERN.test(options.expectedTeam)) reject('invalid_scope')
  canonicalDirectory(options.application)
  canonicalDirectory(options.coordinator)
}

function captureRecoveryRecords(
  options: TerminalRecoveryOptions,
  uid: number,
  selection?: RepairSelection
) {
  const contextPath = updateLaunchContextPath(options.coordinator, options.application)
  const contextRecord = selection ? null : captureRecord(contextPath, CONTEXT_BYTES, [uid])
  const handoffRecord = captureRecord(options.handoff, HANDOFF_BYTES, [uid])
  const productPath = join(options.application, ...PRODUCT_FILE)
  const productRecord = captureRecord(productPath, PRODUCT_BYTES, [0, uid])
  return { contextPath, contextRecord, handoffRecord, productPath, productRecord }
}

function assertRecoveryProduct(
  policy: Record<string, unknown>,
  context: RepairSelection,
  team: string,
  build: string
): void {
  if (
    policy.bundle_id !== context.bundleId ||
    policy.expected_team_id !== team ||
    policy.build_number !== build ||
    policy.release_lane !== DISTRIBUTION_LANE
  )
    reject('source_identity_differs')
}

function absentRecord(filename: string): boolean {
  try {
    lstatSync(filename)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function sameRecoveryRecords(
  options: TerminalRecoveryOptions,
  uid: number,
  records: ReturnType<typeof captureRecoveryRecords>
): boolean {
  const contextMatches = records.contextRecord
    ? sameRecord(records.contextPath, records.contextRecord, CONTEXT_BYTES, [uid])
    : absentRecord(records.contextPath)
  return (
    contextMatches &&
    sameRecord(options.handoff, records.handoffRecord, HANDOFF_BYTES, [uid]) &&
    sameRecord(records.productPath, records.productRecord, PRODUCT_BYTES, [0, uid])
  )
}

export async function inspectOrphanRecovery(
  options: TerminalRecoveryOptions,
  runtime: TerminalRecoveryDependencies
) {
  let phase: InspectionErrorCode = 'invalid_scope'
  try {
    validateRecoveryScope(options, runtime)
    phase = 'unsafe_record'
    const records = captureRecoveryRecords(options, runtime.uid, runtime.selection)
    const { contextPath, contextRecord, handoffRecord, productRecord } = records
    phase = 'invalid_records'
    const context =
      runtime.selection ??
      (contextRecord ? decodeUpdateLaunch(contextRecord.bytes) : reject('invalid_records'))
    if (
      runtime.selection &&
      (!options.selection ||
        !absentRecord(contextPath) ||
        !sameRepairSelection(options.selection, context))
    )
      reject('invalid_scope')
    const handoff = decodeSquirrelHandoff(handoffRecord.bytes)
    if (
      context.uid !== runtime.uid ||
      context.application !== options.application ||
      context.candidate !== handoff.candidate ||
      context.targetBuild !== handoff.buildNumber ||
      !validSquirrelBinding(handoff.binding) ||
      handoff.binding.candidate !== context.candidate ||
      !['requested', 'failed'].includes(handoff.state) ||
      squirrelHandoffRecordPath(context.home) !== options.handoff
    )
      reject('invalid_records')
    const policy = object(JSON.parse(productRecord.bytes.toString('utf8')))
    assertRecoveryProduct(policy, context, options.expectedTeam, context.sourceBuild)
    phase = 'signature_refused'
    await runtime.verifyApplication(options.application, context.bundleId, options.expectedTeam)
    phase = 'native_preflight_refused'
    const observed = object(
      await runtime.probe(options, {
        binding: handoff.binding,
        selection: {
          schema: context.schema,
          paths: [context.home, context.userData, context.workspace],
          identities: context.identities,
        },
      }),
      'native_evidence_differs'
    )
    phase = 'native_evidence_differs'
    const source = object(observed.source, 'native_evidence_differs')
    const target = object(observed.target, 'native_evidence_differs')
    if (
      observed.kind !== ORPHAN_OBSERVATION_KIND ||
      observed.bundleIdentifier !== context.bundleId ||
      !sameSquirrelBinding(observed.binding, handoff.binding) ||
      target.path !== options.application ||
      typeof source.path !== 'string' ||
      !HASH_PATTERN.test(String(object(observed.journal).sha256)) ||
      !HASH_PATTERN.test(String(object(observed.state).sha256)) ||
      object(observed.selection).schema !== context.schema ||
      !HASH_PATTERN.test(String(object(observed.selection).sha256))
    )
      reject('native_evidence_differs')
    canonicalDirectory(source.path)
    phase = 'unsafe_record'
    const candidate = captureRecord(join(source.path, ...PRODUCT_FILE), PRODUCT_BYTES, [
      0,
      runtime.uid,
    ])
    phase = 'invalid_records'
    const candidatePolicy = object(JSON.parse(candidate.bytes.toString('utf8')))
    assertRecoveryProduct(candidatePolicy, context, options.expectedTeam, context.targetBuild)
    phase = 'signature_refused'
    await runtime.verifyApplication(source.path, context.bundleId, options.expectedTeam)
    phase = 'evidence_changed'
    if (
      !sameRecoveryRecords(options, runtime.uid, records) ||
      !sameRecord(join(source.path, ...PRODUCT_FILE), candidate, PRODUCT_BYTES, [0, runtime.uid])
    )
      reject('evidence_changed')
    return observed
  } catch (error) {
    if (error instanceof RecoveryInspectionError) throw error
    reject(phase)
  }
}

export async function inspectTerminalRecovery(
  options: TerminalRecoveryOptions,
  runtime: TerminalRecoveryDependencies
) {
  if (runtime.platform !== 'darwin' || !Number.isSafeInteger(runtime.uid) || runtime.uid < 0)
    reject('unsupported_platform')
  let phase: InspectionErrorCode = 'invalid_scope'
  try {
    validateRecoveryScope(options, runtime)
    phase = 'unsafe_record'
    const records = captureRecoveryRecords(options, runtime.uid)
    const { contextRecord, handoffRecord, productRecord } = records
    phase = 'invalid_records'
    if (!contextRecord) reject('invalid_records')
    const context = decodeUpdateLaunch(contextRecord.bytes)
    const handoff = decodeSquirrelHandoff(handoffRecord.bytes)
    const policy = object(JSON.parse(productRecord.bytes.toString('utf8')))
    const nativeRequest = handoff.nativeRequest
    if (
      context.uid !== runtime.uid ||
      context.application !== options.application ||
      !nativeRequest ||
      !sameSquirrelBinding(handoff.binding, nativeRequest.binding) ||
      handoff.candidate !== context.candidate ||
      handoff.buildNumber !== context.targetBuild ||
      !handoff.binding ||
      handoff.binding.candidate !== context.candidate ||
      nativeRequest.target.path !== options.application
    )
      reject('invalid_records')
    const handoffLocation = relative(context.home, options.handoff)
    if (!handoffLocation || isAbsolute(handoffLocation) || handoffLocation.startsWith('..'))
      reject('invalid_scope')
    assertRecoveryProduct(policy, context, options.expectedTeam, context.sourceBuild)
    phase = 'signature_refused'
    await runtime.verifyApplication(options.application, context.bundleId, options.expectedTeam)
    phase = 'native_preflight_refused'
    const observed = object(
      await runtime.probe(options, {
        source: nativeRequest.source.path,
        binding: handoff.binding,
        selection: {
          schema: context.schema,
          paths: [context.home, context.userData, context.workspace],
          identities: context.identities,
        },
      }),
      'native_evidence_differs'
    )
    phase = 'native_evidence_differs'
    if (
      observed.kind !== NATIVE_OBSERVATION_KIND ||
      observed.bundleIdentifier !== context.bundleId ||
      !Number.isSafeInteger(observed.code) ||
      typeof observed.code !== 'number' ||
      observed.code === 0 ||
      !sameSquirrelBinding(observed.binding, handoff.binding) ||
      !sameCapture(nativeRequest.source, observed.source) ||
      !sameCapture(nativeRequest.target, observed.target)
    )
      reject('native_evidence_differs')
    const selection = object(observed.selection, 'native_evidence_differs')
    if (
      selection.schema !== context.schema ||
      typeof selection.sha256 !== 'string' ||
      !HASH_PATTERN.test(selection.sha256)
    )
      reject('native_evidence_differs')
    const journal = object(observed.journal, 'native_evidence_differs')
    const acknowledgement = object(observed.ack, 'native_evidence_differs')
    const state = object(observed.state, 'native_evidence_differs')
    if (
      ![journal, acknowledgement, state].every(
        (record) => typeof record.sha256 === 'string' && HASH_PATTERN.test(record.sha256)
      )
    )
      reject('native_evidence_differs')
    phase = 'evidence_changed'
    if (!sameRecoveryRecords(options, runtime.uid, records)) reject('evidence_changed')
    return {
      schema: INSPECTION_SCHEMA,
      mode: 'inspect' as const,
      outcome: 'terminal_failure_verified' as const,
      transaction: {
        sourceBuild: context.sourceBuild,
        targetBuild: context.targetBuild,
        candidate: context.candidate,
      },
      failureCode: observed.code,
      records: {
        context: contextRecord.snapshot,
        handoff: handoffRecord.snapshot,
        product: productRecord.snapshot,
        native: {
          journalSha256: journal.sha256 as string,
          acknowledgementSha256: acknowledgement.sha256 as string,
          stateSha256: state.sha256 as string,
        },
      },
      observationSha256: createHash('sha256')
        .update(
          JSON.stringify([
            contextRecord.snapshot,
            handoffRecord.snapshot,
            productRecord.snapshot,
            observed,
          ])
        )
        .digest('hex'),
      selectionSha256: selection.sha256,
      mutationPerformed: false,
      executionAuthority: false,
      remainingExecutionRequirements: EXECUTION_REQUIREMENTS,
    }
  } catch (error) {
    if (error instanceof RecoveryInspectionError) throw error
    reject(phase)
  }
}
