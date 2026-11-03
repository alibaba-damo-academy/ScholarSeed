#!/usr/bin/env node
// Cross-platform npm entry for Desktop package and release builds.
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DESKTOP = path.resolve(__dirname, '../..')
const BUILD = path.join(__dirname, 'build.cjs')
const UPDATE_BASE_URL_ENV = 'SCHOLARSEED_UPDATE_BASE_URL'
const MACOS_TEAM_ID_ENV = 'SCHOLARSEED_MACOS_TEAM_ID'
const APPLE_TEAM_ID_ENV = 'APPLE_TEAM_ID'
const WINDOWS_PUBLISHER_ENV = 'SCHOLARSEED_WINDOWS_SIGN_PUBLISHER'
const CHECK_UPDATE_BASE_URL = 'https://updates.example.com/'
const COMMANDS = new Set(['check', 'package', 'release'])
const CHANNELS = new Set(['preview', 'release'])

function distributionArguments(command, extra) {
  let channel = null
  const args = []
  for (let index = 0; index < extra.length; index += 1) {
    const argument = extra[index]
    if (argument === '--type' || argument.startsWith('--type=')) throw new Error('build type is owned by package command and channel')
    if (argument !== '--channel') { args.push(argument); continue }
    const selected = extra[++index]
    if (command === 'package' || channel || !CHANNELS.has(selected)) throw new Error('--channel preview|release is supported once by release or check only')
    channel = selected
  }
  return { channel: channel || 'release', args }
}

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
    if (!teamId)
      throw new Error(`macOS release signing requires ${MACOS_TEAM_ID_ENV} or ${APPLE_TEAM_ID_ENV}`)
    return ['--team-id', teamId]
  }
  if (platform === 'win32') {
    return ['--windows-publisher', required(WINDOWS_PUBLISHER_ENV, 'Windows publisher')]
  }
  throw new Error(`unsupported Desktop release platform: ${platform}`)
}

function buildArguments(command, extra = []) {
  const { channel, args } = distributionArguments(command, extra)
  const platform = process.platform
  const arch = hostArch()
  const common = ['--platform', platform, '--arch', arch]
  const activationKeys = value('SCHOLARSEED_UPDATE_ACTIVATION_PUBLIC_KEYS')
  if (activationKeys) common.push('--activation-public-keys', path.resolve(activationKeys))
  for (const [name, option] of [
    ['SCHOLARSEED_UPDATE_PAYLOAD_PUBLIC_KEYS', '--payload-public-keys'],
    ['SCHOLARSEED_UPDATE_PAYLOAD_ACTIVATION_PUBLIC_KEYS', '--payload-activation-public-keys'],
    ['SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY', '--payload-private-key'],
    ['SCHOLARSEED_UPDATE_PAYLOAD_COMPATIBILITY', '--payload-compatibility'],
    ['SCHOLARSEED_VPK', '--vpk'],
    ['SCHOLARSEED_VELOPACK_BASE', '--velopack-base'],
  ]) {
    if (value(name)) common.push(option, path.resolve(value(name)))
  }
  const payloadKeyId = value('SCHOLARSEED_UPDATE_PAYLOAD_KEY_ID')
  if (payloadKeyId) common.push('--payload-key-id', payloadKeyId)
  if (command === 'check') {
    return [
      '--type',
      channel,
      ...common,
      '--stage',
      'dir',
      '--candidate',
      '--update-base-url',
      updateBaseUrl({ requiredForRelease: false }),
      ...args,
    ]
  }
  if (command === 'package') {
    return ['--type', 'dev', ...common, '--stage', 'installer', ...args]
  }
  if (command === 'release') {
    return [
      '--type',
      channel,
      ...common,
      '--stage',
      'installer',
      '--update-base-url',
      updateBaseUrl({ requiredForRelease: true }),
      ...releaseSigningArguments(platform),
      ...args,
    ]
  }
  throw new Error(`unknown package command: ${command}`)
}

function run(command, extra = []) {
  const args = buildArguments(command, extra)
  const result = spawnSync(process.execPath, [BUILD, ...args], {
    cwd: DESKTOP,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

function main(argv = process.argv.slice(2)) {
  const [command, ...extra] = argv
  if (!COMMANDS.has(command)) {
    throw new Error(`usage: node scripts/cd/package.cjs ${[...COMMANDS].join('|')} [build options]`)
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
