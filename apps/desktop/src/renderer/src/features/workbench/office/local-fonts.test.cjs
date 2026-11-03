const assert = require('node:assert/strict')
const test = require('node:test')

const {
  selectFontEntries,
  registerFontsInPreRun,
  readAllFontEntries,
  readFontAssets,
  readFontFiles,
} = require('./local-fonts.js')

test('physical files are read once in order, retain TTC bytes, and fail on missing files', async () => {
  const fonts = [{ id: 'collection', filename: 'shared.ttc' }, { id: 'bold', filename: 'bold.ttf' }]
  const calls = []
  const payload = new Uint8Array([116, 116, 99, 102, 1])
  const entries = await readFontFiles(fonts, async id => { calls.push(id); return payload }, () => {})
  assert.deepEqual(calls, ['collection', 'bold'])
  assert.equal(entries[0].bytes, payload)
  assert.equal(entries[0].filename, 'shared.ttc')
  await assert.rejects(readFontFiles(fonts, async () => { throw new Error('missing font') }), /missing font/)
})

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
    { family: 'PingFang SC', fullName: 'PingFang SC Regular', postscriptName: 'PingFangSC-Regular', blob: async () => { reads.push('PingFang SC'); return new Blob([new Uint8Array([0, 1, 0, 0, 1])]) } },
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

test('LibreOffice receives every authorized font before runtime startup', async () => {
  const writes = []
  const payloads = []
  const moduleConfig = { preRun: [], addRunDependency() {}, removeRunDependency() {} }
  const fonts = [
    { bytes: new Uint8Array([1]), filename: 'first.ttf' },
    { bytes: new Uint8Array([2]), filename: 'second.otf' },
  ]
  const filesystem = {
    mkdirTree(path) { writes.push(['mkdir', path]) },
    writeFile(path, bytes, options) {
      writes.push(['write', path, Array.from(bytes)])
      payloads.push({ bytes, options })
    },
  }

  const installed = registerFontsInPreRun(moduleConfig, fonts, { getFs: () => filesystem })
  moduleConfig.preRun[0]()
  await installed

  assert.deepEqual(writes, [
    ['mkdir', '/instdir/share/fonts/truetype'],
    ['write', '/instdir/share/fonts/truetype/first.ttf', [1]],
    ['write', '/instdir/share/fonts/truetype/second.otf', [2]],
  ])
  assert.equal(payloads.length, fonts.length)
  for (const [index, payload] of payloads.entries()) {
    assert.equal(payload.bytes, fonts[index].bytes)
    assert.deepEqual(payload.options, { canOwn: true })
  }
})

test('all unreadable declared fonts degrade to bundled fonts and preserve diagnostics', async () => {
  const failures = []
  const entries = await readAllFontEntries([
    { postscriptName: 'Unavailable', blob: async () => { throw new TypeError('native denied') } }
  ], undefined, (font, error) => failures.push([font.postscriptName, String(error)]))
  assert.deepEqual(entries, [])
  assert.deepEqual(failures, [['Unavailable', 'TypeError: native denied']])
})


test('identical font containers are retained once without skipping catalog reads', async () => {
  const reads = [], progress = []
  const collection = new Uint8Array([116, 116, 99, 102, 1, 2, 3, 4])
  const fonts = ['FaceA', 'FaceB'].map(postscriptName => ({
    postscriptName,
    blob: async () => { reads.push(postscriptName); return new Blob([collection]) }
  }))
  const result = await readAllFontEntries(fonts, (...values) => progress.push(values))
  assert.deepEqual(reads, ['FaceA', 'FaceB'])
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].bytes, collection)
  assert.deepEqual(progress, [[1, 2, 8], [2, 2, 16]])
})

test('different font bytes survive even when their digests collide', async (t) => {
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => new Uint8Array([0]).buffer)
  const fonts = [1, 2].map(value => ({
    postscriptName: 'SameName', blob: async () => new Blob([new Uint8Array([0, 1, 0, 0, value])])
  }))
  const result = await readAllFontEntries(fonts)
  assert.equal(result.length, 2)
  const writes = new Map()
  const moduleConfig = { addRunDependency() {}, removeRunDependency() {} }
  const installed = registerFontsInPreRun(moduleConfig, result, { getFs: () => ({
    mkdirTree() {},
    writeFile(path, bytes) { assert.equal(writes.has(path), false); writes.set(path, bytes) }
  }) })
  moduleConfig.preRun[0]()
  await installed
  assert.equal(writes.size, 2)
  assert.deepEqual([...writes.values()].map(bytes => bytes[4]), [1, 2])
})

