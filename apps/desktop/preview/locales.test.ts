import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('preview-only locale resources have matching keys, parameters and nonempty values', () => {
  const [chinese, english] = ['zh', 'en'].map(locale => {
    const filename = new URL(`./locales/${locale}.json`, import.meta.url)
    const text = readFileSync(filename, 'utf8')
    const source = ts.parseJsonText(filename.pathname, text)
    const statement = source.statements[0]
    assert.ok(ts.isExpressionStatement(statement))
    assert.ok(ts.isObjectLiteralExpression(statement.expression))
    const keys = statement.expression.properties.map(property => {
      assert.ok(ts.isPropertyAssignment(property))
      assert.ok(ts.isStringLiteral(property.name))
      return property.name.text
    })
    assert.equal(new Set(keys).size, keys.length, `${locale}: duplicate locale keys`)
    return JSON.parse(text) as Record<string, string>
  })
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort())
  for (const key of Object.keys(chinese)) {
    assert.equal(typeof chinese[key], 'string', key)
    assert.equal(typeof english[key], 'string', key)
    assert.ok(chinese[key].trim() && english[key].trim(), key)
    assert.deepEqual([...chinese[key].matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort(), [...english[key].matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort(), key)
  }
})
