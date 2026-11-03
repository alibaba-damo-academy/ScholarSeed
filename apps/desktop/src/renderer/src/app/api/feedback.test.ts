import assert from 'node:assert/strict'
import test from 'node:test'
import { submitFeedback } from '../../api.ts'
import { reportApiFailure, flushApiDiagnostics } from './diagnostics.ts'

test('feedback flushes duplicate summaries before collecting consented diagnostics', async (context) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const previousInfo = console.info
  const records: string[] = []
  console.info = (...values) => {
    records.push(values.join(' '))
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      scholarseed: {
        getApiBase: () => '',
        submitFeedback: async (input: { includeLogs: boolean }) => {
          if (!input.includeLogs) return { ok: true, id: 'local' }
          assert.equal(records.length, 2, 'summary must reach the sink before collection starts')
          assert.match(records[1], /"suppressedCount":1/)
          return { ok: true, id: 'local' }
        },
      },
    },
  })
  context.after(() => {
    flushApiDiagnostics()
    console.info = previousInfo
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  for (let index = 0; index < 2; index += 1)
    reportApiFailure('/api/serve/model-profiles', 'GET', 503, 0, 'http')
  globalThis.fetch = async () => Response.json({ id: 'local' })
  assert.deepEqual(
    await submitFeedback({ description: 'test', includeLogs: false, includeTrace: false }),
    { ok: true, id: 'local' }
  )
  assert.equal(records.length, 1, 'no-consent submission must not flush the diagnostic buffer')
  assert.deepEqual(
    await submitFeedback({ description: 'test', includeLogs: true, includeTrace: false }),
    { ok: true, id: 'local' }
  )
  assert.equal(records.length, 2)
})
