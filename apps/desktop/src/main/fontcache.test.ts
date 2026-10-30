import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OFFICE_FONT_CACHE_ENTRIES, type OfficeFontCache } from '../fonts.ts'
import { OfficeFontCacheStore, validateFontCache } from './fontcache.ts'

// Codec fixture only: the real generator and native consumer are tested in Electron.
function fixture(): OfficeFontCache {
  const mtime = 1700000000123
  return {
    directories: OFFICE_FONT_CACHE_ENTRIES.map((entry) => ({ path: entry.path, mtime })),
    files: OFFICE_FONT_CACHE_ENTRIES.map((entry) => {
      const bytes = Buffer.alloc(160)
      bytes.writeUInt32LE(0xfc02fc04, 0)
      bytes.writeUInt32LE(8, 4)
      bytes.writeInt32LE(bytes.length, 8)
      bytes.writeInt32LE(40, 12)
      bytes.writeInt32LE(128, 24)
      bytes.writeInt32LE(Math.floor(mtime / 1000), 28)
      bytes.writeBigInt64LE(BigInt((mtime % 1000) * 1000), 32)
      bytes.write(entry.path, 40)
      return { name: entry.name, bytes }
    }),
  }
}

test('Fontconfig record survives restart; font and engine changes are misses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'office-cache-'))
  try {
    const writer = () => ({ close() {} })
    const store = new OfficeFontCacheStore(directory, 'engine-a', writer)
    const cache = fixture()
    assert.equal(store.load('fonts-a'), null)
    store.save('fonts-a', cache)
    assert.deepEqual(new OfficeFontCacheStore(directory, 'engine-a', writer).load('fonts-a'), cache)
    assert.equal(store.load('fonts-b'), null)
    assert.equal(new OfficeFontCacheStore(directory, 'engine-b', writer).load('fonts-a'), null)
    const file = join(directory, 'cache.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.files[0].sha256 = '0'.repeat(64)
    writeFileSync(file, JSON.stringify(record))
    assert.equal(store.load('fonts-a'), null)
    writeFileSync(file, '{')
    assert.equal(store.load('fonts-a'), null)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('cache codec rejects PID temporary files, partial inventories, corrupt headers and timestamps', () => {
  const invalid = (change: (cache: OfficeFontCache) => void) => {
    const value = fixture()
    change(value)
    assert.throws(() => validateFontCache(value))
  }
  invalid((cache) => {
    cache.files[0].name += '.TMP-123'
  })
  invalid((cache) => {
    cache.files.pop()
  })
  invalid((cache) => {
    cache.files[1] = cache.files[0]
  })
  invalid((cache) => {
    cache.files[0].bytes[0] = 0
  })
  invalid((cache) => {
    cache.files[0].bytes = new Uint8Array([52, 50, 10])
  })
  invalid((cache) => {
    cache.directories[0].mtime = 0
  })
  invalid((cache) => {
    cache.directories[0].path = '/tmp/other'
  })
  invalid((cache) => {
    cache.directories[0].mtime += 1
  })
})
