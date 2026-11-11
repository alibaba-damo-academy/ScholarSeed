import { realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import {
  applyTerminalRecovery,
  pendingOrphanRecovery,
  type TerminalRestorationRuntime,
  type TerminalRestorationOptions,
} from './restoration.ts'
import { captureRecord, orphanSource, TERMINAL_RECORD_LIMITS } from './terminal.ts'
import { decodeUpdateLaunch, updateLaunchContextPath, updateStorageIdentities } from './relaunch.ts'
import { decodeSquirrelHandoff, squirrelHandoffRecordPath } from './squirrel.ts'

export const UPDATE_REPAIR_ARGUMENT = '--repair-update-target='
export const UPDATE_REPAIR_WIZARD_ARGUMENT = '--repair-update'
export const UPDATE_REPAIR_PROTOCOL = 1
export const UPDATE_REPAIR_SELECTION = {
  home: '--repair-update-home=',
  userData: '--repair-update-user-data=',
  workspace: '--repair-update-workspace=',
} as const
const HELPER_SUFFIX = '.ShipIt'
const PREPARATION_DIRECTORY = 'CandidatePreparation'
const CLEANUP_DIRECTORY = 'DeferredCleanup'
const NATIVE_STATE = 'ShipItState.plist'
const MAC_EXECUTABLE_DIRECTORY = ['Contents', 'MacOS']
const INFO_PLIST = ['Contents', 'Info.plist']
const EXECUTABLE_TIMEOUT_MS = 10_000
const EXECUTABLE_OUTPUT_BYTES = 4096
const run = promisify(execFile)

export function updateRepairTarget(
  argv: readonly string[],
  platform: NodeJS.Platform,
  packaged: boolean
): string | null {
  const values = argv.filter((value) => value.startsWith(UPDATE_REPAIR_ARGUMENT))
  if (!values.length) {
    if (
      argv.some((value) =>
        Object.values(UPDATE_REPAIR_SELECTION).some((prefix) => value.startsWith(prefix))
      )
    )
      throw new Error('ERR_UPDATE_REPAIR_ARGUMENT')
    return null
  }
  if (platform !== 'darwin' || !packaged || values.length !== 1)
    throw new Error('ERR_UPDATE_REPAIR_ARGUMENT')
  const target = values[0].slice(UPDATE_REPAIR_ARGUMENT.length)
  if (
    !target ||
    !target.startsWith('/') ||
    target.includes('\0') ||
    realpathSync.native(target) !== target
  )
    throw new Error('ERR_UPDATE_REPAIR_ARGUMENT')
  return target
}
export function updateRepairSelection(argv: readonly string[]) {
  const selected: Partial<Record<keyof typeof UPDATE_REPAIR_SELECTION, string>> = {}
  for (const [key, prefix] of Object.entries(UPDATE_REPAIR_SELECTION)) {
    const values = argv.filter((value) => value.startsWith(prefix))
    if (!values.length) continue
    if (values.length !== 1) throw new Error('ERR_UPDATE_REPAIR_ARGUMENT')
    const path = values[0].slice(prefix.length)
    if (!path.startsWith('/') || path.includes('\0') || realpathSync.native(path) !== path)
      throw new Error('ERR_UPDATE_REPAIR_ARGUMENT')
    selected[key as keyof typeof UPDATE_REPAIR_SELECTION] = path
  }
  if (!Object.keys(selected).length) return undefined
  if (!selected.home || !selected.userData || !selected.workspace)
    throw new Error('ERR_UPDATE_REPAIR_SELECTION_REQUIRED')
  return { home: selected.home, userData: selected.userData, workspace: selected.workspace }
}

export interface UpdateRepairScope {
  application: string
  repairApplication: string
  coordinator: string
  applicationSupport: string
  cache: string
  bundleId: string
  expectedTeam: string
  selection?: TerminalRestorationOptions['selection']
}

export function repairNativePaths(scope: UpdateRepairScope) {
  const owner = `${scope.bundleId}${HELPER_SUFFIX}`
  return {
    nativeState: join(scope.cache, owner, NATIVE_STATE),
    preparation: join(scope.applicationSupport, owner, PREPARATION_DIRECTORY),
    cleanup: join(scope.applicationSupport, owner, CLEANUP_DIRECTORY),
  }
}

export async function verifyRepairApplication(
  application: string,
  bundle: string,
  team: string,
  runtime: TerminalRestorationRuntime
) {
  await runtime.verifyApplication(application, bundle, team)
  const product = JSON.parse(
    captureRecord(
      join(application, 'Contents', 'Resources', 'product.json'),
      TERMINAL_RECORD_LIMITS.product,
      [0, runtime.uid]
    ).bytes.toString('utf8')
  )
  if (
    product.update_repair_protocol !== UPDATE_REPAIR_PROTOCOL ||
    product.bundle_id !== bundle ||
    product.expected_team_id !== team ||
    product.release_lane !== 'distribution'
  )
    throw new Error('ERR_UPDATE_REPAIR_CAPABILITY')
}

export async function planInstalledUpdate(
  scope: UpdateRepairScope,
  runtime: TerminalRestorationRuntime
) {
  const nativePaths = repairNativePaths(scope)
  const selection = scope.selection
  if (!selection) throw new Error('ERR_UPDATE_REPAIR_SELECTION_REQUIRED')
  const pending = pendingOrphanRecovery(
    {
      application: scope.application,
      coordinator: scope.coordinator,
      expectedTeam: scope.expectedTeam,
      toolDirectory: scope.repairApplication,
      selection,
    },
    runtime.uid
  )
  if (pending) {
    if (
      Object.entries(nativePaths).some(
        ([key, value]) => pending[key as keyof typeof nativePaths] !== value
      )
    )
      throw new Error('ERR_UPDATE_REPAIR_SCOPE')
    await runtime.verifyApplication(scope.application, scope.bundleId, scope.expectedTeam)
    return
  }
  const handoff = decodeSquirrelHandoff(
    captureRecord(squirrelHandoffRecordPath(selection.home), TERMINAL_RECORD_LIMITS.handoff, [
      runtime.uid,
    ]).bytes
  )
  if (!handoff.binding || !['requested', 'failed'].includes(handoff.state))
    throw new Error('ERR_UPDATE_REPAIR_STATE')
  const options = { ...nativePaths, application: scope.application }
  const source = orphanSource(options, undefined, runtime.uid)
  await runtime.verifyApplication(scope.application, scope.bundleId, scope.expectedTeam)
  await runtime.verifyApplication(source, scope.bundleId, scope.expectedTeam)
  const tools = runtime.load(scope.repairApplication)
  const holder = tools.open(
    JSON.stringify({
      schema: 1,
      mode: 'orphan-plan',
      cleanup: nativePaths.cleanup,
      preparation: nativePaths.preparation,
      state: nativePaths.nativeState,
      source,
      target: scope.application,
      binding: handoff.binding,
      selection: {
        schema: 2,
        paths: [selection.home, selection.userData, selection.workspace],
        identities: updateStorageIdentities(tools.native, [
          selection.home,
          selection.userData,
          selection.workspace,
        ]),
      },
    })
  )
  try {
    const result = JSON.parse(holder.observe())
    if (
      result.proof?.kind !== 'orphan-preparation-plan' ||
      result.proof.binding?.requestId !== handoff.binding.requestId
    )
      throw new Error('ERR_UPDATE_REPAIR_STATE')
  } finally {
    holder.close()
  }
}

export async function repairInstalledUpdate(
  scope: UpdateRepairScope,
  runtime: TerminalRestorationRuntime
) {
  if (runtime.platform !== 'darwin' || scope.application === scope.repairApplication)
    throw new Error('ERR_UPDATE_REPAIR_SCOPE')
  try {
    for (const path of [
      scope.application,
      scope.repairApplication,
      scope.coordinator,
      scope.applicationSupport,
      scope.cache,
    ])
      if (realpathSync.native(path) !== path) throw new Error('ERR_UPDATE_REPAIR_SCOPE')
  } catch (error) {
    throw new Error('ERR_UPDATE_REPAIR_SCOPE', { cause: error })
  }
  await runtime.verifyApplication(scope.repairApplication, scope.bundleId, scope.expectedTeam)
  const common = {
    application: scope.application,
    coordinator: scope.coordinator,
    expectedTeam: scope.expectedTeam,
    toolDirectory: scope.repairApplication,
  }
  let nativePaths: ReturnType<typeof repairNativePaths>
  try {
    nativePaths = repairNativePaths(scope)
  } catch (error) {
    throw new Error('ERR_UPDATE_REPAIR_STATE', { cause: error })
  }
  let options: TerminalRestorationOptions | null = pendingOrphanRecovery(
    { ...common, selection: scope.selection },
    runtime.uid
  )
  if (
    options &&
    Object.entries(nativePaths).some(
      ([key, value]) => options![key as keyof typeof nativePaths] !== value
    )
  )
    throw new Error('ERR_UPDATE_REPAIR_SCOPE')
  if (!options) {
    let context: ReturnType<typeof decodeUpdateLaunch> | null = null
    try {
      context = decodeUpdateLaunch(
        captureRecord(
          updateLaunchContextPath(scope.coordinator, scope.application),
          TERMINAL_RECORD_LIMITS.context,
          [runtime.uid]
        ).bytes
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('ERR_UPDATE_REPAIR_STATE', { cause: error })
    }
    if (
      context &&
      (context.bundleId !== scope.bundleId ||
        context.uid !== runtime.uid ||
        context.application !== scope.application)
    )
      throw new Error('ERR_UPDATE_REPAIR_SCOPE')
    if (!context && !scope.selection) throw new Error('ERR_UPDATE_REPAIR_SELECTION_REQUIRED')
    const handoffPath = squirrelHandoffRecordPath(context?.home ?? scope.selection!.home)
    let handoff: ReturnType<typeof decodeSquirrelHandoff>
    try {
      handoff = decodeSquirrelHandoff(
        captureRecord(handoffPath, TERMINAL_RECORD_LIMITS.handoff, [runtime.uid]).bytes
      )
    } catch (error) {
      throw new Error('ERR_UPDATE_REPAIR_STATE', { cause: error })
    }
    if (!handoff.binding || !['requested', 'failed'].includes(handoff.state))
      throw new Error('ERR_UPDATE_REPAIR_STATE')
    options = {
      ...common,
      ...nativePaths,
      handoff: handoffPath,
      requestId: handoff.binding.requestId,
      recovery: 'orphan',
      ...(scope.selection ? { selection: scope.selection } : {}),
    }
  }
  const result = await applyTerminalRecovery(options, runtime)
  await runtime.verifyApplication(scope.application, scope.bundleId, scope.expectedTeam)
  return {
    ...result,
    executable: await repairExecutable(result.startup.application),
    arguments: [`--user-data-dir=${result.startup.userData}`],
  }
}

export async function repairExecutable(application: string) {
  const executable = await run(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(application, ...INFO_PLIST)],
    { timeout: EXECUTABLE_TIMEOUT_MS, maxBuffer: EXECUTABLE_OUTPUT_BYTES }
  )
  const name = executable.stdout.trim()
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name))
    throw new Error('ERR_UPDATE_REPAIR_EXECUTABLE')
  return join(application, ...MAC_EXECUTABLE_DIRECTORY, name)
}
