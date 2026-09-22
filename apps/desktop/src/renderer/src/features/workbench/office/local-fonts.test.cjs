const assert = require('node:assert/strict')
const test = require('node:test')

const {
  selectFontEntries,
  registerFontsInPreRun,
  readAllFontEntries,
  readFontAssets,
} = require('./local-fonts.js')

test('runtime default font assets are loaded independently from system font discovery', async () => {
  const requests = []
  const assets = await readFontAssets([
    { filename: 'NotoSansCJKsc-Regular.otf', url: 'https://office.invalid/fonts/NotoSansCJKsc-Regular.otf' },
  ], async (url) => {
    requests.push(url)
    return { ok: true, arrayBuffer: async () => new Uint8Array([79, 84, 84, 79]).buffer }
  })

  assert.deepEqual(requests, ['https://office.invalid/fonts/NotoSansCJKsc-Regular.otf'])
  assert.equal(assets.length, 1)
  assert.equal(assets[0].filename, 'NotoSansCJKsc-Regular.otf')
  assert.deepEqual(Array.from(assets[0].bytes), [79, 84, 84, 79])
})

test('a missing runtime default font is a startup failure', async () => {
  await assert.rejects(
    readFontAssets([{ filename: 'required.otf', url: 'https://office.invalid/required.otf' }], async () => ({ ok: false, status: 404 })),
    /required\.otf.*404/
  )
})

test('only declared font families are selected and unrelated blobs are never read', async () => {
  const reads = []
  const fonts = [
    { family: 'Aptos', fullName: 'Aptos Regular', postscriptName: 'Aptos-Regular', blob: async () => { reads.push('Aptos'); return new Blob([new Uint8Array([0, 1, 0, 0])]) } },
    { family: 'PingFang SC', fullName: 'PingFang SC Regular', postscriptName: 'PingFangSC-Regular', blob: async () => { reads.push('PingFang SC'); return new Blob([new Uint8Array([0, 1, 0, 0])]) } },
    { family: 'Unrelated', fullName: 'Unrelated Bold', postscriptName: 'Unrelated-Bold', blob: async () => { reads.push('Unrelated'); return new Blob([new Uint8Array([0, 1, 0, 0])]) } },
  ]

  const selection = selectFontEntries(fonts, ['aptos', 'PingFang SC', 'Missing'])
  const result = await readAllFontEntries(selection.fonts)

  assert.deepEqual(selection.matched, ['aptos', 'PingFang SC'])
  assert.deepEqual(selection.missing, ['Missing'])
  assert.deepEqual(reads, ['Aptos', 'PingFang SC'])
  assert.equal(result.length, 2)
})

test('an empty declaration selects and reads no system fonts', async () => {
  const selection = selectFontEntries([
    { family: 'Unrelated', blob: async () => { assert.fail('unrelated blob read') } },
  ], [])
  assert.deepEqual(selection, { fonts: [], matched: [], missing: [] })
  assert.deepEqual(await readAllFontEntries(selection.fonts), [])
})

test('an inaccessible system font does not discard other readable fonts', async () => {
  const failures = []
  const result = await readAllFontEntries([
    { postscriptName: 'Unavailable', blob: async () => { throw new TypeError('unavailable') } },
    { postscriptName: 'Readable', blob: async () => new Blob([new Uint8Array([0, 1, 0, 0])]) },
  ], undefined, (font, error) => failures.push([font.postscriptName, String(error)]))
  assert.equal(result.length, 1)
  assert.equal(result[0].filename, 'Readable.ttf')
  assert.equal(failures.length, 1)
  assert.deepEqual(await readAllFontEntries([], undefined), [])
})

test('system font reads report cumulative byte progress', async () => {
  const progress = []
  await readAllFontEntries([
    { postscriptName: 'First', blob: async () => new Blob([new Uint8Array([0, 1, 0, 0])]) },
    { postscriptName: 'Second', blob: async () => new Blob([new Uint8Array([79, 84, 84, 79, 1])]) }
  ], (done, total, loadedBytes) => progress.push([done, total, loadedBytes]))

  assert.deepEqual(progress, [[1, 2, 4], [2, 2, 9]])
})

test('LibreOffice receives every authorized font before runtime startup', () => {
  const writes = []
  const moduleConfig = { preRun: [] }
  const fonts = [
    { bytes: new Uint8Array([1]), filename: 'first.ttf' },
    { bytes: new Uint8Array([2]), filename: 'second.otf' },
  ]
  const filesystem = {
    mkdirTree(path) { writes.push(['mkdir', path]) },
    writeFile(path, bytes) { writes.push(['write', path, Array.from(bytes)]) },
  }

  registerFontsInPreRun(moduleConfig, fonts, () => filesystem)
  moduleConfig.preRun[0]()

  assert.deepEqual(writes, [
    ['mkdir', '/instdir/share/fonts/truetype'],
    ['write', '/instdir/share/fonts/truetype/first.ttf', [1]],
    ['write', '/instdir/share/fonts/truetype/second.otf', [2]],
  ])
})

test('all unreadable declared fonts degrade to bundled fonts and preserve diagnostics', async () => {
  const failures = []
  const entries = await readAllFontEntries([
    { postscriptName: 'Unavailable', blob: async () => { throw new TypeError('native denied') } }
  ], undefined, (font, error) => failures.push([font.postscriptName, String(error)]))
  assert.deepEqual(entries, [])
  assert.deepEqual(failures, [['Unavailable', 'TypeError: native denied']])
})
