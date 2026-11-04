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
import recoveryBuild from '../../scripts/cd/recovery.cjs'
import { classifyMacosTrust, parseCodesignIdentity } from './codesign.ts'
import { decodeUpdateLaunch, updateLaunchContextPath } from './relaunch.ts'
import {
  decodeSquirrelHandoff,
  sameSquirrelBinding,
  type SquirrelNativeCapture,
} from './squirrel.ts'

const INSPECTION_SCHEMA = 1
const CONTEXT_BYTES = 16 * 1024
const HANDOFF_BYTES = 4096
const PRODUCT_BYTES = 64 * 1024
export const TERMINAL_RECORD_LIMITS = Object.freeze({
  context: CONTEXT_BYTES,
  handoff: HANDOFF_BYTES,
  product: PRODUCT_BYTES,
})
const OUTPUT_BYTES = 64 * 1024
const PROCESS_TIMEOUT_MS = 30_000
const UNSAFE_WRITE_MODE = 0o022
const HASH_PATTERN = /^[a-f0-9]{64}$/
const TEAM_PATTERN = /^[A-Z0-9]{10}$/
const PRODUCT_FILE = ['Contents', 'Resources', 'product.json']
const DISTRIBUTION_LANE = 'distribution'
const NATIVE_OBSERVATION_KIND = 'terminal-failure-observation'
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
}

export interface TerminalRecoveryDependencies {
  platform: NodeJS.Platform
  uid: number
  verifyApplication(application: string, bundle: string, team: string): Promise<void>
  probe(options: TerminalRecoveryOptions, request: Record<string, unknown>): Promise<unknown>
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

async function probe(
  options: TerminalRecoveryOptions,
  request: Record<string, unknown>
): Promise<unknown> {
  const { executable } = recoveryBuild.resolveRecoveryProbe(options.toolDirectory)
  const { stdout } = await run(
    executable,
    [
      '--cleanup',
      options.cleanup,
      '--preparation',
      options.preparation,
      '--source',
      String(request.source),
      '--target',
      options.application,
      '--state',
      options.nativeState,
      '--binding',
      JSON.stringify(request.binding),
      '--selection',
      JSON.stringify(request.selection),
    ],
    { timeout: PROCESS_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES }
  )
  const response = object(JSON.parse(stdout), 'native_evidence_differs')
  if (response.schema !== INSPECTION_SCHEMA || response.mode !== 'inspect')
    reject('native_evidence_differs')
  return response.proof
}

const dependencies: TerminalRecoveryDependencies = {
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  verifyApplication,
  probe,
}

export async function inspectTerminalRecovery(
  options: TerminalRecoveryOptions,
  runtime: TerminalRecoveryDependencies = dependencies
) {
  if (runtime.platform !== 'darwin' || !Number.isSafeInteger(runtime.uid) || runtime.uid < 0)
    reject('unsupported_platform')
  let phase: InspectionErrorCode = 'invalid_scope'
  try {
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
    const contextPath = updateLaunchContextPath(options.coordinator, options.application)
    phase = 'unsafe_record'
    const contextRecord = captureRecord(contextPath, CONTEXT_BYTES, [runtime.uid])
    const handoffRecord = captureRecord(options.handoff, HANDOFF_BYTES, [runtime.uid])
    const productPath = join(options.application, ...PRODUCT_FILE)
    const productRecord = captureRecord(productPath, PRODUCT_BYTES, [0, runtime.uid])
    phase = 'invalid_records'
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
    if (
      policy.bundle_id !== context.bundleId ||
      policy.expected_team_id !== options.expectedTeam ||
      policy.build_number !== context.sourceBuild ||
      policy.release_lane !== DISTRIBUTION_LANE
    )
      reject('source_identity_differs')
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
    if (
      !sameRecord(contextPath, contextRecord, CONTEXT_BYTES, [runtime.uid]) ||
      !sameRecord(options.handoff, handoffRecord, HANDOFF_BYTES, [runtime.uid]) ||
      !sameRecord(productPath, productRecord, PRODUCT_BYTES, [0, runtime.uid])
    )
      reject('evidence_changed')
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
