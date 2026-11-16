const policy = require('../../apps/desktop/native/toolchain.json')

const DARWIN_PLATFORMS = Object.freeze({arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin', x86_64: 'x86_64-apple-darwin'})
const DEPLOYMENT_ENV = 'MACOSX_DEPLOYMENT_TARGET'
const PLATFORM_ENV = 'UV_PYTHON_PLATFORM'

function pythonEnvironment(environment, platform = process.platform, arch = process.arch) {
  const result = {...environment}
  if (platform !== 'darwin') return result
  const triple = DARWIN_PLATFORMS[arch]
  if (!triple) throw new Error(`unsupported Python architecture: ${arch}`)
  const minimum = policy.darwin.deploymentTarget
  if (result[DEPLOYMENT_ENV] && result[DEPLOYMENT_ENV] !== minimum)
    throw new Error('Python deployment target differs from product policy')
  if (result[PLATFORM_ENV] && result[PLATFORM_ENV] !== triple)
    throw new Error('Python platform differs from native architecture')
  return {...result, [DEPLOYMENT_ENV]: minimum, [PLATFORM_ENV]: triple}
}

function pythonPlatformArguments(environment, platform = process.platform, arch = process.arch) {
  const selected = pythonEnvironment(environment, platform, arch)
  return platform === 'darwin' ? ['--python-platform', selected[PLATFORM_ENV]] : []
}

module.exports = {pythonEnvironment, pythonPlatformArguments}
