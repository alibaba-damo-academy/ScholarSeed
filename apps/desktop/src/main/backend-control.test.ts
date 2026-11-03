import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import {
  BackendControl,
  type BackendConnectionDiagnostic,
  type BackendControlEvent,
  BackendMaintenanceRejected,
  observeBackendControl,
} from './backend-control.ts'

const COMPILER_RESOURCES = {
  version: '2026-r3',
  archiveSha256: 'a'.repeat(64),
  fontDirectories: ['/verified/fonts'],
}

test('toolchain rejects inconsistent receipts and UTF-8 oversized descriptors before writing', async () => {
  const control = new BackendControl()
  try {
    await assert.rejects(control.toolchain(true), /invalid toolchain/)
    await assert.rejects(control.toolchain(false, COMPILER_RESOURCES), /invalid toolchain/)
    await assert.rejects(
      control.toolchain(true, {
        ...COMPILER_RESOURCES,
        fontDirectories: ['/' + '字'.repeat(1500)],
      }),
      /command too large/
    )
  } finally {
    control.close()
  }
})

test(
  'toolchain snapshots resources before asynchronous connection and accepts failure without resources',
  { timeout: 10_000 },
  async (t) => {
    const control = new BackendControl()
    t.after(() => control.close())
    const bootstrap = JSON.parse((await control.listen()).toString())
    const resources = { ...COMPILER_RESOURCES, fontDirectories: ['/verified/fonts'] }
    const pending = control.toolchain(true, resources)
    resources.fontDirectories[0] = '/mutated'
    const peer = createConnection(bootstrap.port, '127.0.0.1')
    t.after(() => peer.destroy())
    await once(peer, 'connect')
    let input = ''
    const commands: unknown[] = []
    peer.on('data', (bytes) => {
      input += bytes.toString()
      let end: number
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end)
        input = input.slice(end + 1)
        if (line === 'ready') continue
        commands.push(JSON.parse(line))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(1)
        peer.write(Buffer.concat([header, Buffer.from([1])]))
      }
    })
    peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
    await pending
    await control.toolchain(false)
    assert.deepEqual(commands, [
      { operation: 'toolchain', ready: true, resources: COMPILER_RESOURCES },
      { operation: 'toolchain', ready: false, resources: null },
    ])
  }
)

for (const first of ['toolchain', 'skill-python'] as const) {
  test(
    `toolchain receipt is authenticated and serialized with maintenance (${first} first)`,
    { timeout: 10_000 },
    async (t) => {
      const diagnostics: BackendConnectionDiagnostic[] = []
      const control = new BackendControl((message) => diagnostics.push(message))
      t.after(() => control.close())
      const bootstrap = JSON.parse((await control.listen()).toString())
      const peer = createConnection(bootstrap.port, '127.0.0.1')
      t.after(() => peer.destroy())
      await once(peer, 'connect')
      let input = ''
      const commands: object[] = []
      peer.on('data', (bytes) => {
        input += bytes.toString()
        for (let end = input.indexOf('\n'); end >= 0; end = input.indexOf('\n')) {
          const line = input.slice(0, end)
          input = input.slice(end + 1)
          if (line === 'ready') continue
          const command = JSON.parse(line)
          commands.push(command)
          const result =
            command.operation === 'quiesce'
              ? Buffer.from('\x01' + 'a'.repeat(32))
              : Buffer.from([1])
          const header = Buffer.alloc(4)
          header.writeUInt32BE(result.length)
          peer.write(Buffer.concat([header, result]))
        }
      })
      peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
      const receipts =
        first === 'toolchain'
          ? [control.toolchain(true, COMPILER_RESOURCES), control.skillPython(true)]
          : [control.skillPython(true), control.toolchain(true, COMPILER_RESOURCES)]
      const maintenance = control.quiesce()
      await Promise.all(receipts)
      assert.equal(await maintenance, 'a'.repeat(32))
      assert.ok(diagnostics.some((line) => line.event === 'authenticated'))
      assert.ok(
        diagnostics.some(
          (line) =>
            line.event === 'response_received' &&
            line.operation === 'toolchain' &&
            line.status === 1
        )
      )
      assert.ok(!JSON.stringify(diagnostics).includes(bootstrap.token))
      assert.deepEqual(commands, [
        ...(first === 'toolchain'
          ? [
              { operation: 'toolchain', ready: true, resources: COMPILER_RESOURCES },
              { operation: 'skill-python', ready: true },
            ]
          : [
              { operation: 'skill-python', ready: true },
              { operation: 'toolchain', ready: true, resources: COMPILER_RESOURCES },
            ]),
        { operation: 'quiesce', generation: null },
      ])
    }
  )
}

