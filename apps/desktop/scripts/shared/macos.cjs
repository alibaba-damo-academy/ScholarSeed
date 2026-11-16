const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const policy = require('../../native/toolchain.json')

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca])
const HEADER_BYTES = 4
const INSPECTION_TIMEOUT_MS = 30_000
const OTOOL = '/usr/bin/otool'
const MACOS_PLATFORM = '1'

function parseMinimumVersions(output) {
  const versions = []
  let command, selectedPlatform
  for (const line of output.split(/\r?\n/)) {
    const selected = line.match(/^\s*cmd\s+(LC_\w+)/)
    if (selected) {command = selected[1]; selectedPlatform = null}
    const platform = line.match(/^\s*platform\s+(\d+)\s*$/)
    if (command === 'LC_BUILD_VERSION' && platform && platform[1] !== MACOS_PLATFORM)
      throw new Error('native payload is not macOS')
    if (platform) selectedPlatform = platform[1]
    const pattern = command === 'LC_BUILD_VERSION'
      ? /^\s*minos\s+(\d+\.\d+(?:\.\d+)?)\s*$/
      : command === 'LC_VERSION_MIN_MACOSX' ? /^\s*version\s+(\d+\.\d+(?:\.\d+)?)\s*$/ : null
    const version = pattern && line.match(pattern)
    if (version) {
      if (command === 'LC_BUILD_VERSION' && selectedPlatform !== MACOS_PLATFORM)
        throw new Error('Mach-O platform is missing')
      versions.push(version[1])
    }
  }
  if (!versions.length) throw new Error('Mach-O minimum macOS version is missing')
  return versions
}

function newer(actual, minimum) {
  const source = actual.split('.').map(Number), target = minimum.split('.').map(Number)
  return ([0, 1, 2].map(index => (source[index] || 0) - (target[index] || 0)).find(value => value !== 0) || 0) > 0
}

function verifyMachO(filename, minimum = policy.darwin.deploymentTarget, runner = execFileSync) {
  const descriptor = fs.openSync(filename, 'r'), header = Buffer.alloc(HEADER_BYTES)
  let bytes
  try {bytes = fs.readSync(descriptor, header, 0, HEADER_BYTES, 0)} finally {fs.closeSync(descriptor)}
  if (bytes !== HEADER_BYTES || !MACHO_MAGICS.has(header.readUInt32BE())) return null
  const minimums = parseMinimumVersions(runner(OTOOL, ['-l', filename], {encoding: 'utf8', timeout: INSPECTION_TIMEOUT_MS}))
  for (const version of minimums) {
    if (newer(version, minimum)) throw new Error(`${filename} requires macOS ${version}, product supports ${minimum}`)
  }
  return {minimums}
}

function verifyMacOSTree(directory) {
  const root = fs.realpathSync(directory), visited = new Set(), files = []
  const scan = filename => {
    const resolved = fs.realpathSync(filename)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('native inspection path escapes artifact')
    if (visited.has(resolved)) return
    visited.add(resolved)
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(resolved)) scan(path.join(resolved, name))
    } else if (stat.isFile()) {
      const record = verifyMachO(resolved)
      if (record) files.push({path: path.relative(root, resolved).split(path.sep).join('/'), ...record})
    } else throw new Error('unsupported native inspection entry')
  }
  scan(root)
  return {minimum: policy.darwin.deploymentTarget, files}
}

module.exports = {parseMinimumVersions, verifyMachO, verifyMacOSTree}
