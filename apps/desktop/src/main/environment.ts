import { execFile } from 'child_process'
import { accessSync, constants as fsConstants, readdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'

const DEFAULT_MACOS_LOGIN_SHELL = '/bin/zsh'
const LOGIN_SHELL_PATH_MARKER = '__SCHOLARSEED_LOGIN_PATH__'
const LOGIN_SHELL_PATH_COMMAND = `printf '%s%s\\n' '${LOGIN_SHELL_PATH_MARKER}' "$PATH"`
const LOGIN_SHELL_TIMEOUT_MS = 5_000
const LOGIN_SHELL_MAX_BUFFER_BYTES = 64 * 1024
const NVM_VERSION_DIRECTORY = join('.nvm', 'versions', 'node')
const STANDARD_USER_BIN_DIRECTORIES = [
  ['.local', 'bin'],
  ['.volta', 'bin'],
  ['.asdf', 'shims']
] as const
const STANDARD_SYSTEM_BIN_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'] as const
const ENABLED_ENV_VALUE = '1'

export function resolveDeveloperToolsEnabled(
  rendererUrl: string | undefined,
  headless: boolean,
  configured: string | undefined
): boolean {
  return Boolean(rendererUrl) && !headless && configured === ENABLED_ENV_VALUE
}

export function requiresSingleInstanceLock(
  rendererUrl: string | undefined,
  headless: boolean
): boolean {
  return !rendererUrl && !headless
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

export async function resolveLoginShellPath(shell = process.env.SHELL || DEFAULT_MACOS_LOGIN_SHELL): Promise<string> {
  if (!isAbsolute(shell)) return ''
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lc', LOGIN_SHELL_PATH_COMMAND],
      {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: LOGIN_SHELL_MAX_BUFFER_BYTES
      },
      (error, stdout) => resolve(error ? '' : parseLoginShellPath(stdout))
    )
  })
}
