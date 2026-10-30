const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { nativeTar } = require('../../../scripts/shared/python.cjs')
const { ensureArtifact } = require('../../../scripts/shared/artifacts.cjs')

const VENDOR_RELATIVE = path.join('scripts', 'vendor', 'powershell')
const MANIFEST_NAME = 'manifest.json'
const BACKEND_DIRECTORY = 'backend'
const TREE_DIRECTORY = 'powershell'
const EXECUTABLE_NAME = 'pwsh.exe'
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ARCH_ALIASES = { x86_64: 'x64' }
const PROBE_TIMEOUT_MS = 30_000
const PROBE_SCRIPT = '"$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor).$($PSVersionTable.PSVersion.Patch)"'

class PowerShellProbeError extends Error {}

function vendorRoot(desktopRoot) {
  return path.resolve(desktopRoot, '..', '..', VENDOR_RELATIVE)
}

function artifact(desktopRoot, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${ARCH_ALIASES[arch] || arch}`
  if (key !== 'win32-x64') throw new Error(`bundled PowerShell supports Windows x64 only, got ${key}`)
  const document = JSON.parse(fs.readFileSync(path.join(vendorRoot(desktopRoot), MANIFEST_NAME), 'utf8'))
  const selected = document.targets?.[key]
  if (!VERSION_PATTERN.test(document.version) || !selected ||
      !SHA256_PATTERN.test(selected.sha256) || typeof selected.url !== 'string' ||
      !Number.isSafeInteger(selected.bytes) || selected.bytes <= 0 ||
      selected.entry !== `${TREE_DIRECTORY}/${EXECUTABLE_NAME}` || selected.machine !== 'x86_64') {
    throw new Error('PowerShell manifest metadata is invalid')
  }
  return {
    ...selected,
    version: document.version,
    source: document.source,
    archive: path.join(vendorRoot(desktopRoot), selected.archive)
  }
}

function parseProbeOutput(output, expectedVersion) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1 || lines[0] !== expectedVersion) {
    throw new PowerShellProbeError(`PowerShell probe mismatch: expected ${expectedVersion}, got ${JSON.stringify(lines)}`)
  }
  return { version: lines[0] }
}

function probe(executable, expectedVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.toNamespacedPath(executable), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', error => reject(new PowerShellProbeError(`PowerShell probe failed: ${error.message}`)))
    child.once('close', code => {
      if (code !== 0) {
        reject(new PowerShellProbeError(`PowerShell probe failed (${code}): ${stderr.slice(0, 500)}`))
        return
      }
      try {
        resolve(parseProbeOutput(stdout, expectedVersion))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function stagedRoot(resourcesRoot) {
  return path.join(resourcesRoot, BACKEND_DIRECTORY, TREE_DIRECTORY)
}

function stagedExecutable(resourcesRoot) {
  return path.join(stagedRoot(resourcesRoot), EXECUTABLE_NAME)
}

async function stageVerifiedPowerShell(backendDirectory, desktopRoot, platform = process.platform,
  arch = process.arch) {
  const selected = artifact(desktopRoot, platform, arch)
  await ensureArtifact(selected.archive, selected)
  const tree = path.join(backendDirectory, TREE_DIRECTORY)
  fs.mkdirSync(tree, { recursive: true })
  const result = spawnSync(path.toNamespacedPath(nativeTar(platform)), ['-xf', path.toNamespacedPath(selected.archive)], {
    cwd: path.toNamespacedPath(tree), encoding: 'utf8'
  })
  if (result.error || result.status !== 0) {
    throw new Error(`PowerShell archive extraction failed: ${result.stderr || result.error}`)
  }
  const executable = path.join(tree, EXECUTABLE_NAME)
  fs.accessSync(executable, fs.constants.X_OK)
  const reported = await probe(executable, selected.version)
  return { executable, root: tree, reported, sha256: selected.sha256, version: selected.version }
}

module.exports = {
  EXECUTABLE_NAME,
  PROBE_SCRIPT,
  PowerShellProbeError,
  TREE_DIRECTORY,
  artifact,
  parseProbeOutput,
  probe,
  stagedExecutable,
  stagedRoot,
  stageVerifiedPowerShell
}
