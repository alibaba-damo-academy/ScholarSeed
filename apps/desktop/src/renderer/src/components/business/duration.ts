import type { TFunction } from 'i18next'
import type { ActivityRunState } from '../../activity'

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR
const MILLISECONDS_PER_TENTH_SECOND = 100
const MINIMUM_ACTIVITY_SECONDS = 1
const HOURS_PER_DAY = 24
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND

export function planDurationLabel(milliseconds: number, rounding: 'down' | 'up' = 'down'): string {
  const round = rounding === 'up' ? Math.ceil : Math.floor
  const wholeSeconds =
    Math.max(0, round(milliseconds / MILLISECONDS_PER_SECOND)) * MILLISECONDS_PER_SECOND
  const days = Math.floor(wholeSeconds / MILLISECONDS_PER_DAY)
  const remainder = wholeSeconds % MILLISECONDS_PER_DAY
  if (!days) return turnDurationLabel(0, wholeSeconds)
  return remainder ? `${days}d ${turnDurationLabel(0, remainder)}` : `${days}d`
}

export function elapsedLabel(startedAt: number, now: number, t: TFunction<'components'>): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / MILLISECONDS_PER_SECOND))
  if (seconds < SECONDS_PER_MINUTE) return t('stream.seconds', { count: seconds })
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const rest = seconds % SECONDS_PER_MINUTE
  return rest
    ? t('stream.minutesSeconds', { minutes, seconds: rest })
    : t('stream.minutes', { count: minutes })
}

export function activityDurationLabel(startedAt: number, endedAt: number): string {
  const seconds = Math.max(
    MINIMUM_ACTIVITY_SECONDS,
    Math.floor((endedAt - startedAt) / MILLISECONDS_PER_SECOND)
  )
  return turnDurationLabel(0, seconds * MILLISECONDS_PER_SECOND)
}

export function activitySummaryState(
  runState: ActivityRunState,
  stateLabel: string,
  duration: string | null,
  t: TFunction<'components'>
): string {
  if (runState === 'running') {
    return duration ?? ''
  }
  if (runState === 'completed') {
    return duration ? t('stream.durationOnly', { duration }) : ''
  }
  return duration ? t('stream.durationState', { state: stateLabel, duration }) : stateLabel
}

export function turnDurationLabel(startedAt: number, endedAt: number): string {
  const elapsedMilliseconds = Math.max(0, endedAt - startedAt)
  if (elapsedMilliseconds < SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND) {
    const seconds = Math.round(elapsedMilliseconds / MILLISECONDS_PER_TENTH_SECOND) / 10
    return `${seconds}s`
  }
  const totalSeconds = Math.floor(elapsedMilliseconds / MILLISECONDS_PER_SECOND)
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 ? `${seconds}s` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
