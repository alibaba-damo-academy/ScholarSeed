import assert from 'node:assert/strict'
import test from 'node:test'
import { PreferenceQuiescence, type PreferenceShutdownRequest } from './quiescence.ts'
import {
  PREFERENCE_SUBMISSION_SOURCE,
  type PreferenceSubmission,
} from './preference-diagnostics.ts'

const submission: PreferenceSubmission = {
  writerId: '12345678-1234-1234-1234-123456789012',
  submissionSources: [PREFERENCE_SUBMISSION_SOURCE.explicit],
  changedFields: ['theme'],
  submittedRevision: 1,
}

test('quiescence waits for the current renderer receipt and fences later writes', async () => {
  const requests: PreferenceShutdownRequest[] = []
  const owner = new PreferenceQuiescence((request) => requests.push(request))
  owner.register()
  await owner.save(submission, async () => {})
  const waiting = owner.prepare()
  assert.equal(waiting, owner.prepare())
  assert.equal(
    owner.accept({
      requestId: 2,
      ok: true,
      writerId: submission.writerId,
      acknowledgedRevision: 1,
    }),
    false
  )
  assert.equal(
    owner.accept({
      requestId: 1,
      ok: true,
      writerId: submission.writerId,
      acknowledgedRevision: 0,
    }),
    false
  )
  assert.equal(
    owner.accept({
      requestId: 1,
      ok: true,
      writerId: submission.writerId,
      acknowledgedRevision: 1,
    }),
    true
  )
  await waiting
  await assert.rejects(
    owner.save(submission, async () => assert.fail('late write')),
    /ERR_PREFERENCES_FROZEN/
  )
  assert.deepEqual(requests, [{ requestId: 1, mode: 'shutdown' }])
})

test('failure cancels shutdown and the next attempt rejects stale replies', async () => {
  const requests: PreferenceShutdownRequest[] = []
  const owner = new PreferenceQuiescence((request) => requests.push(request))
  owner.register()
  const first = owner.prepare()
  owner.accept({ requestId: 1, ok: false })
  await assert.rejects(first, /ERR_PREFERENCES_UNSAVED/)
  owner.resume()
  await owner.save(submission, async () => {})
  const second = owner.prepare()
  assert.equal(
    owner.accept({
      requestId: 1,
      ok: true,
      writerId: submission.writerId,
      acknowledgedRevision: 1,
    }),
    false
  )
  owner.accept({ requestId: 2, ok: true, writerId: submission.writerId, acknowledgedRevision: 1 })
  await second
  assert.deepEqual(requests, [
    { requestId: 1, mode: 'shutdown' },
    null,
    { requestId: 2, mode: 'shutdown' },
  ])
})

test('unresponsive renderer times out without accepting a shutdown barrier', async () => {
  const owner = new PreferenceQuiescence(() => {})
  owner.register()
  await assert.rejects(owner.prepare(5), /ERR_PREFERENCES_TIMEOUT/)
  owner.resume()
  await owner.save(submission, async () => {})
})

test('an outstanding main write prevents premature acknowledgment after renderer replacement', async () => {
  const owner = new PreferenceQuiescence(() => {})
  owner.register()
  let release!: () => void
  const saving = owner.save(
    submission,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const waiting = owner.prepare()
  assert.equal(
    owner.accept({ requestId: 1, ok: true, writerId: 'replacement', acknowledgedRevision: 0 }),
    false
  )
  release()
  await saving
  owner.accept({ requestId: 1, ok: true, writerId: submission.writerId, acknowledgedRevision: 1 })
  await waiting
})

test('startup before a renderer registers does not require a nonexistent receipt', async () => {
  const owner = new PreferenceQuiescence(() => assert.fail('no renderer'))
  await owner.prepare()
})

test('a failed save operation never advances the main receipt version', async () => {
  const owner = new PreferenceQuiescence(() => {})
  await assert.rejects(
    owner.save(submission, async () => {
      throw new Error('projection failed')
    })
  )
  assert.equal(owner.acknowledged(submission.writerId), 0)
})

test('maintenance keeps controls available until exit upgrades the same saved barrier', async () => {
  const requests: PreferenceShutdownRequest[] = []
  const owner = new PreferenceQuiescence((request) => requests.push(request))
  owner.register()
  const saved = owner.prepare(undefined, 'maintenance')
  owner.accept({ requestId: 1, ok: true, writerId: 'renderer', acknowledgedRevision: 0 })
  await saved
  await assert.rejects(
    owner.save(undefined, async () => {}),
    /ERR_PREFERENCES_FROZEN/
  )
  assert.equal(owner.prepare(), saved)
  assert.equal(owner.prepare(undefined, 'maintenance'), saved)
  assert.deepEqual(requests, [
    { requestId: 1, mode: 'maintenance' },
    { requestId: 1, mode: 'shutdown' },
  ])
  owner.resume()
  await owner.save(undefined, async () => {})
  assert.equal(requests.at(-1), null)
})
