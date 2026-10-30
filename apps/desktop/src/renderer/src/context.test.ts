import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('context consumption refreshes only after durable queue completion', async (context) => {
  const originalWindow = globalThis.window
  globalThis.window = Object.assign(new EventTarget(), {
    location: { origin: 'http://context.test' },
  }) as Window & typeof globalThis
  context.after(() => { globalThis.window = originalWindow })
  const desktop = fileURLToPath(new URL('../../../', import.meta.url))
  const directory = mkdtempSync(join(desktop, 'node_modules/.context-events-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, 'events.mjs')
  await build({
    stdin: {
      contents: "export { onEvent } from './src/renderer/src/live.ts'",
      resolveDir: desktop,
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [
      {
        name: 'unused-hook-boundary',
        setup(builder) {
          builder.onLoad({ filter: /[/\\]store\.tsx$/ }, () => ({
            contents:
              'export function useApp() { throw new Error("Hook not used by event projection") }',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const { onEvent } = await import(pathToFileURL(output).href)
  const refreshed: string[] = []
  let thread = { queuedMessages: [{ queuedMessageId: 'message' }], conversation: [] }
  const project = (type: string, reason?: string) =>
    onEvent(
      'thread',
      {
        type,
        session_id: 'session',
        turn_id: 'turn',
        ts: 1,
        data: { queued_message_id: 'message', reason },
      },
      (_id: string, patch: typeof thread | ((current: typeof thread) => typeof thread)) => {
        thread = { ...thread, ...(typeof patch === 'function' ? patch(thread) : patch) }
      },
      () => {},
      { current: {} },
      { current: () => {} },
      () => {},
      () => {},
      (sessionId: string) => refreshed.push(sessionId),
      () => {},
      false
    )
  project('turn_completed')
  assert.deepEqual(refreshed, [])
  assert.equal(thread.queuedMessages.length, 1)
  project('message_removed', 'completed')
  assert.deepEqual(refreshed, ['session'])
  assert.deepEqual(thread.queuedMessages, [])
  refreshed.length = 0
  project('send_now_accepted')
  assert.deepEqual(refreshed, [])
  project('message_removed', 'cancelled')
  assert.deepEqual(refreshed, ['session'])
})
