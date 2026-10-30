// Reuse rootless delivery ZIPs through the existing immutable component cache.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const cache = require('../shared/component-cache.cjs')
const state = require('../shared/build-state.cjs')

function sourceIdentity(root) {
  const directories = []
  const visit = directory => {
    state.regular(directory, true)
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name)
      if (fs.lstatSync(file).isDirectory()) {
        directories.push(path.relative(root, file).split(path.sep).join('/'))
        visit(file)
      }
    }
  }
  visit(root)
  return state.identity({directories, files: state.inventory(root)})
}

function pack({cacheRoot, repo, kind, target, contentId, pythonArchiveSha256, python, root, output, entry}, environment) {
  const source = sourceIdentity(root)
  const inputs = {kind, target, contentId, source, prefix: '', entry,
    recipe: cache.recipe(repo, {pythonArchiveSha256}, kind)}
  const cached = cacheRoot ? cache.lookup(cacheRoot, inputs, python, environment) : null
  if (cached) fs.copyFileSync(cached.archive, output, fs.constants.COPYFILE_EXCL)
  else execFileSync(python, ['-I', '-B', path.join(__dirname, 'payload.py'), '--root', root,
    '--output', output, '--entry', entry, '--reproducible'], {env: environment, stdio: 'inherit', windowsHide: true})
  const full = cached ? cache.reuse(output, cached.fullInventory) : cache.measure(python, output, environment, '', true)
  const measured = cache.summary(full)
  if (cached && state.identity(cached.inventory) !== state.identity(measured))
    throw new Error('cached component changed before packing')
  if (sourceIdentity(root) !== source) throw new Error('component source changed during packing')
  if (cacheRoot && !cached) cache.publish(cacheRoot, inputs, output, measured, {}, environment)
  return full
}

module.exports = { pack, sourceIdentity }
