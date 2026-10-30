// Hierarchical data-domain coordination. This is an advisory kernel protocol,
// not generation compatibility, namespace migration or activation authority.
const path = require('node:path')
const barriers = require('./barriers.cjs')
const MODES = Object.freeze({
  intent: { a: false },
  shared: { a: false, b: false },
  maintainIntent: { a: false, b: true },
  exclusive: { a: true, b: true },
})
const IDENTITY = /^(?:posix:[a-f0-9]{16}:[a-f0-9]{16}|windows:[a-f0-9]{16}:[a-f0-9]{32})$/
const FAMILY_INDEX = 'domains-v1'
const FAMILY_RECORDS = 4096
const FAMILY_BYTES = 1024 * 1024

function releaseAll(native, handles) {
  while (handles.length) {
    // Consume before close and stop at the first uncertain receipt. Retain all
    // remaining handles in this group, as well as later groups, until death.
    try {
      native.release(handles.pop())
    } catch (error) {
      throw Object.assign(new AggregateError([error], 'domain resource release failed'), {
        code: 'ERR_DOMAIN_RELEASE',
      })
    }
  }
}

function cleanup(native, groups, cause) {
  // A failed close is not evidence that the resource has stopped protecting IO.
  // Retain all later capabilities and require process exit, even during begin().
  if (cause?.code === 'ERR_DOMAIN_RELEASE') throw cause
  if (cause?.code === 'ERR_LEASE_RELEASE')
    throw Object.assign(new AggregateError([cause], 'uncertain native directory release'), {
      code: 'ERR_DOMAIN_RELEASE',
    })
  for (const group of groups) {
    try {
      releaseAll(native, group)
    } catch (error) {
      if (cause) error.errors.unshift(cause)
      throw error
    }
  }
  if (cause) throw cause
}

function binding(native, pin, path, role = 'private') {
  const lineage = native.lineage(pin)
  if (!lineage.length || lineage.some((value) => !IDENTITY.test(value)))
    throw new Error('unsupported native directory identity')
  return { path, role, identity: lineage.at(-1), ancestors: [...new Set(lineage.slice(0, -1))].sort() }
}

function revalidate(native, bindings) {
  const checks = []
  try {
    for (const expected of bindings) {
      const pin = native.pin(expected.path, false, expected.role)
      checks.push(pin)
      const actual = binding(native, pin, expected.path, expected.role)
      if (
        actual.identity !== expected.identity ||
        actual.ancestors.length !== expected.ancestors.length ||
        actual.ancestors.some((value, index) => value !== expected.ancestors[index])
      )
        throw Object.assign(new Error('domain directory identity or ancestry changed'), {
          code: 'ERR_DOMAIN_CHANGED',
        })
    }
  } catch (error) {
    cleanup(native, [checks], error)
  }
  releaseAll(native, checks)
}

function acquire(native, coordinator, plan, phase) {
  const handles = []
  try {
    for (const [identity, mode] of plan) {
      for (const [slot, exclusive] of Object.entries(MODES[mode])) {
        handles.push(
          native.acquireAt(
            coordinator,
            `${identity.replaceAll(':', '-')}-${phase}-${slot}`,
            exclusive
          )
        )
      }
    }
    return handles
  } catch (error) {
    cleanup(native, [handles], error)
  }
}

// Memberships outlive volatile leases. Only the family retirement owner may
// remove them; no contents, PID absence or clock value authorizes maintenance.
function checkFamilies(native, coordinator, location, plan, owned = {}) {
  for (const [identity, mode] of plan) {
    const encoded = identity.replaceAll(':', '-')
    const gates = []
    const pins = []
    try {
      gates.push(native.acquireAt(coordinator, `${encoded}-families`, false))
      for (const scope of mode === 'exclusive' ? ['self', 'descendants'] : ['self']) {
        const directory = path.join(location.path, FAMILY_INDEX, encoded, scope)
        let pin
        try {
          pin = native.pin(directory, false)
        } catch (error) {
          if (error.code === 'ERR_LEASE_MISSING') continue
          throw error
        }
        pins.push(pin)
        const current = binding(native, pin, directory)
        if (!current.ancestors.includes(location.identity))
          throw Object.assign(new Error('family index coordinator changed'), {
            code: 'ERR_DOMAIN_CHANGED',
          })
        revalidate(native, [location, current])
        const records = native.listAt(pin, FAMILY_RECORDS, FAMILY_BYTES)
        revalidate(native, [location, current])
        if (
          Object.entries(records).some(
            ([name, payload]) =>
              !Object.hasOwn(owned, name) ||
              !Buffer.isBuffer(payload) ||
              !payload.equals(Buffer.from(owned[name], 'ascii'))
          )
        )
          throw Object.assign(new Error('persistent family membership blocks maintenance'), {
            code: 'ERR_LEASE_BUSY',
          })
      }
    } catch (error) {
      cleanup(native, [pins, gates], error)
    }
    cleanup(native, [pins, gates])
  }
}

