// CI-only shared cache for the complete upstream-signed macOS runtime.
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const state = require('../scripts/shared/build-state.cjs')
const { ciCacheVersion } = require('../scripts/shared/ci-cache-version.cjs')

const run = promisify(execFile)
const LOCK_TIMEOUT_MS = 15 * 60 * 1000
const SQLITE_BUSY = 5

function sharedRegistry(selected, log) {
  const command = process.env.SCHOLARSEED_CODEX_REGISTRY_COMMAND
  if (command === undefined) return null
  const argv = JSON.parse(command)
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || !arg))
    throw new Error('Invalid macOS Codex registry command')
  const target = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x86_64' }[selected.key]
  if (!target) throw new Error('Unsupported shared Codex runtime target')
  const key = selected.receiptSha256
  const { macComponentVersions } = require('../scripts/cd/mac-component-versions.cjs')
  const version = ciCacheVersion(target, 'codex', macComponentVersions(selected.version).codex)
  const invoke = async (operation, root) => {
    try {
      await run(argv[0], [...argv.slice(1), operation, '--target', target, '--version', version, '--key', key, '--root', root])
    } catch (error) {
      if ((operation === 'fetch' || operation === 'confirm') && error.code === 3) return false
      throw error
    }
    return true
  }
  const publish = async root => {
    await invoke('publish', root)
    log(`[codex-cache] published ${target}/codex/${version} key=${key}`)
  }
  return {
    async fetch(root) {
      const found = await invoke('fetch', root)
      log(`[codex-cache] shared ${found ? 'hit' : 'miss'} ${target}/codex/${version} key=${key}`)
      return found
    },
    async confirmLocal(root) {
      if (await invoke('confirm', root)) {
        log(`[codex-cache] local hit ${target}/codex/${version} key=${key}`)
        return
      }
      await publish(root)
    },
    publish
  }
}

async function withMacRuntimeCache(directory, selected, resolve, log) {
  // A killed runner releases SQLite's write lock. A subsequent run can repair
  // an interrupted extraction or backfill OSS from a verified local tree.
  const { DatabaseSync } = require('node:sqlite')
  const filename = directory + '.sqlite'
  if (fs.lstatSync(filename, { throwIfNoEntry: false })) state.assertPrivateFile(filename)
  const database = new DatabaseSync(filename, { timeout: 0 })
  try {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        database.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        if (error.errcode !== SQLITE_BUSY || Date.now() >= deadline) throw error
        await delay(250)
      }
    }
    const runtime = await resolve(sharedRegistry(selected, log))
    database.exec('COMMIT')
    return runtime
  } finally {
    database.close()
  }
}

module.exports = { withMacRuntimeCache }
