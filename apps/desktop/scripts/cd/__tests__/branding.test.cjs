const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const PE = require('pe-library')
const ResEdit = require('resedit')
const ts = require('typescript')
const PACKAGE = require('../../../package.json')
const { brandLauncher } = require('../branding.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const filename = path.join(root, 'ScholarSeed.exe')
  fs.writeFileSync(filename, Buffer.from(PE.NtExecutable.createEmpty(false).generate()))
  const options = { icon: path.resolve(sourceDirectory, '../../resources/windows.ico'),
    version: '0.2.0', productName: 'ScholarSeed', companyName: 'ScholarSeed' }
  return { filename, options }
}
test('PE branding writes and verifies resources', t => {
  const { filename, options } = fixture(t)
  brandLauncher(filename, options)
  const resources = PE.NtExecutableResource.from(PE.NtExecutable.from(fs.readFileSync(filename)))
  assert(resources.entries.some(entry => entry.type === 14))
  assert(resources.entries.some(entry => entry.type === 16))
})
test('packaging author metadata reaches launcher and uninstaller resources as a company name', context => {
  const source = ts.createSourceFile('build.cjs',
    fs.readFileSync(path.join(sourceDirectory, 'build.cjs'), 'utf8'), ts.ScriptTarget.Latest, true)
  const expressions = []
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'launcher' &&
        ts.isObjectLiteralExpression(node.initializer)) {
      const company = node.initializer.properties.find(property =>
        ts.isPropertyAssignment(property) && property.name.getText(source) === 'companyName')
      if (company) expressions.push(company.initializer.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(expressions.length, 1)
  const author = JSON.stringify(PACKAGE.author)
  const companyName = runInNewContext(expressions[0], { PACKAGE })
  assert.equal(typeof companyName, 'string')
  assert.equal(companyName, PACKAGE.author.name)
  for (const originalFilename of ['ScholarSeed.exe', 'Uninstall.exe']) {
    const { filename, options } = fixture(context)
    brandLauncher(filename, { ...options, version: PACKAGE.version,
      productName: PACKAGE.build.productName, companyName, originalFilename })
    const resources = PE.NtExecutableResource.from(PE.NtExecutable.from(fs.readFileSync(filename)))
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
    assert.equal(versions.length, 1)
    const values = versions[0].getStringValues({ lang: 1033, codepage: 1200 })
    assert.equal(values.CompanyName, PACKAGE.author.name)
    assert.equal(values.ProductName, PACKAGE.build.productName)
    assert.equal(values.OriginalFilename, originalFilename)
    assert.equal(values.FileVersion, `${PACKAGE.version}.0`)
    assert.equal(values.ProductVersion, `${PACKAGE.version}.0`)
    assert(resources.entries.some(entry => entry.type === 14))
  }
  assert.equal(JSON.stringify(PACKAGE.author), author)
})
test('failed write is not replayed and descriptor is closed', t => {
  const { filename, options } = fixture(t)
  const error = Object.assign(new Error('write failed'), { code: 'EBUSY' })
  const write = t.mock.method(fs, 'writeFileSync', () => { throw error })
  const close = t.mock.method(fs, 'closeSync')
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  assert.throws(() => brandLauncher(filename, options), e => e === error)
  assert.equal(write.mock.calls.length, 1)
  const fd = write.mock.calls[0].arguments[0]
  assert(close.mock.calls.some(call => call.arguments[0] === fd))
  assert(logs.some(line => line.includes('"stage":"branding.write"') && line.includes('"status":"failed"')))
})
test('invalid PE fails without writing or retrying', t => {
  const { filename, options } = fixture(t)
  fs.writeFileSync(filename, 'not a PE')
  const write = t.mock.method(fs, 'writeFileSync')
  assert.throws(() => brandLauncher(filename, options))
  assert.equal(write.mock.calls.length, 0)
})
