#!/usr/bin/env node
// Cross-platform npm entry for Desktop package and release builds.
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DESKTOP = path.resolve(__dirname, '..')
const BUILD = path.join(__dirname, 'build.cjs')
const UPDATE_BASE_URL_ENV = 'SCHOLARSEED_UPDATE_BASE_URL'
const MACOS_TEAM_ID_ENV = 'SCHOLARSEED_MACOS_TEAM_ID'
const APPLE_TEAM_ID_ENV = 'APPLE_TEAM_ID'
const WINDOWS_PUBLISHER_ENV = 'SCHOLARSEED_WINDOWS_SIGN_PUBLISHER'
const CHECK_UPDATE_BASE_URL = 'https://updates.example.com/'
const COMMANDS = new Set(['check', 'package', 'release'])

function hostArch() {
  return process.arch === 'x64' ? 'x86_64' : process.arch
}

function value(name) {
  return String(process.env[name] || '').trim()
}

function required(name, description) {
  const result = value(name)
  if (!result) throw new Error(`${description} is required: set ${name}`)
  return result
}

function updateBaseUrl({ requiredForRelease }) {
  const configured = value(UPDATE_BASE_URL_ENV)
  if (configured) return configured
  if (!requiredForRelease) return CHECK_UPDATE_BASE_URL
  throw new Error(`release update base URL is required: set ${UPDATE_BASE_URL_ENV}`)
}

function releaseSigningArguments(platform) {
  if (platform === 'darwin') {
    const teamId = value(MACOS_TEAM_ID_ENV) || value(APPLE_TEAM_ID_ENV)
    if (!teamId) throw new Error(`macOS release signing requires ${MACOS_TEAM_ID_ENV} or ${APPLE_TEAM_ID_ENV}`)
    return ['--team-id', teamId]
  }
  if (platform === 'win32') {
    return ['--windows-publisher', required(WINDOWS_PUBLISHER_ENV, 'Windows publisher')]
  }
  throw new Error(`unsupported Desktop release platform: ${platform}`)
}

function buildArguments(command, extra = []) {
  const platform = process.platform
  const arch = hostArch()
  const common = ['--platform', platform, '--arch', arch]
  if (command === 'check') {
    return [
      '--type', 'release',
      ...common,
      '--stage', 'dir',
      '--candidate',
      '--update-base-url', updateBaseUrl({ requiredForRelease: false }),
      ...extra
    ]
  }
  if (command === 'package') {
    return ['--type', 'dev', ...common, '--stage', 'installer', ...extra]
  }
  if (command === 'release') {
    return [
      '--type', 'release',
      ...common,
      '--stage', 'installer',
      '--update-base-url', updateBaseUrl({ requiredForRelease: true }),
      ...releaseSigningArguments(platform),
      ...extra
    ]
  }
  throw new Error(`unknown package command: ${command}`)
}

function run(command, extra = []) {
  const args = buildArguments(command, extra)
  const result = spawnSync(process.execPath, [BUILD, ...args], {
    cwd: DESKTOP,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  return result.status || 0
}

function main(argv = process.argv.slice(2)) {
  const [command, ...extra] = argv
  if (!COMMANDS.has(command)) {
    throw new Error(`usage: node scripts/package.cjs ${[...COMMANDS].join('|')} [build options]`)
  }
  return run(command, extra)
}

module.exports = { buildArguments, updateBaseUrl, releaseSigningArguments, run }

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[package] ${error.message}`)
    process.exitCode = 1
  }
}
