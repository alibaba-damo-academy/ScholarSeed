import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { chmod, mkdtemp, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ChromiumPipe, ChromiumProtocolError, launchChromiumPipe, trustedChromiumExecutable } from './chromium.ts'

const fixture = new URL('./chromium.fixture.mjs', import.meta.url)
const FIXTURE_STARTUP_TIMEOUT_MS = 10_000

async function fixtureProcess(mode = 'normal') {
  const child = spawn(process.execPath, [fileURLToPath(fixture), mode], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc'] })
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(FIXTURE_STARTUP_TIMEOUT_MS) })
    assert.deepEqual(message, { ready: true })
    return child
  } catch (error) {
    child.kill()
    throw error
  }
}

test('pipe transport correlates NUL-framed replies and emits events', async () => {
  const child = await fixtureProcess()
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 1_000 })
  try {
    const events: string[] = []
    pipe.onEvent(message => events.push(message.method))
    const first = pipe.command('Browser.getVersion')
    const second = pipe.command('Target.getTargets')
    assert.deepEqual(await first, { product: 'fixture' })
    assert.deepEqual(await second, { targetInfos: [] })
    assert.deepEqual(events, ['Target.targetCreated', 'Target.targetCreated'])
  } finally {
    await pipe.close()
  }
  await assert.rejects(pipe.command('Browser.getVersion'), /closed/)
})

test('pipe transport preserves Chromium protocol errors', async () => {
  const child = await fixtureProcess('protocol-error')
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 1_000 })
  try {
    await assert.rejects(pipe.command('Browser.getVersion'), error => {
      assert.ok(error instanceof ChromiumProtocolError)
      assert.equal(error.code, -32601)
      assert.deepEqual(error.data, { reason: 'fixture' })
      return true
    })
  } finally {
    await pipe.close()
  }
})

test('pipe transport rejects timeouts and unexpected exits', async () => {
  const timeoutChild = await fixtureProcess('silent')
  const timeoutPipe = new ChromiumPipe(timeoutChild, { commandTimeoutMs: 50 })
  await assert.rejects(timeoutPipe.command('Browser.getVersion'), /timed out/)
  await timeoutPipe.close()
  const crashChild = await fixtureProcess('crash')
  const crashPipe = new ChromiumPipe(crashChild, { commandTimeoutMs: 1_000 })
  await assert.rejects(crashPipe.command('Browser.getVersion'), /exited|debugging pipe/)
  await crashPipe.close()
})

test('pipe transport fails closed when Chromium closes its debugging output', async () => {
  const child = await fixtureProcess('broken')
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 1_000 })
  try {
    await assert.rejects(pipe.command('Browser.getVersion'), /debugging pipe/)
  } finally {
    await pipe.close()
  }
  assert.notEqual(child.exitCode ?? child.signalCode, null)
})

test('pipe transport rejects an oversized partial frame after a complete event', async () => {
  const child = await fixtureProcess('oversized')
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 2_000 })
  try {
    await assert.rejects(pipe.command('Browser.getVersion'), /frame exceeds limit/)
  } finally {
    await pipe.close()
  }
  assert.notEqual(child.exitCode ?? child.signalCode, null)
})

function controlledPipe() {
  const reader = new EventEmitter()
  const writer = Object.assign(new EventEmitter(), { write: () => true })
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, writer, reader], exitCode: null, signalCode: null,
    kill: () => { child.emit('exit', 0, null); return true },
  })
  return { reader, child, pipe: new ChromiumPipe(child as unknown as ChildProcess) }
}

test('fragmented frames use bounded storage and linear copies while preserving UTF-8 and event order', async () => {
  const { reader, child, pipe } = controlledPipe()
  const events: unknown[] = []
  pipe.onEvent(event => events.push(event))
  const payload = Buffer.from(JSON.stringify({ method: 'large', params: { text: '汉字'.repeat(4096) } }))
  const following = Buffer.from(JSON.stringify({ method: 'next', params: {} }) + '\0')
  const copy = Buffer.prototype.copy
  const allocate = Buffer.allocUnsafe
  let copiedBytes = 0
  let allocations = 0
  let allocatedBytes = 0
  Buffer.prototype.copy = function (...args: Parameters<typeof copy>) {
    const copied = copy.apply(this, args)
    copiedBytes += copied
    return copied
  }
  Buffer.allocUnsafe = size => {
    allocations += 1
    allocatedBytes += size
    return allocate(size)
  }
  try {
    // One-byte chunks split every multibyte UTF-8 code point. No deadline is involved.
    for (const byte of payload) reader.emit('data', Buffer.from([byte]))
    assert.ok(copiedBytes >= payload.length)
    assert.ok(allocations > 0)
    assert.ok(copiedBytes < payload.length * 3)
    assert.ok(allocatedBytes < payload.length * 4)
    assert.ok(allocations <= Math.ceil(Math.log2(payload.length)) + 1)
    reader.emit('data', Buffer.from([0]))
    reader.emit('data', following)
    assert.ok(copiedBytes < (payload.length + following.length) * 3)
    assert.deepEqual(events, [
      { method: 'large', params: { text: '汉字'.repeat(4096) }, sessionId: undefined },
      { method: 'next', params: {}, sessionId: undefined },
    ])
  } finally {
    Buffer.prototype.copy = copy
    Buffer.allocUnsafe = allocate
    child.emit('exit', 0, null)
    await pipe.close()
  }
})

