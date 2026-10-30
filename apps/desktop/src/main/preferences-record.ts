import {
  defaultRendererPreferences,
  sanitizeRendererPreferences,
  type PreferenceLanguage,
  type RendererPreferences,
} from '../preferences.ts'

export const RENDERER_PREFERENCES_FILENAME = 'renderer-preferences.json'
export const RENDERER_PREFERENCES_MAX_BYTES = 8 * 1024 * 1024

/** Decode the exact file representation using the renderer's actual contract. */
export function decodeRendererPreferences(
  bytes: Uint8Array | null,
  fallbackLanguage?: PreferenceLanguage
): RendererPreferences {
  if (bytes === null) return defaultRendererPreferences(fallbackLanguage)
  if (bytes.byteLength > RENDERER_PREFERENCES_MAX_BYTES)
    throw new Error('Renderer preference record exceeds size limit')
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid renderer preference record')
  return sanitizeRendererPreferences(value, fallbackLanguage)
}
