import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import {
  defaultRendererPreferences,
  RendererPreferences,
  sanitizeRendererPreferences
} from '../preferences'
import { applyMainLanguage } from './localization'
import { detectRendererLanguage } from './locale'

const RENDERER_PREFERENCES_FILENAME = 'renderer-preferences.json'
const TEMPORARY_FILE_SUFFIX = '.tmp'

function preferencesPath(): string {
  return join(app.getPath('userData'), RENDERER_PREFERENCES_FILENAME)
}

/**
 * 检测结果只在「没有已持久化的用户选择」时被采纳：文件缺失、文件损坏、或 `language`
 * 字段缺失/非法。文件里存着合法语言时它被直接忽略，用户手选不会被时区变化覆盖。
 * 检测本身只有两次同步的 Intl / Electron 取值，每次 boot 调用都够便宜，无需缓存。
 */
export function loadRendererPreferences(): RendererPreferences {
  const path = preferencesPath()
  const detected = detectRendererLanguage()
  if (!existsSync(path)) return defaultRendererPreferences(detected)
  try {
    return sanitizeRendererPreferences(JSON.parse(readFileSync(path, 'utf8')), detected)
  } catch {
    return defaultRendererPreferences(detected)
  }
}

export function saveRendererPreferences(value: unknown): RendererPreferences {
  const preferences = sanitizeRendererPreferences(value)
  const path = preferencesPath()
  const temporaryPath = path + TEMPORARY_FILE_SUFFIX
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, JSON.stringify(preferences), 'utf8')
  renameSync(temporaryPath, path)
  return preferences
}

/** Read the authoritative file and repair the main projection before acknowledging. */
export async function reconcileRendererPreferences(): Promise<RendererPreferences> {
  const path = preferencesPath()
  const preferences = existsSync(path)
    ? sanitizeRendererPreferences(JSON.parse(readFileSync(path, 'utf8')), detectRendererLanguage())
    : defaultRendererPreferences(detectRendererLanguage())
  await applyMainLanguage(preferences.language)
  return preferences
}

export async function commitRendererPreferences(value: unknown): Promise<RendererPreferences> {
  const preferences = saveRendererPreferences(value)
  await applyMainLanguage(preferences.language)
  return preferences
}
