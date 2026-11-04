import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { beginDomains, type DomainNative, type Domains } from '../../native/domains.cjs'
import recoveryBuild from '../../scripts/cd/recovery.cjs'
import type { QualifiedRecordConsumer } from './journal.ts'
import {
  acquireUpdateLaunchRecordLock,
  consumeUpdateLaunchContext,
  decodeUpdateLaunch,
  updateLaunchContextPath,
  type UpdateLaunchContext,
} from './relaunch.ts'
import {
  consumeSquirrelHandoff,
  decodeSquirrelHandoff,
  squirrelHandoffRecordPath,
  type SquirrelHandoff,
} from './squirrel.ts'
import {
  captureRecord,
  inspectTerminalRecovery,
  sameRecord,
  TERMINAL_RECORD_LIMITS,
  verifyApplication,
  type CapturedRecord,
  type RecordSnapshot,
  type TerminalRecoveryOptions,
} from './terminal.ts'

const SCHEMA = 1
const KIND = 'mac-terminal-recovery'
const DIRECTORY = 'terminal-recovery'
const INTENT_BYTES = 128 * 1024
const MARKER_BYTES = 4096
const REQUEST_ID = /^[a-f0-9]{64}$/
const TEAM_ID = /^[A-Z0-9]{10}$/
const retained: unknown[] = []
const require = createRequire(import.meta.url)

interface RecoveryNative extends DomainNative {
  consumeAt(pin: unknown, name: string, bytes: Buffer, device: string, inode: string): void
}

interface Qualification {
  observe(): string
  close(): void
}

interface MaintenanceTools {
  native: RecoveryNative
  open(configuration: string): Qualification
}

export interface TerminalRestorationRuntime {
  platform: NodeJS.Platform
  uid: number
  load(directory: string): MaintenanceTools
  begin(native: DomainNative, coordinator: string, roots: string[]): Domains
  verifyApplication(application: string, bundle: string, team: string): Promise<void>
}

export interface TerminalRestorationOptions extends TerminalRecoveryOptions {
  requestId: string
}

type RestorationCode =
  | 'unsupported_platform'
  | 'invalid_scope'
  | 'invalid_intent'
  | 'qualification_refused'
  | 'evidence_changed'
  | 'recovery_incomplete'
  | 'release_uncertain'

export class TerminalRestorationError extends Error {
  constructor(
    readonly code: RestorationCode,
    readonly mutationPerformed = false,
    readonly committed = false,
    readonly nativeCode?: string,
    readonly systemCode?: number
  ) {
    super(code)
    this.name = 'TerminalRestorationError'
  }
}

interface SavedRecord {
  bytes: string
  snapshot: RecordSnapshot
}

interface Intent {
  schema: number
  kind: string
  requestId: string
  options: Omit<TerminalRestorationOptions, 'toolDirectory'>
  context: SavedRecord
  handoff: SavedRecord
  product: SavedRecord
  proof: unknown
}

