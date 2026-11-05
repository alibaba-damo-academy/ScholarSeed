import { Buffer } from 'node:buffer'
import { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { dirname, join } from 'path'
import { desktopStorage } from './storage'

import type { PreferenceLanguage, RendererPreferences } from '../preferences'
import {
  systemRendererPreferences,
  isPreferenceLanguage,
  persistedRendererPreferences,
  sanitizeRendererPreferences,
  SYSTEM_LANGUAGE_MODE,
} from '../preferences'
import { applyMainLanguage } from './localization'
import { detectRendererLanguage } from './locale'
import { desktopDirectoryWriter } from './writer'
import { readRecord, writeJson } from './journal.ts'
import {
  decodeRendererPreferences,
  RENDERER_PREFERENCES_FILENAME,
  RENDERER_PREFERENCES_MAX_BYTES,
} from './preferences-record.ts'

function preferencesPath(): string {
  return join(desktopStorage().userData, RENDERER_PREFERENCES_FILENAME)
}

function readRendererPreferences(
  filename = preferencesPath(),
  detected: PreferenceLanguage = detectRendererLanguage()
): RendererPreferences {
  try {
    return decodeRendererPreferences(readRecord(filename, RENDERER_PREFERENCES_MAX_BYTES), detected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return systemRendererPreferences(detected)
    throw error
  }
}

export function loadRendererPreferences(): RendererPreferences {
  // Startup selection is a prerequisite, not a corrupt/missing preference file.
  const filename = preferencesPath()
  const detected = detectRendererLanguage()
  try {
    return readRendererPreferences(filename, detected)
  } catch {
    return { ...systemRendererPreferences(detected), browserAutomationEnabled: false }
  }
}

export function saveRendererPreferences(
  value: unknown,
  diagnostics = new PreferenceDiagnostics('main')
): RendererPreferences {
  const preferences = diagnostics.runSync('validate', () => {
    const projected =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Partial<RendererPreferences>)
        : undefined
    const previous = diagnostics.runSync('read', readRendererPreferences)
    let language: PreferenceLanguage
    if (previous.languageMode === SYSTEM_LANGUAGE_MODE) {
      language = isPreferenceLanguage(projected?.language) ? projected.language : previous.language
    } else {
      language = detectRendererLanguage()
    }
    return {
      ...sanitizeRendererPreferences(value, language),
      browserAutomationEnabled: previous.browserAutomationEnabled,
    }
  })
  return writeRendererPreferences(preferences, diagnostics)
}

export function saveBrowserAutomationPreference(enabled: boolean): RendererPreferences {
  const preferences = readRendererPreferences()
  return writeRendererPreferences({ ...preferences, browserAutomationEnabled: enabled })
}

function writeRendererPreferences(
  preferences: RendererPreferences,
  diagnostics = new PreferenceDiagnostics('main')
): RendererPreferences {
  const path = preferencesPath()
  const record = persistedRendererPreferences(preferences)
  // Refuse a record the actual reader cannot consume before acquiring a writer.
  diagnostics.runSync('validate', () =>
    decodeRendererPreferences(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
  )
  const writer = diagnostics.runSync('acquire', () => desktopDirectoryWriter(dirname(path)))
  try {
    diagnostics.runSync('write', () => writeJson(path, record))
  } finally {
    diagnostics.runSync('release', () => writer.close())
  }
  return preferences
}

/** Read the authoritative file and repair the main projection before acknowledging. */
export async function reconcileRendererPreferences(
  diagnostics = new PreferenceDiagnostics('main')
): Promise<RendererPreferences> {
  const preferences = diagnostics.runSync('read', readRendererPreferences)
  await diagnostics.run('main-apply', () => applyMainLanguage(preferences.language))
  return preferences
}

export async function commitRendererPreferences(
  value: unknown,
  diagnostics = new PreferenceDiagnostics('main')
): Promise<RendererPreferences> {
  const preferences = saveRendererPreferences(value, diagnostics)
  await diagnostics.run('main-apply', () => applyMainLanguage(preferences.language))
  return preferences
}
