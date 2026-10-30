const { Arch, Platform } = require('electron-builder')

// `archType` is the canonical published architecture name used by the update
// service, the OSS layout and the installer file name. It is lowercase everywhere
// and is deliberately not the Node platform/arch spelling: Windows publishes as
// `windows-amd64` even though Node calls the same target `win32`/`x64`.
const TARGETS = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    triple: 'aarch64-apple-darwin',
    archType: 'darwin-arm64',
    builderPlatform: Platform.MAC,
    builderArch: Arch.arm64,
    installer: 'dmg',
    pythonRelative: 'python/bin/python3',
    codexRelative: 'codex-runtime/bin/codex',
    ripgrepName: 'rg',
    icon: 'resources/icon.icns'
  },
  'darwin-x86_64': {
    platform: 'darwin',
    arch: 'x86_64',
    triple: 'x86_64-apple-darwin',
    archType: 'darwin-x86_64',
    builderPlatform: Platform.MAC,
    builderArch: Arch.x64,
    installer: 'dmg',
    pythonRelative: 'python/bin/python3',
    codexRelative: 'codex-runtime/bin/codex',
    ripgrepName: 'rg',
    icon: 'resources/icon.icns'
  },
  'win32-x86_64': {
    platform: 'win32',
    arch: 'x86_64',
    triple: 'x86_64-pc-windows-msvc',
    archType: 'windows-amd64',
    builderPlatform: Platform.WINDOWS,
    builderArch: Arch.x64,
    installer: 'velopack',
    pythonRelative: 'python/python.exe',
    codexRelative: 'codex-runtime/bin/codex.exe',
    ripgrepName: 'rg.exe',
    icon: 'resources/windows.ico'
  }
}

function hostArch() {
  return process.arch === 'x64' ? 'x86_64' : process.arch
}

function target(platform, arch) {
  const result = TARGETS[`${platform}-${arch}`]
  if (!result) throw new Error(`unsupported desktop target: ${platform}/${arch}`)
  return result
}

module.exports = { TARGETS, hostArch, target }