test(
  'private backend control rejects wrong capability and retains exact maintenance generation',
  { timeout: 10_000 },
  async (t) => {
    const diagnostics: BackendConnectionDiagnostic[] = []
    const control = new BackendControl((message) => diagnostics.push(message))
    t.after(() => control.close())
    const bootstrap = JSON.parse((await control.listen()).toString())
    const bad = createConnection(bootstrap.port, '127.0.0.1')
    t.after(() => bad.destroy())
    await once(bad, 'connect')
    bad.write(JSON.stringify({ token: '0'.repeat(64) }) + '\n')
    await once(bad, 'close')
    assert.ok(diagnostics.some((line) => line.event === 'authentication_rejected'))
    assert.ok(!JSON.stringify(diagnostics).includes('0'.repeat(64)))

    const peer = createConnection(bootstrap.port, '127.0.0.1')
    t.after(() => peer.destroy())
    await once(peer, 'connect')
    peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
    let input = ''
    let greeting = true
    const generation = 'a'.repeat(32)
    const commands: string[] = []
    peer.on('data', (bytes) => {
      input += bytes.toString()
      let end: number
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end)
        input = input.slice(end + 1)
        if (greeting) {
          assert.equal(line, 'ready')
          greeting = false
          continue
        }
        const command = JSON.parse(line)
        commands.push(command.operation)
        const response = ['quiesce', 'quiesce_if_idle', 'prepare_update'].includes(
          command.operation
        )
          ? Buffer.concat([Buffer.from([1]), Buffer.from(generation, 'ascii')])
          : Buffer.from([1])
        if (command.operation === 'resume') assert.equal(command.generation, generation)
        const size = Buffer.alloc(4)
        size.writeUInt32BE(response.length)
        peer.write(size.subarray(0, 2))
        peer.write(Buffer.concat([size.subarray(2), response]))
      }
    })
    assert.equal(await control.quiesce(), generation)
    await control.resume(generation)
    assert.equal(await control.quiesceIfIdle(), generation)
    await control.resume(generation)
    assert.equal(await control.prepareUpdate(), generation)
    await control.resume(generation)
    assert.deepEqual(commands, [
      'quiesce',
      'resume',
      'quiesce_if_idle',
      'resume',
      'prepare_update',
      'resume',
    ])
  }
)

test(
  'closing private backend control settles a waiting maintenance request',
  { timeout: 10_000 },
  async () => {
    const control = new BackendControl()
    await control.listen()
    const pending = control.quiesce()
    control.close()
    await assert.rejects(pending, /control closed/)
  }
)

test('only an exact no-maintenance refusal permits retry', { timeout: 10_000 }, async (t) => {
  for (const [operation, method] of [
    ['quiesce', 'quiesce'],
    ['quiesce_if_idle', 'quiesceIfIdle'],
    ['prepare_update', 'prepareUpdate'],
  ] as const) {
    for (const [name, response, retryable] of [
      ['refused', Buffer.from([0]), true],
      ['retained', Buffer.from([2]), false],
      ['malformed', Buffer.from([0, 0]), false],
    ] as const) {
      await t.test(`${operation}: ${name}`, async (t) => {
        const control = new BackendControl()
        t.after(() => control.close())
        const bootstrap = JSON.parse((await control.listen()).toString())
        const peer = createConnection(bootstrap.port, '127.0.0.1')
        t.after(() => peer.destroy())
        await once(peer, 'connect')
        peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
        let input = ''
        peer.on('data', (bytes) => {
          input += bytes.toString()
          let end: number
          while ((end = input.indexOf('\n')) >= 0) {
            const line = input.slice(0, end)
            input = input.slice(end + 1)
            if (line === 'ready') continue
            assert.equal(JSON.parse(line).operation, operation)
            const size = Buffer.alloc(4)
            size.writeUInt32BE(response.length)
            peer.write(Buffer.concat([size, response]))
          }
        })
        await assert.rejects(control[method](), (error: unknown) => {
          assert.equal(error instanceof BackendMaintenanceRejected, retryable)
          return true
        })
        if (retryable) await assert.rejects(control[method](), BackendMaintenanceRejected)
      })
    }
  }
})

test('maintenance diagnostics contain only categories and never alter ownership', async () => {
  const generation = 'b'.repeat(32)
  const events: unknown[] = []
  const refusal = new BackendMaintenanceRejected('private error text')
  let rejected = false
  const observed = observeBackendControl(
    {
      async quiesce() {
        if (rejected) throw refusal
        return generation
      },
      async prepareUpdate() {
        assert.fail('update preparation was not requested')
      },
      async resume() {
        throw new Error('private resume detail')
      },
    },
    (event) => {
      events.push(event)
      throw new Error('diagnostic writer failed')
    }
  )
  assert.equal(await observed.quiesce(), generation)
  rejected = true
  await assert.rejects(observed.quiesce(), (error: unknown) => error === refusal)
  await assert.rejects(observed.resume(generation), /private resume detail/)
  const text = JSON.stringify(events)
  assert.ok(text.includes('quiesce_refused'))
  assert.ok(text.includes('resume_unknown'))
  for (const privateValue of ['private error text', 'private resume detail', generation])
    assert.ok(!text.includes(privateValue))
  assert.equal(events.length, 6)
})

