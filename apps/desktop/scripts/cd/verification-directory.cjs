// Shared private verification paths; keep this usable without Desktop npm dependencies.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { protectWindowsDirectory: protectWindowsVerificationDirectory } = require('../../../../scripts/shared/permissions.cjs')

const DARWIN_SHORT_TEMP_ROOT = '/private/tmp'

function artifactTemporaryRoot(platform = process.platform, runDirectory) {
  if (platform === 'win32') {
    if (typeof runDirectory !== 'string' || !path.isAbsolute(runDirectory))
      throw new Error('Windows package verification requires an absolute build run directory')
    return runDirectory
  }
  return platform === 'darwin' ? DARWIN_SHORT_TEMP_ROOT : os.tmpdir()
}


function createPackageCheckDirectory(frozen) {
  // A private leaf cannot make a shared Temp ancestor safe.
  // The CI may select a short root; native checks still validate every ancestor.
  // Keep component paths short enough for runtimes (including .NET) whose
  // internal APIs still impose MAX_PATH, even when CreateProcess accepts them.
  const buildRoot =
    frozen.platform === 'win32'
      ? frozen.verificationRoot || (frozen.repo ? path.join(frozen.repo, 'tmp') : frozen.runDirectory)
      : frozen.runDirectory
  const root = artifactTemporaryRoot(frozen.platform, buildRoot)
  if (frozen.platform === 'win32') fs.mkdirSync(root, { recursive: true })
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(root, frozen.platform === 'win32' ? 'v-' : 'ss-package-check-')))
  if (frozen.platform === 'win32') protectWindowsVerificationDirectory(directory)
  return directory
}

module.exports = { artifactTemporaryRoot, createPackageCheckDirectory, protectWindowsVerificationDirectory }