/**
 * Open existing, native-validated roots and close admission over their complete
 * ancestry. Writer: S on roots, IS on ancestors. Maintenance: X on roots, IX on
 * ancestors. Two slots implement a conservative compatibility matrix: IX/IX is
 * serialized, while unrelated writers remain compatible with maintenance.
 *
 * Call occupy(), check actual data compatibility while admission is still held,
 * then admit() for a writer. Maintenance keeps admission until close(), including
 * while occupy() reports busy. No upgrade/downgrade or candidate bypass exists.
 * The caller owns real IO drain before close(); lost JS references retain native
 * locks until process exit. The admission-a anchor is permanent; idle sibling
 * slots may be reclaimed only under the native reclamation protocol.
 */
function beginDomains(native, coordinatorPath, roots, maintenance = false, roles = {}) {
  if (!Array.isArray(roots) || !roots.length || typeof maintenance !== 'boolean')
    throw new TypeError('domains require nonempty roots and an explicit maintenance mode')
  if (!roles || typeof roles !== 'object' || Array.isArray(roles) || Object.keys(roles).some(root => !roots.includes(root)))
    throw new TypeError('directory roles require selected roots')
  const pins = []
  const coordination = []
  let admission = []
  let occupancy = []
  let state = 'guarded'
  try {
    const coordinator = native.pin(coordinatorPath, false)
    coordination.push(coordinator)
    const coordinatorBinding = binding(native, coordinator, coordinatorPath)
    const bindings = [coordinatorBinding]
    const coordinatorLineage = [coordinatorBinding.identity, ...coordinatorBinding.ancestors]
    const selected = new Set()
    const selectedRoles = new Map()
    const readers = new Map()
    const ancestors = new Set()
    for (const root of roots) {
      const role = roles[root] ?? 'private'
      if (!['private', 'project'].includes(role)) throw new TypeError('invalid directory role')
      const pin = native.pin(root, false, role)
      pins.push(pin)
      const current = binding(native, pin, root, role)
      bindings.push(current)
      readers.set(root, pin)
      const { identity } = current
      if (
        coordinatorLineage.includes(identity) ||
        current.ancestors.includes(coordinatorBinding.identity)
      )
        throw new Error('coordination directory must remain outside every data root')
      if (selectedRoles.has(identity) && selectedRoles.get(identity) !== role)
        throw new TypeError('conflicting directory roles')
      selectedRoles.set(identity, role)
      selected.add(identity)
      for (const ancestor of current.ancestors) ancestors.add(ancestor)
    }
    const plan = [...new Set([...ancestors, ...selected])]
      .sort()
      .map((identity) => [
        identity,
        selected.has(identity)
          ? maintenance
            ? 'exclusive'
            : 'shared'
          : maintenance
            ? 'maintainIntent'
            : 'intent',
      ])
    admission = acquire(native, coordinator, plan, 'admission')
    revalidate(native, bindings)
    const failedOccupancy = (error) => {
      if (error.code === 'ERR_LEASE_BUSY') {
        try {
          releaseAll(native, occupancy)
        } catch (releaseError) {
          state = 'uncertain'
          throw releaseError
        }
        state = 'guarded'
      } else {
        state = ['ERR_LEASE_RELEASE', 'ERR_DOMAIN_RELEASE'].includes(error.code)
          ? 'uncertain'
          : 'failed'
      }
      throw error
    }
    const startOccupancy = () => {
      if (state !== 'guarded') throw new Error('domain occupancy requires guarded admission')
      occupancy = acquire(native, coordinator, plan, 'occupancy')
      revalidate(native, bindings)
      state = 'authorizing'
    }
    const finishOccupancy = (owned = {}) => {
      if (maintenance) {
        checkFamilies(native, coordinator, coordinatorBinding, plan, owned)
        revalidate(native, bindings)
      }
      state = 'occupied'
    }
    return Object.freeze({
      reserveMutation(owner) {
        if (!maintenance || state !== 'occupied')
          throw new Error('mutation reservation requires exclusive admission')
        const failed = (error) => {
          state = ['ERR_LEASE_RELEASE', 'ERR_DOMAIN_RELEASE'].includes(error.code)
            ? 'uncertain'
            : 'failed'
          throw error
        }
        try {
          revalidate(native, bindings)
          const reservation = barriers.reserve(
            native,
            coordinator,
            coordinatorBinding,
            bindings.slice(1),
            owner
          )
          revalidate(native, bindings)
          return Object.freeze({
            finish() {
              if (state !== 'occupied')
                throw new Error('mutation retirement requires exclusive admission')
              try {
                revalidate(native, bindings)
                reservation.finish()
                revalidate(native, bindings)
              } catch (error) {
                failed(error)
              }
            },
          })
        } catch (error) {
          failed(error)
        }
      },
      checkWritable() {
        if (state !== 'occupied') throw new Error('write check requires occupied admission')
        try {
          revalidate(native, bindings)
          barriers.check(native, coordinator, coordinatorBinding, bindings.slice(1))
          revalidate(native, bindings)
        } catch (error) {
          failedOccupancy(error)
        }
      },
      check() {
        if (state !== 'occupied') throw new Error('domain check requires occupied admission')
        try {
          revalidate(native, bindings)
        } catch (error) {
          failedOccupancy(error)
        }
      },
      read(root, name, maxBytes) {
        if (state !== 'occupied') throw new Error('domain read requires occupied admission')
        try {
          if (!readers.has(root))
            throw new Error('domain read requires an explicitly selected root')
          revalidate(native, bindings)
          const bytes = native.readAt(readers.get(root), name, maxBytes)
          revalidate(native, bindings)
          return bytes
        } catch (error) {
          state = ['ERR_LEASE_RELEASE', 'ERR_DOMAIN_RELEASE'].includes(error.code)
            ? 'uncertain'
            : 'failed'
          // Convert native close uncertainty without relinquishing any domain
          // qualification. Ordinary read errors also forbid subsequent admit().
          cleanup(native, [], error)
        }
      },
      occupy() {
        if (state !== 'guarded') throw new Error('domain occupancy requires guarded admission')
        try {
          startOccupancy()
          finishOccupancy()
        } catch (error) {
          failedOccupancy(error)
        }
      },
      async occupyFamily(authorize) {
        if (!maintenance || state !== 'guarded' || typeof authorize !== 'function')
          throw new Error('family qualification requires guarded maintenance')
        try {
          startOccupancy()
          // Obtain a fresh original-Job grant only after exclusive activity is
          // held. A stored manifest or a previously cached grant cannot enter.
          const owned = await authorize(
            bindings.slice(1).map((value) => ({
              ...value,
              ancestors: [...value.ancestors],
            }))
          )
          if (
            !owned ||
            typeof owned !== 'object' ||
            Array.isArray(owned) ||
            !Object.keys(owned).length ||
            Object.entries(owned).some(
              ([name, value]) =>
                !/^[a-f0-9]{64}$/.test(name) ||
                typeof value !== 'string' ||
                !/^[a-f0-9]{64}$/.test(value)
            )
          )
            throw new Error('invalid original-family grant')
          revalidate(native, bindings)
          finishOccupancy(owned)
        } catch (error) {
          failedOccupancy(error)
        }
      },
      admit() {
        if (maintenance || state !== 'occupied')
          throw new Error('only an occupied writer can open admission')
        state = 'failed'
        try {
          revalidate(native, bindings)
          barriers.check(native, coordinator, coordinatorBinding, bindings.slice(1))
          revalidate(native, bindings)
          releaseAll(native, admission)
          state = 'admitted'
        } catch (error) {
          if (error.code === 'ERR_DOMAIN_RELEASE') state = 'uncertain'
          throw error
        }
      },
      close() {
        if (state === 'closed') throw new Error('domains already closed')
        if (state === 'authorizing')
          throw new Error('join family authorization before closing domains')
        if (state === 'uncertain')
          throw Object.assign(new Error('uncertain domain release requires process exit'), {
            code: 'ERR_DOMAIN_RELEASE',
          })
        state = 'closed'
        // Each successful predecessor is required before relinquishing the next
        // capability. On uncertain close retain remaining leases until death.
        try {
          releaseAll(native, pins)
          releaseAll(native, occupancy)
          releaseAll(native, admission)
          releaseAll(native, coordination)
        } catch (error) {
          state = 'uncertain'
          throw error
        }
      },
    })
  } catch (error) {
    cleanup(native, [pins, occupancy, admission, coordination], error)
  }
}

