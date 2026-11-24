// Container policy for the exact ZIP bytes inspected and handed to Squirrel.
import { constants, promises as nodeFs } from 'node:fs'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const ZIP = {
  end: 0x06054b50,
  central: 0x02014b50,
  local: 0x04034b50,
  descriptor: 0x08074b50,
  endBytes: 22,
  centralBytes: 46,
  localBytes: 30,
  commentBytes: 65535,
  descriptorBytes: 12,
  descriptorSignatureBytes: 4,
  zip64: 0xffffffff,
  zip64Count: 0xffff,
  dataDescriptor: 0x8,
  utf8: 0x800,
  stored: 0,
  deflated: 8,
  unix: 3,
  typeMask: 0xf000,
  symlink: 0xa000,
  directory: 0x4000,
  regular: 0x8000,
  modeShift: 16,
  hostShift: 8,
} as const
const END = {
  disk: 4,
  centralDisk: 6,
  diskEntries: 8,
  entries: 10,
  size: 12,
  offset: 16,
  comment: 20,
} as const
const CENTRAL = {
  host: 4,
  flags: 8,
  method: 10,
  crc: 16,
  compressed: 20,
  expanded: 24,
  name: 28,
  extra: 30,
  comment: 32,
  disk: 34,
  attributes: 38,
  offset: 42,
} as const
const LOCAL = {
  flags: 6,
  method: 8,
  crc: 14,
  compressed: 18,
  expanded: 22,
  name: 26,
  extra: 28,
} as const
const DESCRIPTOR = { crc: 0, compressed: 4, expanded: 8 } as const
const EXTRA_LENGTH_OFFSET = 2
const CURRENT_DIRECTORY = '.'
const PARENT_DIRECTORY = '..'
const LIMIT = {
  entries: ZIP.zip64Count - 1,
  metadata: 16 * 1024 * 1024,
  expanded: 4 * 1024 ** 3,
  link: 4096,
  name: 4096,
  linkHops: 40,
} as const
const APP = 'ScholarSeed.app'
const RESOURCE = '__MACOSX'
const APPLEDOUBLE = '._'
const ROOT = '/'
const NUL = '\0'
const SLASH = '/'
const BACKSLASH = '\\'
const NORMALIZATION = 'NFD'
const SAFE_EXTRA_FIELDS = new Set([0x5455, 0x5855, 0x7875]) // timestamps / Unix uid-gid only
const EXTRA_HEADER_BYTES = 4

export class UpdateArchiveLimitError extends Error {}
export class UpdateArchiveSourceMismatch extends Error {}
export const MACOS_DITTO = '/usr/bin/ditto'
export const MACOS_ARCHIVE_TIMEOUT_MS = 600_000
export const MAX_SQUIRREL_ARCHIVE_BYTES = 1024 ** 3 - 1

export function assertSquirrelArchiveSize(size: number): void {
  // Squirrel buffers the download in CFData, which rounds over 1 GiB to 2 GiB.
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SQUIRREL_ARCHIVE_BYTES)
    throw new UpdateArchiveLimitError('Squirrel archive must be smaller than 1 GiB')
}

export function archiveApplicationArguments(
  source: string,
  archive: string,
  resourceMode: '--sequesterRsrc' | '--norsrc' = '--sequesterRsrc'
): string[] {
  return ['-c', '-k', '--zlibCompressionLevel', '1', resourceMode, '--keepParent', source, archive]
}

interface SourceEntry {
  mode: number
  host: number
  directory: boolean
  data: number
  compressed: number
  expanded: number
  method: number
  link: string | undefined
}

/** Filesystem operations on the mounted bundle must bypass Electron's ASAR view. */
export interface MountedArchiveSource {
  path: string
  fs: Pick<typeof nodeFs, 'lstat' | 'open' | 'opendir' | 'readlink'>
}

function sourceMismatch(): never {
  throw new UpdateArchiveSourceMismatch('Cached ZIP differs from the mounted App')
}

async function hashContents(chunks: AsyncIterable<Buffer>, size: number): Promise<string> {
  const hash = createHash('sha512')
  let count = 0
  for await (const chunk of chunks) {
    count += chunk.length
    if (count > size) sourceMismatch()
    hash.update(chunk)
  }
  if (count !== size) sourceMismatch()
  return hash.digest('hex')
}

