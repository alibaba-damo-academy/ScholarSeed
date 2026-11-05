import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHINA_TIME_ZONES,
  detectPreferenceLanguage,
  FALLBACK_LANGUAGE,
  LANGUAGE_DETECTORS,
  primaryLanguageSubtag,
  readTimeZone,
} from './locale.ts'
import { DEFAULT_RENDERER_PREFERENCES } from './preferences.ts'
import type { LocaleSignals } from './locale.ts'

function signals(timeZone: string | null, languages: readonly string[]): LocaleSignals {
  return { timeZone, languages }
}

function detect(timeZone: string | null, languages: readonly string[]): string {
  return detectPreferenceLanguage(signals(timeZone, languages))
}

test('system language takes precedence over conflicting time zones', () => {
  assert.equal(detect('Asia/Shanghai', ['en-US']), 'en')
  assert.equal(detect('America/New_York', ['zh-Hans-CN']), 'zh')
  assert.equal(detect('Asia/Shanghai', ['fr-FR', 'zh-CN']), 'en')
})

test('mainland China time zones resolve to Chinese when system language is unavailable', () => {
  for (const zone of CHINA_TIME_ZONES) {
    assert.equal(detect(zone, []), 'zh', `zone ${zone}`)
  }
})

test('a non-China time zone falls back to English when no language is usable', () => {
  for (const zone of [
    'Asia/Singapore',
    'Asia/Taipei',
    'Asia/Hong_Kong',
    'Australia/Perth',
    'Asia/Manila',
    'Asia/Tokyo',
    'America/New_York',
    'Europe/Berlin',
  ]) {
    assert.equal(detect(zone, ['', 'x-private']), 'en', `zone ${zone}`)
  }
})

test('rule 3: an indeterminate time zone hands over to the OS system language', () => {
  assert.equal(detect('UTC', ['en-US']), 'en')
  assert.equal(detect('Etc/UTC', ['en']), 'en')
  assert.equal(detect('Factory', ['en']), 'en')
  assert.equal(detect(null, ['en']), 'en')
  assert.equal(detect('', ['en-US']), 'en')
  assert.equal(detect('   ', ['en-GB']), 'en')

  assert.equal(detect('UTC', ['zh-CN']), 'zh')
  assert.equal(detect('Etc/GMT', ['zh-TW']), 'zh')
  assert.equal(detect(null, ['zh']), 'zh')
  // POSIX 风格下划线与大小写都要认。
  assert.equal(detect('UTC', ['zh_CN']), 'zh')
  assert.equal(detect('UTC', ['ZH-hans-CN']), 'zh')
})

test('rule 3 tie-break: the first well-formed tag decides, malformed entries are skipped', () => {
  assert.equal(detect('UTC', ['en-US', 'zh-CN']), 'en')
  assert.equal(detect('UTC', ['zh-CN', 'en-US']), 'zh')
  // 空串不能把后面的合法标签短路掉。
  assert.equal(detect('UTC', ['', 'en-GB']), 'en')
  assert.equal(detect('UTC', ['x-private', 'zh-CN']), 'zh')
})

test('rule 4: no usable signal at all falls back to Chinese', () => {
  assert.equal(detect('UTC', ['x-private']), FALLBACK_LANGUAGE)
  assert.equal(detect('UTC', []), FALLBACK_LANGUAGE)
  assert.equal(detect(null, []), FALLBACK_LANGUAGE)
  assert.equal(detect('UTC', ['123']), FALLBACK_LANGUAGE)
  assert.equal(FALLBACK_LANGUAGE, 'zh')
  assert.equal(FALLBACK_LANGUAGE, DEFAULT_RENDERER_PREFERENCES.language)
})

test('primaryLanguageSubtag reads BCP-47 primary subtags and rejects what has none', () => {
  assert.equal(primaryLanguageSubtag('zh-Hans-CN'), 'zh')
  assert.equal(primaryLanguageSubtag('en'), 'en')
  assert.equal(primaryLanguageSubtag('de-DE-1996'), 'de')
  assert.equal(primaryLanguageSubtag('zh_CN'), 'zh')
  assert.equal(primaryLanguageSubtag('ZH-hans-CN'), 'zh')
  assert.equal(primaryLanguageSubtag('  en-GB  '), 'en')
  // 私用 / 古老 grandfathered 前缀、纯数字、超长首段都没有主语言子标签。
  assert.equal(primaryLanguageSubtag(''), null)
  assert.equal(primaryLanguageSubtag('x-foo'), null)
  assert.equal(primaryLanguageSubtag('i-navajo'), null)
  assert.equal(primaryLanguageSubtag('123'), null)
  assert.equal(primaryLanguageSubtag('toolongprimarysubtag-x'), null)
})

test('readTimeZone returns either a usable zone name or null, never an empty string', () => {
  const zone = readTimeZone()
  assert.ok(zone === null || (typeof zone === 'string' && zone.length > 0 && zone === zone.trim()))
})

test('the detector chain is data-driven and does not mutate its input', () => {
  assert.ok(LANGUAGE_DETECTORS.length >= 2)
  for (const detector of LANGUAGE_DETECTORS) assert.equal(typeof detector, 'function')
  const input = signals('UTC', ['en-US'])
  detectPreferenceLanguage(input)
  assert.deepEqual(input, { timeZone: 'UTC', languages: ['en-US'] })
})
