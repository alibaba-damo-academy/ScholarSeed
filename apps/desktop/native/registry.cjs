// Keep slot lookup and native acquisition in the same transaction as reclamation.
const fs = require('node:fs')
const path = require('node:path')
const MAX_SLOT = 0xffffffff
const REGISTRY_DIRECTORY = '.scholarseed-locks-v2'
const LEGACY_DIRECTORY = '.scholarseed-coordination'
const RANGES = 'ranges'
const PENDING_RANGES = 'ranges.pending'
const DARWIN_BINDING = 'flock:'
const DATABASE = 'registry.sqlite'
const DATABASE_BINDING = 'registry.binding'
const SWEEP_LIMIT = 16
const sweepCursors = new Map()
const DOMAIN_SLOT = /^(posix-[0-9a-f]{16}-[0-9a-f]{16}|windows-[0-9a-f]{16}-[0-9a-f]{32})-/

function writeTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

function checkSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT)
    throw new RangeError('Invalid coordination slot')
  return slot
}

function acquireSlot(database, name, acquire, release) {
  let handle
  try {
    return writeTransaction(database, () => {
      let slot = database.prepare('SELECT slot FROM slots WHERE name = ?').get(name)?.slot
      if (slot === undefined) {
        const row = database.prepare(`
          SELECT MIN(candidate) AS slot FROM (
            SELECT 1 AS candidate
            UNION ALL
            SELECT slot + 1 FROM slots WHERE slot < ?
          ) WHERE candidate NOT IN (SELECT slot FROM slots)
        `).get(MAX_SLOT)
        slot = checkSlot(row.slot)
        database.prepare('INSERT INTO slots VALUES (?, ?)').run(name, slot)
      }
      handle = acquire(checkSlot(slot))
      return handle
    })
  } catch (error) {
    if (handle !== undefined) release(handle)
    throw error
  }
}

function collectSlot(database, name, tryExclusive, release) {
  return writeTransaction(database, () => {
    const row = database.prepare(`
      SELECT slot FROM slots WHERE name = ?
      AND NOT EXISTS (SELECT 1 FROM slot_references WHERE name = ?)
    `).get(name, name)
    if (row === undefined) return false
    const handle = tryExclusive(checkSlot(row.slot))
    if (handle === null) return false
    try {
      database.prepare('DELETE FROM slots WHERE name = ?').run(name)
    } finally {
      release(handle)
    }
    return true
  })
}

function present(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false })
}

function removeLegacyCoordination(coordinator) {
  fs.rmSync(path.join(path.dirname(coordinator), LEGACY_DIRECTORY), {
    recursive: true,
    force: true,
  })
}

function referenced(coordinator, name) {
  const identity = DOMAIN_SLOT.exec(name)?.[1]
  if (identity === undefined) return true
  // Policy locks protect a single operation and have no durable domain reference.
  if (name === identity + '-policy') return false
  for (const index of ['domains-v1', 'mutations-v1']) {
    const root = path.join(coordinator, index)
    const directory = path.join(root, identity)
    const indexInfo = present(root)
    if (!indexInfo) continue
    if (!indexInfo.isDirectory()) return true
    const info = present(directory)
    if (!info) continue
    if (!info.isDirectory()) return true
    for (const scope of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!scope.isDirectory() || !['self', 'descendants'].includes(scope.name) ||
          fs.readdirSync(path.join(directory, scope.name)).length > 0) return true
    }
  }
  return false
}