async function compareSourceTree(
  file: FileHandle,
  { path: application, fs }: MountedArchiveSource,
  entries: Map<string, SourceEntry>,
  signal?: AbortSignal
): Promise<void> {
  const compare = async (path: string, name: string): Promise<void> => {
    signal?.throwIfAborted()
    const entry = entries.get(name)
    const info = await fs.lstat(path)
    if (!entry || entry.host !== ZIP.unix || (entry.mode & 0xffff) !== (info.mode & 0xffff))
      sourceMismatch()
    entries.delete(name)
    if (info.isDirectory() && entry.directory) {
      if (entry.compressed !== 0 || entry.method !== ZIP.stored) sourceMismatch()
      for await (const child of await fs.opendir(path))
        await compare(join(path, child.name), `${name}/${child.name}`)
      return
    }
    if (info.isSymbolicLink() && entry.link !== undefined) {
      if ((await fs.readlink(path)) !== entry.link) sourceMismatch()
      return
    }
    if (
      !info.isFile() ||
      info.size !== entry.expanded ||
      entry.directory ||
      entry.link !== undefined
    )
      sourceMismatch()
    const sourceFile = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let expected
    try {
      expected = await hashContents(
        sourceFile.createReadStream({ autoClose: false, signal }),
        info.size
      )
    } finally {
      await sourceFile.close()
    }
    if (entry.compressed === 0) {
      if (entry.expanded !== 0 || entry.method !== ZIP.stored) sourceMismatch()
      return
    }
    const packed = file.createReadStream({
      start: entry.data,
      end: entry.data + entry.compressed - 1,
      autoClose: false,
      signal,
    })
    if (entry.method === ZIP.stored) {
      if ((await hashContents(packed, entry.expanded)) !== expected) sourceMismatch()
      return
    }
    const inflater = createInflateRaw()
    await pipeline(
      packed,
      inflater,
      async (chunks) => {
        if ((await hashContents(chunks, entry.expanded)) !== expected) sourceMismatch()
      },
      { signal }
    )
    if (inflater.bytesWritten !== entry.compressed) sourceMismatch()
  }
  await compare(application, APP)
  // AppleDouble, duplicate or extra metadata cannot re-establish source proof.
  if (entries.size !== 0) sourceMismatch()
}

export interface UpdateArchiveBudget {
  entries: number
  metadata: number
  expanded: number
}

function assertBudget({ entries, metadata, expanded }: UpdateArchiveBudget): void {
  if (entries > LIMIT.entries || metadata > LIMIT.metadata || expanded > LIMIT.expanded)
    throw new UpdateArchiveLimitError('Update ZIP exceeds entry, metadata or expansion limits')
}

export function assertMeasuredUpdateArchive(budget: UpdateArchiveBudget & { size: number }): void {
  if (
    !budget ||
    ![budget.entries, budget.metadata, budget.expanded].every(Number.isSafeInteger) ||
    budget.entries <= 0 ||
    budget.metadata <= 0 ||
    budget.expanded < 0
  )
    throw new UpdateArchiveLimitError('Missing or invalid measured update ZIP budget')
  assertSquirrelArchiveSize(budget.size)
  assertBudget(budget)
}

/** Measure a lower bound from the read-only mounted App. AppleDouble entries
 * and compression overhead are accounted for by inspecting the generated ZIP.
 */
export async function preflightApplicationArchive(
  { path: application, fs }: MountedArchiveSource,
  signal?: AbortSignal
): Promise<UpdateArchiveBudget> {
  const budget = { entries: 0, metadata: 0, expanded: 0 }
  const visit = async (path: string, name: string): Promise<void> => {
    signal?.throwIfAborted()
    const info = await fs.lstat(path)
    budget.entries++
    budget.metadata += ZIP.centralBytes + Buffer.byteLength(name) + Number(info.isDirectory())
    if (info.isFile()) budget.expanded += info.size
    else if (info.isSymbolicLink()) budget.expanded += Buffer.byteLength(await fs.readlink(path))
    assertBudget(budget)
    if (info.isDirectory())
      for await (const entry of await fs.opendir(path))
        await visit(join(path, entry.name), `${name}/${entry.name}`)
  }
  await visit(application, APP)
  return budget
}

function extraFields(extra: Buffer): void {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + EXTRA_HEADER_BYTES > extra.length) invalid()
    const kind = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + EXTRA_LENGTH_OFFSET)
    if (!SAFE_EXTRA_FIELDS.has(kind) || cursor + EXTRA_HEADER_BYTES + length > extra.length)
      invalid()
    cursor += EXTRA_HEADER_BYTES + length
  }
}

function invalid(): never {
  throw new Error('Update ZIP structure is not canonical')
}
async function bytes(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = await file.read(result, offset, length - offset, position + offset)
    if (!read.bytesRead) invalid()
    offset += read.bytesRead
  }
  return result
}

