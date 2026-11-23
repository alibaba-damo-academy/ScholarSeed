import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STARTUP_TASK_RECOVERY_MS, StartupTaskRecovery } from './startup.ts'

test('startup recovery shares one deadline through reading and presentation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const outcomes: string[] = []
  const attempt = new StartupTaskRecovery((outcome) => outcomes.push(outcome), Date.now)
  t.mock.timers.tick(STARTUP_TASK_RECOVERY_MS - 1)
  assert.equal(attempt.current, true)
  t.mock.timers.tick(1)
  assert.equal(attempt.current, false)
  assert.equal(attempt.signal.aborted, true)
  attempt.finish('restored')
  assert.deepEqual(outcomes, ['timeout'])
})

for (const outcome of ['failed', 'skipped', 'restored'] as const) {
  test(`startup recovery settles ${outcome} once and cancels outstanding reads`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const outcomes: string[] = []
    const attempt = new StartupTaskRecovery((result) => outcomes.push(result), Date.now)
    attempt.finish(outcome)
    assert.equal(attempt.current, false)
    assert.equal(attempt.signal.aborted, true)
    t.mock.timers.tick(STARTUP_TASK_RECOVERY_MS)
    attempt.finish('restored')
    assert.deepEqual(outcomes, [outcome])
  })
}

test('an overdue response cannot win while the timeout callback is waiting to run', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const outcomes: string[] = []
  const start = Date.now()
  const attempt = new StartupTaskRecovery((outcome) => outcomes.push(outcome), Date.now)
  t.mock.timers.setTime(start + STARTUP_TASK_RECOVERY_MS)
  assert.equal(attempt.current, false)
  attempt.finish('restored')
  assert.deepEqual(outcomes, ['timeout'])
})
