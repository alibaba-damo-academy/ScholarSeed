import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SELECTION_PROMPTS, MAX_SELECTION_PROMPT_CHARS, SELECTION_PROMPT_ACTIONS, selectionInstruction, selectionPromptsEqual, sanitizeSelectionPrompts } from './prompts.ts'
import { sanitizeRendererPreferences } from './preferences.ts'

test('old and invalid preferences use independent default prompts', () => {
  assert.deepEqual(SELECTION_PROMPT_ACTIONS, ['explain', 'translate', 'polish', 'figure'])
  assert.deepEqual(sanitizeRendererPreferences({}).selectionPrompts, DEFAULT_SELECTION_PROMPTS)
  const value = sanitizeSelectionPrompts({ explain: '  结合上下文解释\n标明推断  ', polish: 42, translate: ' ', figure: null })
  assert.equal(value.explain, '  结合上下文解释\n标明推断  ')
  assert.equal(value.polish, DEFAULT_SELECTION_PROMPTS.polish)
  assert.equal(value.translate, DEFAULT_SELECTION_PROMPTS.translate)
  assert.equal(value.figure, DEFAULT_SELECTION_PROMPTS.figure)
  value.polish = 'changed'
  assert.notEqual(DEFAULT_SELECTION_PROMPTS.polish, 'changed')
})

test('prompt round trip preserves multiline Unicode and rejects oversized entries', () => {
  const prompts = { ...DEFAULT_SELECTION_PROMPTS, polish: '更学术\n保留引用 αβ', figure: '先讲坐标与图例\n再说明趋势' }
  assert.deepEqual(sanitizeRendererPreferences(JSON.parse(JSON.stringify({ selectionPrompts: prompts }))).selectionPrompts, prompts)
  assert.equal(sanitizeSelectionPrompts({ polish: 'a'.repeat(MAX_SELECTION_PROMPT_CHARS + 1) }).polish, DEFAULT_SELECTION_PROMPTS.polish)
  assert.equal(sanitizeSelectionPrompts({ figure: 'a'.repeat(MAX_SELECTION_PROMPT_CHARS + 1) }).figure, DEFAULT_SELECTION_PROMPTS.figure)
})

test('prompt equality includes the figure explanation requirement', () => {
  assert.equal(selectionPromptsEqual(
    { ...DEFAULT_SELECTION_PROMPTS },
    { ...DEFAULT_SELECTION_PROMPTS, figure: '优先说明纵轴' }
  ), false)
})

test('temporary requirements supplement the saved prompt and restoring one leaves the others', () => {
  const prompts = { explain: '解释术语', polish: '改善行文', translate: '采用领域术语', figure: '先说明如何读图' }
  assert.equal(selectionInstruction(prompts, 'polish', '更简洁'), '改善行文\n\n更简洁')
  assert.equal(selectionInstruction(prompts, 'polish', ''), '改善行文')
  assert.equal(selectionInstruction(prompts, 'explain', '   '), '解释术语')
  assert.equal(selectionInstruction(prompts, 'translate'), '采用领域术语')
  assert.equal(selectionInstruction(prompts, 'figure', '聚焦异常点'), '先说明如何读图\n\n聚焦异常点')
  const restored = { ...prompts, figure: DEFAULT_SELECTION_PROMPTS.figure }
  assert.equal(restored.explain, prompts.explain)
  assert.equal(restored.translate, prompts.translate)
  assert.equal(restored.polish, prompts.polish)
})
