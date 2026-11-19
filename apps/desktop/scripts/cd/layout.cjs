const fs = require('node:fs')
const path = require('node:path')

const APPLICATION_LAYOUT = Object.freeze({ asar: 'asar', directory: 'directory' })
const DEFAULT_APP_ARCHIVE = 'default_app.asar'
const ASAR_EXTENSION = '.asar'

function applicationLayout(resources, format = APPLICATION_LAYOUT.asar) {
  if (format !== APPLICATION_LAYOUT.asar && format !== APPLICATION_LAYOUT.directory)
    throw new Error('unsupported packaged Electron application layout')
  const archived = format === APPLICATION_LAYOUT.asar
  const applicationRoot = path.join(resources, archived ? 'app.asar' : 'app')
  return {
    applicationRoot,
    nativeDirectory: path.join(archived ? applicationRoot + '.unpacked' : applicationRoot, 'out', 'main'),
  }
}

function bridgeResources(app) {
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  for (const directory of [app, contents, resources])
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('invalid macOS update bridge bundle layout')
  return resources
}

function assertBridgeApplication(app) {
  bridgeResources(app)
  const pending = [app]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.name.toLowerCase().endsWith(ASAR_EXTENSION))
        throw new Error(`macOS update bridge contains an ASAR path: ${path.relative(app, filename)}`)
      if (entry.isDirectory()) pending.push(filename)
    }
  }
}

function prepareBridgeApplication(app) {
  const resources = bridgeResources(app)
  const archive = path.join(resources, DEFAULT_APP_ARCHIVE)
  const info = fs.lstatSync(archive, { throwIfNoEntry: false })
  // Electron ships its fallback app even when the product uses a directory entrypoint.
  if (info) {
    if (!info.isFile() || info.nlink !== 1) throw new Error('unexpected Electron default app archive')
    fs.unlinkSync(archive)
  }
  assertBridgeApplication(app)
}

module.exports = { APPLICATION_LAYOUT, applicationLayout, assertBridgeApplication, prepareBridgeApplication }
