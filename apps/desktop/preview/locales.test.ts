import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('preview-only locale resources have matching keys, parameters and nonempty values', () => {
  const chinese = JSON.parse(readFileSync(new URL('./locales/zh.json', import.meta.url), 'utf8')) as Record<string, string>
  const english = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8')) as Record<string, string>
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort())
  for (const key of Object.keys(chinese)) {
    assert.equal(typeof chinese[key], 'string', key)
    assert.equal(typeof english[key], 'string', key)
    assert.ok(chinese[key].trim() && english[key].trim(), key)
    assert.deepEqual([...chinese[key].matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort(), [...english[key].matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort(), key)
  }
})