test('quiesce diagnostics distinguish refusal from uncertainty without reading configuration', async () => {
  const generation = 'c'.repeat(32)
  const refusal = new BackendMaintenanceRejected('private maintenance detail')
  const unknown = new Error('private transport detail')
  const events: unknown[] = []
  let failure: Error | null = null
  const observed = observeBackendControl(
    {
      async quiesce() {
        if (failure) throw failure
        return generation
      },
      async prepareUpdate() {
        assert.fail('update preparation was not requested')
      },
      async resume() {},
    },
    (event) => {
      events.push(event)
    }
  )
  assert.equal(await observed.quiesce(), generation)
  failure = refusal
  await assert.rejects(observed.quiesce(), (error: unknown) => error === refusal)
  failure = unknown
  await assert.rejects(observed.quiesce(), (error: unknown) => error === unknown)
  const serialized = JSON.stringify(events)
  assert.ok(serialized.includes('quiesce_refused'))
  assert.ok(serialized.includes('quiesce_unknown'))
  for (const value of [
    generation,
    refusal.message,
    unknown.message,
    'capture_refused',
    'capture_unknown',
  ])
    assert.ok(!serialized.includes(value))
  assert.equal(events.length, 6)
})

test('update preparation diagnostics distinguish refusal from uncertainty without exposing generation', async () => {
  const generation = 'd'.repeat(32)
  const refusal = new BackendMaintenanceRejected('private update preparation detail')
  const unknown = new Error('private transport detail')
  const events: unknown[] = []
  let failure: Error | null = null
  const observed = observeBackendControl(
    {
      async quiesce() {
        assert.fail('update preparation must not quiesce attachments')
      },
      async prepareUpdate() {
        if (failure) throw failure
        return generation
      },
      async resume() {},
    },
    (event) => events.push(event)
  )
  assert.equal(await observed.prepareUpdate(), generation)
  failure = refusal
  await assert.rejects(observed.prepareUpdate(), (error: unknown) => error === refusal)
  failure = unknown
  await assert.rejects(observed.prepareUpdate(), (error: unknown) => error === unknown)
  const serialized = JSON.stringify(events)
  assert.ok(serialized.includes('prepare-update'))
  assert.ok(serialized.includes('prepare_update_refused'))
  assert.ok(serialized.includes('prepare_update_unknown'))
  for (const value of [generation, refusal.message, unknown.message])
    assert.ok(!serialized.includes(value))
  assert.equal(events.length, 6)
})

for (const [stage, method, refusalCode, unknownCode] of [
  ['quiesce', 'quiesce', 'quiesce_refused', 'quiesce_unknown'],
  ['prepare-update', 'prepareUpdate', 'prepare_update_refused', 'prepare_update_unknown'],
  ['resume', 'resume', 'resume_unknown', 'resume_unknown'],
] as const) {
  for (const [failureKind, expectedCode] of [
    ['refused', refusalCode],
    ['unknown', unknownCode],
  ] as const) {
    test(`${stage} ${failureKind} diagnostics preserve exact categories and errors`, async () => {
      const generation = 'e'.repeat(32)
      const failure =
        failureKind === 'refused'
          ? new BackendMaintenanceRejected(`private ${stage} refusal detail`)
          : new Error(`private ${stage} transport detail`)
      const events: BackendControlEvent[] = []
      const failOperation = async (): Promise<never> => {
        throw failure
      }
      const observed = observeBackendControl(
        {
          quiesce: failOperation,
          prepareUpdate: failOperation,
          async resume(receivedGeneration) {
            assert.equal(receivedGeneration, generation)
            throw failure
          },
        },
        (event) => events.push(event)
      )
      await assert.rejects(
        () => (method === 'resume' ? observed.resume(generation) : observed[method]()),
        (error: unknown) => error === failure
      )
      assert.deepEqual(
        events.map((event) => ({
          stage: event.stage,
          event: event.event,
          result: event.result,
          errorCode: event.errorCode,
        })),
        [
          { stage, event: 'started', result: 'started', errorCode: '' },
          { stage, event: 'finished', result: 'failed', errorCode: expectedCode },
        ]
      )
      const serialized = JSON.stringify(events)
      for (const privateValue of [generation, failure.message])
        assert.ok(!serialized.includes(privateValue))
    })
  }
}

