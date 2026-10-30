import { Buffer } from 'node:buffer'
import { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { dirname, join } from 'path'
import { desktopStorage } from './storage'

import type { RendererPreferences } from '../preferences'
import { defaultRendererPreferences, sanitizeRendererPreferences } from '../preferences'
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

function readRendererPreferences(filename = preferencesPath()): RendererPreferences {
  const detected = detectRendererLanguage()
  try {
    return decodeRendererPreferences(readRecord(filename, RENDERER_PREFERENCES_MAX_BYTES), detected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultRendererPreferences(detected)
    throw error
  }
}

/**
 * 检测结果只在「没有已持久化的用户选择」时被采纳：文件缺失、文件损坏、或 `language`
 * 字段缺失/非法。文件里存着合法语言时它被直接忽略，用户手选不会被时区变化覆盖。
 * 检测本身只有两次同步的 Intl / Electron 取值，每次 boot 调用都够便宜，无需缓存。
 */
export function loadRendererPreferences(): RendererPreferences {
  // Startup selection is a prerequisite, not a corrupt/missing preference file.
  const filename = preferencesPath()
  const detected = detectRendererLanguage()
  try {
    return readRendererPreferences(filename)
  } catch {
    return { ...defaultRendererPreferences(detected), browserAutomationEnabled: false }
  }
}

export function saveRendererPreferences(
  value: unknown,
  diagnostics = new PreferenceDiagnostics('main')
): RendererPreferences {
  const preferences = diagnostics.runSync('validate', () =>
    sanitizeRendererPreferences({
      ...sanitizeRendererPreferences(value),
      browserAutomationEnabled: diagnostics.runSync('read', readRendererPreferences)
        .browserAutomationEnabled,
    })
  )
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
  // Refuse a record the actual reader cannot consume before acquiring a writer.
  diagnostics.runSync('validate', () =>
    decodeRendererPreferences(Buffer.from(`${JSON.stringify(preferences)}\n`, 'utf8'))
  )
  const writer = diagnostics.runSync('acquire', () => desktopDirectoryWriter(dirname(path)))
  try {
    diagnostics.runSync('write', () => writeJson(path, preferences))
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
