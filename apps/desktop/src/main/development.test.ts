import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { startDevelopmentControl } from './development.ts'

const GENERATION = 'a'.repeat(32)

async function fixture(
  context: test.TestContext,
  callbacks: {
    quiesceIfIdle?: () => Promise<string | null>
    resume?: (generation: string) => Promise<void>
    prepareExit?: () => Promise<void>
    exit?: () => void
  } = {},
  timeoutMs = 500
) {
  const input = new PassThrough()
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const accepted = once(server, 'connection')
  const started = startDevelopmentControl({
    enabled: true,
    input,
    timeoutMs,
    quiesceIfIdle: async () => GENERATION,
    resume: async () => {},
    exit: () => {},
    ...callbacks,
  })
  input.write(JSON.stringify({ version: 1, port: address.port, token: 'b'.repeat(64) }) + '\n')
  const [socket] = (await accepted) as [Socket]
  const [greeting] = await once(socket, 'data')
  assert.equal(greeting.toString(), JSON.stringify({ token: 'b'.repeat(64) }) + '\n')
  socket.write('ready\n')
  const control = await started
  assert.ok(control)
  context.after(() => {
    control.close()
    socket.destroy()
    server.close()
    input.destroy()
  })
  const request = async (operation: string, generation: string | null = null) => {
    const received = once(socket, 'data')
    socket.write(JSON.stringify({ operation, generation }) + '\n')
    const [frame] = (await received) as [Buffer]
    assert.equal(frame.readUInt32BE(0), frame.length - 4)
    return frame.subarray(4)
  }
  return { socket, control, request }
}

test('bootstrap rejects duplicate keys, extra fields, oversize and absent input within deadline', async () => {
  const identity = { version: 1, port: 1, token: 'b'.repeat(64) }
  for (const raw of [
    JSON.stringify(identity).replace('{', '{"version":1,'),
    JSON.stringify({ ...identity, extra: true }),
    'x'.repeat(4097),
    null,
  ]) {
    const input = new PassThrough()
    const started = startDevelopmentControl({
      enabled: true,
      input,
      timeoutMs: 20,
      quiesceIfIdle: async () => assert.fail(),
      resume: async () => assert.fail(),
      exit: () => assert.fail(),
    })
    if (raw !== null) input.write(raw + '\n')
    await assert.rejects(started)
    assert.equal(input.listenerCount('data'), 0)
    input.destroy()
  }
})

test('disabled control never reads inherited input or calls owners', async () => {
  const input = new PassThrough()
  const unavailable = async () => {
    throw new Error('must not run')
  }
  assert.equal(
    await startDevelopmentControl({
      enabled: false,
      input,
      quiesceIfIdle: unavailable,
      resume: unavailable,
      exit: () => assert.fail(),
    }),
    null
  )
  assert.equal(input.listenerCount('data'), 0)
  input.destroy()
})

test('idle generation is owned until exact resume and busy is an exact refusal', async (context) => {
  let attempts = 0
  const resumed: string[] = []
  const session = await fixture(context, {
    quiesceIfIdle: async () => (++attempts === 1 ? null : GENERATION),
    resume: async (generation) => {
      resumed.push(generation)
    },
  })
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from([0]))
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from('\x01' + GENERATION))
  assert.deepEqual(await session.request('resume', 'c'.repeat(32)), Buffer.from([2]))
  assert.deepEqual(await session.request('resume', GENERATION), Buffer.from([1]))
  assert.deepEqual(resumed, [GENERATION])
})

test('owner failure remains unknown and never authorizes a fresh idle attempt', async (context) => {
  let attempts = 0
  const session = await fixture(context, {
    quiesceIfIdle: async () => {
      attempts++
      throw new Error('private detail')
    },
  })
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from([2]))
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from([2]))
  assert.equal(attempts, 1)
})

test('exit requires the owned generation and writes its receipt before requesting quit', async (context) => {
  let exited = false
  const session = await fixture(context, {
    exit: () => {
      exited = true
    },
  })
  assert.deepEqual(await session.request('exit', GENERATION), Buffer.from([2]))
  assert.equal(exited, false)
  await session.request('quiesce_if_idle')
  assert.deepEqual(await session.request('exit', GENERATION), Buffer.from([1]))
  assert.equal(exited, true)
})

