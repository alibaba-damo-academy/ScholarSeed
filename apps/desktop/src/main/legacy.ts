// Desktop legacy-home transfer. The startup owner must hold maintenance over
// both homes before calling this owner; this journal is recovery evidence only.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeJson } from './journal.ts'
import { beginDomains, ensureDirectories } from '../../native/domains.cjs'
import type { DomainNative, FamilyAuthorization, Domains } from '../../native/domains.cjs'

const RECORD = '.desktop-legacy-migration.json'
const VERSION = 1
const MAX_ENTRIES = 100_000
const MAX_RECORD_BYTES = 32 * 1024 * 1024
const COPY_BUFFER_BYTES = 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/
const TRANSACTION = /^[a-f0-9]{32}$/

type Entry =
  | { path: string; identity: string; kind: 'directory' }
  | { path: string; identity: string; kind: 'file'; bytes: number; sha256: string }
interface Transfer {
  version: number
  id: string
  source: string
  target: string
  sourceIdentity: string
  targetIdentity: string
  phase: 'copying' | 'committed' | 'retired'
  entries: Entry[]
}

function identity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}`
}
function directory(path: string): BigIntStats {
  const info = lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Legacy migration requires ordinary directories')
  return info
}
function regular(info: BigIntStats): void {
  if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Legacy migration refuses linked or special files')
}
function contained(root: string, path: string): boolean {
  const name = relative(root, path)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`))
}
function signature(info: BigIntStats): string {
  return `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}
function checksum(path: string): { bytes: number; sha256: string } {
  const before = lstatSync(path, { bigint: true })
  regular(before)
  const fd = openSync(path, 'r')
  try {
    const opened = fstatSync(fd, { bigint: true })
    regular(opened)
    if (signature(before) !== signature(opened)) throw new Error('Legacy migration source changed')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let bytes = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      bytes += count
      if (BigInt(bytes) > opened.size) throw new Error('Legacy migration source grew during copy')
    }
    if (
      BigInt(bytes) !== opened.size ||
      signature(fstatSync(fd, { bigint: true })) !== signature(opened) ||
      signature(lstatSync(path, { bigint: true })) !== signature(opened)
    )
      throw new Error('Legacy migration source changed during read')
    return { bytes, sha256: hash.digest('hex') }
  } finally {
    closeSync(fd)
  }
}
function inventory(root: string): Entry[] {
  const entries: Entry[] = []
  function visit(parent: string): void {
    directory(parent)
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name)
      const key = relative(root, path)
      if (key === RECORD || name.startsWith('.desktop-legacy-stage-'))
        throw new Error('Legacy home contains reserved migration metadata')
      const info = lstatSync(path, { bigint: true })
      if (info.isDirectory() && !info.isSymbolicLink())
        entries.push({ path: key, identity: identity(info), kind: 'directory' })
      else {
        regular(info)
        entries.push({ path: key, identity: identity(info), kind: 'file', ...checksum(path) })
      }
      if (entries.length > MAX_ENTRIES) throw new Error('Legacy migration inventory exceeds limit')
      if (info.isDirectory()) visit(path)
    }
  }
  visit(root)
  return entries
}
function sameFile(path: string, entry: Extract<Entry, { kind: 'file' }>): boolean {
  const observed = checksum(path)
  return observed.bytes === entry.bytes && observed.sha256 === entry.sha256
}
function readTransfer(path: string): Transfer {
  const info = lstatSync(path, { bigint: true })
  regular(info)
  if (info.size > MAX_RECORD_BYTES) throw new Error('Legacy migration record exceeds limit')
  const descriptor = openSync(path, 'r')
  let raw: string
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    regular(opened)
    if (signature(opened) !== signature(info)) throw new Error('Legacy migration record changed')
    const buffer = Buffer.alloc(Number(opened.size) + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
    }
    if (
      BigInt(bytes) !== opened.size ||
      signature(fstatSync(descriptor, { bigint: true })) !== signature(opened) ||
      signature(lstatSync(path, { bigint: true })) !== signature(opened)
    )
      throw new Error('Legacy migration record changed while reading')
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))
  } finally {
    closeSync(descriptor)
  }
  const value = JSON.parse(raw) as Transfer
  if (raw !== `${JSON.stringify(value)}\n`) throw new Error('Noncanonical legacy migration record')
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'entries,id,phase,source,sourceIdentity,target,targetIdentity,version' ||
    value.version !== VERSION ||
    !TRANSACTION.test(value.id) ||
    !isAbsolute(value.source) ||
    !isAbsolute(value.target) ||
    !/^[0-9]+:[0-9]+$/.test(value.sourceIdentity) ||
    !/^[0-9]+:[0-9]+$/.test(value.targetIdentity) ||
    !['copying', 'committed', 'retired'].includes(value.phase) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  )
    throw new Error('Invalid legacy migration record')
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (
      !entry ||
      !/^[0-9]+:[0-9]+$/.test(entry.identity) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      isAbsolute(entry.path) ||
      entry.path.includes('\0') ||
      entry.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
      !contained(value.target, resolve(value.target, entry.path)) ||
      seen.has(entry.path)
    )
      throw new Error('Invalid legacy migration entry')
    seen.add(entry.path)
    if (entry.kind === 'directory' && Object.keys(entry).sort().join(',') === 'identity,kind,path')
      continue
    if (
      entry.kind !== 'file' ||
      Object.keys(entry).sort().join(',') !== 'bytes,identity,kind,path,sha256' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !DIGEST.test(entry.sha256)
    )
      throw new Error('Invalid legacy migration file')
  }
  return value
}
function preflight(target: string, entries: Entry[]): void {
  for (const entry of entries) {
    const path = join(target, entry.path)
    if (!existsSync(path)) continue
    if (entry.kind === 'directory') directory(path)
    else if (!sameFile(path, entry))
      throw new Error('Legacy and current data conflict; both copies were retained')
  }
}
function recoverStages(target: string, transfer: Transfer): void {
  for (const [index, entry] of transfer.entries.entries()) {
    if (entry.kind !== 'file') continue
    const destination = join(target, entry.path)
    const stage = join(dirname(destination), `.desktop-legacy-stage-${transfer.id}-${index}`)
    if (!existsSync(stage)) continue
    const info = lstatSync(stage, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid legacy migration stage')
    if (info.nlink !== 1n) {
      // Crash after link publication and before unlink: the only additional
      // link may be the exact destination recorded in this transaction.
      if (
        info.nlink !== 2n ||
        !existsSync(destination) ||
        identity(lstatSync(destination, { bigint: true })) !== identity(info)
      )
        throw new Error('Legacy migration stage has an unrelated link')
    }
    unlinkSync(stage)
    syncDirectory(dirname(stage))
  }
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function copyFile(
  source: string,
  target: string,
  temporary: string,
  entry: Extract<Entry, { kind: 'file' }>
): void {
  if (existsSync(target)) {
    if (!sameFile(target, entry)) throw new Error('Legacy migration target changed')
    return
  }
  if (existsSync(temporary)) {
    // This exact staging name belongs to the persisted transaction. Never
    // remove arbitrary directory entries or overwrite the destination.
    regular(lstatSync(temporary, { bigint: true }))
    unlinkSync(temporary)
  }
  const input = openSync(source, 'r')
  let output: number | undefined
  let published = false
  try {
    const before = fstatSync(input, { bigint: true })
    regular(before)
    if (
      identity(before) !== entry.identity ||
      signature(lstatSync(source, { bigint: true })) !== signature(before)
    )
      throw new Error('Legacy migration source replaced')
    output = openSync(temporary, 'wx', Number(before.mode & 0o777n))
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let bytes = 0
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      bytes += count
      if (bytes > entry.bytes) throw new Error('Legacy migration source grew')
      let written = 0
      while (written < count) {
        const countWritten = writeSync(output, buffer, written, count - written)
        if (countWritten === 0) throw new Error('Legacy migration short write')
        written += countWritten
      }
    }
    if (
      bytes !== entry.bytes ||
      hash.digest('hex') !== entry.sha256 ||
      signature(fstatSync(input, { bigint: true })) !== signature(before) ||
      signature(lstatSync(source, { bigint: true })) !== signature(before)
    )
      throw new Error('Legacy migration source changed during copy')
    fsyncSync(output)
    const completed = output
    output = undefined
    closeSync(completed)
    // Same-volume hard-link publication refuses an existing name on both OSes.
    // The source may reside on another volume; only this local stage is linked.
    linkSync(temporary, target)
    published = true
    unlinkSync(temporary)
    syncDirectory(dirname(target))
  } finally {
    if (output !== undefined) closeSync(output)
    closeSync(input)
    // Partial stages are retained for the next attempt; source is never deleted.
    if (published && existsSync(temporary))
      throw new Error('Legacy migration publication cleanup incomplete')
  }
}

// Absence handling must stay read-only: the source could appear between the
// native missing result and this check, which must never trigger an unqualified
// copy through a second call to the transfer engine.
function missingSource(source: string, target: string): void {
  if (existsSync(source)) throw new Error('Legacy source appeared after startup selection')
  const recordPath = join(target, RECORD)
  if (!existsSync(recordPath)) return
  const transfer = readTransfer(recordPath)
  if (
    transfer.source !== resolve(source) ||
    transfer.target !== resolve(target) ||
    transfer.targetIdentity !== identity(directory(target)) ||
    transfer.phase === 'copying'
  )
    throw new Error('Incomplete or mismatched legacy migration lost its source')
}

/** Copies under startup maintenance, with durable progress and no overwrite.
 * The committed receipt prevents replaying retained legacy bytes over newer data.
 * Source retirement is a separate native maintenance operation after this receipt.
 */
export function transferLegacyHome(
  sourceInput: string,
  targetInput: string
): { files: number; resumed: boolean } | null {
  const source = resolve(sourceInput),
    target = resolve(targetInput)
  if (source === target) return null
  if (contained(source, target) || contained(target, source))
    throw new Error('Legacy migration roots overlap')
  const recordPath = join(target, RECORD)
  if (!existsSync(source)) {
    missingSource(source, target)
    return null
  }
  const sourceIdentity = identity(directory(source))
  if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 })
  const targetIdentity = identity(directory(target))
  const resumed = existsSync(recordPath)
  let transfer: Transfer
  if (resumed) {
    transfer = readTransfer(recordPath)
    if (
      transfer.source !== source ||
      transfer.target !== target ||
      transfer.sourceIdentity !== sourceIdentity ||
      transfer.targetIdentity !== targetIdentity
    )
      throw new Error('Legacy migration roots differ from the recorded transaction')
    if (transfer.phase !== 'copying') return null
    if (JSON.stringify(inventory(source)) !== JSON.stringify(transfer.entries))
      throw new Error('Legacy migration source differs from its recovery record')
  } else {
    transfer = {
      version: VERSION,
      id: randomUUID().replaceAll('-', ''),
      source,
      target,
      sourceIdentity,
      targetIdentity,
      phase: 'copying',
      entries: inventory(source),
    }
    preflight(target, transfer.entries)
    if (Buffer.byteLength(JSON.stringify(transfer)) > MAX_RECORD_BYTES)
      throw new Error('Legacy migration record exceeds limit')
    writeJson(recordPath, transfer)
  }
  recoverStages(target, transfer)
  preflight(target, transfer.entries)
  let files = 0
  for (const [index, entry] of transfer.entries.entries()) {
    const destination = join(target, entry.path)
    if (entry.kind === 'directory') {
      mkdirSync(destination, { recursive: true, mode: 0o700 })
      directory(destination)
      syncDirectory(dirname(destination))
      continue
    }
    copyFile(
      join(source, entry.path),
      destination,
      join(dirname(destination), `.desktop-legacy-stage-${transfer.id}-${index}`),
      entry
    )
    files++
  }
  if (
    identity(directory(source)) !== sourceIdentity ||
    identity(directory(target)) !== targetIdentity ||
    JSON.stringify(inventory(source)) !== JSON.stringify(transfer.entries)
  )
    throw new Error('Legacy migration source changed before commit')
  preflight(target, transfer.entries)
  writeJson(recordPath, { ...transfer, phase: 'committed' })
  return { files, resumed }
}

// Called only while the same source/target maintenance owner is still held.
// Keep the empty root: deleting that root would invalidate the held native
// binding and would require a separate namespace-parent transaction.
function retireLegacySource(sourceInput: string, targetInput: string, check: () => void): number {
  const source = resolve(sourceInput),
    target = resolve(targetInput)
  const recordPath = join(target, RECORD)
  const transfer = readTransfer(recordPath)
  if (
    transfer.source !== source ||
    transfer.target !== target ||
    transfer.sourceIdentity !== identity(directory(source)) ||
    transfer.targetIdentity !== identity(directory(target)) ||
    transfer.phase === 'copying'
  )
    throw new Error('Legacy retirement lacks a matching committed transfer')
  const remaining = inventory(source)
  const expected = new Map(transfer.entries.map((entry) => [entry.path, entry]))
  // Inspect the complete remainder before deleting anything. A new or changed
  // source entry is user data, not garbage from this transaction.
  for (const entry of remaining) {
    if (JSON.stringify(entry) !== JSON.stringify(expected.get(entry.path)))
      throw new Error('Legacy source changed after transfer; cleanup retained all remaining data')
  }
  if (transfer.phase === 'retired') {
    if (remaining.length) throw new Error('Retired legacy home received new data')
    return 0
  }
  // Reopen and verify every destination before source deletion. A durable
  // receipt alone cannot prove that all directory entries survived a crash.
  for (const entry of transfer.entries) {
    const destination = join(target, entry.path)
    if (entry.kind === 'directory') directory(destination)
    else if (!sameFile(destination, entry))
      throw new Error('Legacy destination differs before source retirement')
  }
  let removed = 0
  for (const entry of [...remaining].reverse()) {
    check()
    const path = join(source, entry.path)
    const observed = lstatSync(path, { bigint: true })
    if (identity(observed) !== entry.identity)
      throw new Error('Legacy retirement entry was replaced')
    if (entry.kind === 'directory') {
      directory(path)
      // Nonrecursive removal refuses a new child instead of erasing it.
      rmdirSync(path)
    } else {
      if (!sameFile(path, entry)) throw new Error('Legacy retirement file changed')
      unlinkSync(path)
      removed++
    }
    syncDirectory(dirname(path))
  }
  check()
  if (readdirSync(source).length) throw new Error('Legacy source changed during retirement')
  writeJson(recordPath, { ...transfer, phase: 'retired' })
  return removed
}

// This is the production entry point. The low-level transfer stays synchronous
// while this owner holds exclusive activity through the complete copy/commit.
export async function migrateLegacyHome(
  native: DomainNative,
  coordinator: string,
  source: string,
  target: string,
  authorize?: FamilyAuthorization
): Promise<{ files: number; resumed: boolean; retired: number } | null> {
  let sourcePin: unknown
  try {
    sourcePin = native.pin(source, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_LEASE_MISSING') {
      missingSource(source, target)
      return null
    }
    throw error
  }
  let coordination: unknown
  let domains: Domains | undefined
  let failure: unknown
  try {
    // Only the OS-account coordinator may be created directly. Product home
    // structure uses the native parent-IS creation protocol before X occupancy.
    coordination = native.pin(coordinator, true)
    ensureDirectories(native, coordinator, [target])
    domains = beginDomains(native, coordinator, [source, target], true)
    if (authorize) await domains.occupyFamily(authorize)
    else domains.occupy()
    domains.check()
    const reservation = domains.reserveMutation(
      JSON.stringify({
        kind: 'desktop-legacy',
        version: VERSION,
        source: resolve(source),
        target: resolve(target),
      })
    )
    const result = transferLegacyHome(source, target)
    domains.check()
    const retired =
      resolve(source) === resolve(target)
        ? 0
        : retireLegacySource(source, target, () => domains!.check())
    domains.check()
    reservation.finish()
    return result || retired
      ? { files: result?.files ?? 0, resumed: result?.resumed ?? true, retired }
      : null
  } catch (error) {
    failure = error
    throw error
  } finally {
    const code = (failure as NodeJS.ErrnoException | undefined)?.code
    // Uncertain native release retains all remaining capabilities until exit.
    if (code !== 'ERR_DOMAIN_RELEASE' && code !== 'ERR_LEASE_RELEASE') {
      domains?.close()
      if (coordination !== undefined) native.release(coordination)
      native.release(sourcePin)
    }
  }
}