function bindRegistry(native, coordinator, pin) {
  if (path.basename(coordinator) !== REGISTRY_DIRECTORY) return native
  const { DatabaseSync } = require('node:sqlite')
  const filename = path.join(coordinator, DATABASE)
  const ranges = path.join(coordinator, RANGES)
  const darwin = process.platform === 'darwin'
  const leases = new Map()
  let identity
  function database(operation) {
    const info = present(filename)
    let binding = native.readAt(pin, DATABASE_BINDING, 128)
    if (binding && !info)
      throw Object.assign(new Error('Coordination database disappeared'), { code: 'ERR_LEASE_CHANGED' })
    if (info && (!info.isFile() || info.nlink !== 1))
      throw Object.assign(new Error('Invalid coordination database'), { code: 'ERR_LEASE_FILE' })
    const db = new DatabaseSync(filename, { timeout: 5000 })
    try {
      let observed
      if (process.platform === 'darwin') {
        const stat = fs.lstatSync(filename, { bigint: true })
        const encode = value => BigInt.asUintN(64, value).toString(16).padStart(16, '0')
        observed = `posix:${encode(stat.dev)}:${encode(stat.ino)}`
      } else {
        observed = native.fileIdentityAt(pin, DATABASE)
      }
      if (binding === null) {
        if (present(ranges))
          throw Object.assign(new Error('Missing coordination database binding'), { code: 'ERR_LEASE_CHANGED' })
        try {
          native.createAt(pin, DATABASE_BINDING, Buffer.from(observed, 'ascii'))
        } catch (error) {
          if (error.code !== 'ERR_LEASE_EXISTS') throw error
        }
        binding = native.readAt(pin, DATABASE_BINDING, 128)
      }
      if (binding?.toString('ascii') !== observed)
        throw Object.assign(new Error('Coordination database identity changed'), { code: 'ERR_LEASE_CHANGED' })
      db.exec('PRAGMA trusted_schema = OFF')
      return operation(db)
    } finally {
      db.close()
    }
  }
  function initialize(db) {
    const bound = writeTransaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS slots (name TEXT PRIMARY KEY, slot INTEGER UNIQUE);
        CREATE TABLE IF NOT EXISTS slot_references (name TEXT, kind TEXT, PRIMARY KEY (name, kind));
        CREATE TABLE IF NOT EXISTS binding (identity TEXT NOT NULL);
      `)
      const row = db.prepare('SELECT identity FROM binding').get()
      if (row) return row.identity
      if (present(ranges))
        throw Object.assign(new Error('Unbound coordination lock file'), { code: 'ERR_LEASE_CHANGED' })
      const handle = native.acquireAt(pin, PENDING_RANGES, true, 0)
      try {
        const observed = (darwin ? DARWIN_BINDING : '') + native.lockIdentity(handle)
        db.prepare('INSERT INTO binding VALUES (?)').run(observed)
        return observed
      } finally {
        native.release(handle)
      }
    })
    if (darwin && !bound.startsWith(DARWIN_BINDING))
      throw Object.assign(new Error('Incompatible coordination lock binding'), { code: 'ERR_LEASE_CHANGED' })
    const expected = darwin ? bound.slice(DARWIN_BINDING.length) : bound
    writeTransaction(db, () => {
      if (present(ranges)) return
      native.release(native.acquireAt(pin, PENDING_RANGES, true, 0, expected))
      fs.renameSync(path.join(coordinator, PENDING_RANGES), ranges)
    })
    return expected
  }
  function lockSlot(slot, exclusive) {
    if (!darwin) return native.acquireAt(pin, RANGES, exclusive, slot, identity)
    if (native.fileIdentityAt(pin, RANGES) !== identity)
      throw Object.assign(new Error('Coordination lock binding changed'), { code: 'ERR_LEASE_CHANGED' })
    // Keep each slot file even after its SQLite mapping is reclaimed.
    return native.acquireAt(pin, `slot-${slot}`, exclusive)
  }
  function collect(db, name) {
    return collectSlot(db, name, slot => {
      let handle
      try {
        handle = lockSlot(slot, true)
      } catch (error) {
        if (error.code !== 'ERR_LEASE_BUSY') throw error
        return null
      }
      let retained
      try {
        retained = referenced(coordinator, name)
      } catch (error) {
        native.release(handle)
        throw error
      }
      if (!retained) return handle
      native.release(handle)
      return null
    }, native.release)
  }
  return Object.create(native, {
    acquireAt: { value(parent, name, exclusive) {
      if (parent !== pin) return native.acquireAt(parent, name, exclusive)
      const handle = database(db => {
        if (identity === undefined) {
          identity = initialize(db)
          const rows = db.prepare('SELECT slot, name FROM slots WHERE slot > ? ORDER BY slot LIMIT ?')
            .all(sweepCursors.get(coordinator) ?? 0, SWEEP_LIMIT)
          for (const row of rows) collect(db, row.name)
          sweepCursors.set(coordinator, rows.length === SWEEP_LIMIT ? rows.at(-1).slot : 0)
        }
        return acquireSlot(db, name,
          slot => lockSlot(slot, exclusive),
          native.release)
      })
      leases.set(handle, name)
      return handle
    }},
    release: { value(handle) {
      native.release(handle)
      const name = leases.get(handle)
      if (name === undefined) return
      leases.delete(handle)
      try {
        database(db => collect(db, name))
      } catch (error) {
        if (error.code === 'ERR_LEASE_RELEASE') throw error
        console.warn('Could not reclaim coordination slot', name, error)
      }
    }},
  })
}

module.exports = { acquireSlot, bindRegistry, collectSlot, REGISTRY_DIRECTORY, removeLegacyCoordination }
