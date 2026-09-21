import assert from 'node:assert/strict'
import test from 'node:test'
import type { TFunction } from 'i18next'

import { activityDurationLabel, elapsedLabel, turnDurationLabel } from './duration.ts'

const translate = ((key: string, options?: { count?: number; minutes?: number; seconds?: number }) => {
  if (key === 'stream.seconds') return `${options?.count} ${options?.count === 1 ? 'second' : 'seconds'}`
  if (key === 'stream.minutesSeconds') return `${options?.minutes} min ${options?.seconds} sec`
  if (key === 'stream.minutes') return `${options?.count} ${options?.count === 1 ? 'minute' : 'minutes'}`
  throw new Error(`Unexpected translation key: ${key}`)
}) as TFunction<'components'>

test('activity duration displays subsecond groups as one second without changing longer timing', () => {
  assert.equal(activityDurationLabel(1000, 1000, translate), '1 second')
  assert.equal(activityDurationLabel(1000, 1999, translate), '1 second')
  assert.equal(activityDurationLabel(1000, 2000, translate), '1 second')
  assert.equal(activityDurationLabel(1000, 2999, translate), '1 second')
  assert.equal(activityDurationLabel(1000, 3000, translate), '2 seconds')
  assert.equal(activityDurationLabel(1000, 61000, translate), '1 minute')
})

test('other elapsed-time labels retain their zero-second behavior', () => {
  assert.equal(elapsedLabel(1000, 1999, translate), '0 seconds')
})

test('turn duration uses compact English units', () => {
  assert.equal(turnDurationLabel(1000, 4800), '3.8s')
  assert.equal(turnDurationLabel(1000, 39100), '38.1s')
  assert.equal(turnDurationLabel(1000, 62100), '1m 1s')
  assert.equal(turnDurationLabel(1000, 3662000), '1h 1m 1s')
})
