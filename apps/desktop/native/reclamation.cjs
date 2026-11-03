// Names select candidates only. The native operation owns every deletion proof.
const fs = require('node:fs')
const SLOT = /^(posix-[a-f0-9]{16}-[a-f0-9]{16}|windows-[a-f0-9]{16}-[a-f0-9]{32})-(?:admission-b|occupancy-[ab])$/
const MAX_GROUPS = 1024
const retainedPins = []
const UNCERTAIN = new Set(['ERR_LEASE_RELEASE', 'ERR_DOMAIN_RELEASE'])

function uncertainRelease(error) {
  return UNCERTAIN.has(error?.code)
}

function reclaimCoordination(native, directory) {
  const result = { removed: 0, busy: 0, retained: 0, examined: 0, complete: true, absent: false, errors: [] }
  try {
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('coordination root is not a directory')
  } catch (error) {
    if (error.code === 'ENOENT') return { ...result, absent: true }
    throw error
  }
  const pin = native.pin(directory, false)
  let failure
  try {
    // A name obtained through a replaced listing cannot authorize deletion:
    // reclaimAt resolves only beneath this retained, native-validated pin.
    const listing = fs.opendirSync(directory)
    const seen = new Set()
    try {
      let entry
      while ((entry = listing.readSync()) !== null) {
        const match = SLOT.exec(entry.name)
        if (!match || seen.has(match[1])) continue
        if (seen.size === MAX_GROUPS) {
          result.complete = false
          break
        }
        const identity = match[1]
        seen.add(identity)
        result.examined++
        try {
          const group = native.reclaimAt(pin, identity)
          result.removed += group.removed
          result.busy += Number(group.busy)
          result.retained += Number(group.retained)
        } catch (error) {
          if (uncertainRelease(error)) {
            failure = error
            throw error
          }
          result.errors.push({ code: error.code || 'ERR_RECLAMATION', systemCode: error.systemCode ?? null })
        }
      }
    } finally {
      listing.closeSync()
    }
  } catch (error) {
    if (!uncertainRelease(failure)) failure = error
    throw failure
  } finally {
    if (uncertainRelease(failure)) retainedPins.push(pin)
    else {
      try { native.release(pin) } catch (error) {
        retainedPins.push(pin)
        throw Object.assign(new AggregateError([error], 'coordination pin release uncertain'), {
          code: 'ERR_DOMAIN_RELEASE',
        })
      }
    }
  }
  return result
}

module.exports = { reclaimCoordination, uncertainRelease }
