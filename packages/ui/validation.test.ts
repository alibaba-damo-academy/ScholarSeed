import assert from 'node:assert/strict'
import test from 'node:test'
import { OPENUI_FORMAT, OPENUI_LIMITS, OPENUI_VERSION } from './document.ts'
import { validateEnvelope, validateSource, validateTree } from './validation.ts'

const document = (source: string) => ({ format: OPENUI_FORMAT, version: OPENUI_VERSION, source })

test('declarative envelopes reject executable and unknown formats without changing input', () => {
  const value = document('root = Conversation([])')
  assert.deepEqual(validateEnvelope(value), value)
  for (const invalid of [null, [], { ...value, format: 'react' }, { ...value, version: 2 }, { ...value, script: 'alert(1)' }])
    assert.throws(() => validateEnvelope(invalid))
})

test('source budgets apply before parsing and ignore delimiters in literal strings', () => {
  assert.doesNotThrow(() => validateSource('root = Conversation([TextContent("[({")])'))
  assert.throws(() => validateSource('('.repeat(OPENUI_LIMITS.depth + 1)))
  assert.throws(() => validateSource('中'.repeat(OPENUI_LIMITS.bytes)))
  for (const source of ['root = Query("mcp")', 'root = Mutation("save")', 'root = @Run(save)', ']]>openui:content\nroot = X()', 'root = Conversation([])\n<script>alert(1)</script>'])
    assert.throws(() => validateSource(source))
})

test('reserved statements remain ordinary text inside string literals', () => {
  for (const text of ['Query(\"tool\")', 'Mutation(\"save\")', ']]>openui:scripts', '<script>'])
    assert.doesNotThrow(() => validateSource(`root = Conversation([TextContent(${JSON.stringify(text)})])`))
})

test('registered literal trees and typed user intents cannot smuggle dynamic calls', () => {
  const element = { type: 'element', typeName: 'Button', props: { type: 'normal', action: { k: 'Comp', name: 'Submit', args: [], fn: true } } }
  assert.throws(() => validateTree(element, ['Button']), /openui_action/)
  assert.throws(() => validateTree({ ...element, props: { action: { k: 'Comp', name: 'OpenArtifact', fn: true, args: [{ k: 'Str', v: 'published-id' }], mappedProps: { id: { k: 'Str', v: 'published-id' } } } } }, ['Button']), /openui_action/)
  assert.throws(() => validateTree({ ...element, props: { action: { k: 'Comp', name: 'OpenArtifact', fn: true, args: [{ k: 'Var', name: '$script' }] } } }, ['Button']), /openui_action/)
  assert.throws(() => validateTree({ ...element, props: { action: { type: 'Submit', params: {} } } }, ['Button']), /openui_action/)
  assert.throws(() => validateTree(element, ['TextContent']))
  assert.throws(() => validateTree({ ...element, props: { action: { k: 'Comp', name: 'Each', args: [], fn: true } } }, ['Button']))
  assert.throws(() => validateTree({ ...element, props: { action: { k: 'Var', name: '$danger' } } }, ['Button']))
  for (const action of [{ type: 'open_url', params: { url: 'https://example.com' } }, { steps: [{ type: 'navigate', url: 'https://example.com' }] }, 'https://example.com'])
    assert.throws(() => validateTree({ ...element, props: { action } }, ['Button']), /openui_action/)
  for (const action of [{ type: 'Submit', url: 'https://example.com' }, { type: 'Submit', params: { url: 'https://example.com' } }])
    assert.throws(() => validateTree({ ...element, props: { action } }, ['Button']), /openui_action/)
})

test('parsed values cannot inherit a component or action through a modified prototype', () => {
  const inherited = Object.create({ type: 'element', typeName: 'TextContent', props: { text: 'inherited' } })
  assert.throws(() => validateTree(inherited, ['TextContent']), /openui_property/)
})

test('untrusted form rules cannot introduce a synchronous regular expression', () => {
  assert.throws(() => validateTree({ type: 'element', typeName: 'Input', props: { name: 'input', rules: { pattern: '(a+)+$' } } }, ['Input']), /openui_validation_rules/)
})

test('nested props cannot introduce remote resources through a registered control', () => {
  for (const property of ['src', 'href', 'url'])
    assert.throws(() => validateTree({ type: 'element', typeName: 'Select', props: { items: [{ topContent: { [property]: 'https://example.com/image' } }] } }, ['Select']), /openui_resource/)
})
