import type { TFunction } from 'i18next'

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR
const MILLISECONDS_PER_TENTH_SECOND = 100
const MINIMUM_ACTIVITY_SECONDS = 1

export function elapsedLabel(
  startedAt: number,
  now: number,
  t: TFunction<'components'>
): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / MILLISECONDS_PER_SECOND))
  if (seconds < SECONDS_PER_MINUTE) return t('stream.seconds', { count: seconds })
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const rest = seconds % SECONDS_PER_MINUTE
  return rest
    ? t('stream.minutesSeconds', { minutes, seconds: rest })
    : t('stream.minutes', { count: minutes })
}

export function activityDurationLabel(
  startedAt: number,
  endedAt: number,
  t: TFunction<'components'>
): string {
  if (endedAt - startedAt < MILLISECONDS_PER_SECOND) {
    return t('stream.seconds', { count: MINIMUM_ACTIVITY_SECONDS })
  }
  return elapsedLabel(startedAt, endedAt, t)
}

export function turnDurationLabel(
  startedAt: number,
  endedAt: number
): string {
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
    seconds > 0 ? `${seconds}s` : ''
  ].filter(Boolean).join(' ')
}
