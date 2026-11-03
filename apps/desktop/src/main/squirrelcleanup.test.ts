import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryMacCleanup } from './squirrelcleanup.ts'

const request = {
  platform: 'darwin' as const,
  packaged: true,
  application: '/Applications/Scholar Seed.app',
  bundle: 'com.scholarseed.desktop',
}

test('cleanup dispatches only the packaged native helper and never waits on startup', async () => {
  let finish!: (value: { code: number; stderr: string }) => void
  const calls: string[][] = []
  const logs: string[] = []
  const promise = retryMacCleanup(request, () => {}, {
    execute: (executable, args) => {
      calls.push([executable, ...args])
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    delay: async () => {},
    log: (line) => logs.push(line),
  })
  await Promise.resolve()
  assert.deepEqual(calls, [
    [
      '/Applications/Scholar Seed.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt',
      '___cleanup___',
      'com.scholarseed.desktop.ShipIt',
      request.application,
    ],
  ])
  finish({ code: 0, stderr: 'unrelated private message\n[shipit-cleanup] event=complete\n' })
  assert.equal(await promise, true)
  assert.ok(logs.some((line) => line.includes('event=complete')))
  assert.ok(logs.every((line) => !line.includes('private')))
})

test('busy/failed worker retries with bounded backoff and leaves persistent work for startup', async () => {
  const delays: number[] = []
  const logs: string[] = []
  let attempts = 0
  assert.equal(
    await retryMacCleanup(request, () => {}, {
      execute: async () => {
        attempts++
        throw new Error('spawn unavailable')
      },
      delay: async (ms) => {
        delays.push(ms)
      },
      log: (line) => logs.push(line),
    }),
    false
  )
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [0, 30_000, 120_000])
  assert.ok(logs.at(-1)?.includes('retry-on-next-startup'))
})

test('successful retry stops; non-macOS and unpackaged execution have no side effects', async () => {
  let attempts = 0
  const dependencies = {
    execute: async () => ({ code: ++attempts === 2 ? 0 : 75, stderr: '' }),
    delay: async () => {},
    log: () => {},
  }
  assert.equal(await retryMacCleanup(request, () => {}, dependencies), true)
  assert.equal(attempts, 2)
  await retryMacCleanup({ ...request, platform: 'win32' }, () => {}, dependencies)
  await retryMacCleanup({ ...request, packaged: false }, () => {}, dependencies)
  await retryMacCleanup({ ...request, bundle: '../escape' }, () => {}, dependencies)
  assert.equal(attempts, 2)
})
