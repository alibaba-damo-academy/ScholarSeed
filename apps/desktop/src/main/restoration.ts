import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { readdirSync } from 'node:fs'
import { constants } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { DomainNative, Domains } from '../../native/domains.cjs'
import type { QualifiedRecordConsumer } from './journal.ts'
import {
  acquireUpdateLaunchRecordLock,
  consumeUpdateLaunchContext,
  decodeUpdateLaunch,
  updateLaunchContextPath,
  updateStorageIdentities,
  UPDATE_STORAGE_IDENTITY_SCHEMA,
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
  inspectOrphanRecovery,
  orphanSource,
  sameRecord,
  TERMINAL_RECORD_LIMITS,
  DISTRIBUTION_LANE,
  sameRepairSelection,
  type CapturedRecord,
  type RecordSnapshot,
  type TerminalRecoveryOptions,
  type RepairSelection,
} from './terminal.ts'
import { BUILD_NUMBER_PATTERN } from './version.ts'

const SCHEMA = 1
const KIND = 'mac-terminal-recovery'
const SELECTED_SCHEMA = 2
const SELECTED_KIND = 'mac-orphan-selection-recovery'
const DIRECTORY = 'terminal-recovery'
const INTENT_BYTES = 128 * 1024
const MARKER_BYTES = 4096
const REQUEST_ID = /^[a-f0-9]{64}$/
const PENDING_LIMIT = 128
const TEAM_ID = /^[A-Z0-9]{10}$/
const QUALIFICATION_ATTEMPTS = 3
const QUALIFICATION_RETRY_MS = 100
const retained: unknown[] = []

export interface RecoveryNative extends DomainNative {
  consumeAt(pin: unknown, name: string, bytes: Buffer, device: string, inode: string): void
}

export interface Qualification {
  observe(): string
  close(): void
  repair?(): void
}

export interface MaintenanceTools {
  native: RecoveryNative
  open(configuration: string): Qualification
}

async function qualify(tools: MaintenanceTools, configuration: string, orphan: boolean) {
  for (let attempt = 1; ; attempt++) {
    try {
      return tools.open(configuration)
    } catch (error) {
      const native = error as { code?: string; systemCode?: number }
      const busy =
        native.code === 'ERR_TERMINAL_OPEN' && native.systemCode === constants.errno.EWOULDBLOCK
      const parking =
        native.code === 'ERR_TERMINAL_PARK' &&
        [constants.errno.EBUSY, constants.errno.ESTALE].includes(native.systemCode ?? -1)
      if (!orphan || attempt >= QUALIFICATION_ATTEMPTS || (!busy && !parking)) throw error
      await delay(QUALIFICATION_RETRY_MS)
    }
  }
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
  recovery?: 'orphan'
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
  context: SavedRecord | null
  selection?: RepairSelection
  handoff: SavedRecord
  product: SavedRecord
  proof: unknown
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

function decodeProductPolicy(record: CapturedRecord): Record<string, unknown> {
  try {
    const policy: unknown = JSON.parse(record.bytes.toString('utf8'))
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
      throw new TerminalRestorationError('invalid_scope')
    return policy as Record<string, unknown>
  } catch (error) {
    if (error instanceof TerminalRestorationError) throw error
    throw new TerminalRestorationError('invalid_scope')
  }
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
  if (!intent || typeof intent !== 'object' || Array.isArray(intent))
    throw new TerminalRestorationError('invalid_intent')
  let validShape: boolean
  if (intent.context === null) {
    validShape =
      Object.keys(intent).sort().join(',') ===
        'context,handoff,kind,options,product,proof,requestId,schema,selection' &&
      intent.schema === SELECTED_SCHEMA &&
      intent.kind === SELECTED_KIND &&
      Boolean(options.selection) &&
      options.recovery === 'orphan' &&
      Boolean(intent.selection)
  } else {
    validShape =
      Object.keys(intent).sort().join(',') ===
        'context,handoff,kind,options,product,proof,requestId,schema' &&
      intent.schema === SCHEMA &&
      intent.kind === KIND
  }
  if (
    !validShape ||
    intent.requestId !== options.requestId ||
    canonical(intent.options) !== canonical(optionsWithoutTool(options))
  )
    throw new TerminalRestorationError('invalid_intent')
  if (intent.context) restored(intent.context, TERMINAL_RECORD_LIMITS.context, [uid])
  restored(intent.handoff, TERMINAL_RECORD_LIMITS.handoff, [uid])
  restored(intent.product, TERMINAL_RECORD_LIMITS.product, [0, uid])
  return intent
}

export function pendingOrphanRecovery(
  scope: {
    application: string
    coordinator: string
    expectedTeam: string
    toolDirectory: string
    selection?: TerminalRecoveryOptions['selection']
  },
  uid: number
): TerminalRestorationOptions | null {
  const directory = join(
    dirname(updateLaunchContextPath(scope.coordinator, scope.application)),
    DIRECTORY
  )
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (names.length > PENDING_LIMIT) throw new TerminalRestorationError('invalid_intent')
  const pending: TerminalRestorationOptions[] = []
  for (const name of names.filter((name) => name.endsWith('.intent'))) {
    const requestId = name.slice(0, -'.intent'.length)
    if (!REQUEST_ID.test(requestId)) throw new TerminalRestorationError('invalid_intent')
    const record = captureRecord(join(directory, name), INTENT_BYTES, [uid])
    const raw = JSON.parse(record.bytes.toString('utf8')) as Intent
    const options = { ...raw.options, toolDirectory: scope.toolDirectory }
    if (
      options.application !== scope.application ||
      options.coordinator !== scope.coordinator ||
      options.expectedTeam !== scope.expectedTeam ||
      options.requestId !== requestId ||
      options.recovery !== 'orphan'
    )
      continue
    decodeIntent(record, options, uid)
    const committed = optionalRecord(join(directory, `${requestId}.committed`), MARKER_BYTES, [uid])
    if (committed) {
      const expected = Buffer.from(
        canonical({
          schema: raw.schema,
          kind: raw.kind,
          requestId,
          intentSha256: digest(record.bytes),
          stage: 'committed',
        }) + '\n'
      )
      if (!committed.bytes.equals(expected)) throw new TerminalRestorationError('invalid_intent')
      if (
        [
          [
            updateLaunchContextPath(scope.coordinator, scope.application),
            TERMINAL_RECORD_LIMITS.context,
          ],
          [options.handoff, TERMINAL_RECORD_LIMITS.handoff],
          [options.nativeState, TERMINAL_RECORD_LIMITS.product],
        ].every(([filename, maximum]) => !optionalRecord(String(filename), Number(maximum), [uid]))
      )
        pending.push(options)
    } else pending.push(options)
  }
  if (pending.length > 1) throw new TerminalRestorationError('invalid_intent')
  const options = pending[0]
  if (!options) return null
  if (scope.selection) {
    const intent = decodeIntent(
      captureRecord(join(directory, `${options.requestId}.intent`), INTENT_BYTES, [uid]),
      options,
      uid
    )
    const selected = intent.context
      ? decodeUpdateLaunch(restored(intent.context, TERMINAL_RECORD_LIMITS.context, [uid]).bytes)
      : intent.selection!
    if (!sameRepairSelection(scope.selection, selected))
      throw new TerminalRestorationError('invalid_scope')
  }
  return options
}

function validateSelection(
  context: RepairSelection,
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
    (options.recovery !== 'orphan' &&
      handoff.nativeRequest?.binding?.requestId !== options.requestId) ||
    squirrelHandoffRecordPath(context.home) !== options.handoff
  )
    throw new TerminalRestorationError('invalid_scope')
}

