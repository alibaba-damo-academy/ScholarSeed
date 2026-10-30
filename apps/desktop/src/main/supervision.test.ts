import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { DevelopmentSupervisor } from './supervision.ts'
import { startDevelopmentControl } from './development.ts'
import { BackendMaintenanceRejected } from './backend-control.ts'

test('development supervisor and main exchange precise idle, resume and exit receipts', async (context) => {
  const parent = new DevelopmentSupervisor()
  context.after(() => parent.close())
  const input = new PassThrough()
  const generation = 'c'.repeat(32)
  const events: string[] = []
  let busy = true
  const pending = startDevelopmentControl({
    enabled: true,
    input,
    quiesceIfIdle: async () => (busy ? null : generation),
    resume: async (value) => {
      assert.equal(value, generation)
      events.push('resume')
    },
    exit: () => {
      events.push('exit')
    },
  })
  input.end(await parent.listen())
  const client = await pending
  context.after(() => client?.close())
  await assert.rejects(parent.quiesceIfIdle(), BackendMaintenanceRejected)
  busy = false
  assert.equal(await parent.quiesceIfIdle(), generation)
  await parent.resume(generation)
  assert.equal(await parent.quiesceIfIdle(), generation)
  await parent.exit(generation)
  assert.deepEqual(events, ['resume', 'exit'])
})

test('development exit rejects invalid generations before opening a connection', async (context) => {
  const parent = new DevelopmentSupervisor()
  context.after(() => parent.close())
  await assert.rejects(parent.exit('invalid'), /invalid development maintenance generation/)
})
