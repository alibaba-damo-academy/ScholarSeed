import type { TFunction } from 'i18next'

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
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
