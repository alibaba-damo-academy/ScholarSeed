// The registry decides the winner across runners. A local-only store uses the
// same first-writer rule with an atomic directory rename on the cache volume.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const state = require('../shared/build-state.cjs')

const ARCHIVE = 'component.zip'
const RECEIPT = 'receipt.json'
const KINDS = new Set(['electron', 'frameworks', 'python', 'texlive'])
const TARGETS = new Set(['darwin-arm64', 'darwin-x86_64'])

function signedRuntimeStore(root, command, kind, target) {
  if (!path.isAbsolute(root)) throw new Error('macOS signed runtime cache must use an absolute directory')
  if (!KINDS.has(kind) || !TARGETS.has(target)) throw new Error('Invalid macOS signed runtime kind or target')
  const registry = command === undefined ? null : JSON.parse(command)
  if (command !== undefined && (!Array.isArray(registry) || !registry.length ||
      registry.some(part => typeof part !== 'string' || !part))) {
    throw new Error('Invalid macOS signed runtime registry command')
  }
  root = state.ensurePrivateDirectory(root)
  const scope = state.ensurePrivateDirectory(path.join(root, registry ? 'shared-v2' : 'local-v2'))
  const group = state.ensurePrivateDirectory(path.join(scope, kind))
  const directory = state.ensurePrivateDirectory(path.join(group, target))

  function exchange(operation, key, archive) {
    const [binary, ...args] = registry
    const run = spawnSync(binary, [...args, operation, '--kind', kind, '--target', target, '--key', key, '--archive', archive], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    if (run.error) throw run.error
    if (run.status === 0) return true
    if (run.status === (operation === 'fetch' ? 3 : 4)) return false
    throw new Error(`macOS signed runtime registry ${operation} failed (${run.signal || run.status})`)
  }

  function validateKey(key) {
    if (typeof key !== 'string' || !state.SHA256.test(key)) throw new Error('Invalid macOS signed runtime key')
  }

  function local(key) {
    validateKey(key)
    state.assertPrivateDirectory(directory)
    const entry = path.join(directory, key)
    if (!fs.lstatSync(entry, {throwIfNoEntry: false})) return null
    state.assertPrivateDirectory(entry)
    const archive = path.join(entry, ARCHIVE)
    const receiptFile = path.join(entry, RECEIPT)
    state.assertPrivateFile(receiptFile)
    state.assertPrivateFile(archive)
    if (state.regular(receiptFile).size > 1024) throw new Error('Invalid macOS signed runtime receipt')
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    const inputs = receipt?.inputs
    const inventory = receipt?.inventory
    if (receipt?.schema !== 2 || inputs?.kind !== kind || inputs.target !== target || inputs.key !== key ||
        typeof inventory?.archiveSha256 !== 'string' || !state.SHA256.test(inventory.archiveSha256))
      throw new Error('Invalid macOS signed runtime receipt')
    if (inventory.archiveBytes !== state.regular(archive).size || state.hashFile(archive) !== inventory.archiveSha256)
      throw new Error('macOS signed runtime cache digest mismatch')
    return {archive, digest: inventory.archiveSha256}
  }

  function retain(key, archive, digest) {
    state.assertPrivateDirectory(directory)
    const stage = fs.mkdtempSync(path.join(directory, '.publish-'))
    try {
      const copy = path.join(stage, ARCHIVE)
      fs.copyFileSync(archive, copy, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL)
      if (state.hashFile(copy) !== digest) throw new Error('Signed runtime changed during publication')
      const receipt = {schema: 2, inputs: {kind, target, key}, inventory: {archiveSha256: digest, archiveBytes: state.regular(copy).size}}
      fs.writeFileSync(path.join(stage, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'})
      const entry = path.join(directory, key)
      try {
        fs.renameSync(stage, entry)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        const winner = local(key)
        if (!winner || (registry && winner.digest !== digest)) throw new Error('Inconsistent signed runtime winner')
        return winner
      }
      return {archive: path.join(entry, ARCHIVE), digest}
    } finally {
      fs.rmSync(stage, {recursive: true, force: true})
    }
  }

  return {
    lookup(key, temporary, restore) {
      const hit = local(key)
      if (hit) {
        restore(hit.archive)
        return 'local'
      }
      if (!registry || !exchange('fetch', key, temporary)) return null
      state.assertPrivateFile(temporary)
      const digest = state.hashFile(temporary)
      restore(temporary)
      retain(key, temporary, digest)
      return 'registry'
    },
    publish(key, archive, temporary, restore) {
      validateKey(key)
      state.assertPrivateDirectory(directory)
      state.assertPrivateFile(archive)
      const signed = state.hashFile(archive)
      let digest = signed
      if (registry && !exchange('publish', key, archive)) {
        if (!exchange('fetch', key, temporary)) throw new Error('Published signed runtime winner disappeared')
        state.assertPrivateFile(temporary)
        digest = state.hashFile(temporary)
        restore(temporary)
        archive = temporary
      }
      const winner = retain(key, archive, digest)
      if (winner.digest !== digest) restore(winner.archive)
      return winner.digest !== signed
    },
  }
}

module.exports = {signedRuntimeStore}
