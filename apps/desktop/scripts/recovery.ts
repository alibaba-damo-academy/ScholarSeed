import { resolve, isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { beginDomains } from '../native/domains.cjs'
import recoveryBuild from './cd/recovery.cjs'
import {
  inspectTerminalRecovery,
  RecoveryInspectionError,
  type TerminalRecoveryOptions,
  TERMINAL_PROTOCOL,
  verifyApplication,
} from '../src/main/terminal.ts'
import {
  applyTerminalRecovery,
  TerminalRestorationError,
  type TerminalRestorationOptions,
  type TerminalRestorationRuntime,
  type RecoveryNative,
  type MaintenanceTools,
} from '../src/main/restoration.ts'
import { validSquirrelBinding } from '../src/main/squirrel.ts'
import { UPDATE_STORAGE_IDENTITY_SCHEMAS } from '../src/main/relaunch.ts'

const SCHEMA = TERMINAL_PROTOCOL.schema
const INVALID_ARGUMENTS = 'invalid_arguments'
const COMMAND_FAILED = 'command_failed'
const require = createRequire(import.meta.url)
const run = promisify(execFile)
const HELP = [
  'Mac terminal recovery. Inspect is read-only: No state is consumed.',
  'node --experimental-transform-types apps/desktop/scripts/recovery.ts build --output ABSOLUTE_PRIVATE_TOOL_DIRECTORY',
  'node --experimental-transform-types apps/desktop/scripts/recovery.ts build-maintenance --output DIRECTORY --headers LOCAL_ARCHIVE --license LOCAL_LICENSE',
  'node --experimental-transform-types apps/desktop/scripts/recovery.ts inspect',
  '  --application APP --coordinator DIRECTORY --handoff FILE --native-state FILE',
  '  --preparation DIRECTORY --cleanup DIRECTORY --tool-directory DIRECTORY --expected-team TEAM',
  'apply uses the same explicit scope plus --request-id SHA256; it only consumes two proved old records under held qualifications.',
  'build compiles a local probe only; it does not download, codesign, install or inspect product state.',
  'inspect never compiles, creates locks, resumes installation or grants recovery authority.',
  'Orphan recovery and orphan intents require the signed App repair entry; this CLI does not accept orphan mode or storage selections.',
].join('\n')
const FLAGS = {
  '--application': 'application',
  '--coordinator': 'coordinator',
  '--handoff': 'handoff',
  '--native-state': 'nativeState',
  '--preparation': 'preparation',
  '--cleanup': 'cleanup',
  '--tool-directory': 'toolDirectory',
  '--expected-team': 'expectedTeam',
} as const

type Command =
  | { mode: 'help' }
  | { mode: 'build'; output: string }
  | { mode: 'build-maintenance'; output: string; inputs: { headers: string; license: string } }
  | { mode: 'inspect'; options: TerminalRecoveryOptions }
  | { mode: 'apply'; options: TerminalRestorationOptions }

export function parseRecoveryArguments(argv: readonly string[]): Command {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { mode: 'help' }
  const [command, ...arguments_] = argv
  if (
    command === 'build' &&
    arguments_.length === 2 &&
    arguments_[0] === '--output' &&
    arguments_[1]
  )
    return { mode: 'build', output: arguments_[1] }
  if (command === 'build-maintenance') {
    const flags = { '--output': 'output', '--headers': 'headers', '--license': 'license' } as const
    const values: Record<string, string> = {}
    for (let index = 0; index < arguments_.length; index += 2) {
      const key = arguments_[index],
        value = arguments_[index + 1]
      if (!Object.hasOwn(flags, key) || !value || value.startsWith('--'))
        throw new Error(INVALID_ARGUMENTS)
      const field = flags[key as keyof typeof flags]
      if (Object.hasOwn(values, field)) throw new Error(INVALID_ARGUMENTS)
      values[field] = value
    }
    if (Object.keys(values).length !== Object.keys(flags).length) throw new Error(INVALID_ARGUMENTS)
    return {
      mode: 'build-maintenance',
      output: values.output,
      inputs: { headers: values.headers, license: values.license },
    }
  }
  if (command !== 'inspect' && command !== 'apply') throw new Error(INVALID_ARGUMENTS)
  const allowed: Record<string, string> =
    command === 'apply' ? { ...FLAGS, '--request-id': 'requestId' } : FLAGS
  const options: Record<string, string> = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!Object.hasOwn(allowed, flag) || !value || value.startsWith('--'))
      throw new Error(INVALID_ARGUMENTS)
    const field = allowed[flag]
    if (Object.hasOwn(options, field)) throw new Error(INVALID_ARGUMENTS)
    options[field] = value
  }
  if (Object.keys(options).length !== Object.keys(allowed).length)
    throw new Error(INVALID_ARGUMENTS)
  return command === 'apply'
    ? { mode: 'apply', options: options as unknown as TerminalRestorationOptions }
    : { mode: 'inspect', options: options as unknown as TerminalRecoveryOptions }
}

