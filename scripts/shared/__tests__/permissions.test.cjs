const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const security = require('../security.cjs')

const source = fs.readFileSync(path.join(__dirname, '../permissions.cjs'), 'utf8')

// A Windows process-boundary unit test; native ACL acceptance lives in lease.test.cjs.
function boundary(environment, execute) {
  const exports = { exports: {} }
  const dependencies = {
    'node:path': path.win32,
    'node:fs': {
      lstatSync: filename => ({
        isSymbolicLink: () => false,
        isFile: () => filename.endsWith('.exe'),
        isDirectory: () => !filename.endsWith('.exe')
      }),
      realpathSync: filename => filename
    },
    'node:child_process': { execFileSync: execute },
    './security.cjs': { ...security, recordDenial: () => {} }
  }
  vm.runInNewContext(source, {
    require: name => { assert.ok(name in dependencies); return dependencies[name] },
    module: exports, process: { env: environment }, Buffer
  })
  return exports.exports
}

for (const key of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
  test(`ACL child isolates inherited ${key} without changing its parent`, () => {
    const environment = {
      SystemRoot: 'C:\\Windows',
      [key]: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\untrusted',
      TEMP: 'C:\\Users\\runner\\Temp'
    }
    const original = { ...environment }
    let calls = 0
    boundary(environment, (executable, args, options) => {
      calls++
      assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      assert.equal(options.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
      assert.deepEqual(Object.keys(options.env).filter(name => name.toLowerCase() === 'psmodulepath'), ['PSModulePath'])
      assert.equal(options.env.TEMP, environment.TEMP)
      assert.equal(args[0], '-NoProfile')
      assert.equal(args[1], '-NonInteractive')
      const script = Buffer.from(args[3], 'base64').toString('utf16le')
      assert.ok(script.startsWith("$env:PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'\n"))
    }).assertWindowsPermissions('C:\\Users\\runner\\private')
    assert.equal(calls, 1)
    assert.deepEqual(environment, original)
  })
}

test('ACL child still propagates permission failures', () => {
  const failure = new Error('foreign private state owner')
  const permissions = boundary({ SystemRoot: 'C:\\Windows' }, () => { throw failure })
  assert.throws(() => permissions.assertWindowsPermissions('C:\\private'), error => error === failure)
})
