import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { OFFICE_FONT_CACHE_ENTRIES, OFFICE_FONT_CACHE_MAX_BYTES } from '../src/fonts.ts'
import type { OfficeFontCache } from '../src/fonts.ts'
import { createPreviewFonts } from './fonts.ts'
import { createPreviewBridge } from './bridge.ts'
import { defaultRendererPreferences } from '../src/preferences.ts'

function assets(corrupt?: string) {
  const requests: string[] = []
  const request: typeof fetch = async input => {
    const path = String(input)
    requests.push(path)
    const name = path.split('/').pop()!
    const bytes = corrupt === name ? new TextEncoder().encode('unreviewed') : new Uint8Array(readFileSync(new URL(`../src/renderer/public/fonts/${name}`, import.meta.url)))
    return new Response(bytes.buffer as ArrayBuffer)
  }
  return { request, requests }
}

function cache(): OfficeFontCache {
  const mtime = Date.now()
  return {
    files: OFFICE_FONT_CACHE_ENTRIES.map(entry => {
      const bytes = new Uint8Array(160)
      const data = new DataView(bytes.buffer)
      data.setUint32(0, 0xfc02fc04, true)
      data.setInt32(4, 8, true)
      data.setInt32(8, bytes.length, true)
      data.setInt32(12, 40, true)
      data.setInt32(24, 128, true)
      data.setInt32(28, Math.floor(mtime / 1000), true)
      data.setBigInt64(32, BigInt((mtime % 1000) * 1000), true)
      bytes.set(new TextEncoder().encode(entry.path), 40)
      return { name: entry.name, bytes }
    }),
    directories: OFFICE_FONT_CACHE_ENTRIES.map(entry => ({ path: entry.path, mtime })),
  }
}

test('preview Office fonts verify reviewed bytes and license, expose opaque identity and never reread on catalog or transferred reads', async () => {
  const source = assets()
  const diagnostics: string[] = []
  const fonts = createPreviewFonts(source.request, detail => diagnostics.push(detail.kind))
  assert.equal(await fonts.requestOfficeFontAccess(), true)
  const catalog = await fonts.listOfficeFonts()
  assert.equal(catalog.faceCount, 1)
  assert.equal(catalog.fonts.length, 1)
  assert.equal(catalog.fonts[0].filename, 'NotoSansCJKsc-Regular.otf')
  assert.deepEqual(catalog.fonts[0].postscriptNames, ['NotoSansCJKsc-Regular'])
  assert.match(catalog.fonts[0].id, /^preview-bundled:/)
  const bytes = await fonts.readOfficeFont(catalog.fonts[0].id)
  assert.equal(bytes.byteLength, 16_437_364)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'OTTO')
  structuredClone(bytes, { transfer: [bytes.buffer] })
  assert.equal((await fonts.readOfficeFont(catalog.fonts[0].id)).byteLength, 16_437_364)
  catalog.fonts[0].postscriptNames[0] = 'mutated'
  assert.deepEqual((await fonts.listOfficeFonts()).fonts[0].postscriptNames, ['NotoSansCJKsc-Regular'])
  assert.equal(await fonts.requestOfficeFontAccess(), true)
  assert.equal(source.requests.length, 2)
  assert.deepEqual(diagnostics, ['office-fonts-bundled-preview'])
})

test('preview font failures and unknown IDs fail closed without system font authorization or arbitrary fetches', async () => {
  for (const name of ['NotoSansCJKsc-Regular.otf', 'OFL.txt']) {
    const source = assets(name)
    const fonts = createPreviewFonts(source.request)
    assert.equal(await fonts.requestOfficeFontAccess(), false)
    await assert.rejects(fonts.listOfficeFonts(), /hash mismatch/)
  }
  const source = assets()
  const fonts = createPreviewFonts(source.request)
  await assert.rejects(fonts.readOfficeFont('/Users/private/font.otf'), /Unknown preview font/)
  assert.deepEqual(source.requests, [])
})

test('preview Office font cache is one bounded fingerprint snapshot with defensive copies and strict inventory', async () => {
  const fonts = createPreviewFonts(assets().request)
  const other = createPreviewFonts(assets().request)
  const { fingerprint } = await fonts.listOfficeFonts()
  assert.equal(await fonts.readOfficeFontCache(fingerprint), null)
  const value = cache()
  await fonts.writeOfficeFontCache(fingerprint, value)
  value.files[0].bytes.fill(9)
  const saved = (await fonts.readOfficeFontCache(fingerprint))!
  assert.equal(saved.files[0].bytes[0], 4)
  saved.files[0].bytes.fill(8)
  saved.directories[0].path = '/Users/private'
  assert.equal((await fonts.readOfficeFontCache(fingerprint))!.files[0].bytes[0], 4)
  assert.equal(await other.readOfficeFontCache(fingerprint), null)
  await assert.rejects(fonts.readOfficeFontCache('stale'), /fingerprint/)
  await assert.rejects(fonts.writeOfficeFontCache(fingerprint, { files: [], directories: [] }), /cache/)
  const oversized = cache()
  oversized.files[0].bytes = new Uint8Array(OFFICE_FONT_CACHE_MAX_BYTES + 1)
  await assert.rejects(fonts.writeOfficeFontCache(fingerprint, oversized), /cache/)
  const traversal = cache()
  traversal.files[0].name = '../outside'
  await assert.rejects(fonts.writeOfficeFontCache(fingerprint, traversal), /cache/)
  const invalidHeader = cache()
  invalidHeader.files[0].bytes[0] = 0
  await assert.rejects(fonts.writeOfficeFontCache(fingerprint, invalidHeader), /cache/)
  assert.equal((await fonts.readOfficeFontCache(fingerprint))!.files[0].bytes[0], 4)
})

test('explicit reviewed font fixtures do not grant native filesystem actions', async () => {
  const source = assets()
  const bridge = createPreviewBridge({ instance: 'fonts-tab', scene: 'viewer-office', preferences: defaultRendererPreferences('en'), request: source.request, fonts: createPreviewFonts(source.request) })
  assert.equal(await bridge.requestOfficeFontAccess(), true)
  const catalog = await bridge.listOfficeFonts()
  assert.equal((await bridge.readOfficeFont(catalog.fonts[0].id)).byteLength, 16_437_364)
  assert.equal((await bridge.openPath('/Users/private')).ok, false)
  assert.equal((await bridge.revealPath('/Users/private')).ok, false)
  assert.equal(source.requests.length, 2)
})
