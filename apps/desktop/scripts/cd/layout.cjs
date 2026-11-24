const fs = require('node:fs')
const path = require('node:path')

const APPLICATION_LAYOUT = Object.freeze({ asar: 'asar', directory: 'directory' })
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

function assertBridgeApplication(app) {
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  for (const directory of [app, contents, resources])
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('invalid macOS update bridge bundle layout')
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

module.exports = { APPLICATION_LAYOUT, applicationLayout, assertBridgeApplication }
