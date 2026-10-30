const sourceDirectory = require('node:path').dirname(__dirname)
// Routing contracts with a mock signer; this is not formal signing acceptance.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const source = fs.readFileSync(path.join(sourceDirectory, 'velopack-sign.cjs'), 'utf8')

async function route(filename, { trusted = false, ci = true } = {}) {
  const signed = []
  const module = { exports: {} }
  const requireMock = name => {
    if (name === 'node:path') return path
    if (name === './windows-sign.cjs') return {
      verify() { if (!trusted) throw new Error('unsigned fixture') },
      async signFile(file) { signed.push(file) },
    }
    throw new Error(`unexpected dependency: ${name}`)
  }
  runInNewContext(source, { require: requireMock, module, console,
    process: { argv: ['node', 'velopack-sign.cjs', filename], env: { CI: String(ci) } } })
  await module.exports.main()
  return signed
}

test('Velopack signs generated updater, localized stub and personal Setup', async () => {
  for (const name of ['Uninstall.exe', 'Squirrel.exe', '书深_ExecutionStub.exe', 'Update.exe', 'ScholarSeed.exe', 'scholarseed-win-Setup.exe']) {
    const filename = `C:/build/PreprocessPackDirWin/${name}`
    assert.deepEqual(await route(filename), [filename])
    assert.deepEqual(await route(filename, { trusted: true }), [])
  }
  assert.deepEqual(await route('C:/build/scholarseed.msi'), [])
})

test('Velopack signing preserves vendor resources and requires CI', async () => {
  for (const filename of ['C:/app/resources/Squirrel.exe', 'C:/app/resources/书深_ExecutionStub.exe', 'C:/app/python/python.exe', 'C:/app/texlive/bin/windows/tex.exe', 'C:/app/powershell/pwsh.exe'])
    assert.deepEqual(await route(filename), [])
  await assert.rejects(route('C:/build/Squirrel.exe', { ci: false }), /CI-only/)
})
