import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DEFAULT_RENDERER_PREFERENCES, PREFERENCES_SAVE_CHANNEL } from '../preferences.ts'
import { PREFERENCE_SHUTDOWN_CHANNEL, type PreferenceShutdownRequest } from '../quiescence.ts'
import {
  PREFERENCE_SUBMISSION_SOURCE,
  type PreferenceSubmission,
} from '../preference-diagnostics.ts'

test('preload verifies receipt revision and exposes only shutdown payloads to the renderer', async () => {
  const result = await build({
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  let bridge!: {
    savePreferences: (
      preferences: typeof DEFAULT_RENDERER_PREFERENCES,
      submission: PreferenceSubmission
    ) => Promise<typeof DEFAULT_RENDERER_PREFERENCES>
    onPreferenceShutdownRequest: (
      callback: (request: PreferenceShutdownRequest) => void
    ) => () => void
    respondPreferenceShutdown: (reply: unknown) => Promise<boolean>
  }
  const calls: unknown[][] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let acknowledgedRevision = 1
  runInNewContext(result.outputFiles[0].text, {
    require: () => ({
      ipcRenderer: {
        sendSync: () => ({ apiBase: '', preferences: DEFAULT_RENDERER_PREFERENCES }),
        invoke: async (...args: unknown[]) => {
          calls.push(args)
          return args[0] === PREFERENCES_SAVE_CHANNEL
            ? { preferences: DEFAULT_RENDERER_PREFERENCES, acknowledgedRevision }
            : true
        },
        on: (channel: string, handler: (...args: unknown[]) => void) =>
          listeners.set(channel, handler),
        removeListener: (channel: string) => listeners.delete(channel),
      },
      contextBridge: {
        exposeInMainWorld: (_name: string, value: typeof bridge) => {
          bridge = value
        },
      },
    }),
    process: { platform: 'darwin' },
    TextEncoder,
    TextDecoder,
  })
  const submission: PreferenceSubmission = {
    writerId: '12345678-1234-1234-1234-123456789012',
    submissionSources: [PREFERENCE_SUBMISSION_SOURCE.explicit],
    changedFields: ['theme'],
    submittedRevision: 1,
  }
  assert.equal(
    await bridge.savePreferences(DEFAULT_RENDERER_PREFERENCES, submission),
    DEFAULT_RENDERER_PREFERENCES
  )
  assert.deepEqual(calls[0], [PREFERENCES_SAVE_CHANNEL, DEFAULT_RENDERER_PREFERENCES, submission])
  acknowledgedRevision = 2
  await assert.rejects(
    bridge.savePreferences(DEFAULT_RENDERER_PREFERENCES, submission),
    /ERR_PREFERENCES_RECEIPT/
  )
  const received: unknown[] = []
  const unsubscribe = bridge.onPreferenceShutdownRequest((request) => received.push(request))
  const request = { requestId: 3, mode: 'maintenance' }
  listeners.get(PREFERENCE_SHUTDOWN_CHANNEL.request)!({ privileged: true }, request)
  assert.deepEqual(received, [request])
  unsubscribe()
  assert.equal(listeners.has(PREFERENCE_SHUTDOWN_CHANNEL.request), false)
  await bridge.respondPreferenceShutdown({ requestId: 3, ok: false })
  assert.deepEqual(calls.at(-1), [PREFERENCE_SHUTDOWN_CHANNEL.reply, { requestId: 3, ok: false }])
})
