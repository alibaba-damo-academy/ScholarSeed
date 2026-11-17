import { join } from 'node:path'
import { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { systemRendererPreferences, type RendererPreferences } from '../preferences.ts'
import { desktopStorage } from './storage'
import { applyMainLanguage } from './localization'
import { detectRendererLanguage } from './locale'
import { RENDERER_PREFERENCES_FILENAME } from './preferences-record.ts'
import { readPreferences } from './preferencefile.ts'
import { desktopPersistence } from './persistence.ts'

function preferencesPath(): string {
  return join(desktopStorage().userData, RENDERER_PREFERENCES_FILENAME)
}

export function loadRendererPreferences(): RendererPreferences {
  const filename = preferencesPath()
  const detected = detectRendererLanguage()
  try {
    return readPreferences(filename, detected)
  } catch {
    return { ...systemRendererPreferences(detected), browserAutomationEnabled: false }
  }
}

function persist(
  mode: 'save' | 'read' | 'automation',
  diagnostics: PreferenceDiagnostics,
  value?: unknown,
  enabled?: boolean
): Promise<RendererPreferences> {
  return desktopPersistence().request(
    'preferences',
    {
      path: preferencesPath(),
      language: detectRendererLanguage(),
      mode,
      value,
      enabled,
      diagnostics: diagnostics.context(),
    },
    { diagnostic: (line) => diagnostics.relay(line) }
  )
}

export function saveRendererPreferences(
  value: unknown,
  diagnostics = new PreferenceDiagnostics('main')
): Promise<RendererPreferences> {
  return persist('save', diagnostics, value)
}

export function saveBrowserAutomationPreference(enabled: boolean): Promise<RendererPreferences> {
  return persist('automation', new PreferenceDiagnostics('main'), undefined, enabled)
}

export async function reconcileRendererPreferences(
  diagnostics = new PreferenceDiagnostics('main')
): Promise<RendererPreferences> {
  const preferences = await persist('read', diagnostics)
  await diagnostics.run('main-apply', () => applyMainLanguage(preferences.language))
  return preferences
}

export async function commitRendererPreferences(
  value: unknown,
  diagnostics = new PreferenceDiagnostics('main')
): Promise<RendererPreferences> {
  const preferences = await saveRendererPreferences(value, diagnostics)
  await diagnostics.run('main-apply', () => applyMainLanguage(preferences.language))
  return preferences
}
