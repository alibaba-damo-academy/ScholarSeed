const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { runInNewContext } = require('node:vm')
const { collectConsoleScripts, writeConsoleScriptShells } = require('../bundle.cjs')

test('backend export resolves the moved verifier for both targets without changing its installed name', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bundle-path-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.resolve(__dirname, '../bundle.cjs')
  const ownerRequire = createRequire(filename)
  const repo = path.resolve(__dirname, '../../../../..')
  const uv = path.join(directory, 'uv.exe')
  fs.writeFileSync(uv, '')
  for (const platform of ['darwin', 'win32']) {
    const boundary = new Error('export invocation observed; no build executed')
    const loaded = { exports: {} }
    let observed
    runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: loaded, __dirname: path.dirname(filename), console, Buffer,
      process: { ...process, platform },
      require(name) {
        if (name === 'node:child_process') return {
          spawnSync(executable, args) {
            observed = { executable, args: Array.from(args) }
            assert.ok(fs.statSync(args[2]).isFile(), 'export helper must exist in the actual source tree')
            throw boundary
          }
        }
        return ownerRequire(name)
      }
    }, { filename })
    const pythonRelative = platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
    await assert.rejects(loaded.exports.bundle({ repo, resourceRoot: directory, runDirectory: directory },
      { pythonRelative }, { UV: uv }), error => error === boundary)
    assert.equal(observed.executable, path.join(directory, 'backend', pythonRelative))
    assert.deepEqual(observed.args.slice(0, 4), ['-I', '-B', path.join(repo, 'scripts/shared/dependencies.py'), 'export'])
    assert.equal(observed.args[observed.args.indexOf('--repo') + 1], repo)
    assert.equal(loaded.exports.VERIFIER_FILENAME, 'dependencies.py')
  }
})

function fixture(context, targets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-entrypoints-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const site = path.join(root, 'python', 'lib', 'python3.12', 'site-packages')
  for (const [index, target] of targets.entries()) {
    const distribution = path.join(site, `distribution${index}.dist-info`)
    fs.mkdirSync(distribution, { recursive: true })
    fs.writeFileSync(path.join(distribution, 'entry_points.txt'), `[console_scripts]\r\nmcp = ${target}\r\n`)
  }
  return { root, site }
}

test('console scripts parse optional extras and whitespace without changing the callable', context => {
  for (const target of ['mcp.cli:app', 'mcp.cli:app [cli]', 'mcp.cli : app[ cli, tls-extra ]', 'mcp.cli:app []']) {
    const { site } = fixture(context, [target])
    assert.deepEqual(collectConsoleScripts([site]), { mcp: { module: 'mcp.cli', function: 'app' } })
  }
})

test('console scripts compare duplicate callables independently of extras', context => {
  const { site } = fixture(context, ['mcp.cli:app [cli]', 'mcp.cli : app [other]'])
  assert.deepEqual(collectConsoleScripts([site]), { mcp: { module: 'mcp.cli', function: 'app' } })
  const conflicting = fixture(context, ['mcp.cli:app [cli]', 'mcp.cli:other [cli]'])
  assert.throws(() => collectConsoleScripts([conflicting.site]), /duplicate console_script mcp/)
})

test('console scripts still reject malformed references and extras', context => {
  for (const target of ['mcp.cli:app:other', 'mcp..cli:app', 'mcp.cli:app [cli] trailing',
    'mcp.cli:app [cli', 'mcp.cli:app [cli,,tls]', 'mcp.cli:app [cli;bad]',
    'mcp.cli:app [cli] [tls]', 'mcp.cli:app();bad', 'mcp.cli:app [-cli]']) {
    const { site } = fixture(context, [target])
    assert.throws(() => collectConsoleScripts([site]), /entry point/, target)
  }
})

test('console script launchers call the parsed function without extras', context => {
  for (const pythonRelative of ['python/bin/python3', 'python/python.exe']) {
    const { root, site } = fixture(context, ['mcp.cli:app [cli]'])
    if (pythonRelative.endsWith('.exe')) {
      const libraries = path.join(root, 'python', 'Lib')
      fs.mkdirSync(libraries, { recursive: true })
      fs.renameSync(site, path.join(libraries, 'site-packages'))
    }
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    writeConsoleScriptShells(path.join(root, pythonRelative), bin, { pythonRelative })
    const launcher = fs.readFileSync(path.join(bin, process.platform === 'win32' ? 'mcp.cmd' : 'mcp'), 'utf8')
    assert.ok(launcher.includes('from mcp.cli import app as _entry; sys.exit(_entry())'))
    assert.ok(!launcher.includes('[cli]'))
  }
})
