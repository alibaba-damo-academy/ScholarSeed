// Fixed engine entry. Product code, metadata and native modules belong to current.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { app } = require('electron')

const ENGINE = 'ScholarSeedEngine.exe'
const engine = path.dirname(fs.realpathSync(process.execPath))
if (process.platform !== 'win32' || path.basename(process.execPath) !== ENGINE ||
    path.basename(path.dirname(engine)) !== 'electron' ||
    path.basename(path.dirname(path.dirname(engine))) !== 'runtime')
  throw new Error('Electron engine is outside its installation runtime')
const current = path.resolve(engine, '../../..', 'current')
if (fs.realpathSync(current).toLowerCase() !== current.toLowerCase())
  throw new Error('Application directory must not redirect outside its installation')
const code = path.join(current, 'resources', 'app.asar')
const metadata = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8'))
if (metadata.name !== 'scholarseed-desktop' || !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
    metadata.main !== 'out/main/index.js') throw new Error('Invalid ScholarSeed application entry')
app.name = 'ScholarSeed'
app.setVersion(metadata.version)
app.setAppPath(code)
// This is the explicit application loader, not a deferred dependency import.
createRequire(path.join(code, 'package.json'))('./' + metadata.main)
