import assert from 'node:assert/strict'
import test from 'node:test'
import { webSearchPresentation } from '../../activity.ts'
import { TOOL_MATERIAL_STATES, toolMaterial } from './tools.ts'

test('tool materials expose every adopted data state without executing tools', () => {
  assert.deepEqual(TOOL_MATERIAL_STATES, [
    'running',
    'streaming',
    'completed',
    'failed',
    'paused',
    'search',
  ])
  for (const state of TOOL_MATERIAL_STATES) {
    const sample = toolMaterial(state, (key) => key, 100_000)
    assert.equal(sample.readOnly, true)
    assert.equal(sample.conversation?.filter((item) => item.kind === 'user').length, 1)
    assert.ok(
      Object.values(sample.turnTimings ?? {}).every((timing) => timing.startedAt <= 100_000)
    )
  }
})

test('streaming keeps the process running after all tools complete; tool failure does not fail the turn', () => {
  const streaming = toolMaterial('streaming', (key) => key, 100_000)
  assert.equal(streaming.running, true)
  assert.ok(
    streaming.conversation
      ?.filter((item) => item.kind === 'tool')
      .every((item) => item.status === 'done')
  )
  const failed = toolMaterial('failed', (key) => key, 100_000)
  assert.equal(Object.values(failed.turnOutcomes ?? {})[0], 'completed')
})

test('paused material preserves the recorded user-stop reason and terminal timing', () => {
  const sample = toolMaterial('paused', (key) => key, 100_000)
  const notice = sample.conversation?.find((item) => item.kind === 'status')
  assert.equal(notice?.kind === 'status' && notice.interruptionReason, 'user_interrupt')
  assert.equal(Object.values(sample.turnOutcomes ?? {})[0], 'interrupted')
  assert.equal(Object.values(sample.turnTimings ?? {})[0].completedAt, 100_000)
})

test('search material uses the shared preview and expansion policy without mutating results', () => {
  const sample = toolMaterial('search', (key) => key, 100_000)
  const search = sample.conversation?.find((item) => item.kind === 'web_search')
  assert.equal(search?.kind, 'web_search')
  if (search?.kind !== 'web_search') return
  assert.equal(webSearchPresentation(search, false).results.length, 3)
  assert.equal(webSearchPresentation(search, true).results.length, 6)
  assert.equal(webSearchPresentation(search, false).queries.length, 3)
  assert.equal(search.results.length, 6)
})
