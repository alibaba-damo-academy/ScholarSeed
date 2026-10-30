// Build owner for the immutable Windows Electron component and thin program tree.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ensureArtifact } = require('../../../../scripts/shared/artifacts.cjs')
const { nativeTar } = require('../../../../scripts/shared/python.cjs')
const { sha256FileSync } = require('../../runtime/components.cjs')
const { sourceIdentity } = require('./compression.cjs')
const artifact = require('../../runtime/electron.json')
const pkg = require('../../package.json')

const ENGINE = 'ScholarSeedEngine.exe'
const BOOTSTRAP = path.join(__dirname, '../../runtime/electron')
async function prepare({runDirectory, platform, environment = process.env}) {
  if (platform !== 'win32') return null
  if (pkg.devDependencies.electron !== artifact.version) throw new Error('Electron artifact version differs from Desktop dependency')
  const archive = path.join(runDirectory, artifact.filename)
  await ensureArtifact(archive, artifact, {environment, platform})
  const root = path.join(runDirectory, 'electron')
  fs.mkdirSync(root)
  execFileSync(nativeTar(), ['-xf', archive, '-C', root], {env: environment, windowsHide: true})
  if (sha256FileSync(archive) !== artifact.sha256) throw new Error('Electron archive changed during preparation')
  // Renaming preserves upstream PE bytes and signatures; never brand or re-sign it.
  fs.renameSync(path.join(root, 'electron.exe'), path.join(root, ENGINE))
  fs.unlinkSync(path.join(root, 'resources', 'default_app.asar'))
  const bootstrap = path.join(root, 'resources', 'app')
  fs.mkdirSync(bootstrap)
  for (const filename of ['package.json', 'bootstrap.cjs']) {
    // Canonical LF bytes make the same reviewed component reproducible on Windows.
    fs.writeFileSync(path.join(bootstrap, filename), fs.readFileSync(path.join(BOOTSTRAP, filename), 'utf8').replaceAll('\r\n', '\n'), {flag: 'wx'})
  }
  return {version: artifact.version, root, archive, sourceSha256: artifact.sha256, contentId: sourceIdentity(root), entry: ENGINE}
}

function installApplication(application, frozen) {
  if (frozen.platform !== 'win32') return
  if (!frozen.electron || !frozen.launcher) throw new Error('Windows application requires frozen engine and launcher')
  if (!fs.statSync(path.join(application, 'resources', 'app.asar')).isFile()) throw new Error('Packaged application code is missing')
  // This is electron-builder's fresh output, never an installed/user directory.
  if (!path.resolve(application).startsWith(path.resolve(frozen.output) + path.sep)) throw new Error('Application is outside build output')
  for (const entry of fs.readdirSync(application)) {
    if (entry !== 'resources') fs.rmSync(path.join(application, entry), {recursive: true, force: false})
  }
  for (const name of ['ScholarSeed.exe', 'libvelopack.dll', 'LAUNCHER-GO-LICENSE.txt', 'Uninstall.exe']) {
    fs.copyFileSync(path.join(frozen.launcher.directory, name), path.join(application, name), fs.constants.COPYFILE_EXCL)
  }
}

module.exports = {prepare, installApplication, ENGINE}
