const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')

test('native font benchmark loads its generated sibling module before the native boundary', async context => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'font-generation-'))
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const filename = path.resolve(__dirname, '../fonts.cjs')
  const ownerRequire = createRequire(filename)
  const nativeLibrary = path.join(temporary, 'fonts.node')
  const nativeBoundary = new Error('native enumeration is outside this generation contract')
  let generatedModule
  const benchmark = runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nnativeBenchmark`, {
    console,
    process: { ...process, argv: [process.execPath, filename, '--native-files',
      path.resolve(__dirname, '../../../src/main/fontfiles.ts'), path.join(temporary, 'result.json'), nativeLibrary] },
    require(name) {
      if (name === 'electron') return { app: { setPath() {}, whenReady: () => ({ then() {} }) } }
      if (name === 'node:os') return { ...os, tmpdir: () => temporary }
      if (name === 'node:http') return { createServer: () => ({}) }
      if (name === nativeLibrary) throw nativeBoundary
      const loaded = ownerRequire(name)
      if (path.basename(name) === 'fontfiles.cjs') generatedModule = loaded
      return loaded
    }
  }, { filename })
  await assert.rejects(benchmark(), error => error === nativeBoundary)
  assert.equal(typeof generatedModule.OfficeFontFiles, 'function')
  const generatedDirectory = path.join(temporary, fs.readdirSync(temporary)[0])
  assert.deepEqual(fs.readdirSync(generatedDirectory).sort(), ['fontcollection.cjs', 'fontfiles.cjs'])
})
