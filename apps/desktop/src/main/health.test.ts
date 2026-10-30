import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkbenchHealth } from './health.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function instance() {
  const ready = deferred<boolean>()
  const exited = deferred<unknown>()
  return { backend: { ready: ready.promise, exited: exited.promise }, ready, exited }
}

test('background writes require a confirmed current backend and document', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  const acknowledgement = deferred<void>()
  assert.equal(gate.confirmedFor(null), false)
  assert.equal(gate.confirmedFor(app.backend), false)
  const pending = gate.confirm(
    app.backend,
    () => true,
    () => acknowledgement.promise
  )
  app.ready.resolve(true)
  await Promise.resolve()
  assert.equal(gate.confirmedFor(app.backend), false)
  acknowledgement.resolve()
  assert.equal(await pending, true)
  assert.equal(gate.confirmedFor(app.backend), true)
  assert.equal(gate.confirmedFor(instance().backend), false)
  gate.invalidate()
  assert.equal(gate.confirmedFor(app.backend), false)
})

test('document replacement cancels pending readiness and requires a new observation', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  let commits = 0
  const old = gate.confirm(
    app.backend,
    () => true,
    () => {
      commits++
    }
  )
  gate.invalidate()
  assert.equal(await old, false)
  app.ready.resolve(true)
  assert.equal(commits, 0)
  assert.equal(
    await gate.confirm(
      app.backend,
      () => true,
      () => {
        commits++
      }
    ),
    true
  )
  assert.equal(commits, 1)
})

test('backend exit ends an unresolved readiness wait without confirming', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  const pending = gate.confirm(
    app.backend,
    () => true,
    () => assert.fail('dead backend')
  )
  app.exited.resolve(null)
  assert.equal(await pending, false)
})

test('concurrent confirmations consume once, and another backend needs its own receipt', async () => {
  const gate = new WorkbenchHealth()
  const first = instance()
  let commits = 0
  const commit = () => {
    commits++
  }
  const pending = [
    gate.confirm(first.backend, () => true, commit),
    gate.confirm(first.backend, () => true, commit),
  ]
  first.ready.resolve(true)
  assert.deepEqual(await Promise.all(pending), [true, true])
  assert.equal(commits, 1)
  const second = instance()
  second.ready.resolve(true)
  assert.equal(await gate.confirm(second.backend, () => true, commit), true)
  assert.equal(commits, 2)
})

test('replacement during readiness and failed receipt cannot become confirmed', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  let current = true
  const pending = gate.confirm(
    app.backend,
    () => current,
    () => assert.fail('stale backend')
  )
  current = false
  app.ready.resolve(true)
  assert.equal(await pending, false)
  current = true
  await assert.rejects(
    gate.confirm(
      app.backend,
      () => current,
      () => {
        throw new Error('receipt failed')
      }
    )
  )
  let commits = 0
  assert.equal(
    await gate.confirm(
      app.backend,
      () => current,
      () => {
        commits++
      }
    ),
    true
  )
  assert.equal(commits, 1)
})

test('navigation during native acknowledgement does not confirm the new document', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  app.ready.resolve(true)
  const acknowledgement = deferred<void>()
  const entered = deferred<void>()
  const pending = gate.confirm(
    app.backend,
    () => true,
    async () => {
      entered.resolve()
      await acknowledgement.promise
    }
  )
  await entered.promise
  gate.invalidate()
  acknowledgement.resolve()
  assert.equal(await pending, false)
  let observations = 0
  assert.equal(
    await gate.confirm(
      app.backend,
      () => true,
      () => {
        observations++
      }
    ),
    true
  )
  assert.equal(observations, 1)
})

test('transport sees document invalidation even when Electron reuses the same frame object', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  app.ready.resolve(true)
  const challenge = deferred<void>()
  const entered = deferred<void>()
  let sent = false
  const pending = gate.confirm(
    app.backend,
    () => true,
    async (stillCurrent) => {
      entered.resolve()
      await challenge.promise
      if (stillCurrent()) sent = true
    }
  )
  await entered.promise
  gate.invalidate()
  challenge.resolve()
  assert.equal(await pending, false)
  assert.equal(sent, false)
})

test('initial preference writes wait for the native acknowledgement, not backend readiness', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  const receipt = deferred<void>()
  const entered = deferred<void>()
  let writes = 0
  const save = gate
    .waitForConfirmation(app.backend, () => true)
    .then((accepted) => {
      if (accepted) writes++
      return accepted
    })
  app.ready.resolve(true)
  const confirmation = gate.confirm(
    app.backend,
    () => true,
    () => {
      entered.resolve()
      return receipt.promise
    }
  )
  await entered.promise
  assert.equal(writes, 0)
  receipt.resolve()
  assert.equal(await confirmation, true)
  assert.equal(await save, true)
  assert.equal(writes, 1)
  assert.equal(await gate.waitForConfirmation(app.backend, () => true), true)
  assert.equal(await gate.waitForConfirmation(app.backend, () => false), false)
})

test('navigation and backend exit cancel queued writes instead of transferring them', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  const old = gate.waitForConfirmation(app.backend, () => true)
  gate.invalidate()
  assert.equal(await old, false)
  const next = gate.waitForConfirmation(app.backend, () => true)
  app.exited.resolve(null)
  assert.equal(await next, false)
})

test('a failed acknowledgement keeps writes pending until a successful retry', async () => {
  const gate = new WorkbenchHealth()
  const app = instance()
  app.ready.resolve(true)
  let settled = false
  const save = gate
    .waitForConfirmation(app.backend, () => true)
    .then((accepted) => {
      settled = true
      return accepted
    })
  await assert.rejects(
    gate.confirm(
      app.backend,
      () => true,
      () => {
        throw new Error('receipt failed')
      }
    )
  )
  assert.equal(settled, false)
  await gate.confirm(
    app.backend,
    () => true,
    () => {}
  )
  assert.equal(await save, true)
})

test('queued writes recheck their sender and expire without a receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = new WorkbenchHealth()
  const app = instance()
  const stale = gate.waitForConfirmation(app.backend, () => false)
  app.ready.resolve(true)
  await gate.confirm(
    app.backend,
    () => true,
    () => {}
  )
  assert.equal(await stale, false)
  gate.invalidate()
  const expired = gate.waitForConfirmation(app.backend, () => true)
  t.mock.timers.tick(60_000)
  assert.equal(await expired, false)
})

test('another backend receipt cannot release a queued preference write', async () => {
  const gate = new WorkbenchHealth()
  const first = instance()
  const second = instance()
  first.ready.resolve(true)
  second.ready.resolve(true)
  let settled = false
  const save = gate
    .waitForConfirmation(first.backend, () => true)
    .then((accepted) => {
      settled = true
      return accepted
    })
  await gate.confirm(
    second.backend,
    () => true,
    () => {}
  )
  assert.equal(settled, false)
  await gate.confirm(
    first.backend,
    () => true,
    () => {}
  )
  assert.equal(await save, true)
})
