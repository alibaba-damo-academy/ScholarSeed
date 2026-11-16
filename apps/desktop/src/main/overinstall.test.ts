import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import { listenForSetupExit, setupExitPipe } from './overinstall.ts'

async function fixture(t: test.TestContext, actions: Parameters<typeof listenForSetupExit>[1]) {
  const directory = mkdtempSync(join(tmpdir(), 'setup-'))
  const endpoint =
    process.platform === 'win32' ? setupExitPipe(directory) : join(directory, 'exit.sock')
  const server = await listenForSetupExit(endpoint, actions)
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  return async (request = 'prepare\n') => {
    const socket = createConnection(endpoint)
    let result = ''
    socket.on('data', (chunk) => {
      result += chunk.toString()
      if (result === 'ready\n') socket.write('commit\n')
    })
    socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write(request)
    await once(socket, 'close')
    return result
  }
}

test('pipe identity is scoped to installation and ignores Windows case', () => {
  assert.equal(setupExitPipe('C:\\Apps\\书深\\'), setupExitPipe('c:\\apps\\书深'))
  assert.notEqual(setupExitPipe('C:\\Apps\\one'), setupExitPipe('C:\\Apps\\two'))
  assert.match(setupExitPipe('C:\\Apps\\one'), /^\\\\\.\\pipe\\scholarseed-setup-[a-f0-9]{64}$/)
})

test('confirmation and clean preparation precede ready and exit', async (t) => {
  const calls: string[] = []
  const request = await fixture(t, {
    confirm: async () => {
      calls.push('confirm')
      return true
    },
    prepare: async (signal) => {
      signal.throwIfAborted()
      calls.push('prepare')
    },
    recover: async () => {
      calls.push('recover')
    },
    exit: () => {
      calls.push('exit')
    },
    failed: (error) => assert.fail(String(error)),
  })
  assert.equal(await request(), 'ready\n')
  assert.deepEqual(calls, ['confirm', 'prepare', 'exit'])
})

test('cancel preserves running application', async (t) => {
  const request = await fixture(t, {
    confirm: async () => false,
    prepare: async () => assert.fail('prepared after cancel'),
    recover: async () => assert.fail('recovered after cancel'),
    exit: () => assert.fail('quit after cancel'),
    failed: (error) => assert.fail(String(error)),
  })
  assert.equal(await request(), 'cancelled\n')
})

test('failed preparation recovers and never sends ready', async (t) => {
  let recovered = false
  const failures: unknown[] = []
  const request = await fixture(t, {
    confirm: async () => true,
    prepare: async () => {
      throw new Error('owned family still running')
    },
    recover: async () => {
      recovered = true
    },
    exit: () => assert.fail('unsafe quit'),
    failed: (error) => failures.push(error),
  })
  assert.equal(await request(), 'failed\n')
  assert.equal(recovered, true)
  assert.equal(failures.length, 1)
})

test('malformed requests cannot prompt or quit', async (t) => {
  const request = await fixture(t, {
    confirm: async () => assert.fail('malformed request prompted'),
    prepare: async () => assert.fail(),
    recover: async () => assert.fail(),
    exit: () => assert.fail(),
    failed: (error) => assert.fail(String(error)),
  })
  assert.equal(await request('prepare\nextra'), '')
})

test('a coordinator lost after preparation recovers without exiting', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-lost-'))
  const endpoint =
    process.platform === 'win32' ? setupExitPipe(directory) : join(directory, 'exit.sock')
  let recovered!: () => void
  const recovery = new Promise<void>((resolve) => {
    recovered = resolve
  })
  const server = await listenForSetupExit(endpoint, {
    confirm: async () => true,
    prepare: async () => {},
    recover: async () => {
      recovered()
    },
    exit: () => assert.fail('lost coordinator authorized exit'),
    failed: () => {},
  })
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  const socket = createConnection(endpoint)
  socket.on('error', () => {})
  socket.on('data', () => socket.destroy())
  await once(socket, 'connect')
  socket.write('prepare\n')
  await recovery
})

test('concurrent installers cannot share a shutdown confirmation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-busy-'))
  const endpoint =
    process.platform === 'win32' ? setupExitPipe(directory) : join(directory, 'exit.sock')
  let prompted!: () => void
  const prompt = new Promise<void>((resolve) => {
    prompted = resolve
  })
  let decline!: (value: boolean) => void
  const confirmation = new Promise<boolean>((resolve) => {
    decline = resolve
  })
  const server = await listenForSetupExit(endpoint, {
    confirm: async () => {
      prompted()
      return confirmation
    },
    prepare: async () => assert.fail(),
    recover: async () => assert.fail(),
    exit: () => assert.fail(),
    failed: (error) => assert.fail(String(error)),
  })
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  const first = createConnection(endpoint)
  first.resume()
  await once(first, 'connect')
  first.write('prepare\n')
  await prompt
  const second = createConnection(endpoint)
  let response = ''
  second.on('data', (chunk) => {
    response += chunk.toString()
  })
  await once(second, 'connect')
  second.write('prepare\n')
  await once(second, 'close')
  assert.equal(response, 'busy\n')
  decline(false)
  await once(first, 'close')
})
