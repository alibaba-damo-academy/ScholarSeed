// The registry decides the winner across runners. A local-only store uses the
// same first-writer rule with an atomic directory rename on the cache volume.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const state = require('../shared/build-state.cjs')
const {ciCacheVersion} = require('../shared/ci-cache-version.cjs')
const {macComponentVersions} = require('./mac-component-versions.cjs')

const ARCHIVE = 'component.zip'
const RECEIPT = 'receipt.json'
const KINDS = new Set(['electron', 'frameworks', 'python', 'texlive'])
const TARGETS = new Set(['darwin-arm64', 'darwin-x86_64'])
const MISS = 3
const OTHER_WINNER = 4
const UNREGISTERED_WINNER = 5

function signedRuntimeStore(root, command, kind, target, environment = process.env) {
  if (!path.isAbsolute(root)) throw new Error('macOS signed runtime cache must use an absolute directory')
  if (!KINDS.has(kind) || !TARGETS.has(target)) throw new Error('Invalid macOS signed runtime kind or target')
  const registry = command === undefined ? null : JSON.parse(command)
  if (command !== undefined && (!Array.isArray(registry) || !registry.length ||
      registry.some(part => typeof part !== 'string' || !part))) {
    throw new Error('Invalid macOS signed runtime registry command')
  }
  root = state.ensurePrivateDirectory(root)
  const versions = macComponentVersions()
  // Mantle, ReactiveObjC and Squirrel come from the Electron distribution.
  const baseline = kind === 'frameworks' ? versions.electron.replace(/-r\d+$/, '-r1') : versions[kind]
  const version = registry && ciCacheVersion(target, kind, baseline, environment)
  const scope = state.ensurePrivateDirectory(path.join(root, registry ? 'shared-v3' : 'local-v2'))
  const group = state.ensurePrivateDirectory(path.join(scope, kind))
  const targetDirectory = state.ensurePrivateDirectory(path.join(group, target))
  const directory = registry ? state.ensurePrivateDirectory(path.join(targetDirectory, version)) : targetDirectory
  const previous = registry && environment.SCHOLARSEED_MAC_SIGN_PREVIOUS_CACHE
  if (previous && !path.isAbsolute(previous)) throw new Error('Invalid previous macOS signed runtime cache')
  const previousDirectory = previous && path.join(previous, 'shared-v2', kind, target)

  function exchange(operation, key, archive) {
    const [binary, ...args] = registry
    const run = spawnSync(binary, [...args, operation, '--kind', kind, '--target', target, '--version', version, '--key', key, '--archive', archive], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    if (run.error) throw run.error
    if (run.status === 0 || (run.status === MISS && operation !== 'publish') ||
        (run.status === OTHER_WINNER && (operation === 'confirm' || operation === 'publish')) ||
        (run.status === UNREGISTERED_WINNER && operation === 'publish')) return run.status
    throw new Error(`macOS signed runtime registry ${operation} failed (${run.signal || run.status})`)
  }

  function validateKey(key) {
    if (typeof key !== 'string' || !state.SHA256.test(key)) throw new Error('Invalid macOS signed runtime key')
  }

  function local(key, legacy = false) {
    validateKey(key)
    if (!legacy) state.assertPrivateDirectory(directory)
    const entry = path.join(legacy ? previousDirectory : directory, key)
    if (!fs.lstatSync(entry, {throwIfNoEntry: false})) return null
    state.assertPrivateDirectory(entry)
    const receiptFile = path.join(entry, RECEIPT)
    state.assertPrivateFile(receiptFile)
    if (state.regular(receiptFile).size > 1024) throw new Error('Invalid macOS signed runtime receipt')
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    const inputs = receipt?.inputs
    const inventory = receipt?.inventory
    const versioned = registry && !legacy
    if (receipt?.schema !== (versioned ? 3 : 2) || inputs?.kind !== kind || inputs.target !== target || inputs.key !== key ||
        (versioned && inputs.version !== version) ||
        typeof inventory?.archiveSha256 !== 'string' || !state.SHA256.test(inventory.archiveSha256))
      throw new Error('Invalid macOS signed runtime receipt')
    const archive = path.join(entry, versioned ? inventory.archiveSha256 + '.zip' : ARCHIVE)
    state.assertPrivateFile(archive)
    if (inventory.archiveBytes !== state.regular(archive).size || state.hashFile(archive) !== inventory.archiveSha256)
      throw new Error('macOS signed runtime cache digest mismatch')
    return {archive, digest: inventory.archiveSha256}
  }

  function retain(key, archive, digest) {
    state.assertPrivateDirectory(directory)
    const stage = fs.mkdtempSync(path.join(directory, '.publish-'))
    try {
      const filename = registry ? digest + '.zip' : ARCHIVE
      const copy = path.join(stage, filename)
      fs.copyFileSync(archive, copy, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL)
      if (state.hashFile(copy) !== digest) throw new Error('Signed runtime changed during publication')
      const receipt = {schema: registry ? 3 : 2, inputs: {kind, target, ...(registry && {version}), key},
        inventory: {archiveSha256: digest, archiveBytes: state.regular(copy).size}}
      fs.writeFileSync(path.join(stage, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600, flag: 'wx'})
      const entry = path.join(directory, key)
      try {
        fs.renameSync(stage, entry)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        const winner = local(key)
        if (!winner) throw new Error('Local signed runtime winner disappeared')
        if (!registry || winner.digest === digest) return winner
        // The remote binding can change after an intentional purge and a new signing
        // race. Keep old digest files for concurrent readers; switch the receipt last.
        fs.renameSync(copy, path.join(entry, filename))
        fs.renameSync(path.join(stage, RECEIPT), path.join(entry, RECEIPT))
      }
      return {archive: path.join(entry, filename), digest}
    } finally {
      fs.rmSync(stage, {recursive: true, force: true})
    }
  }

  function downloadWinner(key, temporary, restore, recover = false) {
    if (exchange(recover ? 'recover' : 'fetch', key, temporary) === MISS) return null
    state.assertPrivateFile(temporary)
    const digest = state.hashFile(temporary)
    restore(temporary)
    // Only this runner can validate the archived signatures against its active
    // policy. An orphan must pass restore before the registry may create a receipt.
    if (recover && (state.hashFile(temporary) !== digest || exchange('publish', key, temporary) !== 0))
      throw new Error('Unregistered signed runtime winner changed during verification')
    return retain(key, temporary, digest)
  }

  return {
    lookup(key, temporary, restore) {
      const current = local(key)
      let hit = current
      let status
      if (current) {
        status = registry ? exchange('confirm', key, current.archive) : 0
      } else {
        if (!registry) return null
        if (downloadWinner(key, temporary, restore)) return 'registry'
        // Consult the old local scope only after a confirmed miss in the new registry.
        hit = previousDirectory && local(key, true)
        if (!hit) return null
        status = MISS
      }
      if (status !== OTHER_WINNER) {
        restore(hit.archive)
        if (status === MISS) status = exchange('publish', key, hit.archive)
        if (status === 0) {
          if (!current) retain(key, hit.archive, hit.digest)
          return 'local'
        }
      }
      if (!downloadWinner(key, temporary, restore, status === UNREGISTERED_WINNER))
        throw new Error('Signed runtime winner disappeared')
      return 'registry'
    },
    publish(key, archive, temporary, restore) {
      validateKey(key)
      state.assertPrivateDirectory(directory)
      state.assertPrivateFile(archive)
      const signed = state.hashFile(archive)
      const status = registry ? exchange('publish', key, archive) : 0
      if (status !== 0) {
        const winner = downloadWinner(key, temporary, restore, status === UNREGISTERED_WINNER)
        if (!winner) throw new Error('Signed runtime winner disappeared')
        return winner.digest !== signed
      }
      const winner = retain(key, archive, signed)
      if (winner.digest !== signed) restore(winner.archive)
      return winner.digest !== signed
    },
  }
}

module.exports = {signedRuntimeStore}
