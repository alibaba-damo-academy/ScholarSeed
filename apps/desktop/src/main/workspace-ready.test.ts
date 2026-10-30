import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { WORKSPACE_READY_SCRIPT, waitForWorkspaceReady, workspaceReady } from './workspace-ready.ts'

for (const [name, complete, body, controls, loading, expected] of [
  ['loaded HTML is insufficient', true, false, false, false, false],
  ['workspace skeleton is insufficient', true, true, false, false, false],
  ['loading overlay blocks readiness', true, true, true, true, false],
  ['document still loading', false, true, true, false, false],
  ['real workspace and navigation controls', true, true, true, false, true],
] as const) {
  test(name, async () => {
    const document = {
      readyState: complete ? 'complete' : 'loading',
      querySelector: (selector: string) =>
        selector === '.vds-workspace-body'
          ? body
            ? { querySelector: () => (controls ? {} : null) }
            : null
          : selector.includes('progress-screen') && loading
            ? {}
            : null,
    }
    assert.equal(
      await vm.runInNewContext(WORKSPACE_READY_SCRIPT, {
        document,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback: () => void) => {
          callback()
          return 1
        },
        cancelAnimationFrame: () => {},
      }),
      expected
    )
  })
}

test('requires stable readiness and restarts after a regression or probe failure', async () => {
  const samples = [false, true, false, true, new Error('navigation'), true, true]
  let time = 0
  let calls = 0
  const result = await waitForWorkspaceReady(
    async () => {
      const value = samples[calls++]
      if (value instanceof Error) throw value
      return value as boolean
    },
    100,
    10,
    () => time,
    async (ms) => {
      time += ms
    }
  )
  assert.equal(result, true)
  assert.equal(calls, 7)
})

test('times out without accepting a final isolated ready sample', async () => {
  let time = 0
  assert.equal(
    await waitForWorkspaceReady(
      async () => time === 20,
      30,
      10,
      () => time,
      async (ms) => {
        time += ms
      }
    ),
    false
  )
})

test('renderer failure and non-boolean values fail closed', async () => {
  assert.equal(
    await workspaceReady({
      executeJavaScript: async () => {
        throw new Error('gone')
      },
    }),
    false
  )
  assert.equal(await workspaceReady({ executeJavaScript: async () => 'true' }), false)
})

test('readiness waits across two frames and rejects a loading regression before painting', async () => {
  const frames: Array<() => void> = []
  let loading = false
  const document = {
    readyState: 'complete',
    querySelector: (selector: string) => selector === '.vds-workspace-body'
      ? { querySelector: () => ({}) }
      : selector.includes('progress-screen') && loading ? {} : null,
  }
  let resolved = false
  const pending = vm.runInNewContext(WORKSPACE_READY_SCRIPT, {
    document, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
  }).then((value: boolean) => { resolved = true; return value })
  await Promise.resolve()
  assert.equal(resolved, false)
  frames.shift()!()
  await Promise.resolve()
  assert.equal(resolved, false)
  loading = true
  frames.shift()!()
  assert.equal(await pending, false)
})
