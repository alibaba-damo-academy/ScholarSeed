import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { loadReviewedSamples } from './samples.ts'

export interface PreviewFileEntry {
  readonly path: string
  readonly name: string
  readonly kind: 'file' | 'dir'
  readonly size: number
  readonly mtime: number
  readonly identity: string
  readonly revision: string
}

export interface PreviewFileContent extends PreviewFileEntry {
  readonly bytes: Uint8Array
}

export const PREVIEW_FILE_ERROR = {
  invalidPath: 'preview_invalid_path',
  notFound: 'preview_file_not_found',
  notFile: 'preview_not_a_file',
  notDirectory: 'preview_not_a_directory',
  conflict: 'preview_path_conflict',
  invalidBytes: 'preview_invalid_bytes',
} as const

export class PreviewFileError extends Error {
  constructor(readonly code: typeof PREVIEW_FILE_ERROR[keyof typeof PREVIEW_FILE_ERROR]) {
    super(code)
    this.name = 'PreviewFileError'
  }
}

const INITIAL_MTIME = Date.UTC(2026, 9, 20) / 1000
const MTIME_STEP = 1
const DIRECTORY_SEPARATOR = '/'
const REVISION_PREFIX = 'sha256:'

function revision(bytes: Uint8Array): string {
  return REVISION_PREFIX + createHash('sha256').update(bytes).digest('hex')
}

function normalize(path: string, rootAllowed = false): string {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || path.includes(':') || posix.isAbsolute(path) || path.split(DIRECTORY_SEPARATOR).includes('..')) {
    throw new PreviewFileError(PREVIEW_FILE_ERROR.invalidPath)
  }
  const normalized = posix.normalize(path)
  if (normalized === '.') {
    if (rootAllowed) return ''
    throw new PreviewFileError(PREVIEW_FILE_ERROR.invalidPath)
  }
  return normalized.endsWith(DIRECTORY_SEPARATOR) ? normalized.slice(0, -1) : normalized
}

function metadata(file: PreviewFileContent): PreviewFileEntry {
  const { bytes: _bytes, ...entry } = file
  return entry
}

let sampleCache: ReadonlyMap<string, PreviewFileContent> | undefined

function loadSamples(): ReadonlyMap<string, PreviewFileContent> {
  return sampleCache ??= new Map(loadReviewedSamples().map(({ document, bytes }) => {
    const path = document.path
    return [path, { path, name: path, kind: 'file' as const, bytes, size: bytes.byteLength, mtime: INITIAL_MTIME, identity: `preview-sample:${path}`, revision: revision(bytes) }]
  }))
}

export class PreviewFiles {
  private files = new Map(loadSamples())
  private clock = INITIAL_MTIME

  private tick(): number {
    this.clock += MTIME_STEP
    return this.clock
  }

  manifest(): PreviewFileEntry[] {
    return [...this.files.values()].map(metadata).sort((left, right) => left.path.localeCompare(right.path))
  }

  fileInfo(path: string): PreviewFileEntry {
    const key = normalize(path)
    const file = this.files.get(key)
    if (file) return metadata(file)
    const children = [...this.files.values()].filter(item => item.path.startsWith(key + DIRECTORY_SEPARATOR))
    if (!children.length) throw new PreviewFileError(PREVIEW_FILE_ERROR.notFound)
    return {
      path: key, name: posix.basename(key), kind: 'dir', size: 0,
      mtime: Math.max(...children.map(item => item.mtime)),
      identity: `preview-directory:${key}`,
      revision: revision(new TextEncoder().encode(children.map(item => `${item.path}:${item.revision}`).sort().join('\n'))),
    }
  }

  list(path = ''): PreviewFileEntry[] {
    const directory = normalize(path, true)
    if (directory && this.fileInfo(directory).kind !== 'dir') throw new PreviewFileError(PREVIEW_FILE_ERROR.notDirectory)
    const prefix = directory ? directory + DIRECTORY_SEPARATOR : ''
    const paths = new Set<string>()
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) paths.add(prefix + key.slice(prefix.length).split(DIRECTORY_SEPARATOR)[0])
    }
    return [...paths].map(key => this.fileInfo(key)).sort((left, right) => left.path.localeCompare(right.path))
  }

  read(path: string): PreviewFileContent {
    const key = normalize(path)
    const file = this.files.get(key)
    if (!file) {
      this.fileInfo(key)
      throw new PreviewFileError(PREVIEW_FILE_ERROR.notFile)
    }
    return { ...file, bytes: new Uint8Array(file.bytes) }
  }

  write(path: string, bytes: Uint8Array): PreviewFileEntry {
    const key = normalize(path)
    if (!(bytes instanceof Uint8Array)) throw new PreviewFileError(PREVIEW_FILE_ERROR.invalidBytes)
    if ([...this.files.keys()].some(existing => existing.startsWith(key + DIRECTORY_SEPARATOR) || key.startsWith(existing + DIRECTORY_SEPARATOR))) throw new PreviewFileError(PREVIEW_FILE_ERROR.conflict)
    const previous = this.files.get(key)
    const content = new Uint8Array(bytes)
    const file: PreviewFileContent = {
      path: key, name: posix.basename(key), kind: 'file', bytes: content, size: content.byteLength,
      mtime: this.tick(), identity: previous?.identity ?? `preview-file:${randomUUID()}`, revision: revision(content),
    }
    this.files.set(key, file)
    return metadata(file)
  }

  rename(path: string, target: string): PreviewFileEntry {
    const key = normalize(path)
    const destination = normalize(target)
    const source = this.fileInfo(key)
    if (key === destination) return source
    if (destination.startsWith(key + DIRECTORY_SEPARATOR)) throw new PreviewFileError(PREVIEW_FILE_ERROR.conflict)
    if ([...this.files.keys()].some(existing => existing === destination || existing.startsWith(destination + DIRECTORY_SEPARATOR))) throw new PreviewFileError(PREVIEW_FILE_ERROR.conflict)
    const moving = [...this.files.values()].filter(file => file.path === key || file.path.startsWith(key + DIRECTORY_SEPARATOR))
    const remaining = new Set([...this.files.keys()].filter(existing => !moving.some(file => file.path === existing)))
    const replacements = moving.map(file => ({ file, path: destination + file.path.slice(key.length) }))
    for (const item of replacements) {
      if ([...remaining].some(existing => existing === item.path || existing.startsWith(item.path + DIRECTORY_SEPARATOR) || item.path.startsWith(existing + DIRECTORY_SEPARATOR))) throw new PreviewFileError(PREVIEW_FILE_ERROR.conflict)
    }
    const mtime = this.tick()
    for (const file of moving) this.files.delete(file.path)
    for (const item of replacements) this.files.set(item.path, { ...item.file, path: item.path, name: posix.basename(item.path), mtime })
    return this.fileInfo(destination)
  }

  delete(path: string): void {
    const key = normalize(path)
    this.fileInfo(key)
    for (const existing of this.files.keys()) {
      if (existing === key || existing.startsWith(key + DIRECTORY_SEPARATOR)) this.files.delete(existing)
    }
    this.tick()
  }

  reset(): void {
    this.files = new Map(loadSamples())
    this.clock = INITIAL_MTIME
  }
}