interface CommandDependencies {
  write(value: unknown): void
  build(output: string): unknown
  buildMaintenance?(output: string, inputs: { headers: string; license: string }): unknown
  inspect(options: TerminalRecoveryOptions): Promise<unknown>
  apply?(options: TerminalRestorationOptions): Promise<unknown>
}

export function recoveryProbeArguments(
  scope: TerminalRecoveryOptions,
  request: Record<string, unknown>
): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new RecoveryInspectionError('invalid_records')
  const selection = request.selection as
    { schema?: unknown; paths?: unknown; identities?: unknown } | undefined
  const source = request.source
  if (
    typeof source !== 'string' ||
    !isAbsolute(source) ||
    normalize(source) !== source ||
    source.includes('\0') ||
    !validSquirrelBinding(request.binding) ||
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    typeof selection.schema !== 'number' ||
    !UPDATE_STORAGE_IDENTITY_SCHEMAS.includes(selection.schema) ||
    !Array.isArray(selection.paths) ||
    selection.paths.length !== 3 ||
    !selection.paths.every(
      (value) =>
        typeof value === 'string' &&
        isAbsolute(value) &&
        normalize(value) === value &&
        !value.includes('\0')
    ) ||
    !Array.isArray(selection.identities) ||
    selection.identities.length !== 3 ||
    !selection.identities.every((value) => typeof value === 'string' && value.length > 0)
  )
    throw new RecoveryInspectionError('invalid_records')
  return [
    '--cleanup',
    scope.cleanup,
    '--preparation',
    scope.preparation,
    '--source',
    source,
    '--target',
    scope.application,
    '--state',
    scope.nativeState,
    '--binding',
    JSON.stringify(request.binding),
    '--selection',
    JSON.stringify(selection),
  ]
}

const dependencies: CommandDependencies = {
  write: (value) =>
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`),
  build: recoveryBuild.buildRecoveryProbe,
  buildMaintenance: recoveryBuild.buildRecoveryMaintenance,
  inspect: (options) =>
    inspectTerminalRecovery(options, {
      platform: process.platform,
      uid: process.getuid?.() ?? -1,
      verifyApplication,
      probe: async (scope, request) => {
        const { executable } = recoveryBuild.resolveRecoveryProbe(scope.toolDirectory)
        const { stdout } = await run(executable, recoveryProbeArguments(scope, request), {
          timeout: TERMINAL_PROTOCOL.timeoutMs,
          maxBuffer: TERMINAL_PROTOCOL.outputBytes,
        })
        const response = JSON.parse(stdout)
        if (
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          response.schema !== SCHEMA ||
          response.mode !== 'inspect' ||
          !response.proof ||
          typeof response.proof !== 'object' ||
          Array.isArray(response.proof)
        )
          throw new RecoveryInspectionError('native_evidence_differs')
        return response.proof
      },
    }),
  apply: (options) => applyTerminalRecovery(options, maintenance),
}

const maintenance: TerminalRestorationRuntime = {
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  load(directory) {
    const files = recoveryBuild.resolveRecoveryMaintenance(directory)
    const native = require(files.lease) as RecoveryNative
    const terminal = require(files.terminal) as Pick<MaintenanceTools, 'open'>
    if (typeof native.consumeAt !== 'function' || typeof terminal.open !== 'function')
      throw new Error('Missing maintenance capability')
    return { native, open: terminal.open }
  },
  begin: (native, coordinator, roots) => beginDomains(native, coordinator, roots, true),
  verifyApplication,
}

export async function runRecoveryCommand(
  argv: readonly string[],
  runtime: CommandDependencies = dependencies
): Promise<number> {
  let command: Command
  try {
    command = parseRecoveryArguments(argv)
  } catch {
    runtime.write({
      schema: SCHEMA,
      mode: 'refused',
      code: INVALID_ARGUMENTS,
      mutationPerformed: false,
      executionAuthority: false,
    })
    return 1
  }
  try {
    if (command.mode === 'help') runtime.write(HELP)
    else if (command.mode === 'build' || command.mode === 'build-maintenance')
      runtime.write({
        schema: SCHEMA,
        mode: command.mode,
        tool: await (command.mode === 'build'
          ? runtime.build(command.output)
          : runtime.buildMaintenance!(command.output, command.inputs)),
        productMutationPerformed: false,
        toolArtifactsWritten: true,
        executionAuthority: false,
      })
    else if (command.mode === 'apply') runtime.write(await runtime.apply!(command.options))
    else runtime.write(await runtime.inspect(command.options))
    return 0
  } catch (error) {
    runtime.write({
      schema: SCHEMA,
      mode: command.mode,
      outcome: 'refused',
      code:
        error instanceof RecoveryInspectionError || error instanceof TerminalRestorationError
          ? error.code
          : COMMAND_FAILED,
      mutationPerformed:
        error instanceof TerminalRestorationError ? error.mutationPerformed : false,
      ...(error instanceof TerminalRestorationError ? { committed: error.committed } : {}),
      ...(error instanceof TerminalRestorationError && error.nativeCode
        ? { nativeCode: error.nativeCode, systemCode: error.systemCode }
        : {}),
      executionAuthority: false,
    })
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runRecoveryCommand(process.argv.slice(2))
}
