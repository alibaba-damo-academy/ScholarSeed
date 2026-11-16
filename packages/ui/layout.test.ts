import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindConversationLayout } from './layout.ts'
import { validateEnvelope } from './validation.ts'

const layout = {
  component: 'Conversation' as const,
  args: [[{ component: 'TextContent', args: [{ field: 'summary' }] }]],
}
const allowed = ['Conversation', 'TextContent']

test('one fixed layout binds two different results as literals', () => {
  for (const summary of ['10 days → 15 days', '"); Query("forbidden"); //']) {
    const document = bindConversationLayout(layout, { summary }, allowed)
    assert.equal(document.source, `root = Conversation([TextContent(${JSON.stringify(summary)})])`)
    assert.deepEqual(validateEnvelope(document), document)
  }
})

test('missing fields and unregistered components fail closed', () => {
  assert.throws(() => bindConversationLayout(layout, {}, allowed), /openui_layout_field_invalid/)
  assert.throws(() => bindConversationLayout(layout, { summary: { component: 'TextContent' } }, allowed), /openui_layout_literal_invalid/)
  assert.throws(() => bindConversationLayout(layout, { summary: 'value' }, ['Conversation']), /openui_layout_node_invalid/)
})
