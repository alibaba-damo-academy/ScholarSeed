const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')
const { verifyClosure, verifyAsarClosure } = require('./closure.cjs')

function entries(main) {
  return new Map([['out/main/index.js', main], ['out/preload/index.js', 'require("electron")']])
}

test('compiled entry closure accepts host modules and real local chunks, not string lookalikes', () => {
  const files = entries('require("node:fs"); require("./chunk.js"); const script = "ObjC.import(123)";')
  files.set('out/main/chunk.js', 'module.exports = require("path")')
  files.set('out/main/unused.json', '{}')
  const evidence = verifyClosure(files)
  assert.deepEqual(evidence.external_modules, [])
  assert.deepEqual(evidence.host_modules, ['electron', 'node:fs', 'path'])
  assert.equal(evidence.entries.length, 3)
  const jsonFiles = entries('require("./config.json")')
  jsonFiles.set('out/main/config.json', '{}')
  assert.equal(verifyClosure(jsonFiles).files.length, 3)
  const nativeFiles = entries('require("./addon.node")')
  nativeFiles.set('out/main/addon.node', 'fixture')
  assert.throws(() => verifyClosure(nativeFiles), /missing or escaped/)
})

test('compiled entry closure fails on external, non-literal and missing dependencies', () => {
  for (const code of ['require("react")', 'import "react"', 'export * from "react"']) {
    assert.throws(() => verifyClosure(entries(code)), /external npm/)
  }
  for (const code of ['require(variable)', 'import(variable)', 'module.require(variable)']) {
    assert.throws(() => verifyClosure(entries(code)), /non-literal/)
  }
  for (const code of ['require("./missing")', 'import "../../escape.js"']) {
    assert.throws(() => verifyClosure(entries(code)), /missing or escaped/)
  }
  assert.throws(() => verifyClosure(new Map()), /missing compiled/)
  for (const code of ['const load=require; load("left-pad")', 'module["require"]("left-pad")',
    '(require)("left-pad")', 'const {createRequire}=require("node:module"); createRequire(__filename)("left-pad")']) {
    assert.throws(() => verifyClosure(entries(code)), /aliased|indirect|dynamic/)
  }
})

test('compiled entry closure only flags unshadowed CommonJS module access', () => {
  const local = `function f(module) { return module.type }
    const add = (module) => module.name
    function g() { var module = {}; return module.custom }
    { let module = {}; module.exports = 1 }
    var outer = {}
    function h() { var module = function () {}; return module.custom }`
  assert.doesNotThrow(() => verifyClosure(entries(local)))
  assert.doesNotThrow(() => verifyClosure(entries('module.exports = 1; module.require("path")')))
  assert.doesNotThrow(() => verifyClosure(entries('if (require.main === module) { main(process.argv.slice(2)) }')))
  assert.doesNotThrow(() => verifyClosure(entries('var exports = module.exports === module.exports && module === module')))
  assert.throws(() => verifyClosure(entries('module.filename')), /indirect/)
  assert.throws(() => verifyClosure(entries('function g() { return module.id }')), /indirect/)
  assert.throws(() => verifyClosure(entries('try { } catch (err) { module.foo(err) }')), /indirect/)
  assert.throws(() => verifyClosure(entries('module["exports"]')), /indirect/)
  assert.throws(() => verifyClosure(entries('const load = require; load("left-pad")')), /aliased/)
})

test('exact asar is checked for duplicate renderer, npm and unpacked assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-closure-'))
  try {
    for (const [index, extra] of ['', 'node_modules/pkg/index.js', 'out/renderer/index.html'].entries()) {
      const source = path.join(root, `source-${index}`)
      const output = path.join(root, `output-${index}`)
      fs.mkdirSync(output)
      const files = entries('require("electron")')
      files.set('package.json', '{"main":"out/main/index.js"}')
      if (extra) files.set(extra, 'fixture')
      for (const [name, content] of files) {
        fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true })
        fs.writeFileSync(path.join(source, name), content)
      }
      await asar.createPackage(source, path.join(output, 'app.asar'))
      if (extra) assert.throws(() => verifyAsarClosure(output), /duplicate/)
      else {
        assert.equal(verifyAsarClosure(output).entries.length, 2)
        fs.mkdirSync(path.join(output, 'app.asar.unpacked'))
        fs.writeFileSync(path.join(output, 'app.asar.unpacked/extra.node'), 'fixture')
        assert.throws(() => verifyAsarClosure(output), /unpacked/)
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})
