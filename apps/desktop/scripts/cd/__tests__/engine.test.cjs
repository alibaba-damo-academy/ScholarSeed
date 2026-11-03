const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const {createRequire} = require('node:module')
const {installApplication, prepare, ENGINE} = require('../engine.cjs')
const bootstrap = path.join(sourceDirectory, '../../runtime/electron/bootstrap.cjs')

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-engine-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  return root
}
test('fixed bootstrap loads program metadata and entry from its own installation', t => {
  const root = fixture(t)
  const engine = path.join(root, '中文 runtime', 'runtime', 'electron', '44.3.0-r1', ENGINE)
  const code = path.join(root, '中文 runtime', 'current', 'resources', 'app.asar')
  fs.mkdirSync(path.dirname(engine), {recursive: true})
  fs.writeFileSync(engine, 'engine')
  fs.mkdirSync(code, {recursive: true})
  const metadata = {name: 'scholarseed-desktop', version: '0.2.0', main: 'out/main/index.js'}
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify(metadata))
  const app = {setVersion(value) {this.version = value}, setAppPath(value) {this.path = value}}
  let loaded
  const realRequire = createRequire(bootstrap)
  const runtime = {platform: 'win32', execPath: engine, resourcesPath: path.join(path.dirname(engine), 'resources')}
  const execute = () => vm.runInNewContext(fs.readFileSync(bootstrap, 'utf8'), {process: runtime, require: name => {
    if (name === 'electron') return {app}
    if (name === 'node:module') return {createRequire: filename => entry => {loaded = [filename, entry]}}
    return realRequire(name)
  }}, {filename: bootstrap})
  execute()
  assert.equal(app.name, 'ScholarSeed')
  assert.equal(app.version, '0.2.0')
  assert.equal(app.path, code)
  assert.deepEqual(loaded, [path.join(code, 'package.json'), './out/main/index.js'])
  assert.equal(runtime.execPath, engine)
  assert.equal(runtime.resourcesPath, path.join(path.dirname(engine), 'resources'))
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({...metadata, main: '../outside.js'}))
  assert.throws(execute, /Invalid ScholarSeed/)
  runtime.execPath = path.join(root, ENGINE)
  fs.writeFileSync(runtime.execPath, 'foreign')
  assert.throws(execute, /outside its installation/)
})

test('builder output retains program resources and replaces the embedded engine with frozen launcher files', t => {
  const root = fixture(t)
  const application = path.join(root, 'artifacts', 'win-unpacked')
  const directory = path.join(root, 'launcher')
  fs.mkdirSync(path.join(application, 'resources'), {recursive: true})
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(application, 'resources', 'app.asar'), 'program')
  fs.writeFileSync(path.join(application, 'ScholarSeed.exe'), 'branded-electron')
  fs.writeFileSync(path.join(application, 'chrome_100_percent.pak'), 'engine')
  for (const name of ['ScholarSeed.exe', 'libvelopack.dll', 'LAUNCHER-GO-LICENSE.txt', 'Uninstall.exe']) fs.writeFileSync(path.join(directory, name), name)
  const frozen = {platform: 'win32', output: path.join(root, 'artifacts'), electron: {}, launcher: {directory}}
  assert.throws(() => installApplication(application, {...frozen, output: path.join(root, 'other')}), /outside build output/)
  assert.equal(fs.readFileSync(path.join(application, 'ScholarSeed.exe'), 'utf8'), 'branded-electron')
  installApplication(application, frozen)
  assert.deepEqual(fs.readdirSync(application).sort(), ['LAUNCHER-GO-LICENSE.txt', 'ScholarSeed.exe', 'libvelopack.dll', 'Uninstall.exe', 'resources'].sort())
  assert.equal(fs.readFileSync(path.join(application, 'resources', 'app.asar'), 'utf8'), 'program')
  assert.equal(fs.readFileSync(path.join(application, 'ScholarSeed.exe'), 'utf8'), 'ScholarSeed.exe')
})
test('macOS engine preparation and builder layout remain unchanged', async () => {
  assert.equal(await prepare({platform: 'darwin'}), null)
  installApplication('unused', {platform: 'darwin'})
})