test('disconnect does not guess resume for a granted generation', async (context) => {
  let resumed = false
  const session = await fixture(context, {
    resume: async () => {
      resumed = true
    },
  })
  await session.request('quiesce_if_idle')
  session.socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(resumed, false)
})

test('unknown and duplicate-key commands do not call maintenance owners', async (context) => {
  let calls = 0
  const session = await fixture(context, {
    quiesceIfIdle: async () => {
      calls++
      return null
    },
  })
  assert.deepEqual(await session.request('unsupported'), Buffer.from([2]))
  const received = once(session.socket, 'data')
  session.socket.write(
    '{"operation":"quiesce_if_idle","operation":"quiesce_if_idle","generation":null}\n'
  )
  const [frame] = (await received) as [Buffer]
  assert.deepEqual(frame.subarray(4), Buffer.from([2]))
  assert.equal(calls, 0)
})

test('maintenance deadline yields unknown and cannot revive authority on late completion', async (context) => {
  let settle!: (generation: string) => void
  let calls = 0
  const session = await fixture(
    context,
    {
      quiesceIfIdle: () => {
        calls++
        return new Promise((resolve) => {
          settle = resolve
        })
      },
    },
    30
  )
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from([2]))
  settle(GENERATION)
  assert.deepEqual(await session.request('quiesce_if_idle'), Buffer.from([2]))
  assert.equal(calls, 1)
})

test('pipelined commands never invoke owners concurrently', async (context) => {
  let calls = 0
  const session = await fixture(context, {
    quiesceIfIdle: async () => {
      calls++
      return GENERATION
    },
  })
  const closed = once(session.socket, 'close')
  session.socket.write('{"operation":"quiesce_if_idle","generation":null}\n'.repeat(2))
  await closed
  assert.equal(calls, 0)
})

test('a concurrent command closes the channel without guessing cancellation or resume', async (context) => {
  let started!: () => void
  let settle!: (generation: string) => void
  const invoked = new Promise<void>((resolve) => {
    started = resolve
  })
  let calls = 0
  let resumes = 0
  const session = await fixture(context, {
    quiesceIfIdle: () => {
      calls++
      started()
      return new Promise((resolve) => {
        settle = resolve
      })
    },
    resume: async () => {
      resumes++
    },
  })
  session.socket.write('{"operation":"quiesce_if_idle","generation":null}\n')
  await invoked
  const closed = once(session.socket, 'close')
  session.socket.write('{"operation":"quiesce_if_idle","generation":null}\n')
  await closed
  settle(GENERATION)
  assert.equal(calls, 1)
  assert.equal(resumes, 0)
})

test('oversized and incomplete command frames terminate only the control channel', async (context) => {
  for (const payload of ['x'.repeat(4097), '{']) {
    const session = await fixture(context, { quiesceIfIdle: async () => assert.fail() }, 30)
    const closed = once(session.socket, 'close')
    session.socket.write(payload)
    await closed
  }
})

test('resume failure retains uncertain generation and never calls exit', async (context) => {
  const session = await fixture(context, {
    resume: async () => {
      throw new Error('owner completion unproven')
    },
    exit: () => assert.fail(),
  })
  await session.request('quiesce_if_idle')
  assert.deepEqual(await session.request('resume', GENERATION), Buffer.from([2]))
  assert.deepEqual(await session.request('exit', GENERATION), Buffer.from([2]))
})

test('exit waits for exact backend completion before acknowledgement and quit', async (context) => {
  let complete!: () => void
  let entered!: () => void
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  let quit = false
  const session = await fixture(context, {
    prepareExit: () => {
      entered()
      return new Promise((resolve) => {
        complete = resolve
      })
    },
    exit: () => {
      quit = true
    },
  })
  await session.request('quiesce_if_idle')
  let acknowledged = false
  const exiting = session.request('exit', GENERATION).then((response) => {
    acknowledged = true
    return response
  })
  await preparing
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(acknowledged, false)
  assert.equal(quit, false)
  complete()
  assert.deepEqual(await exiting, Buffer.from([1]))
  assert.equal(quit, true)
})

test('failed backend exit preparation is unknown and never requests application quit', async (context) => {
  const session = await fixture(context, {
    prepareExit: async () => {
      throw new Error('backend family still live')
    },
    exit: () => assert.fail(),
  })
  await session.request('quiesce_if_idle')
  assert.deepEqual(await session.request('exit', GENERATION), Buffer.from([2]))
  assert.deepEqual(await session.request('exit', GENERATION), Buffer.from([2]))
})
