import { createHash, randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { NativeFontFace, OfficeFontCatalog } from '../fonts'
import { fontPostscriptNames, selectFontCollection } from './fontcollection.ts'

interface FontSource {
  path: string
  identity: BigIntStats
  selectionNames: string[]
  faceIndices?: number[]
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

/** Catalogs hold metadata only; renderer never supplies paths or caches font bytes in main. */
export class OfficeFontFiles {
  private sources = new Map<string, FontSource>()
  private pending: Promise<OfficeFontCatalog> | undefined
  private fingerprint = ''
  constructor(private readonly enumerate: () => Promise<NativeFontFace[]>) {}

  catalog(): Promise<OfficeFontCatalog> {
    this.pending ??= this.enumerateCatalog().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async enumerateCatalog(): Promise<OfficeFontCatalog> {
    const sources = new Map<string, FontSource>()
    const byIdentity = new Map<string, OfficeFontCatalog['fonts'][number]>()
    const byPath = new Map<string, OfficeFontCatalog['fonts'][number]>()
    const names = new Set<string>()
    const previous = new Map(
      [...this.sources].map(([id, source]) => [
        `${source.identity.dev}:${source.identity.ino}`,
        { id, ...source },
      ])
    )
    const faces = await this.enumerate()
    faces.sort((left, right) =>
      left.postscriptName < right.postscriptName
        ? -1
        : left.postscriptName > right.postscriptName
          ? 1
          : 0
    )
    for (const face of faces) {
      names.add(face.postscriptName)
      let font = byPath.get(face.path)
      if (!font) {
        const path = await realpath(face.path)
        const identity = await stat(path, { bigint: true })
        if (!identity.isFile()) throw new Error('Office font source is not a file')
        const key = `${identity.dev}:${identity.ino}`
        font = byIdentity.get(key)
        if (!font) {
          const existing = previous.get(key)
          const id = existing && sameFile(existing.identity, identity) ? existing.id : randomUUID()
          font = { id, filename: basename(path), postscriptNames: [] }
          byIdentity.set(key, font)
          sources.set(font.id, { path, identity, selectionNames: [] })
        }
        byPath.set(face.path, font)
      }
      if (font.postscriptNames.includes(face.postscriptName)) continue
      font.postscriptNames.push(face.postscriptName)
      const source = sources.get(font.id)!
      if (face.faceIndex !== undefined) {
        source.faceIndices ??= []
        if (!source.faceIndices.includes(face.faceIndex)) source.faceIndices.push(face.faceIndex)
      } else if (face.nameTable) {
        source.selectionNames.push(...fontPostscriptNames(face.nameTable))
      } else {
        source.selectionNames.push(face.postscriptName)
      }
    }
    if (!byIdentity.size) throw new Error('Office font catalog is empty')
    this.sources = sources
    const fonts = [...byIdentity.values()]
    // Installation order and TTC selection are part of the identity. Opaque IDs
    // only authorize reads in this process and must never enter persistent keys.
    const identity = fonts.map((font) => {
      const source = sources.get(font.id)!
      const { dev, ino, size, mtimeNs, ctimeNs } = source.identity
      return [
        source.path,
        ...[dev, ino, size, mtimeNs, ctimeNs].map(String),
        font.filename,
        font.postscriptNames,
        [...new Set(source.selectionNames)].sort(),
        source.faceIndices?.slice().sort((a, b) => a - b),
      ]
    })
    this.fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    return { fingerprint: this.fingerprint, faceCount: names.size, fonts }
  }

  assertFingerprint(value: unknown): asserts value is string {
    if (!this.fingerprint || value !== this.fingerprint)
      throw new Error('Unknown or stale Office font snapshot')
  }

  async read(id: string): Promise<Uint8Array> {
    const source = this.sources.get(id)
    if (!source) throw new Error('Unknown Office font')
    const file = await open(source.path, 'r')
    try {
      if (!sameFile(source.identity, await file.stat({ bigint: true })))
        throw new Error('Office font changed before reading')
      const bytes = await file.readFile()
      if (
        !sameFile(source.identity, await file.stat({ bigint: true })) ||
        BigInt(bytes.length) !== source.identity.size
      ) {
        throw new Error('Office font changed while reading')
      }
      return selectFontCollection(bytes, source.selectionNames, source.faceIndices)
    } finally {
      await file.close()
    }
  }
}