test('frame byte limit is inclusive and resets after each complete frame', async () => {
  const limit = 32 * 1024 * 1024
  const { reader, child, pipe } = controlledPipe()
  const events: string[] = []
  const failures: string[] = []
  pipe.onEvent(event => events.push(event.method))
  pipe.onClose(error => failures.push(error.message))
  const prefix = Buffer.from('{"method":"boundary","params":{"text":"')
  const suffix = Buffer.from('"}}')
  try {
    reader.emit('data', prefix)
    reader.emit('data', Buffer.alloc(limit - prefix.length - suffix.length, 65))
    reader.emit('data', suffix)
    assert.deepEqual(events, [])
    reader.emit('data', Buffer.from('\0{"method":"next","params":{}}\0'))
    assert.deepEqual(events, ['boundary', 'next'])
    reader.emit('data', Buffer.alloc(limit, 65))
    assert.deepEqual(failures, [])
    reader.emit('data', Buffer.from('A'))
    assert.deepEqual(failures, ['Chromium debugging frame exceeds limit'])
  } finally {
    child.emit('exit', 0, null)
    await pipe.close()
  }
})

test('profile removal follows child exit, including a forced shutdown', async () => {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-profile-test-'))
  await writeFile(join(profileDirectory, 'marker'), 'private')
  const child = await fixtureProcess('silent')
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 50, exitTimeoutMs: 1_000, profileDirectory })
  await pipe.close()
  assert.notEqual(child.exitCode ?? child.signalCode, null)
  await assert.rejects(stat(profileDirectory), { code: 'ENOENT' })
})

test('trusted executable requires an absolute path within its explicit resource root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-test-'))
  const executable = join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome')
  try {
    await writeFile(executable, '')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    assert.equal(await trustedChromiumExecutable(executable, root), await realpath(executable))
    await assert.rejects(trustedChromiumExecutable('chrome', root), /absolute/)
    await assert.rejects(trustedChromiumExecutable(process.execPath, root), /trusted resource root/)
    if (process.platform !== 'win32') {
      await symlink(process.execPath, join(root, 'escaped'))
      await assert.rejects(trustedChromiumExecutable(join(root, 'escaped'), root), /trusted resource root/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launcher does not run an untrusted executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-test-'))
  try {
    await assert.rejects(launchChromiumPipe({ executablePath: process.execPath, trustedRoot: root,
      profile: { kind: 'temporary', parentDirectory: root } }), /trusted resource root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launcher requires explicit profile ownership and validates persistent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-profile-test-'))
  const file = join(root, 'not-a-directory')
  await writeFile(file, '')
  const executablePath = process.execPath
  const trustedRoot = dirname(executablePath)
  try {
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot } as never), /profile/i)
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'persistent', directory: 'relative' } }), /absolute/)
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'persistent', directory: file } }), /directory/)
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'persistent', directory: parse(root).root } }), /root|directory/)
    if (process.platform !== 'win32') {
      const link = join(root, 'linked-profile')
      await symlink(root, link)
      await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
        profile: { kind: 'persistent', directory: link } }), /symbolic|directory/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('temporary launcher parent is explicit and only its owned child is removed on startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-profile-test-'))
  const marker = join(root, 'keep')
  await writeFile(marker, 'keep')
  const executablePath = process.execPath
  const trustedRoot = dirname(executablePath)
  try {
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'temporary', parentDirectory: 'relative' } }), /absolute/)
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'temporary', parentDirectory: marker } }), /directory/)
    await assert.rejects(launchChromiumPipe({ executablePath, trustedRoot,
      profile: { kind: 'temporary', parentDirectory: root }, commandTimeoutMs: 1_000 }), /Chromium|debugging pipe/)
    assert.deepEqual(await readdir(root), ['keep'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('persistent launcher startup failure leaves the caller-owned directory untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-persistent-test-'))
  const marker = join(directory, 'keep')
  await writeFile(marker, 'keep')
  try {
    await assert.rejects(launchChromiumPipe({ executablePath: process.execPath,
      trustedRoot: dirname(process.execPath), profile: { kind: 'persistent', directory }, commandTimeoutMs: 1_000 }),
    /Chromium|debugging pipe/)
    assert.equal((await readdir(directory)).includes('keep'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persistent launcher does not delete caller data when shutdown also rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-persistent-test-'))
  const marker = join(directory, 'keep')
  await writeFile(marker, 'keep')
  const originalClose = ChromiumPipe.prototype.close
  ChromiumPipe.prototype.close = async function () {
    await originalClose.call(this)
    throw new Error('shutdown failed')
  }
  try {
    await assert.rejects(launchChromiumPipe({ executablePath: process.execPath,
      trustedRoot: dirname(process.execPath), profile: { kind: 'persistent', directory }, commandTimeoutMs: 1_000 }),
    /startup and shutdown failed/)
    assert.deepEqual(await readdir(directory), ['keep'])
  } finally {
    ChromiumPipe.prototype.close = originalClose
    await rm(directory, { recursive: true, force: true })
  }
})

test('temporary profile is removed after an unexpected child exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scholarseed-chromium-profile-test-'))
  const child = await fixtureProcess('crash')
  const pipe = new ChromiumPipe(child, { commandTimeoutMs: 1_000, profileDirectory: directory })
  await assert.rejects(pipe.command('Browser.getVersion'), /exited|debugging pipe/)
  await pipe.close()
  await assert.rejects(stat(directory), { code: 'ENOENT' })
})
