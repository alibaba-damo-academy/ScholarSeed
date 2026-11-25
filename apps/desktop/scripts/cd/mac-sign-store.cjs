// The registry decides the winner across runners. A local-only store uses the
// same first-writer rule with an atomic directory rename on the cache volume.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const state = require('../shared/build-state.cjs')

const ARCHIVE = 'signed.zip'
const DIGEST = 'sha256'

function signedRuntimeStore(root, command) {
  if (!path.isAbsolute(root)) throw new Error('macOS signed runtime cache must use an absolute directory')
  const registry = command === undefined ? null : JSON.parse(command)
  if (command !== undefined && (!Array.isArray(registry) || !registry.length ||
      registry.some(part => typeof part !== 'string' || !part))) {
    throw new Error('Invalid macOS signed runtime registry command')
  }
  root = state.ensurePrivateDirectory(root)
  const directory = state.ensurePrivateDirectory(path.join(root, registry ? 'shared-v1' : 'local-v1'))

  function exchange(operation, key, archive) {
    const [binary, ...args] = registry
    const run = spawnSync(binary, [...args, operation, '--key', key, '--archive', archive], {
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
    const entry = path.join(directory, key)
    if (!fs.lstatSync(entry, {throwIfNoEntry: false})) return null
    state.assertPrivateDirectory(entry)
    const archive = path.join(entry, ARCHIVE)
    const receipt = path.join(entry, DIGEST)
    state.assertPrivateFile(receipt)
    state.assertPrivateFile(archive)
    if (state.regular(receipt).size !== 65) throw new Error('Invalid macOS signed runtime receipt')
    const digest = fs.readFileSync(receipt, 'utf8').trim()
    if (!state.SHA256.test(digest) || state.hashFile(archive) !== digest)
      throw new Error('macOS signed runtime cache digest mismatch')
    return {archive, digest}
  }

  function retain(key, archive, digest) {
    const stage = fs.mkdtempSync(path.join(directory, '.publish-'))
    try {
      const copy = path.join(stage, ARCHIVE)
      fs.copyFileSync(archive, copy, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL)
      if (state.hashFile(copy) !== digest) throw new Error('Signed runtime changed during publication')
      fs.writeFileSync(path.join(stage, DIGEST), digest + '\n', {mode: 0o600, flag: 'wx'})
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
