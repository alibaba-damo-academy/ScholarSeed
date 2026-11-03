// Reviewed official Windows packaging tools, isolated from runner installations.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ensureArtifact, matches } = require('../../../../scripts/shared/artifacts.cjs')
const manifest = require('./vpk.json')
const cache = require('./cache.cjs')

const VERSION = manifest.version
const COMMAND_TIMEOUT = 120_000

function assertVersion(output) {
  if (!new RegExp(`Velopack(?: CLI)? ${VERSION.replaceAll('.', '\\.')}([, +\\r\\n]|$)`).test(String(output).trim()))
    throw new Error(`vpk must be exactly ${VERSION}`)
}

function invocation(prepared, args = {}, environment = process.env) {
  if (!prepared || prepared.version !== VERSION || !prepared.executable || !prepared.prefix?.length)
    throw new Error('Windows packaging requires prepared official Velopack tools')
  const selected = args.vpk || environment.SCHOLARSEED_VPK
  const tool = selected ? path.resolve(selected) : null
  const dll = tool && /\.dll$/i.test(tool)
  return {
    executable: tool && !dll ? tool : prepared.executable,
    prefix: tool ? (dll ? [tool] : []) : prepared.prefix,
    environment: { ...environment, ...prepared.environment },
  }
}

function check(command, execute = execFileSync) {
  assertVersion(execute(command.executable, [...command.prefix, '-h'], {
    env: command.environment, encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT,
  }))
}

async function prepare({ platform, stage, runDirectory, environment = process.env, args = {} },
  dependencies = {}) {
  if (platform !== 'win32' || stage === 'backend') return null
  const download = dependencies.ensureArtifact || ensureArtifact
  const execute = dependencies.execFileSync || execFileSync
  const directory = fs.mkdtempSync(path.join(runDirectory, 'velopack-tools-'))
  try {
    const archives = []
    const roots = {}
    const tar = path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    for (const artifact of manifest.archives) {
      const filename = path.join(directory, artifact.filename)
      await download(filename, artifact, { environment, platform })
      // Keep the same validation boundary for injected/prepopulated downloads.
      if (!await matches(filename, artifact)) throw new Error(`invalid official tool archive: ${artifact.filename}`)
      roots[artifact.name] = cache.expanded(filename, artifact, environment, destination =>
        execute(tar, ['-xf', filename, '-C', destination], {
          env: environment, windowsHide: true, timeout: COMMAND_TIMEOUT,
        }))
      archives.push({ path: filename, url: artifact.url, bytes: artifact.bytes, sha256: artifact.sha256 })
    }
    const dotnet = roots.dotnet
    const libc = { path: path.join(roots.libc, manifest.libc.file), ...manifest.libc }
    if (!await matches(libc.path, libc)) throw new Error('official Velopack C ABI library differs from reviewed artifact')
    const prepared = {
      version: VERSION, directory, executable: path.join(dotnet, 'dotnet.exe'),
      prefix: [path.join(roots.vpk, manifest.entrypoint)],
      environment: { DOTNET_ROOT: dotnet, DOTNET_ROOT_X64: dotnet, DOTNET_MULTILEVEL_LOOKUP: '0' },
      libc, archives,
    }
    // Validate the reviewed entrypoint even when a caller explicitly selects an override.
    check(invocation(prepared, {}, { ...environment, SCHOLARSEED_VPK: '' }), execute)
    if (args.vpk || environment.SCHOLARSEED_VPK) check(invocation(prepared, args, environment), execute)
    return prepared
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

module.exports = { VERSION, manifest, prepare, invocation, assertVersion, check }
