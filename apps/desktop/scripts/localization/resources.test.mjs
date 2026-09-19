import assert from 'node:assert/strict'
import test from 'node:test'
import { generateTypes, validateResources, generateRegistration, validateCatalog } from './resources.mjs'

const sample = () => ({
  zh: { foundation: { greet: '你好 {{name}}', files_other: '{{count}} 个文件' } },
  en: { foundation: { greet: 'Hello {{name}}', files_one: '{{count}} file', files_other: '{{count}} files' } }
})
test('language-specific plural branches and literal generated interpolation types', () => {
  assert.deepEqual(validateResources(sample()), [])
  assert.match(generateTypes(sample()), /你好 {{name}}/)
})
test('missing and empty messages, parameters and plural coverage are rejected', () => {
  for (const mutate of [
    (r) => { delete r.en.foundation.greet },
    (r) => { r.en.foundation.greet = ' ' },
    (r) => { r.en.foundation.greet = 'Hi {{other}}' },
    (r) => { delete r.en.foundation.files_one }
  ]) {
    const resources = sample(); mutate(resources)
    assert.ok(validateResources(resources).length)
  }
})

test('rich component tags must match, balance, and contain no arbitrary attributes', () => {
  const rich = (en) => ({ zh: { foundation: { body: '<strong>你好</strong>' } }, en: { foundation: { body: en } } })
  assert.deepEqual(validateResources(rich('<strong>Hello</strong>')), [])
  assert.ok(validateResources(rich('<strong>Hello')).length)
  assert.ok(validateResources(rich('<a href="https://example.com">Hello</a>')).length)
  assert.ok(validateResources(rich('<em>Hello</em>')).length)
})

test('locale catalog and generated runtime imports track the complete JSON inventory', () => {
  const resources = sample()
  const catalog = `export const LOCALES = { zh: {}, en: {} } as const satisfies Record<string, object>`
  assert.deepEqual(validateCatalog(resources, catalog), [])
  assert.ok(validateCatalog({ zh: resources.zh }, catalog).length)
  assert.ok(validateCatalog(resources, `export const LOCALES = { ...other }`).length)
  resources.en.extra = { title: 'Extra' }
  resources.zh.extra = { title: '附加' }
  const output = generateRegistration(resources)
  for (const language of ['zh', 'en']) for (const namespace of ['foundation', 'extra']) {
    assert.ok(output.includes(`./locales/${language}/${namespace}.json`))
  }
  assert.equal(output, generateRegistration({ en: resources.en, zh: resources.zh }))
})
