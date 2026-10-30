// Durable mutation reservations share the physical hierarchy used by domains.
// Ordinary writers cannot enter an interrupted mutation after its volatile X
// lease disappears. Only the same maintenance owner may resume its exact intent.
const path = require('node:path')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const INDEX = 'mutations-v1'
const MAX_RECORDS = 4096
const MAX_BYTES = 1024 * 1024

function close(native, handles) {
  while (handles.length) {
    try {
      native.release(handles.pop())
    } catch (error) {
      throw Object.assign(new AggregateError([error], 'mutation record release uncertain'), {
        code: 'ERR_DOMAIN_RELEASE',
      })
    }
  }
}
function busy() {
  return Object.assign(new Error('unfinished mutation prevents data admission'), {
    code: 'ERR_LEASE_BUSY',
  })
}
function plan(bindings) {
  const selected = new Set(bindings.map((value) => value.identity))
  return [...new Set(bindings.flatMap((value) => [value.identity, ...value.ancestors]))]
    .sort()
    .map((identity) => [identity, selected.has(identity)])
}
function bucket(native, coordinatorPath, coordinatorIdentity, identity, scope, create, held) {
  const names = [INDEX, identity.replaceAll(':', '-'), scope]
  let current = coordinatorPath
  let parent = native.pin(current, false)
  held.push(parent)
  if (native.lineage(parent).at(-1) !== coordinatorIdentity)
    throw new Error('mutation coordinator changed')
  for (const name of names) {
    if (create) native.createChild(parent, name)
    current = path.join(current, name)
    try {
      parent = native.pin(current, false)
    } catch (error) {
      if (!create && error.code === 'ERR_LEASE_MISSING') return null
      throw error
    }
    held.push(parent)
    if (!native.lineage(parent).includes(coordinatorIdentity))
      throw new Error('mutation index moved outside coordinator')
  }
  return { pin: parent, path: current }
}
function visit(native, coordinator, location, identity, scopes, create, operation) {
  const handles = []
  let failure
  try {
    handles.push(
      native.acquireAt(coordinator, `${identity.replaceAll(':', '-')}-mutations`, create)
    )
    for (const scope of scopes) {
      const directory = bucket(
        native,
        location.path,
        location.identity,
        identity,
        scope,
        create,
        handles
      )
      if (directory) operation(directory)
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (!['ERR_LEASE_RELEASE', 'ERR_DOMAIN_RELEASE'].includes(failure?.code)) close(native, handles)
  }
}
function check(native, coordinator, location, bindings, own) {
  for (const [identity, selected] of plan(bindings)) {
    visit(
      native,
      coordinator,
      location,
      identity,
      selected ? ['self', 'descendants'] : ['self'],
      false,
      ({ pin }) => {
        const records = native.listAt(pin, MAX_RECORDS, MAX_BYTES)
        for (const [name, bytes] of Object.entries(records)) {
          if (!own || name !== own.name || !Buffer.isBuffer(bytes) || !bytes.equals(own.bytes))
            throw busy()
        }
      }
    )
  }
}
function targets(bindings) {
  const roots = new Set(bindings.map((value) => value.identity))
  const ancestors = new Set(bindings.flatMap((value) => value.ancestors))
  return [...new Set([...roots, ...ancestors])]
    .sort()
    .map((identity) => [
      identity,
      [
        ...(roots.has(identity) ? ['self'] : []),
        ...(ancestors.has(identity) ? ['descendants'] : []),
      ],
    ])
}
function reserve(native, coordinator, location, bindings, owner) {
  if (typeof owner !== 'string' || !owner.length || Buffer.byteLength(owner) > 16 * 1024)
    throw new Error('invalid mutation recovery owner')
  const bytes = Buffer.from(JSON.stringify({ version: 1, owner, bindings }))
  if (bytes.length > MAX_BYTES) throw new Error('mutation intent exceeds limit')
  const name = createHash('sha256').update(bytes).digest('hex')
  const own = { name, bytes }
  // A different interrupted transaction is never silently replaced or deleted.
  check(native, coordinator, location, bindings, own)
  const entries = targets(bindings)
  for (const [identity, scopes] of entries) {
    visit(native, coordinator, location, identity, scopes, true, ({ pin }) => {
      const previous = native.readAt(pin, name, MAX_BYTES)
      if (previous === null) native.createAt(pin, name, bytes)
      else if (!previous.equals(bytes)) throw busy()
    })
  }
  let finished = false
  return Object.freeze({
    finish() {
      if (finished) throw new Error('mutation reservation already finished')
      // Call only after the owning transaction has committed and finished its
      // synchronous writes. Missing records permit interrupted cleanup to resume.
      for (const [identity, scopes] of entries) {
        visit(native, coordinator, location, identity, scopes, true, ({ pin, path: directory }) => {
          const previous = native.readAt(pin, name, MAX_BYTES)
          if (previous === null) return
          if (!previous.equals(bytes)) throw busy()
          fs.unlinkSync(path.join(directory, name))
          if (process.platform !== 'win32') {
            const fd = fs.openSync(directory, 'r')
            try {
              fs.fsyncSync(fd)
            } finally {
              fs.closeSync(fd)
            }
          }
        })
      }
      finished = true
    },
  })
}
module.exports = { check, reserve }