/** Create/open one direct child under IS qualification, never recursive maintenance. */
function createDirectory(native, coordinatorPath, parentPath, name, role = 'private') {
  const coordination = []
  const pins = []
  let admission = []
  let occupancy = []
  let identity
  try {
    const coordinator = native.pin(coordinatorPath, false)
    coordination.push(coordinator)
    const parent = native.pin(parentPath, false, role)
    pins.push(parent)
    const coordinatorBinding = binding(native, coordinator, coordinatorPath)
    const parentBinding = binding(native, parent, parentPath, role)
    const bindings = [coordinatorBinding, parentBinding]
    const plan = [...new Set([parentBinding.identity, ...parentBinding.ancestors])]
      .sort()
      .map((value) => [value, 'intent'])
    admission = acquire(native, coordinator, plan, 'admission')
    revalidate(native, bindings)
    occupancy = acquire(native, coordinator, plan, 'occupancy')
    revalidate(native, bindings)
    // Directory preparation is itself a namespace mutation. A crashed data
    // migration must block mkdir as well as subsequent business-file writes.
    barriers.check(native, coordinator, coordinatorBinding, [parentBinding])
    revalidate(native, bindings)
    // Native checks a single child name and resolves it against the held parent,
    // not a new pathname walk. No seed, recursive merge, rename or removal here.
    identity = native.createChild(parent, name)
    revalidate(native, bindings)
    const childPath = path.join(parentPath, name)
    const child = native.pin(childPath, false, role)
    pins.push(child)
    const selected = binding(native, child, childPath, role)
    if (selected.identity !== identity)
      throw Object.assign(new Error('created directory was replaced'), {
        code: 'ERR_DOMAIN_CHANGED',
      })
    if ([coordinatorBinding.identity, ...coordinatorBinding.ancestors].includes(identity))
      throw new Error('coordination directory must remain outside every data root')
    revalidate(native, [...bindings, selected])
  } catch (error) {
    cleanup(native, [pins, occupancy, admission, coordination], error)
  }
  cleanup(native, [pins, occupancy, admission, coordination])
  return identity
}