function entryPath(raw: Buffer): string {
  const name = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const path = name.endsWith(SLASH) ? name.slice(0, -1) : name
  if (
    !path ||
    raw.length > LIMIT.name ||
    /[\x00-\x1f\x7f]/.test(name) ||
    name.includes(BACKSLASH) ||
    path.startsWith(SLASH) ||
    path
      .split(SLASH)
      .some((part) => !part || part === CURRENT_DIRECTORY || part === PARENT_DIRECTORY)
  )
    invalid()
  const parts = path.split(SLASH)
  if (parts[0] !== APP) {
    if (
      parts[0] !== RESOURCE ||
      (parts.length > 1 &&
        parts[1] !== APP &&
        !(parts.length === 2 && parts[1] === `${APPLEDOUBLE}${APP}`))
    )
      invalid()
    if (!name.endsWith(SLASH) && !parts.at(-1)?.startsWith(APPLEDOUBLE)) invalid()
  }
  return name
}

/** Fail before extraction: central/local records, paths and symlinks must agree. */
export async function verifyApplicationArchive(
  path: string,
  signal?: AbortSignal,
  source?: MountedArchiveSource
): Promise<UpdateArchiveBudget> {
  const file = await nodeFs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await verifyApplicationArchiveFile(file, signal, source)
  } finally {
    await file.close()
  }
}