const dependencies: TerminalRestorationRuntime = {
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  load(directory) {
    const files = recoveryBuild.resolveRecoveryMaintenance(directory)
    const native = require(files.lease) as RecoveryNative
    const terminal = require(files.terminal) as { open(configuration: string): Qualification }
    if (typeof native.consumeAt !== 'function' || typeof terminal.open !== 'function')
      throw new Error('Missing maintenance capability')
    return { native, open: terminal.open }
  },
  begin: (native, coordinator, roots) => beginDomains(native, coordinator, roots, true),
  verifyApplication,
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TerminalRestorationError('invalid_intent')
  return serialized
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function saved(record: CapturedRecord): SavedRecord {
  return { bytes: record.bytes.toString('base64'), snapshot: record.snapshot }
}

function restored(record: SavedRecord, maximum: number, owners: readonly number[]): CapturedRecord {
  if (!record || typeof record.bytes !== 'string' || !record.snapshot)
    throw new TerminalRestorationError('invalid_intent')
  const bytes = Buffer.from(record.bytes, 'base64')
  if (
    !bytes.length ||
    bytes.length > maximum ||
    bytes.toString('base64') !== record.bytes ||
    digest(bytes) !== record.snapshot.sha256 ||
    record.snapshot.size !== bytes.length ||
    !owners.includes(record.snapshot.uid) ||
    typeof record.snapshot.device !== 'string' ||
    typeof record.snapshot.inode !== 'string' ||
    !/^\d+$/.test(record.snapshot.device) ||
    !/^\d+$/.test(record.snapshot.inode) ||
    typeof record.snapshot.modified !== 'string' ||
    typeof record.snapshot.changed !== 'string' ||
    !/^\d+$/.test(record.snapshot.modified) ||
    !/^\d+$/.test(record.snapshot.changed) ||
    !Number.isSafeInteger(record.snapshot.mode) ||
    Boolean(record.snapshot.mode & 0o022)
  )
    throw new TerminalRestorationError('invalid_intent')
  return { bytes, snapshot: record.snapshot }
}

function optionsWithoutTool(
  options: TerminalRestorationOptions
): Omit<TerminalRestorationOptions, 'toolDirectory'> {
  const { toolDirectory: _toolDirectory, ...scope } = options
  return scope
}

function proof(qualification: Qualification): unknown {
  const output = JSON.parse(qualification.observe())
  if (!output || output.schema !== SCHEMA || output.mode !== 'inspect' || !output.proof)
    throw new TerminalRestorationError('qualification_refused')
  return output.proof
}

function uncertain(error: unknown): boolean {
  return [
    'ERR_LEASE_RELEASE',
    'ERR_LEASE_SYNC',
    'ERR_DOMAIN_RELEASE',
    'ERR_TERMINAL_RELEASE',
  ].includes(String((error as { code?: unknown })?.code))
}

function optionalRecord(
  filename: string,
  maximum: number,
  owners: readonly number[]
): CapturedRecord | null {
  try {
    return captureRecord(filename, maximum, owners)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function decodeIntent(
  record: CapturedRecord,
  options: TerminalRestorationOptions,
  uid: number
): Intent {
  const intent = JSON.parse(record.bytes.toString('utf8')) as Intent
  if (
    !intent ||
    Object.keys(intent).sort().join(',') !==
      'context,handoff,kind,options,product,proof,requestId,schema' ||
    intent.schema !== SCHEMA ||
    intent.kind !== KIND ||
    intent.requestId !== options.requestId ||
    canonical(intent.options) !== canonical(optionsWithoutTool(options))
  )
    throw new TerminalRestorationError('invalid_intent')
  restored(intent.context, TERMINAL_RECORD_LIMITS.context, [uid])
  restored(intent.handoff, TERMINAL_RECORD_LIMITS.handoff, [uid])
  restored(intent.product, TERMINAL_RECORD_LIMITS.product, [0, uid])
  return intent
}

function validateSelection(
  context: UpdateLaunchContext,
  handoff: SquirrelHandoff,
  options: TerminalRestorationOptions,
  uid: number
): void {
  if (
    context.uid !== uid ||
    context.application !== options.application ||
    context.candidate !== handoff.candidate ||
    context.targetBuild !== handoff.buildNumber ||
    handoff.binding?.requestId !== options.requestId ||
    handoff.nativeRequest?.binding?.requestId !== options.requestId ||
    squirrelHandoffRecordPath(context.home) !== options.handoff
  )
    throw new TerminalRestorationError('invalid_scope')
}

export async function applyTerminalRecovery(
  options: TerminalRestorationOptions,
  runtime: TerminalRestorationRuntime = dependencies
) {
  if (runtime.platform !== 'darwin' || !Number.isSafeInteger(runtime.uid) || runtime.uid < 0)
    throw new TerminalRestorationError('unsupported_platform')
  for (const field of [
    'application',
    'coordinator',
    'handoff',
    'nativeState',
    'preparation',
    'cleanup',
    'toolDirectory',
  ] as const) {
    const value = options[field]
    if (
      typeof value !== 'string' ||
      !isAbsolute(value) ||
      normalize(value) !== value ||
      value.includes('\0')
    )
      throw new TerminalRestorationError('invalid_scope')
  }
  if (!REQUEST_ID.test(options.requestId) || !TEAM_ID.test(options.expectedTeam))
    throw new TerminalRestorationError('invalid_scope')
  const contextPath = updateLaunchContextPath(options.coordinator, options.application)
  const recoveryDirectory = join(dirname(contextPath), DIRECTORY)
  const intentPath = join(recoveryDirectory, `${options.requestId}.intent`)
  const originalIntent = optionalRecord(intentPath, INTENT_BYTES, [runtime.uid])
  let intent = originalIntent ? decodeIntent(originalIntent, options, runtime.uid) : undefined
  const contextRecord = intent
    ? restored(intent.context, TERMINAL_RECORD_LIMITS.context, [runtime.uid])
    : captureRecord(contextPath, TERMINAL_RECORD_LIMITS.context, [runtime.uid])
  const handoffRecord = intent
    ? restored(intent.handoff, TERMINAL_RECORD_LIMITS.handoff, [runtime.uid])
    : captureRecord(options.handoff, TERMINAL_RECORD_LIMITS.handoff, [runtime.uid])
  const context = decodeUpdateLaunch(contextRecord.bytes)
  const handoff = decodeSquirrelHandoff(handoffRecord.bytes)
  validateSelection(context, handoff, options, runtime.uid)
  const productPath = join(options.application, 'Contents', 'Resources', 'product.json')
  const productRecord = intent
    ? restored(intent.product, TERMINAL_RECORD_LIMITS.product, [0, runtime.uid])
    : captureRecord(productPath, TERMINAL_RECORD_LIMITS.product, [0, runtime.uid])
  const tools = runtime.load(options.toolDirectory)
  let qualification: Qualification | undefined
  let domains: Domains | undefined
  const pins: unknown[] = []
  let recordLock: unknown
  let writesStarted = Boolean(originalIntent)
  let committed = false
  let failure: unknown
  let releaseUncertain = false
  let result:
    | {
        schema: number
        mode: 'apply'
        outcome: 'recovered'
        requestId: string
        sourceBuild: string
        targetBuild: string
        candidate: string
        mutationPerformed: true
        installationPerformed: false
        executionAuthority: false
        startup: {
          application: string
          home: string
          userData: string
          workspace: string
          debugPort?: number
        }
        intent: string
      }
    | undefined
  try {
    qualification = tools.open(
      JSON.stringify({
        schema: SCHEMA,
        cleanup: options.cleanup,
        preparation: options.preparation,
        source: handoff.nativeRequest!.source.path,
        target: options.application,
        state: options.nativeState,
        binding: handoff.binding,
        selection: {
          schema: context.schema,
          paths: [context.home, context.userData, context.workspace],
          identities: context.identities,
        },
      })
    )
    domains = runtime.begin(tools.native, options.coordinator, [
      ...new Set([
        context.home,
        context.userData,
        context.workspace,
        dirname(contextPath),
        dirname(options.handoff),
      ]),
    ])
    domains.occupy()
    const contextPin = tools.native.pin(dirname(contextPath), false)
    pins.push(contextPin)
    const handoffPin = tools.native.pin(dirname(options.handoff), false)
    pins.push(handoffPin)
    recordLock = acquireUpdateLaunchRecordLock(tools.native, contextPin)
    let recoveryPin: unknown
    const currentProof = proof(qualification)
    if (intent && canonical(currentProof) !== canonical(intent.proof))
      throw new TerminalRestorationError('evidence_changed')
    const verifyNative = () => {
      domains!.check()
      if (canonical(proof(qualification!)) !== canonical(intent?.proof ?? currentProof))
        throw new TerminalRestorationError('evidence_changed')
      if (!sameRecord(productPath, productRecord, TERMINAL_RECORD_LIMITS.product, [0, runtime.uid]))
        throw new TerminalRestorationError('evidence_changed')
      domains!.check()
    }
    const verifySignature = async () => {
      await runtime.verifyApplication(options.application, context.bundleId, options.expectedTeam)
      verifyNative()
    }
    const byteCheck = (
      filename: string,
      expected: CapturedRecord,
      maximum: number,
      missing: boolean
    ) => {
      const current = optionalRecord(filename, maximum, [runtime.uid])
      if (!current) {
        if (missing) return
        throw new TerminalRestorationError('evidence_changed')
      }
      if (
        !current.bytes.equals(expected.bytes) ||
        canonical(current.snapshot) !== canonical(expected.snapshot)
      )
        throw new TerminalRestorationError('evidence_changed')
    }
    if (!intent) {
      domains.checkWritable()
      byteCheck(contextPath, contextRecord, TERMINAL_RECORD_LIMITS.context, false)
      byteCheck(options.handoff, handoffRecord, TERMINAL_RECORD_LIMITS.handoff, false)
      let inspectionUncertainty: unknown
      try {
        await inspectTerminalRecovery(options, {
          platform: runtime.platform,
          uid: runtime.uid,
          verifyApplication: runtime.verifyApplication,
          probe: async () => {
            try {
              return proof(qualification!)
            } catch (error) {
              if (uncertain(error)) inspectionUncertainty = error
              throw error
            }
          },
        })
      } catch (error) {
        throw inspectionUncertainty ?? error
      }
      verifyNative()
      intent = {
        schema: SCHEMA,
        kind: KIND,
        requestId: options.requestId,
        options: optionsWithoutTool(options),
        context: saved(contextRecord),
        handoff: saved(handoffRecord),
        product: saved(productRecord),
        proof: currentProof,
      }
    }
    await verifySignature()
    const intentBytes = originalIntent?.bytes ?? Buffer.from(canonical(intent) + '\n')
    const intentSha256 = digest(intentBytes)
    if (intentBytes.length > INTENT_BYTES) throw new TerminalRestorationError('invalid_intent')
    try {
      recoveryPin = tools.native.pin(recoveryDirectory, false)
    } catch (error) {
      if (
        String((error as { code?: string }).code) !== 'ERR_LEASE_MISSING' &&
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error
      writesStarted = true
      tools.native.createChild(contextPin, DIRECTORY)
      recoveryPin = tools.native.pin(recoveryDirectory, false)
    }
    pins.push(recoveryPin)
    const readIntent = tools.native.readAt(recoveryPin, `${options.requestId}.intent`, INTENT_BYTES)
    if (originalIntent) {
      if (
        !readIntent?.equals(intentBytes) ||
        !sameRecord(intentPath, originalIntent, INTENT_BYTES, [runtime.uid])
      )
        throw new TerminalRestorationError('invalid_intent')
    } else {
      if (readIntent !== null) throw new TerminalRestorationError('invalid_intent')
      writesStarted = true
      tools.native.createAt(recoveryPin, `${options.requestId}.intent`, intentBytes)
    }
    const marker = (stage: 'context' | 'handoff' | 'committed', create: boolean): boolean => {
      const name = `${options.requestId}.${stage}`
      const bytes = Buffer.from(
        canonical({
          schema: SCHEMA,
          kind: KIND,
          requestId: options.requestId,
          intentSha256,
          stage,
        }) + '\n'
      )
      const previous = tools.native.readAt(recoveryPin, name, MARKER_BYTES)
      if (previous !== null) {
        if (!previous.equals(bytes)) throw new TerminalRestorationError('invalid_intent')
        return true
      }
      if (create) tools.native.createAt(recoveryPin, name, bytes)
      return create
    }
    const validateRecords = () => {
      byteCheck(
        contextPath,
        contextRecord,
        TERMINAL_RECORD_LIMITS.context,
        marker('context', false)
      )
      byteCheck(
        options.handoff,
        handoffRecord,
        TERMINAL_RECORD_LIMITS.handoff,
        marker('handoff', false)
      )
    }
    const consumer: QualifiedRecordConsumer = Object.freeze({
      consume(filename: string, expected: Buffer, device: string, inode: string) {
        verifyNative()
        const selected =
          filename === contextPath
            ? contextPin
            : filename === options.handoff
              ? handoffPin
              : undefined
        if (selected === undefined) throw new TerminalRestorationError('invalid_scope')
        tools.native.consumeAt(selected, basename(filename), expected, device, inode)
        verifyNative()
      },
    })
    validateRecords()
    await verifySignature()
    const reservation = domains.reserveMutation(
      canonical({ schema: SCHEMA, kind: KIND, requestId: options.requestId, intentSha256 })
    )
    writesStarted = true
    verifyNative()
    marker('context', true)
    if (
      tools.native.readAt(contextPin, basename(contextPath), TERMINAL_RECORD_LIMITS.context) !==
      null
    )
      consumeUpdateLaunchContext(
        consumer,
        options.coordinator,
        options.application,
        contextRecord.bytes,
        contextRecord.snapshot.device,
        contextRecord.snapshot.inode
      )
    validateRecords()
    await verifySignature()
    marker('handoff', true)
    if (
      tools.native.readAt(handoffPin, basename(options.handoff), TERMINAL_RECORD_LIMITS.handoff) !==
      null
    )
      consumeSquirrelHandoff(
        consumer,
        context.home,
        handoffRecord.bytes,
        handoffRecord.snapshot.device,
        handoffRecord.snapshot.inode
      )
    validateRecords()
    if (
      tools.native.readAt(contextPin, basename(contextPath), TERMINAL_RECORD_LIMITS.context) !==
        null ||
      tools.native.readAt(handoffPin, basename(options.handoff), TERMINAL_RECORD_LIMITS.handoff) !==
        null
    )
      throw new TerminalRestorationError('evidence_changed')
    await verifySignature()
    marker('committed', true)
    committed = true
    reservation.finish()
    result = {
      schema: SCHEMA,
      mode: 'apply',
      outcome: 'recovered',
      requestId: options.requestId,
      sourceBuild: context.sourceBuild,
      targetBuild: context.targetBuild,
      candidate: context.candidate,
      mutationPerformed: true,
      installationPerformed: false,
      executionAuthority: false,
      startup: {
        application: context.application,
        home: context.home,
        userData: context.userData,
        workspace: context.workspace,
        ...(context.debugPort === undefined ? {} : { debugPort: context.debugPort }),
      },
      intent: intentPath,
    }
  } catch (error) {
    failure = error
    releaseUncertain = uncertain(error)
  }
  if (!releaseUncertain) {
    try {
      if (recordLock !== undefined) tools.native.release(recordLock)
      while (pins.length) tools.native.release(pins.pop())
      domains?.close()
      qualification?.close()
    } catch (error) {
      failure = error
      releaseUncertain = true
    }
  }
  if (releaseUncertain) {
    retained.push({ tools, qualification, domains, pins, recordLock })
    throw new TerminalRestorationError('release_uncertain', writesStarted, committed)
  }
  if (failure)
    throw new TerminalRestorationError(
      failure instanceof TerminalRestorationError
        ? failure.code
        : writesStarted
          ? 'recovery_incomplete'
          : 'qualification_refused',
      writesStarted,
      committed,
      /^ERR_(?:TERMINAL|LEASE|DOMAIN)_[A-Z_]+$/.test(String((failure as { code?: unknown }).code))
        ? String((failure as { code?: unknown }).code)
        : undefined,
      Number.isSafeInteger((failure as { systemCode?: unknown }).systemCode)
        ? Number((failure as { systemCode?: unknown }).systemCode)
        : undefined
    )
  return result!
}