/**
 * Prepare only caller-authorized directory structure. Each missing level gets
 * fresh, sorted IS qualification. This returns no writer or migration authority;
 * callers must resample the pointer and begin all final domains afterwards.
 */
function ensureDirectories(native, coordinatorPath, roots, roles = {}) {
  if (!Array.isArray(roots) || !roots.length)
    throw new TypeError('directory preparation requires nonempty roots')
  // Reject structural ambiguity before any creation, including invalid suffixes
  // hidden behind a missing prefix. Native remains the ACL/volume authority.
  const planned = roots.map((root) => {
    if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root))
      throw new TypeError('directory preparation requires absolute paths')
    const prefix = path.parse(root).root
    const components = root.slice(prefix.length).split(process.platform === 'win32' ? /[\\/]/ : '/')
    if (
      root !== prefix &&
      components.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          (process.platform === 'win32' && (part.includes(':') || /[. ]$/.test(part)))
      )
    )
      throw new TypeError('directory preparation rejects ambiguous path components')
    return { root, limit: components.length }
  })
  for (const { root, limit } of planned) {
    let complete = false
    for (let step = 0; step <= limit; step++) {
      let ancestor = root
      let child
      for (;;) {
        let pin
        try {
          pin = native.pin(ancestor, false, roles[root] ?? 'private')
        } catch (error) {
          if (error.code !== 'ERR_LEASE_MISSING') cleanup(native, [], error)
          const parent = path.dirname(ancestor)
          if (parent === ancestor) throw error
          child = path.basename(ancestor)
          ancestor = parent
          continue
        }
        releaseAll(native, [pin])
        break
      }
      if (ancestor === root) {
        complete = true
        break
      }
      createDirectory(native, coordinatorPath, ancestor, child, roles[root] ?? 'private')
    }
    if (!complete)
      throw Object.assign(new Error('directory structure changed during preparation'), {
        code: 'ERR_DOMAIN_CHANGED',
      })
  }
}

module.exports = { beginDomains, createDirectory, ensureDirectories }