/** Inspect the same pinned ZIP descriptor that owns its byte proof. */
export async function verifyApplicationArchiveFile(
  file: FileHandle,
  signal?: AbortSignal,
  source?: MountedArchiveSource
): Promise<UpdateArchiveBudget> {
  const info = await file.stat()
  if (!info.isFile() || info.size >= ZIP.zip64 || info.size < ZIP.endBytes) invalid()
  const tailSize = Math.min(info.size, ZIP.endBytes + ZIP.commentBytes)
  const tail = await bytes(file, info.size - tailSize, tailSize)
  let end = -1
  for (let offset = tail.length - ZIP.endBytes; offset >= 0; offset--) {
    if (
      tail.readUInt32LE(offset) === ZIP.end &&
      offset + ZIP.endBytes + tail.readUInt16LE(offset + END.comment) === tail.length
    ) {
      end = offset
      break
    }
  }
  if (end < 0 || tail.readUInt16LE(end + END.disk) || tail.readUInt16LE(end + END.centralDisk))
    invalid()
  const count = tail.readUInt16LE(end + END.entries)
  const size = tail.readUInt32LE(end + END.size)
  const start = tail.readUInt32LE(end + END.offset)
  assertBudget({ entries: count, metadata: size, expanded: 0 })
  if (
    !count ||
    tail.readUInt16LE(end + END.diskEntries) !== count ||
    start + size !== info.size - tailSize + end
  )
    invalid()
  const central = await bytes(file, start, size)
  const names = new Map<string, boolean>()
  const links = new Map<string, { name: string; target: string }>()
  const sourceEntries = source ? new Map<string, SourceEntry>() : undefined
  let cursor = 0,
    localEnd = 0,
    expanded = 0
  for (let entry = 0; entry < count; entry++) {
    signal?.throwIfAborted()
    if (cursor + ZIP.centralBytes > central.length || central.readUInt32LE(cursor) !== ZIP.central)
      invalid()
    const flags = central.readUInt16LE(cursor + CENTRAL.flags)
    const method = central.readUInt16LE(cursor + CENTRAL.method)
    const crc = central.readUInt32LE(cursor + CENTRAL.crc)
    const compressed = central.readUInt32LE(cursor + CENTRAL.compressed)
    const unpacked = central.readUInt32LE(cursor + CENTRAL.expanded)
    const nameSize = central.readUInt16LE(cursor + CENTRAL.name)
    const extraSize = central.readUInt16LE(cursor + CENTRAL.extra)
    const commentSize = central.readUInt16LE(cursor + CENTRAL.comment)
    const local = central.readUInt32LE(cursor + CENTRAL.offset)
    const next = cursor + ZIP.centralBytes + nameSize + extraSize + commentSize
    if (
      next > central.length ||
      local !== localEnd ||
      central.readUInt16LE(cursor + CENTRAL.disk) ||
      compressed === ZIP.zip64 ||
      unpacked === ZIP.zip64 ||
      flags & ~(ZIP.dataDescriptor | ZIP.utf8) ||
      ![ZIP.stored, ZIP.deflated].includes(method as 0 | 8)
    )
      invalid()
    expanded += unpacked
    assertBudget({ entries: count, metadata: size, expanded })
    const raw = central.subarray(cursor + ZIP.centralBytes, cursor + ZIP.centralBytes + nameSize)
    extraFields(
      central.subarray(
        cursor + ZIP.centralBytes + nameSize,
        cursor + ZIP.centralBytes + nameSize + extraSize
      )
    )
    const name = entryPath(raw)
    const directory = name.endsWith(SLASH)
    const key = (directory ? name.slice(0, -1) : name).normalize(NORMALIZATION).toLowerCase()
    if (names.has(key)) invalid()
    names.set(key, directory)
    const header = await bytes(file, local, ZIP.localBytes)
    if (
      header.readUInt32LE(0) !== ZIP.local ||
      header.readUInt16LE(LOCAL.flags) !== flags ||
      header.readUInt16LE(LOCAL.method) !== method ||
      header.readUInt16LE(LOCAL.name) !== nameSize
    )
      invalid()
    const localName = await bytes(file, local + ZIP.localBytes, nameSize)
    if (!localName.equals(raw)) invalid()
    const data = local + ZIP.localBytes + nameSize + header.readUInt16LE(LOCAL.extra)
    extraFields(
      await bytes(file, local + ZIP.localBytes + nameSize, header.readUInt16LE(LOCAL.extra))
    )
    if (
      data + compressed > start ||
      compressed > LIMIT.expanded ||
      (method === ZIP.stored && compressed !== unpacked)
    )
      invalid()
    localEnd = data + compressed
    if (flags & ZIP.dataDescriptor) {
      const first = await bytes(file, localEnd, ZIP.descriptorSignatureBytes)
      const signed = first.readUInt32LE(0) === ZIP.descriptor
      const descriptor = await bytes(
        file,
        localEnd + (signed ? ZIP.descriptorSignatureBytes : 0),
        ZIP.descriptorBytes
      )
      if (
        descriptor.readUInt32LE(DESCRIPTOR.crc) !== crc ||
        descriptor.readUInt32LE(DESCRIPTOR.compressed) !== compressed ||
        descriptor.readUInt32LE(DESCRIPTOR.expanded) !== unpacked
      )
        invalid()
      localEnd += ZIP.descriptorBytes + (signed ? ZIP.descriptorSignatureBytes : 0)
    } else if (
      header.readUInt32LE(LOCAL.crc) !== crc ||
      header.readUInt32LE(LOCAL.compressed) !== compressed ||
      header.readUInt32LE(LOCAL.expanded) !== unpacked
    )
      invalid()
    const host = central.readUInt16LE(cursor + CENTRAL.host) >>> ZIP.hostShift
    const mode = central.readUInt32LE(cursor + CENTRAL.attributes) >>> ZIP.modeShift
    const type = mode & ZIP.typeMask
    if (
      host === ZIP.unix &&
      type &&
      ![ZIP.symlink, ZIP.directory, ZIP.regular].includes(type as 40960 | 16384 | 32768)
    )
      invalid()
    if (host === ZIP.unix && type === ZIP.symlink) {
      if (
        directory ||
        !name.startsWith(`${APP}${SLASH}`) ||
        !unpacked ||
        unpacked > LIMIT.link ||
        compressed > LIMIT.link
      )
        invalid()
      const payload = await bytes(file, data, compressed)
      const targetBytes =
        method === ZIP.stored ? payload : inflateRawSync(payload, { maxOutputLength: unpacked })
      if (targetBytes.length !== unpacked) invalid()
      const target = new TextDecoder('utf-8', { fatal: true }).decode(targetBytes)
      if (!target || target.includes(NUL) || target.includes(BACKSLASH) || target.startsWith(SLASH))
        invalid()
      links.set(key, { name, target })
    } else if (host === ZIP.unix && type && (type === ZIP.directory) !== directory) invalid()
    if (directory && unpacked !== 0) invalid()
    sourceEntries?.set(directory ? name.slice(0, -1) : name, {
      mode,
      host,
      directory,
      data,
      compressed,
      expanded: unpacked,
      method,
      link: links.get(key)?.target,
    })
    cursor = next
  }
  if (cursor !== central.length || localEnd !== start || names.get(APP.toLowerCase()) !== true)
    invalid()
  // No file may become an ancestor; links are resolved transitively, not just textually.
  for (const key of names.keys()) {
    const parts = key.split(SLASH)
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join(SLASH)
      if (names.get(parent) === false) invalid()
    }
  }
  for (const { name } of links.values()) {
    let pending = name.split(SLASH),
      resolved: string[] = [],
      hops = 0
    while (pending.length) {
      signal?.throwIfAborted()
      const part = pending.shift()!
      if (part === CURRENT_DIRECTORY) continue
      if (part === PARENT_DIRECTORY) {
        resolved.pop()
        if (!resolved.length) invalid()
        continue
      }
      resolved.push(part)
      const link = links.get(resolved.join(SLASH).normalize(NORMALIZATION).toLowerCase())
      if (link !== undefined) {
        if (++hops > LIMIT.linkHops) invalid()
        resolved.pop()
        pending = [...link.target.split(SLASH), ...pending]
      }
      if (resolved[0] !== APP) invalid()
    }
    if (!posix.resolve(ROOT, ...resolved).startsWith(`${ROOT}${APP}${SLASH}`)) invalid()
  }
  if (source && sourceEntries) await compareSourceTree(file, source, sourceEntries, signal)
  return { entries: count, metadata: size, expanded }
}
