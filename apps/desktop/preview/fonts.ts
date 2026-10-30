import manifest from '../src/renderer/public/fonts/sources.json' with { type: 'json' }
import { OFFICE_FONT_CACHE_ENTRIES, OFFICE_FONT_CACHE_MAX_BYTES, OFFICE_FONT_CACHE_SCHEMA } from '../src/fonts.ts'
import type { OfficeFontCache, OfficeFontCatalog } from '../src/fonts.ts'

const FONT_DIRECTORY = '/fonts/'
const FONT_POSTSCRIPT_NAME = 'NotoSansCJKsc-Regular'
const CACHE_HEADER_BYTES = 40
const CACHE_FONTSET_BYTES = 12
const CACHE_MAGIC = 0xfc02fc04
const CACHE_VERSION = 8
const FONT_DIGEST = 'SHA-256'
const CACHE_ERROR = 'Invalid preview Office font cache'

async function digest(bytes: Uint8Array): Promise<string> {
  const hashed = new Uint8Array(await crypto.subtle.digest(FONT_DIGEST, bytes.buffer as ArrayBuffer))
  return Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('')
}

function snapshot(value: OfficeFontCache): OfficeFontCache {
  return {
    files: value.files.map(file => ({ name: file.name, bytes: new Uint8Array(file.bytes) })),
    directories: value.directories.map(directory => ({ path: directory.path, mtime: directory.mtime })),
  }
}

function validateCache(value: OfficeFontCache): void {
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.directories)
    || value.files.length !== OFFICE_FONT_CACHE_ENTRIES.length || value.directories.length !== OFFICE_FONT_CACHE_ENTRIES.length) throw new Error(CACHE_ERROR)
  let total = 0
  for (const expected of OFFICE_FONT_CACHE_ENTRIES) {
    const files = value.files.filter(file => file?.name === expected.name)
    const directories = value.directories.filter(directory => directory?.path === expected.path)
    if (files.length !== 1 || directories.length !== 1) throw new Error(CACHE_ERROR)
    const { bytes } = files[0]
    const { mtime } = directories[0]
    if (!(bytes instanceof Uint8Array) || bytes.length < CACHE_HEADER_BYTES || !Number.isSafeInteger(mtime) || mtime <= 0 || mtime > Date.now()) throw new Error(CACHE_ERROR)
    total += bytes.byteLength
    if (total > OFFICE_FONT_CACHE_MAX_BYTES) throw new Error(CACHE_ERROR)
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const directoryOffset = data.getInt32(12, true)
    const fontsetOffset = data.getInt32(24, true)
    const subdirsOffset = data.getInt32(16, true)
    const subdirsCount = data.getInt32(20, true)
    if (data.getUint32(0, true) !== CACHE_MAGIC || data.getInt32(4, true) !== CACHE_VERSION || data.getInt32(8, true) !== bytes.length
      || directoryOffset < CACHE_HEADER_BYTES || directoryOffset >= bytes.length
      || fontsetOffset < CACHE_HEADER_BYTES || fontsetOffset > bytes.length - CACHE_FONTSET_BYTES
      || subdirsCount < 0 || subdirsCount > bytes.length / 4
      || (subdirsCount > 0 && (subdirsOffset < CACHE_HEADER_BYTES || subdirsOffset + subdirsCount * 4 > bytes.length))
      || data.getInt32(28, true) !== Math.floor(mtime / 1000)
      || data.getBigInt64(32, true) !== BigInt((mtime % 1000) * 1000)) throw new Error(CACHE_ERROR)
    const end = bytes.indexOf(0, directoryOffset)
    if (end < 0 || new TextDecoder().decode(bytes.subarray(directoryOffset, end)) !== expected.path) throw new Error(CACHE_ERROR)
  }
}

export function createPreviewFonts(request: typeof fetch, diagnostic?: (detail: { kind: string }) => void) {
  const id = `preview-bundled:${crypto.randomUUID()}`
  let prepared: Promise<{ bytes: Uint8Array; fingerprint: string }> | undefined
  let cached: OfficeFontCache | null = null
  const prepare = (): Promise<{ bytes: Uint8Array; fingerprint: string }> => {
    prepared ??= Promise.all([manifest.font, manifest.license].map(async asset => {
      const response = await request(FONT_DIRECTORY + asset.file, { credentials: 'omit', cache: 'force-cache' })
      if (!response.ok) throw new Error('Reviewed preview font asset unavailable')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (await digest(bytes) !== asset.sha256) throw new Error(`Preview font asset hash mismatch: ${asset.file}`)
      return bytes
    })).then(async ([bytes]) => {
      const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([OFFICE_FONT_CACHE_SCHEMA, manifest])))
      diagnostic?.({ kind: 'office-fonts-bundled-preview' })
      return { bytes, fingerprint }
    }).catch(error => { prepared = undefined; throw error })
    return prepared
  }
  const assertFingerprint = async (fingerprint: string): Promise<void> => {
    if (fingerprint !== (await prepare()).fingerprint) throw new Error('Unknown preview Office font fingerprint')
  }
  return {
    async requestOfficeFontAccess(): Promise<boolean> {
      try { await prepare(); return true }
      catch { diagnostic?.({ kind: 'office-fonts-bundled-unavailable' }); return false }
    },
    async listOfficeFonts(): Promise<OfficeFontCatalog> {
      const { fingerprint } = await prepare()
      return { fingerprint, faceCount: 1, fonts: [{ id, filename: manifest.font.file, postscriptNames: [FONT_POSTSCRIPT_NAME] }] }
    },
    async readOfficeFont(selected: string): Promise<Uint8Array> {
      if (selected !== id) throw new Error('Unknown preview font')
      return new Uint8Array((await prepare()).bytes)
    },
    async readOfficeFontCache(fingerprint: string): Promise<OfficeFontCache | null> {
      await assertFingerprint(fingerprint)
      return cached ? snapshot(cached) : null
    },
    async writeOfficeFontCache(fingerprint: string, value: OfficeFontCache): Promise<void> {
      await assertFingerprint(fingerprint)
      validateCache(value)
      cached = snapshot(value)
    },
  }
}