for (const fontsFirst of [true, false]) {
  test(`font dependency blocks startup and installs once when ${fontsFirst ? 'fonts' : 'WASM'} is ready first`, async () => {
    let resolveFonts
    const fonts = new Promise(resolve => { resolveFonts = resolve })
    const events = []
    const moduleConfig = {
      addRunDependency(id) { events.push(['add', id]) },
      removeRunDependency(id) { events.push(['remove', id]) },
    }
    const installed = registerFontsInPreRun(moduleConfig, fonts, {
      getFs: () => ({ mkdirTree() {}, writeFile() { events.push(['write']) } }),
      onInstalled: () => events.push(['installed']),
    })
    if (fontsFirst) { resolveFonts([{ filename: 'font.ttf', bytes: new Uint8Array([1]) }]); await Promise.resolve() }
    assert.deepEqual(events, [])
    moduleConfig.preRun[0]()
    moduleConfig.preRun[0]()
    assert.deepEqual(events.map(event => event[0]), ['add'])
    if (!fontsFirst) resolveFonts([{ filename: 'font.ttf', bytes: new Uint8Array([1]) }])
    await installed
    assert.deepEqual(events.map(event => event[0]), ['add', 'write', 'installed', 'remove'])
    assert.equal(events[0][1], events.at(-1)[1])
  })
}

test('font preparation and FS failures never release an incomplete runtime', async () => {
  for (const sourceFails of [true, false]) {
    const failure = new Error(sourceFails ? 'font unavailable' : 'FS failed')
    let releases = 0
    const moduleConfig = { addRunDependency() {}, removeRunDependency() { releases++ } }
    const installed = registerFontsInPreRun(moduleConfig,
      sourceFails ? Promise.reject(failure) : [{ filename: 'font.ttf', bytes: new Uint8Array([1]) }], {
        getFs: () => ({ mkdirTree() { throw failure } }),
      })
    const rejected = assert.rejects(installed, failure)
    await Promise.resolve()
    moduleConfig.preRun[0]()
    await rejected
    assert.equal(releases, 0)
  }
})

test('disposing an old frame prevents its pending fonts from installing or releasing WASM', async () => {
  let resolveFonts, disposed = false
  const moduleConfig = { addRunDependency() {}, removeRunDependency() { assert.fail('disposed runtime released') } }
  const installed = registerFontsInPreRun(moduleConfig, new Promise(resolve => { resolveFonts = resolve }), {
    isDisposed: () => disposed,
    getFs: () => { assert.fail('disposed filesystem accessed') },
  })
  moduleConfig.preRun[0]()
  disposed = true
  resolveFonts([{ filename: 'font.ttf', bytes: new Uint8Array([1]) }])
  await installed
})


test('a container verification failure is not reported as an unreadable system font', async (t) => {
  const failure = new Error('digest unavailable')
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => { throw failure })
  const unavailable = []
  await assert.rejects(readAllFontEntries([
    { postscriptName: 'Readable', blob: async () => new Blob([new Uint8Array([0, 1, 0, 0])]) }
  ], undefined, (...values) => unavailable.push(values)), failure)
  assert.deepEqual(unavailable, [])
})

test('digest collisions preserve every changed byte across word and tail boundaries', async (t) => {
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => new Uint8Array([0]).buffer)
  for (const length of [1, 3, 4, 5, 7, 8, 9, 13]) {
    const original = new Uint8Array(length).fill(1)
    const payloads = [original, original.slice()]
    for (let offset = 0; offset < length; offset += 1) {
      const changed = original.slice()
      changed[offset] = 2
      payloads.push(changed)
    }
    const entries = await readAllFontEntries(payloads.map((bytes, index) => ({
      postscriptName: `Boundary-${length}-${index}`,
      blob: async () => new Blob([bytes]),
    })))
    assert.equal(entries.length, length + 1, `length ${length}`)
    assert.deepEqual(entries.map(entry => Array.from(entry.bytes)), [original, ...payloads.slice(2)].map(bytes => Array.from(bytes)))
  }
})

test('WASM installation failure reports operation, errno and completed bytes without font paths', async () => {
  const logs = []
  const error = Object.assign(new Error('C:\\Users\\secret\\private-font.ttf'), { name: 'ErrnoError', errno: 44 })
  let writes = 0
  const moduleConfig = { addRunDependency() {}, removeRunDependency() {} }
  const fonts = [
    { filename: 'private-font.ttf', bytes: new Uint8Array(8) },
    { filename: 'another-private-font.ttf', bytes: new Uint8Array(16) },
  ]
  const installed = registerFontsInPreRun(moduleConfig, Promise.resolve(fonts), {
    getFs: () => ({ mkdirTree() {}, writeFile() { if (++writes === 2) throw error } }),
    onDiagnostic: value => logs.push(value)
  })
  moduleConfig.preRun[0]()
  await assert.rejects(installed, value => value === error)
  assert.deepEqual(logs, [{ operation: 'wasm-write', errorName: 'ErrnoError', errno: 44,
    completedFonts: 1, completedBytes: 8, totalFonts: 2, attemptedBytes: 16 }])
  assert.ok(!JSON.stringify(logs).includes('private-font'))
})

test('source read failure remains the original error even when diagnostic logging fails', async () => {
  const error = Object.assign(new Error('secret'), { code: 'EACCES' })
  await assert.rejects(readFontFiles([{ id: 'private', filename: 'secret' }],
    async () => { throw error }, undefined, () => { throw new Error('sink') }), value => value === error)
})

test('font diagnostic rejects untrusted names and nonnumeric errno', () => {
  const { fontErrorDiagnostic } = require('./local-fonts.js')
  assert.deepEqual(fontErrorDiagnostic({ name: 'secret', errno: 'path', code: 'token' }), { errorName: 'unknown' })
})
