import { dirname } from 'node:path'
import {
  systemRendererPreferences,
  sanitizeRendererPreferences,
  persistedRendererPreferences,
  isPreferenceLanguage,
  SYSTEM_LANGUAGE_MODE,
  type PreferenceLanguage,
  type RendererPreferences,
} from '../preferences.ts'
import type { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { readRecord, writeJson } from './journal.ts'
import { desktopDirectoryWriter } from './writer.ts'
import { decodeRendererPreferences, RENDERER_PREFERENCES_MAX_BYTES } from './preferences-record.ts'

export function readPreferences(
  filename: string,
  detected: PreferenceLanguage
): RendererPreferences {
  try {
    return decodeRendererPreferences(readRecord(filename, RENDERER_PREFERENCES_MAX_BYTES), detected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return systemRendererPreferences(detected)
    throw error
  }
}

export function savePreferences(
  filename: string,
  detected: PreferenceLanguage,
  value: unknown,
  diagnostics: PreferenceDiagnostics
): RendererPreferences {
  const preferences = diagnostics.runSync('validate', () => {
    const projected =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Partial<RendererPreferences>)
        : undefined
    const previous = diagnostics.runSync('read', () => readPreferences(filename, detected))
    const language =
      previous.languageMode === SYSTEM_LANGUAGE_MODE
        ? isPreferenceLanguage(projected?.language)
          ? projected.language
          : previous.language
        : detected
    return {
      ...sanitizeRendererPreferences(value, language),
      browserAutomationEnabled: previous.browserAutomationEnabled,
    }
  })
  return writePreferences(filename, preferences, diagnostics)
}

export function writePreferences(
  filename: string,
  preferences: RendererPreferences,
  diagnostics: PreferenceDiagnostics
): RendererPreferences {
  const record = persistedRendererPreferences(preferences)
  diagnostics.runSync('validate', () =>
    decodeRendererPreferences(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
  )
  const writer = diagnostics.runSync('acquire', () => desktopDirectoryWriter(dirname(filename)))
  try {
    diagnostics.runSync('write', () =>
      writeJson(filename, record, (event) =>
        diagnostics.recordWrite(event, {
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          node: process.versions.node,
          electron: process.versions.electron,
          uv: process.versions.uv,
        })
      )
    )
  } finally {
    diagnostics.runSync('release', () => writer.close())
  }
  return preferences
}
