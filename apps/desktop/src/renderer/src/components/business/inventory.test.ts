import assert from 'node:assert/strict'
import test from 'node:test'

import { inventoryRevision, reconcileInventory } from './inventory.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test('a superseded inventory read never applies its payload', async () => {
  const revision = inventoryRevision()
  const older = deferred<{ id: string } | null>()
  const newer = deferred<{ id: string } | null>()
  const applied: string[] = []

  const first = reconcileInventory(
    revision,
    () => older.promise,
    (value) => {
      applied.push(value.id)
    },
    () => {
      applied.push('failed')
    }
  )
  const second = reconcileInventory(
    revision,
    () => newer.promise,
    (value) => {
      applied.push(value.id)
    },
    () => {
      applied.push('failed')
    }
  )

  newer.resolve({ id: 'newer' })
  await second
  older.resolve({ id: 'older' })
  await first

  assert.deepEqual(applied, ['newer'])
})

test('a superseded failure never downgrades a ready page', async () => {
  const revision = inventoryRevision()
  const older = deferred<null>()
  const newer = deferred<{ id: string } | null>()
  const events: string[] = []

  const first = reconcileInventory(
    revision,
    () => older.promise,
    () => {
      events.push('apply')
    },
    () => {
      events.push('failed')
    }
  )
  const second = reconcileInventory(
    revision,
    () => newer.promise,
    () => {
      events.push('apply')
    },
    () => {
      events.push('failed')
    }
  )

  newer.resolve({ id: 'newer' })
  await second
  older.resolve(null)
  await first

  assert.deepEqual(events, ['apply'])
})

test('a catalog ticket is invalidated by a later revision bump', async () => {
  const revision = inventoryRevision()
  const catalog = deferred<{ id: string } | null>()
  const applied: string[] = []

  await reconcileInventory(
    revision,
    async () => ({ id: 'profiles' }),
    () => {
      const ticket = revision.next()
      void catalog.promise.then((value) => {
        if (revision.current(ticket) && value) applied.push(value.id)
      })
    },
    () => {
      applied.push('failed')
    }
  )

  revision.next()
  catalog.resolve({ id: 'stale-catalog' })
  await Promise.resolve()

  assert.deepEqual(applied, [])
})

test('the newest read applies, and a null read reports failure', async () => {
  const revision = inventoryRevision()
  const events: string[] = []

  await reconcileInventory(
    revision,
    async () => ({ id: 'only' }),
    (value) => {
      events.push(`apply:${value.id}`)
    },
    () => {
      events.push('failed')
    }
  )
  await reconcileInventory(
    revision,
    async () => null,
    () => {
      events.push('apply')
    },
    () => {
      events.push('failed')
    }
  )

  assert.deepEqual(events, ['apply:only', 'failed'])
})

test('a mutation receipt supersedes an in-flight read', async () => {
  const revision = inventoryRevision()
  const pending = deferred<{ id: string } | null>()
  const applied: string[] = []

  const inflight = reconcileInventory(
    revision,
    () => pending.promise,
    (value) => {
      applied.push(value.id)
    },
    () => {
      applied.push('failed')
    }
  )

  revision.next()
  applied.push('receipt')
  pending.resolve({ id: 'stale' })
  await inflight

  assert.deepEqual(applied, ['receipt'])
})

test('a superseded read without a failure handler resolves quietly', async () => {
  const revision = inventoryRevision()
  const pending = deferred<null>()
  const applied: string[] = []

  const inflight = reconcileInventory(
    revision,
    () => pending.promise,
    () => {
      applied.push('apply')
    }
  )

  revision.next()
  pending.resolve(null)
  await inflight

  assert.deepEqual(applied, [])
})

test('only the newest ticket is current, so the newest owner settles the page', () => {
  const revision = inventoryRevision()
  const first = revision.next()
  const second = revision.next()

  assert.equal(revision.current(first), false)
  assert.equal(revision.current(second), true)

  revision.next()

  assert.equal(revision.current(second), false)
})
