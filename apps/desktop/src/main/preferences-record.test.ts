import assert from 'node:assert/strict'
import test from 'node:test'
import {
  persistedRendererPreferences,
  sanitizeRendererPreferences,
  SYSTEM_LANGUAGE_MODE,
} from '../preferences.ts'
import { defaultSelectionPrompts, SELECTION_PROMPT_ACTIONS } from '../prompts.ts'
import { decodeRendererPreferences, RENDERER_PREFERENCES_MAX_BYTES } from './preferences-record.ts'

test('CDP choice survives record restarts and missing legacy choice uses the default', () => {
  assert.equal(decodeRendererPreferences(null).browserAutomationEnabled, true)
  assert.equal(
    decodeRendererPreferences(Buffer.from('{"theme":"dark"}')).browserAutomationEnabled,
    true
  )
  for (const enabled of [false, true]) {
    const preferences = decodeRendererPreferences(
      Buffer.from(JSON.stringify({ browserAutomationEnabled: enabled }))
    )
    assert.equal(
      decodeRendererPreferences(Buffer.from(JSON.stringify(preferences))).browserAutomationEnabled,
      enabled
    )
  }
})

test('persisted language wins over detection while missing selection uses detection', () => {
  assert.equal(decodeRendererPreferences(Buffer.from('{"language":"zh"}'), 'en').language, 'zh')
  assert.equal(decodeRendererPreferences(Buffer.from('{}'), 'en').language, 'en')
  assert.equal(decodeRendererPreferences(null, 'en').language, 'en')
})

test('system mode persists intent without pinning the detected language', () => {
  const initial = decodeRendererPreferences(null, 'en')
  const record = persistedRendererPreferences({ ...initial, theme: 'dark' })
  assert.equal(record.languageMode, SYSTEM_LANGUAGE_MODE)
  assert.ok(!Object.hasOwn(record, 'language'))

  const restored = decodeRendererPreferences(Buffer.from(JSON.stringify(record)), 'zh')
  assert.equal(restored.language, 'zh')
  assert.equal(restored.languageMode, SYSTEM_LANGUAGE_MODE)
  assert.equal(restored.theme, 'dark')
  assert.deepEqual(restored.selectionPrompts, initial.selectionPrompts)
  assert.equal(
    decodeRendererPreferences(Buffer.from('{"language":"en"}'), 'zh').languageMode,
    undefined
  )
})

test('new preference records seed prompts in their initial language and old values survive decoding', () => {
  assert.deepEqual(
    decodeRendererPreferences(null, 'en').selectionPrompts,
    defaultSelectionPrompts('en')
  )
  assert.deepEqual(
    decodeRendererPreferences(null, 'zh').selectionPrompts,
    defaultSelectionPrompts('zh')
  )
  const original = { language: 'en', selectionPrompts: defaultSelectionPrompts('zh') }
  const bytes = Buffer.from(JSON.stringify(original))
  const decoded = decodeRendererPreferences(bytes, 'en')
  assert.deepEqual(decoded.selectionPrompts, original.selectionPrompts)
  assert.deepEqual(Object.keys(decoded.selectionPrompts), [...SELECTION_PROMPT_ACTIONS])
  assert.deepEqual(JSON.parse(bytes.toString()), original)
})

test('file decoding uses the actual preference sanitizer without changing source bytes', () => {
  const value = {
    language: 'en',
    autoDownloadUpdates: false,
    theme: 'dark',
    sidebarOpen: false,
    futurePreference: 'preserved-on-disk',
  }
  const bytes = Buffer.from(JSON.stringify(value))
  const original = Buffer.from(bytes)
  assert.deepEqual(decodeRendererPreferences(bytes), sanitizeRendererPreferences(value))
  assert.deepEqual(bytes, original)
  const sanitized = sanitizeRendererPreferences(value)
  assert.deepEqual(
    decodeRendererPreferences(Buffer.from(`${JSON.stringify(sanitized)}\n`)),
    sanitized
  )
})

test('malformed JSON, UTF-8 and oversized records fail before a preference acknowledgement', () => {
  for (const bytes of [
    Buffer.from('{bad'),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('true'),
    Buffer.from([255]),
    Buffer.alloc(RENDERER_PREFERENCES_MAX_BYTES + 1),
  ])
    assert.throws(() => decodeRendererPreferences(bytes))
})
