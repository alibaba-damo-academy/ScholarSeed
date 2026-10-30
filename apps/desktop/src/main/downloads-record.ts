import { isAbsolute } from 'node:path'

export interface DownloadPreferencesRecord {
  directoryOverride: string | null
  askEveryTime: boolean
}

/** Shared reader for stored preferences; paths are values, never accessed here. */
export function decodeDownloadPreferences(raw: string): DownloadPreferencesRecord {
  const value: unknown = JSON.parse(raw)
  let directoryOverride: string | null = null
  let askEveryTime = true
  if (
    value &&
    typeof value === 'object' &&
    'directoryOverride' in value &&
    typeof value.directoryOverride === 'string' &&
    isAbsolute(value.directoryOverride)
  ) {
    directoryOverride = value.directoryOverride
  }
  if (
    value &&
    typeof value === 'object' &&
    'askEveryTime' in value &&
    typeof value.askEveryTime === 'boolean'
  )
    askEveryTime = value.askEveryTime
  return { directoryOverride, askEveryTime }
}
