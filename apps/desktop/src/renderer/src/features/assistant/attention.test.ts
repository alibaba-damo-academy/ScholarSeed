import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import type { AttentionSnapshot } from '../../../../attention.ts'

test('attention preserves snapshot identity and subscribers for repeated versions', async () => {
  let incoming: AttentionSnapshot = {
    epoch: 'first',
    revision: 2,
    unread_count: 0,
    by_session: {},
    items: [],
  }
  let notifications = 0
  let readSnapshot: () => AttentionSnapshot
  let cleanup: (() => void) | undefined
  const output = await build({
    entryPoints: [fileURLToPath(new URL('./attention.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'attention-boundaries',
        setup(builder) {
          builder.onResolve(
            { filter: /^react$|^\.\.\/\.\.\/(store|app\/api\/client)$/ },
            (args) => ({ path: args.path, namespace: 'attention-test' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'attention-test' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'react'
                ? 'export const { useEffect, useRef, useSyncExternalStore } = probe'
                : args.path.endsWith('/store')
                  ? 'export function useApp() { return { state: { serviceInstanceId: "service" } } }; export function activeThread() { return {} }'
                  : 'export const apiFetch = probe.fetch',
          }))
        },
      },
    ],
  })
  const module = {
    exports: {} as {
      useAttention: () => AttentionSnapshot
      markInteractionAttentionRead: (session: string, request: string) => Promise<void>
      useAttentionLifecycle: () => void
    },
  }
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    clearTimeout,
    setTimeout,
    console,
    probe: {
      fetch: async () => ({ ok: true, json: async () => incoming }),
      useRef: (value: unknown) => ({ current: value }),
      useEffect: (effect: () => (() => void) | undefined) => {
        if (!cleanup) cleanup = effect()
      },
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => AttentionSnapshot
      ) => {
        if (!readSnapshot)
          subscribe(() => {
            notifications += 1
          })
        readSnapshot = getSnapshot
        return getSnapshot()
      },
    },
  })
  const publishResponse = () => module.exports.markInteractionAttentionRead('session', 'request')
  module.exports.useAttention()
  await publishResponse()
  const first = readSnapshot!()
  assert.equal(notifications, 1)

  incoming = { ...incoming, by_session: {}, items: [] }
  await publishResponse()
  assert.equal(notifications, 1)
  assert.equal(readSnapshot!(), first)

  incoming = { ...incoming, revision: 1 }
  await publishResponse()
  assert.equal(notifications, 1)
  assert.equal(readSnapshot!(), first)

  incoming = { ...incoming, revision: 3 }
  await publishResponse()
  assert.equal(notifications, 2)
  assert.equal(readSnapshot!(), incoming)

  module.exports.useAttentionLifecycle()
  cleanup?.()
  assert.equal(readSnapshot!().epoch, '')
  incoming = { ...incoming, epoch: 'second', revision: 0 }
  await publishResponse()
  assert.equal(readSnapshot!(), incoming)
  assert.equal(notifications, 4)
})
