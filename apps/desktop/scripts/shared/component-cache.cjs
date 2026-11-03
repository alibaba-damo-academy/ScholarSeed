// Immutable build-side component ZIP cache; never stores product state or acceptance.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { nativeTar } = require('../../../../scripts/shared/python.cjs')
const state = require('./build-state.cjs')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const SCHEMA = 2
const ARCHIVE = 'component.zip'
const RECEIPT = 'receipt.json'
const MAX_RECEIPT_BYTES = 128 * 1024
const RECIPE_FILES = {
  python: ['apps/desktop/scripts/cd/assembly.cjs', 'apps/desktop/scripts/cd/bytecode.py',
    'apps/desktop/scripts/cd/normalize.py', 'apps/desktop/scripts/cd/payload.py', 'scripts/shared/dependencies.py',
    'apps/serve/service/capabilities/service/dependencies.py'],
  texlive: ['apps/desktop/runtime/texlive.cjs', 'apps/desktop/scripts/cd/texlive.cjs', 'apps/desktop/scripts/cd/payload.py',
    'apps/desktop/package.json', 'apps/desktop/pnpm-lock.yaml'],
  powershell: ['apps/desktop/runtime/powershell.cjs', 'apps/desktop/scripts/cd/payload.py'],
  codex: ['apps/desktop/scripts/cd/compression.cjs', 'apps/desktop/scripts/cd/payload.py'],
  office: ['apps/desktop/scripts/cd/compression.cjs', 'apps/desktop/scripts/cd/payload.py'],
  electron: ['apps/desktop/scripts/cd/engine.cjs', 'apps/desktop/runtime/electron/bootstrap.cjs',
    'apps/desktop/runtime/electron/package.json', 'apps/desktop/runtime/electron.json',
    'apps/desktop/scripts/cd/compression.cjs', 'apps/desktop/scripts/cd/payload.py']
}
function recipe(repo, tools, kind = 'python') {
  if (!RECIPE_FILES[kind]) throw new Error('unknown component recipe')
  return { tools, files: RECIPE_FILES[kind].map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file), 'utf8').replaceAll('\r\n', '\n')).digest('hex')]) }
}
function shared(operation, root, inputs, environment = process.env) {
  const configured = environment.SCHOLARSEED_COMPONENT_REGISTRY_COMMAND
  if (!configured) return
  const command = JSON.parse(configured)
  if (!Array.isArray(command) || !command.length || command.some(item => typeof item !== 'string' || !item))
    throw new Error('invalid component registry command')
  execFileSync(command[0], [...command.slice(1), operation, '--root', root, '--key', key(inputs)],
    { input: JSON.stringify(inputs), env: environment, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
}
function key(inputs) { return state.identity({ schema: SCHEMA, inputs }) }
function summary({files: _files, ...inventory}) { return inventory }
function measure(python, archive, environment, prefix = 'python', files = false) {
  return timed('components.inventory', () => JSON.parse(execFileSync(python,
    ['-I', '-B', path.join(__dirname, '../cd/archive_inventory.py'), ...(files ? ['--files'] : []),
      ...(prefix === '' ? [] : ['--root', prefix]), archive],
    { encoding: 'utf8', env: environment, maxBuffer: files ? 32 * 1024 * 1024 : MAX_RECEIPT_BYTES, windowsHide: true }))[0])
}
// Reuse only an inventory computed in this process, bound to the exact final ZIP.
function reuse(archive, inventory) {
  if (!inventory?.files || state.regular(archive).size !== inventory.archiveBytes ||
      state.hashFile(archive) !== inventory.archiveSha256) throw new Error('component changed after inventory')
  return inventory
}
function lookup(root, inputs, python, environment) {
  const started=Date.now()
  if (!root) return null
  root = state.ensurePrivateDirectory(root)
  const directory = path.join(root, key(inputs))
  if (!fs.existsSync(directory)) shared('fetch', root, inputs, environment)
  if (!fs.existsSync(directory)) { console.log(`[component-cache] miss ${inputs.kind} ${key(inputs)}`); return null }
  state.assertPrivateDirectory(directory)
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([ARCHIVE, RECEIPT].sort())) throw new Error('incomplete component cache entry')
  const file = path.join(directory, RECEIPT)
  state.assertPrivateFile(file)
  if (state.regular(file).size > MAX_RECEIPT_BYTES) throw new Error('oversized component cache receipt')
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (receipt.schema !== SCHEMA || state.identity(receipt.inputs) !== state.identity(inputs)) throw new Error('component cache input mismatch')
  const archive = path.join(directory, ARCHIVE)
  state.assertPrivateFile(archive)
  if (state.regular(archive).size !== receipt.inventory.archiveBytes || state.hashFile(archive) !== receipt.inventory.archiveSha256)
    throw new Error('component cache archive digest mismatch')
  const prefix = inputs.prefix === undefined ? inputs.kind : inputs.prefix
  if (prefix !== '' && prefix !== inputs.kind) throw new Error('invalid component archive prefix')
  const fullInventory = measure(python, archive, environment, prefix, true)
  const actual = summary(fullInventory)
  if (JSON.stringify(actual) !== JSON.stringify(receipt.inventory)) throw new Error('component cache inventory mismatch')
  shared('publish', root, inputs, environment)
  console.log(`[component-cache] hit ${inputs.kind} ${key(inputs)} (${Date.now()-started}ms)` )
  return { archive, ...receipt, fullInventory }
}
function restore(entry, backend, tree) {
  const directory = path.join(backend, tree)
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true })
  execFileSync(nativeTar(), ['-xf', entry.archive, '-C', backend], { stdio: 'pipe', windowsHide: true })
  state.assertPrivateDirectory(directory)
  if (state.hashFile(entry.archive) !== entry.inventory.archiveSha256) throw new Error('component cache changed during restoration')
}
function publish(root, inputs, archive, measured, evidence, environment = process.env) {
  if (!root) return
  root = state.ensurePrivateDirectory(root)
  const directory = path.join(root, key(inputs))
  const temporary = fs.mkdtempSync(path.join(root, '.publish-'))
  try {
    fs.copyFileSync(archive, path.join(temporary, ARCHIVE), fs.constants.COPYFILE_EXCL)
    if (state.hashFile(path.join(temporary, ARCHIVE)) !== measured.archiveSha256) throw new Error('component cache copy mismatch')
    fs.writeFileSync(path.join(temporary, RECEIPT), JSON.stringify({ schema: SCHEMA, inputs, inventory: measured, evidence })+'\n', { flag: 'wx', mode: 0o600 })
    try { fs.renameSync(temporary, directory) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !fs.existsSync(directory)) throw error
      // A complete winner is checked by lookup, never overwritten by a second writer.
      state.assertPrivateDirectory(directory)
      state.assertPrivateFile(path.join(directory,RECEIPT))
      state.assertPrivateFile(path.join(directory,ARCHIVE))
      const winner = JSON.parse(fs.readFileSync(path.join(directory, RECEIPT)))
      if (winner.schema !== SCHEMA || state.identity(winner.inputs) !== state.identity(inputs) ||
          state.hashFile(path.join(directory, ARCHIVE)) !== winner.inventory.archiveSha256) throw new Error('invalid concurrent component cache publisher')
      if (state.identity(winner.inventory) !== state.identity(measured)) throw new Error('component reproducibility conflict: same inputs produced different archives')
    }
    shared('publish', root, inputs, environment)
    console.log(`[component-cache] stored ${inputs.kind} ${key(inputs)}`)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
module.exports = { recipe, key, measure, summary, reuse, lookup, restore, publish }
