import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  OFFICE_FONT_CACHE_ENTRIES,
  OFFICE_FONT_CACHE_MAX_BYTES,
  OFFICE_FONT_CACHE_SCHEMA,
  type OfficeFontCache,
} from '../fonts.ts'
import { readRecord, writeJson } from './journal.ts'
import { desktopDirectoryWriter, type DirectoryWriter } from './writer.ts'

const CACHE_FILENAME = 'cache.json'
const CACHE_MAGIC = 0xfc02fc04
const CACHE_VERSION = 8
const CACHE_HEADER_BYTES = 40
const CACHE_FONTSET_BYTES = 12
const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Accept only complete native indexes for the pinned engine's two font directories. */
export function validateFontCache(value: unknown): OfficeFontCache {
  const cache = value as OfficeFontCache
  if (
    !cache ||
    !Array.isArray(cache.files) ||
    !Array.isArray(cache.directories) ||
    cache.files.length !== OFFICE_FONT_CACHE_ENTRIES.length ||
    cache.directories.length !== OFFICE_FONT_CACHE_ENTRIES.length
  ) {
    throw new Error('Incomplete Office font cache')
  }
  let total = 0
  for (const expected of OFFICE_FONT_CACHE_ENTRIES) {
    const files = cache.files.filter((file) => file?.name === expected.name)
    const directories = cache.directories.filter((directory) => directory?.path === expected.path)
    if (files.length !== 1 || directories.length !== 1)
      throw new Error('Invalid Office font cache inventory')
    const { mtime } = directories[0]
    if (!Number.isSafeInteger(mtime) || mtime <= 0 || mtime > Date.now())
      throw new Error('Invalid font directory timestamp')
    const { bytes } = files[0]
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid font cache bytes')
    total += bytes.byteLength
    if (bytes.byteLength < CACHE_HEADER_BYTES || total > OFFICE_FONT_CACHE_MAX_BYTES)
      throw new Error('Invalid font cache size')
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const directoryOffset = data.readInt32LE(12),
      fontsetOffset = data.readInt32LE(24)
    const subdirsOffset = data.readInt32LE(16),
      subdirsCount = data.readInt32LE(20)
    if (
      data.readUInt32LE(0) !== CACHE_MAGIC ||
      data.readInt32LE(4) !== CACHE_VERSION ||
      data.readInt32LE(8) !== data.length ||
      directoryOffset < CACHE_HEADER_BYTES ||
      directoryOffset >= data.length ||
      fontsetOffset < CACHE_HEADER_BYTES ||
      fontsetOffset > data.length - CACHE_FONTSET_BYTES ||
      subdirsCount < 0 ||
      subdirsCount > data.length / 4 ||
      (subdirsCount &&
        (subdirsOffset < CACHE_HEADER_BYTES || subdirsOffset + subdirsCount * 4 > data.length)) ||
      data.readInt32LE(28) !== Math.floor(mtime / 1000) ||
      // The pinned Emscripten stat ABI stores the millisecond remainder * 1000.
      data.readBigInt64LE(32) !== BigInt((mtime % 1000) * 1000)
    )
      throw new Error('Invalid Fontconfig cache header')
    const end = data.indexOf(0, directoryOffset)
    if (end < 0 || data.toString('utf8', directoryOffset, end) !== expected.path)
      throw new Error('Invalid Fontconfig cache directory')
  }
  return cache
}

export class OfficeFontCacheStore {
  constructor(
    private readonly directory: string,
    private readonly namespace: string,
    private readonly writer: (path: string) => DirectoryWriter = desktopDirectoryWriter
  ) {}

  private key(fingerprint: string): string {
    return digest(JSON.stringify([OFFICE_FONT_CACHE_SCHEMA, this.namespace, fingerprint]))
  }

  load(fingerprint: string): OfficeFontCache | null {
    try {
      const record = JSON.parse(
        readRecord(join(this.directory, CACHE_FILENAME), OFFICE_FONT_CACHE_MAX_BYTES * 2).toString(
          'utf8'
        )
      )
      if (
        record.schema !== OFFICE_FONT_CACHE_SCHEMA ||
        record.key !== this.key(fingerprint) ||
        !Array.isArray(record.files) ||
        record.files.length !== OFFICE_FONT_CACHE_ENTRIES.length
      )
        return null
      const files = record.files.map((file: { name: string; base64: string; sha256: string }) => {
        if (typeof file.base64 !== 'string') throw new Error('Invalid cache encoding')
        const bytes = Buffer.from(file.base64, 'base64')
        if (digest(bytes) !== file.sha256) throw new Error('Font cache checksum mismatch')
        return { name: file.name, bytes }
      })
      return validateFontCache({ files, directories: record.directories })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[office-font-cache] rejected record', String(error))
      return null
    }
  }

  save(fingerprint: string, value: unknown): void {
    const cache = validateFontCache(value)
    const record = {
      schema: OFFICE_FONT_CACHE_SCHEMA,
      key: this.key(fingerprint),
      directories: cache.directories,
      files: cache.files.map((file) => ({
        name: file.name,
        base64: Buffer.from(file.bytes).toString('base64'),
        sha256: digest(file.bytes),
      })),
    }
    const writer = this.writer(this.directory)
    try {
      writeJson(join(this.directory, CACHE_FILENAME), record)
    } finally {
      writer.close()
    }
  }
}
