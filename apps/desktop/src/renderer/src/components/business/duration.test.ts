import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance, type TFunction } from 'i18next'

import enTasks from '../../../../localization/locales/en/tasks.json' with { type: 'json' }
import zhTasks from '../../../../localization/locales/zh/tasks.json' with { type: 'json' }

import {
  activityDurationLabel,
  activitySummaryState,
  elapsedLabel,
  planDurationLabel,
  turnDurationLabel,
} from './duration.ts'

const translate = ((
  key: string,
  options?: {
    count?: number
    minutes?: number
    seconds?: number
    state?: string
    duration?: string
  }
) => {
  if (key === 'stream.seconds')
    return `${options?.count} ${options?.count === 1 ? 'second' : 'seconds'}`
  if (key === 'stream.minutesSeconds') return `${options?.minutes} min ${options?.seconds} sec`
  if (key === 'stream.minutes')
    return `${options?.count} ${options?.count === 1 ? 'minute' : 'minutes'}`
  if (key === 'stream.durationOnly') return `Took ${options?.duration}`
  if (key === 'stream.durationState') return `${options?.state} · Took ${options?.duration}`
  throw new Error(`Unexpected translation key: ${key}`)
}) as TFunction<'components'>

test('activity duration uses whole compact seconds and retains the one-second minimum', () => {
  assert.equal(activityDurationLabel(1000, 1000), '1s')
  assert.equal(activityDurationLabel(1000, 1999), '1s')
  assert.equal(activityDurationLabel(1000, 16000), '15s')
  assert.equal(activityDurationLabel(1000, 26000), '25s')
  assert.equal(activityDurationLabel(1000, 62000), '1m 1s')
})

test('plan upper bounds round up without understating the observed interval', () => {
  assert.equal(planDurationLabel(1_999, 'up'), '2s')
  assert.equal(planDurationLabel(59_999, 'up'), '1m')
  assert.equal(planDurationLabel(86_399_999, 'up'), '1d')
})

test('plan estimated durations display only the time in both supported languages', async () => {
  const localization = createInstance()
  await localization.init({
    resources: { en: { tasks: enTasks }, zh: { tasks: zhTasks } },
    defaultNS: 'tasks',
    lng: 'zh',
  })
  for (const language of ['zh', 'en']) {
    const translateTiming = localization.getFixedT(language, 'tasks')
    for (const duration of ['24s', '2m 40s']) {
      assert.equal(translateTiming('plan.timing.upperBound', { duration }), duration)
    }
    assert.notEqual(translateTiming('plan.timing.upperBoundExplanation'), '')
    assert.notEqual(
      translateTiming('plan.timing.upperBoundExplanation'),
      'plan.timing.upperBoundExplanation'
    )
  }
})

test('other elapsed-time labels retain their zero-second behavior', () => {
  assert.equal(elapsedLabel(1000, 1999, translate), '0 seconds')
})

test('activity summary hides running and completed status without losing failure states', () => {
  assert.equal(activitySummaryState('running', 'Executing', '15s', translate), '15s')
  assert.equal(activitySummaryState('running', 'Executing', null, translate), '')
  assert.equal(activitySummaryState('completed', 'Done', '25s', translate), 'Took 25s')
  assert.equal(activitySummaryState('completed', 'Done', null, translate), '')
  assert.equal(activitySummaryState('failed', 'Failed', '25s', translate), 'Failed · Took 25s')
  assert.equal(activitySummaryState('failed', 'Failed', null, translate), 'Failed')
  assert.equal(
    activitySummaryState('interrupted', 'Cancelled', '25s', translate),
    'Cancelled · Took 25s'
  )
  assert.equal(activitySummaryState('interrupted', 'Cancelled', null, translate), 'Cancelled')
})

test('turn duration uses compact English units', () => {
  assert.equal(turnDurationLabel(1000, 4800), '3.8s')
  assert.equal(turnDurationLabel(1000, 39100), '38.1s')
  assert.equal(turnDurationLabel(1000, 62100), '1m 1s')
  assert.equal(turnDurationLabel(1000, 3662000), '1h 1m 1s')
})

test('plan duration uses whole seconds and compact day hour minute units', () => {
  assert.equal(planDurationLabel(0), '0s')
  assert.equal(planDurationLabel(59_999), '59s')
  assert.equal(planDurationLabel(60_000), '1m')
  assert.equal(planDurationLabel(1_447_000), '24m 7s')
  assert.equal(planDurationLabel(3_661_000), '1h 1m 1s')
  assert.equal(planDurationLabel(86_400_000), '1d')
  assert.equal(planDurationLabel(90_061_000), '1d 1h 1m 1s')
})