test(
  'update preparation rejects a success receipt without an exact generation',
  { timeout: 10_000 },
  async (context) => {
    for (const response of [
      Buffer.from([1]),
      Buffer.from('\x01' + 'a'.repeat(31)),
      Buffer.from('\x01' + 'A'.repeat(32)),
    ]) {
      await context.test(`receipt length=${response.length}`, async (context) => {
        const control = new BackendControl()
        context.after(() => control.close())
        const bootstrap = JSON.parse((await control.listen()).toString())
        const peer = createConnection(bootstrap.port, '127.0.0.1')
        context.after(() => peer.destroy())
        await once(peer, 'connect')
        peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
        let input = ''
        peer.on('data', (bytes) => {
          input += bytes.toString()
          for (let end = input.indexOf('\n'); end >= 0; end = input.indexOf('\n')) {
            const line = input.slice(0, end)
            input = input.slice(end + 1)
            if (line === 'ready') continue
            assert.deepEqual(JSON.parse(line), { operation: 'prepare_update', generation: null })
            const size = Buffer.alloc(4)
            size.writeUInt32BE(response.length)
            peer.write(Buffer.concat([size, response]))
          }
        })
        await assert.rejects(control.prepareUpdate(), /maintenance invalid/)
        await assert.rejects(control.quiesce(), /control unavailable|control closed/)
      })
    }
  }
)

test(
  'cold startup can authenticate after the maintenance connection deadline',
  { timeout: 10_000 },
  async (t) => {
    const control = new BackendControl()
    t.after(() => control.close())
    const bootstrap = JSON.parse((await control.listen()).toString())
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const receipt = control.toolchain(true, COMPILER_RESOURCES)
    void receipt.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    t.mock.timers.tick(40_001)
    t.mock.timers.reset()
    const peer = createConnection(bootstrap.port, '127.0.0.1')
    t.after(() => peer.destroy())
    // A late peer must still be able to authenticate; no token or authority changes.
    await once(peer, 'connect')
    let input = ''
    peer.on('data', (bytes) => {
      input += bytes.toString()
      for (let end = input.indexOf('\n'); end >= 0; end = input.indexOf('\n')) {
        const line = input.slice(0, end)
        input = input.slice(end + 1)
        if (line === 'ready') continue
        assert.deepEqual(JSON.parse(line), {
          operation: 'toolchain',
          ready: true,
          resources: COMPILER_RESOURCES,
        })
        peer.write(Buffer.from([0, 0, 0, 1, 1]))
      }
    })
    peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
    await receipt
  }
)

test('startup owner closure settles an unauthenticated toolchain receipt', async () => {
  const control = new BackendControl()
  await control.listen()
  const pending = control.toolchain(true, COMPILER_RESOURCES)
  control.close()
  await assert.rejects(pending, /control closed/)
})

test('maintenance connection still has a deadline', async (t) => {
  const control = new BackendControl()
  t.after(() => control.close())
  await control.listen()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = control.quiesce()
  const rejected = assert.rejects(pending, /connection_timeout/)
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(40_001)
  await rejected
})

test(
  'authenticated toolchain request still has a response deadline',
  { timeout: 10_000 },
  async (t) => {
    const control = new BackendControl()
    t.after(() => control.close())
    const bootstrap = JSON.parse((await control.listen()).toString())
    const peer = createConnection(bootstrap.port, '127.0.0.1')
    t.after(() => peer.destroy())
    await once(peer, 'connect')
    peer.write(JSON.stringify({ token: bootstrap.token }) + '\n')
    await once(peer, 'data') // authenticated ready greeting
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = control.toolchain(true, COMPILER_RESOURCES)
    const rejected = assert.rejects(pending, /response_timeout/)
    await Promise.resolve()
    await Promise.resolve()
    t.mock.timers.tick(40_001)
    await rejected
  }
)

test('control diagnostics retain closed categories without bootstrap secrets', async () => {
  const events: unknown[] = []
  const control = new BackendControl((event) => events.push(event))
  const bootstrap = JSON.parse((await control.listen()).toString())
  control.close('startup_timeout')
  control.close('response_timeout')
  const serialized = JSON.stringify(events)
  assert.ok(serialized.includes('startup_timeout'))
  assert.equal(serialized.includes(bootstrap.token), false)
  assert.equal(events.filter((event) => (event as { event: string }).event === 'closed').length, 1)
})

test('a failed diagnostic observer cannot break control shutdown', async () => {
  const control = new BackendControl(() => {
    throw new Error('observer-only failure')
  })
  await control.listen()
  assert.doesNotThrow(() => control.close('startup_timeout'))
})
