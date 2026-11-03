import { execFile } from 'child_process'
import { accessSync, constants as fsConstants, readdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, posix, win32 } from 'path'

const DEFAULT_MACOS_LOGIN_SHELL = '/bin/zsh'
const LOGIN_SHELL_PATH_MARKER = '__SCHOLARSEED_LOGIN_PATH__'
const LOGIN_SHELL_PATH_COMMAND = `printf '%s%s\\n' '${LOGIN_SHELL_PATH_MARKER}' "$PATH"`
const LOGIN_SHELL_TIMEOUT_MS = 5_000
const LOGIN_SHELL_MAX_BUFFER_BYTES = 64 * 1024
const NVM_VERSION_DIRECTORY = join('.nvm', 'versions', 'node')
const STANDARD_USER_BIN_DIRECTORIES = [
  ['.local', 'bin'],
  ['.volta', 'bin'],
  ['.asdf', 'shims'],
] as const
const STANDARD_SYSTEM_BIN_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'] as const
const ENABLED_ENV_VALUE = '1'
const WINDOWS_PLATFORM = 'win32'
const USER_DATA_DIRECTORY_SWITCH = '--user-data-dir'

/** Match Node's child environment selection, including Windows case aliases. */
export function captureEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Readonly<Record<string, string>> {
  const keys: string[] = []
  for (const key in environment) keys.push(key)
  if (platform === WINDOWS_PLATFORM) keys.sort()
  const seen = new Set<string>()
  const entries: [string, string][] = []
  for (const key of keys) {
    const identity = platform === WINDOWS_PLATFORM ? key.toUpperCase() : key
    if (seen.has(identity)) continue
    seen.add(identity)
    const value = environment[key]
    if (value !== undefined) entries.push([key, value])
  }
  return Object.freeze(Object.fromEntries(entries))
}

export interface SeedSource {
  readonly input: string | null
  readonly packaged: string | null
}

/** Observe input before the existing packaged-default override is applied. */
export function captureSeedSource(
  environment: NodeJS.ProcessEnv,
  packaged: string | null,
  platform: NodeJS.Platform = process.platform
): Readonly<SeedSource> {
  const key = 'SCHOLARSEED_CONFIG_SEED_PATH'
  const effective = captureEnvironment(environment, platform)
  const inputKey = Object.keys(effective).find((name) =>
    platform === WINDOWS_PLATFORM ? name.toUpperCase() === key : name === key
  )
  return Object.freeze({ input: inputKey === undefined ? null : effective[inputKey], packaged })
}

export function protocolClientArguments(
  platform: string,
  defaultApp: boolean,
  appPath: string,
  userDataPath: string
): string[] {
  const args = defaultApp ? [appPath] : []
  if (platform === WINDOWS_PLATFORM) {
    args.push(`${USER_DATA_DIRECTORY_SWITCH}=${userDataPath}`)
  }
  return args
}

export function resolveDeveloperToolsEnabled(
  rendererUrl: string | undefined,
  headless: boolean,
  configured: string | undefined
): boolean {
  return (
    Boolean(rendererUrl) &&
    !headless &&
    (configured === undefined || configured === ENABLED_ENV_VALUE)
  )
}

export function requiresSingleInstanceLock(headless: boolean): boolean {
  return !headless
}

export function parseLoginShellPath(output: string): string {
  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.startsWith(LOGIN_SHELL_PATH_MARKER)) {
      return line.slice(LOGIN_SHELL_PATH_MARKER.length).trim()
    }
  }
  return ''
}

export function mergeExecutablePaths(...values: Array<string | null | undefined>): string {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    for (const entry of String(value || '').split(delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(delimiter)
}

export function pythonExecutableDirectories(
  executable: string,
  scripts: string,
  platform: string = process.platform
): string[] {
  const directory = (platform === WINDOWS_PLATFORM ? win32 : posix).dirname(executable)
  return scripts === directory ? [scripts] : [scripts, directory]
}

export function standardExecutablePath(home = homedir()): string {
  const nvmRoot = join(home, NVM_VERSION_DIRECTORY)
  let nvmVersions: string[] = []
  try {
    nvmVersions = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(nvmRoot, version, 'bin'))
  } catch {
    /* NVM is optional. */
  }
  const userBins = STANDARD_USER_BIN_DIRECTORIES.map((parts) => join(home, ...parts))
  return mergeExecutablePaths(...nvmVersions, ...userBins, ...STANDARD_SYSTEM_BIN_DIRECTORIES)
}

export function findExecutableOnPath(name: string, pathValue: string): string {
  if (!name || name.includes('/')) return ''
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* Continue through the declared search path. */
    }
  }
  return ''
}

export function resolvePreferredExecutable(
  configured: string,
  bundled: string,
  fallback: string
): string {
  const explicit = configured.trim()
  if (explicit) return explicit
  if (bundled.trim()) return bundled.trim()
  try {
    accessSync(fallback, fsConstants.X_OK)
    return fallback
  } catch {
    return ''
  }
}

export async function resolveLoginShellPath(
  shell = process.env.SHELL || DEFAULT_MACOS_LOGIN_SHELL
): Promise<string> {
  if (!isAbsolute(shell)) return ''
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lc', LOGIN_SHELL_PATH_COMMAND],
      {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: LOGIN_SHELL_MAX_BUFFER_BYTES,
      },
      (error, stdout) => resolve(error ? '' : parseLoginShellPath(stdout))
    )
  })
}
