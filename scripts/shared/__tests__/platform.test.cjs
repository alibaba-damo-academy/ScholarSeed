const test = require('node:test')
const assert = require('node:assert/strict')
const { pythonEnvironment, pythonPlatformArguments } = require('../platform.cjs')
const policy = require('../../../apps/desktop/native/toolchain.json')

test('macOS dependency selection and native compilation share the product floor', () => {
  for (const [arch, triple] of [['arm64', 'aarch64-apple-darwin'], ['x64', 'x86_64-apple-darwin'], ['x86_64', 'x86_64-apple-darwin']]) {
    const input = {PATH: 'preserved'}
    const actual = pythonEnvironment(input, 'darwin', arch)
    assert.equal(actual.MACOSX_DEPLOYMENT_TARGET, policy.darwin.deploymentTarget)
    assert.equal(actual.UV_PYTHON_PLATFORM, triple)
    assert.deepEqual(pythonPlatformArguments(input, 'darwin', arch), ['--python-platform', triple])
    assert.equal(actual.PATH, input.PATH)
    assert.deepEqual(input, {PATH: 'preserved'})
  }
})

test('conflicting deployment targets and unsupported native architectures fail closed', () => {
  assert.throws(() => pythonEnvironment({MACOSX_DEPLOYMENT_TARGET: '14.0'}, 'darwin', 'arm64'), /deployment target/)
  assert.throws(() => pythonEnvironment({UV_PYTHON_PLATFORM: 'x86_64-apple-darwin'}, 'darwin', 'arm64'), /Python platform/)
  assert.throws(() => pythonEnvironment({}, 'darwin', 'unknown'), /architecture/)
})

test('Windows and CI environment semantics remain native and unchanged', () => {
  const input = {PATH: 'native', VCToolsVersion: 'reviewed'}
  assert.deepEqual(pythonEnvironment(input, 'win32', 'x64'), input)
  assert.deepEqual(pythonEnvironment(input, 'linux', 'x64'), input)
  assert.deepEqual(pythonPlatformArguments(input, 'win32', 'x64'), [])
})