export async function applyTerminalRecovery(
  options: TerminalRestorationOptions,
  runtime: TerminalRestorationRuntime
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
  if (options.recovery !== undefined && options.recovery !== 'orphan')
    throw new TerminalRestorationError('invalid_scope')
  if (
    options.selection &&
    (options.recovery !== 'orphan' ||
      Object.keys(options.selection).sort().join(',') !== 'home,userData,workspace')
  )
    throw new TerminalRestorationError('invalid_scope')
  const contextPath = updateLaunchContextPath(options.coordinator, options.application)
  const recoveryDirectory = join(dirname(contextPath), DIRECTORY)
  const intentPath = join(recoveryDirectory, `${options.requestId}.intent`)
  const originalIntent = optionalRecord(intentPath, INTENT_BYTES, [runtime.uid])
  let intent = originalIntent ? decodeIntent(originalIntent, options, runtime.uid) : undefined
  let contextRecord: CapturedRecord | null
  if (intent) {
    contextRecord = intent.context
      ? restored(intent.context, TERMINAL_RECORD_LIMITS.context, [runtime.uid])
      : null
  } else if (options.selection && options.recovery === 'orphan') {
    contextRecord = optionalRecord(contextPath, TERMINAL_RECORD_LIMITS.context, [runtime.uid])
  } else {
    contextRecord = captureRecord(contextPath, TERMINAL_RECORD_LIMITS.context, [runtime.uid])
  }
  const handoffRecord = intent
    ? restored(intent.handoff, TERMINAL_RECORD_LIMITS.handoff, [runtime.uid])
    : captureRecord(options.handoff, TERMINAL_RECORD_LIMITS.handoff, [runtime.uid])
  const handoff = decodeSquirrelHandoff(handoffRecord.bytes)
  const productPath = join(options.application, 'Contents', 'Resources', 'product.json')
  const productRecord = intent
    ? restored(intent.product, TERMINAL_RECORD_LIMITS.product, [0, runtime.uid])
    : captureRecord(productPath, TERMINAL_RECORD_LIMITS.product, [0, runtime.uid])
  const policy = decodeProductPolicy(productRecord)
  const tools = runtime.load(options.toolDirectory)
  let context: RepairSelection
  if (contextRecord) {
    context = decodeUpdateLaunch(contextRecord.bytes)
    if (options.selection && !sameRepairSelection(options.selection, context))
      throw new TerminalRestorationError('invalid_scope')
  } else if (intent?.selection) {
    context = intent.selection
  } else {
    if (!options.selection || options.recovery !== 'orphan')
      throw new TerminalRestorationError('invalid_scope')
    for (const root of Object.values(options.selection))
      if (
        typeof root !== 'string' ||
        !isAbsolute(root) ||
        normalize(root) !== root ||
        root.includes('\0')
      )
        throw new TerminalRestorationError('invalid_scope')
    if (
      typeof policy.bundle_id !== 'string' ||
      typeof policy.build_number !== 'string' ||
      !BUILD_NUMBER_PATTERN.test(policy.build_number) ||
      !BUILD_NUMBER_PATTERN.test(handoff.buildNumber) ||
      handoff.buildNumber <= policy.build_number
    )
      throw new TerminalRestorationError('invalid_scope')
    context = {
      schema: UPDATE_STORAGE_IDENTITY_SCHEMA,
      uid: runtime.uid,
      application: options.application,
      bundleId: policy.bundle_id,
      sourceBuild: policy.build_number,
      targetBuild: handoff.buildNumber,
      candidate: handoff.candidate,
      ...options.selection,
      identities: updateStorageIdentities(tools.native, [
        options.selection.home,
        options.selection.userData,
        options.selection.workspace,
      ]),
    }
  }
  validateSelection(context, handoff, options, runtime.uid)
  if (!contextRecord) {
    if (
      policy.bundle_id !== context.bundleId ||
      policy.build_number !== context.sourceBuild ||
      policy.expected_team_id !== options.expectedTeam ||
      policy.release_lane !== DISTRIBUTION_LANE
    )
      throw new TerminalRestorationError('invalid_scope')
  }
  if (options.selection && !sameRepairSelection(options.selection, context))
    throw new TerminalRestorationError('invalid_scope')
  const checkContext = () => {
    if (contextRecord) {
      if (!sameRecord(contextPath, contextRecord, TERMINAL_RECORD_LIMITS.context, [runtime.uid]))
        throw new TerminalRestorationError('evidence_changed')
    } else if (optionalRecord(contextPath, TERMINAL_RECORD_LIMITS.context, [runtime.uid]))
      throw new TerminalRestorationError('evidence_changed')
  }
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
    qualification = await qualify(
      tools,
      JSON.stringify({
        schema: SCHEMA,
        cleanup: options.cleanup,
        preparation: options.preparation,
        source:
          options.recovery === 'orphan'
            ? orphanSource(options, intent?.proof, runtime.uid)
            : handoff.nativeRequest!.source.path,
        target: options.application,
        state: options.nativeState,
        binding: handoff.binding,
        selection: {
          schema: context.schema,
          paths: [context.home, context.userData, context.workspace],
          identities: context.identities,
        },
        ...(options.recovery === 'orphan'
          ? { mode: 'orphan', park: true, ...(intent ? { expected: intent.proof } : {}) }
          : {}),
      }),
      options.recovery === 'orphan'
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
      checkContext()
      byteCheck(options.handoff, handoffRecord, TERMINAL_RECORD_LIMITS.handoff, false)
      let inspectionUncertainty: unknown
      try {
        const inspect =
          options.recovery === 'orphan' ? inspectOrphanRecovery : inspectTerminalRecovery
        await inspect(options, {
          platform: runtime.platform,
          uid: runtime.uid,
          ...(!contextRecord ? { selection: context } : {}),
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
        schema: contextRecord ? SCHEMA : SELECTED_SCHEMA,
        kind: contextRecord ? KIND : SELECTED_KIND,
        requestId: options.requestId,
        options: optionsWithoutTool(options),
        context: contextRecord ? saved(contextRecord) : null,
        ...(!contextRecord ? { selection: context } : {}),
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
          schema: intent!.schema,
          kind: intent!.kind,
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
      if (contextRecord)
        byteCheck(
          contextPath,
          contextRecord,
          TERMINAL_RECORD_LIMITS.context,
          marker('context', false)
        )
      else checkContext()
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
      canonical({
        schema: intent.schema,
        kind: intent.kind,
        requestId: options.requestId,
        intentSha256,
      })
    )
    writesStarted = true
    verifyNative()
    marker('context', true)
    if (
      contextRecord &&
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
    if (options.recovery === 'orphan') {
      if (typeof qualification.repair !== 'function')
        throw new TerminalRestorationError('qualification_refused')
      qualification.repair()
      verifyNative()
    }
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
