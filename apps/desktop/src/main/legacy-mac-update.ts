// Older macOS installers launch the candidate with this argument and wait up to
// 60 seconds for confirmed-<token>. Keep this bridge until those installers age out.
import { constants, mkdirSync, openSync, statSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_PREFIX = '--scholarseed-update-token='
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function pendingLegacyMacUpdateToken(argv: readonly string[]): string | null {
  const tokens = argv.filter((argument) => argument.startsWith(TOKEN_PREFIX))
  if (!tokens.length) return null
  if (tokens.length !== 1) throw new Error('Duplicate legacy macOS update token')
  const token = tokens[0].slice(TOKEN_PREFIX.length)
  if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid legacy macOS update token')
  return token
}

export function confirmLegacyMacUpdate(home: string, token: string, version: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid legacy macOS update token')
  const directory = join(home, 'updates')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `confirmed-${token}`)
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    writeSync(fd, `${version}\n`)
  } finally {
    closeSync(fd)
  }
  return path
}

export interface ResourceDirectoryIdentity {
  dev: number
  ino: number
}

export function resourceDirectoryIdentity(path: string): ResourceDirectoryIdentity {
  const stat = statSync(path)
  if (!stat.isDirectory()) throw new Error('Application resources path is not a directory')
  return { dev: stat.dev, ino: stat.ino }
}

export function resourceDirectoryChanged(
  path: string,
  original: ResourceDirectoryIdentity
): boolean {
  try {
    const current = resourceDirectoryIdentity(path)
    return current.dev !== original.dev || current.ino !== original.ino
  } catch {
    return true
  }
}

/** A moved/replaced App must stop before its absolute backend paths read another build. */
export function watchResourceDirectory(path: string, onChange: () => void): () => void {
  const original = resourceDirectoryIdentity(path)
  const timer = setInterval(() => {
    if (!resourceDirectoryChanged(path, original)) return
    clearInterval(timer)
    onChange()
  }, 250)
  timer.unref()
  return () => clearInterval(timer)
}
