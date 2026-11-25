// CI-only shared cache for the complete upstream-signed macOS runtime.
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const state = require('../scripts/shared/build-state.cjs')

const run = promisify(execFile)
const LOCK_TIMEOUT_MS = 15 * 60 * 1000
const SQLITE_BUSY = 5

function sharedRegistry(selected, database, log) {
  const command = process.env.SCHOLARSEED_CODEX_REGISTRY_COMMAND
  if (command === undefined) return null
  const argv = JSON.parse(command)
  const scope = process.env.SCHOLARSEED_CODEX_REGISTRY_SCOPE
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || !arg) || !state.SHA256.test(scope))
    throw new Error('Invalid macOS Codex registry command or scope')
  const target = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x86_64' }[selected.key]
  if (!target) throw new Error('Unsupported shared Codex runtime target')
  const key = selected.receiptSha256
  database.exec('CREATE TABLE IF NOT EXISTS published (scope TEXT, receipt TEXT, PRIMARY KEY(scope, receipt))')
  const recordPublication = () => database.prepare('INSERT OR IGNORE INTO published VALUES (?, ?)').run(scope, key)
  const invoke = async (operation, root) => {
    try {
      await run(argv[0], [...argv.slice(1), operation, '--target', target, '--key', key, '--root', root])
    } catch (error) {
      if (operation === 'fetch' && error.code === 3) return false
      throw error
    }
    return true
  }
  const publish = async root => {
    await invoke('publish', root)
    recordPublication()
    log(`[codex-cache] published ${target} key=${key}`)
  }
  return {
    async fetch(root) {
      const found = await invoke('fetch', root)
      log(`[codex-cache] shared ${found ? 'hit' : 'miss'} ${target} key=${key}`)
      return found
    },
    async confirmLocal(root) {
      if (database.prepare('SELECT 1 FROM published WHERE scope = ? AND receipt = ?').get(scope, key)) {
        log(`[codex-cache] local hit ${target} key=${key}`)
        return
      }
      await publish(root)
    },
    publish, recordPublication
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
    const runtime = await resolve(sharedRegistry(selected, database, log))
    database.exec('COMMIT')
    return runtime
  } finally {
    database.close()
  }
}

module.exports = { withMacRuntimeCache }
