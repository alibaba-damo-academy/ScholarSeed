import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultSelectionPrompts,
  MAX_SELECTION_PROMPT_CHARS,
  SELECTION_PROMPT_ACTIONS,
  selectionInstruction,
  selectionPromptsEqual,
  sanitizeSelectionPrompts,
} from './prompts.ts'
import { defaultRendererPreferences, sanitizeRendererPreferences } from './preferences.ts'

const CHINESE_PROMPTS = defaultSelectionPrompts('zh')

test('old and invalid preferences use independent default prompts', () => {
  assert.deepEqual(SELECTION_PROMPT_ACTIONS, ['explain', 'translate', 'polish', 'figure'])
  assert.deepEqual(sanitizeRendererPreferences({}).selectionPrompts, CHINESE_PROMPTS)
  const value = sanitizeSelectionPrompts({
    explain: '  结合上下文解释\n标明推断  ',
    polish: 42,
    translate: ' ',
    figure: null,
  })
  assert.equal(value.explain, '  结合上下文解释\n标明推断  ')
  assert.equal(value.polish, CHINESE_PROMPTS.polish)
  assert.equal(value.translate, CHINESE_PROMPTS.translate)
  assert.equal(value.figure, CHINESE_PROMPTS.figure)
  value.polish = 'changed'
  assert.notEqual(defaultSelectionPrompts('zh').polish, 'changed')
})

test('prompt round trip preserves multiline Unicode and rejects oversized entries', () => {
  const prompts = {
    ...CHINESE_PROMPTS,
    polish: '更学术\n保留引用 αβ',
    figure: '先讲坐标与图例\n再说明趋势',
  }
  assert.deepEqual(
    sanitizeRendererPreferences(JSON.parse(JSON.stringify({ selectionPrompts: prompts })))
      .selectionPrompts,
    prompts
  )
  assert.equal(
    sanitizeSelectionPrompts({ polish: 'a'.repeat(MAX_SELECTION_PROMPT_CHARS + 1) }).polish,
    CHINESE_PROMPTS.polish
  )
  assert.equal(
    sanitizeSelectionPrompts({ figure: 'a'.repeat(MAX_SELECTION_PROMPT_CHARS + 1) }).figure,
    CHINESE_PROMPTS.figure
  )
})

test('prompt equality includes the figure explanation requirement', () => {
  assert.equal(
    selectionPromptsEqual({ ...CHINESE_PROMPTS }, { ...CHINESE_PROMPTS, figure: '优先说明纵轴' }),
    false
  )
})

test('temporary requirements supplement the saved prompt and restoring one leaves the others', () => {
  const prompts = {
    explain: '解释术语',
    polish: '改善行文',
    translate: '采用领域术语',
    figure: '先说明如何读图',
  }
  assert.equal(selectionInstruction(prompts, 'polish', '更简洁'), '改善行文\n\n更简洁')
  assert.equal(selectionInstruction(prompts, 'polish', ''), '改善行文')
  assert.equal(selectionInstruction(prompts, 'explain', '   '), '解释术语')
  assert.equal(selectionInstruction(prompts, 'translate'), '采用领域术语')
  assert.equal(
    selectionInstruction(prompts, 'figure', '聚焦异常点'),
    '先说明如何读图\n\n聚焦异常点'
  )
  const restored = { ...prompts, figure: CHINESE_PROMPTS.figure }
  assert.equal(restored.explain, prompts.explain)
  assert.equal(restored.translate, prompts.translate)
  assert.equal(restored.polish, prompts.polish)
})

test('fresh English preferences seed English prompts while Chinese preferences seed Chinese prompts', () => {
  const english = defaultRendererPreferences('en')
  assert.equal(english.language, 'en')
  assert.match(english.selectionPrompts.explain, /^Explain /)
  for (const action of SELECTION_PROMPT_ACTIONS) {
    assert.doesNotMatch(english.selectionPrompts[action], /\p{Script=Han}/u)
    assert.ok(english.selectionPrompts[action].length <= MAX_SELECTION_PROMPT_CHARS)
  }
  const chinese = defaultRendererPreferences('zh')
  assert.deepEqual(chinese.selectionPrompts, CHINESE_PROMPTS)
  assert.match(chinese.selectionPrompts.explain, /^结合上下文/)
  english.selectionPrompts.explain = 'Custom text'
  assert.notEqual(defaultRendererPreferences('en').selectionPrompts.explain, 'Custom text')
})

test('missing or invalid prompts initialize in the persisted language before the detected fallback', () => {
  const storedEnglish = sanitizeRendererPreferences(
    {
      language: 'en',
      selectionPrompts: {
        explain: ' My own instructions\nKeep this ',
        translate: ' ',
        polish: null,
        figure: 'x'.repeat(MAX_SELECTION_PROMPT_CHARS + 1),
      },
    },
    'zh'
  )
  assert.equal(storedEnglish.selectionPrompts.explain, ' My own instructions\nKeep this ')
  assert.match(storedEnglish.selectionPrompts.translate, /^Translate /)
  assert.match(storedEnglish.selectionPrompts.polish, /^Improve /)
  assert.match(storedEnglish.selectionPrompts.figure, /^Explain /)
  assert.match(sanitizeRendererPreferences({}, 'en').selectionPrompts.explain, /^Explain /)
  assert.deepEqual(
    sanitizeRendererPreferences({ language: 'zh' }, 'en').selectionPrompts,
    CHINESE_PROMPTS
  )
})

test('switching language preserves the single saved prompt map including old default text', () => {
  const original = defaultRendererPreferences('zh')
  const englishUi = sanitizeRendererPreferences({ ...original, language: 'en' })
  assert.deepEqual(englishUi.selectionPrompts, original.selectionPrompts)
  const restarted = sanitizeRendererPreferences(JSON.parse(JSON.stringify(englishUi)), 'en')
  const chineseUi = sanitizeRendererPreferences({ ...restarted, language: 'zh' })
  assert.deepEqual(chineseUi.selectionPrompts, original.selectionPrompts)
  assert.deepEqual(Object.keys(chineseUi.selectionPrompts), [...SELECTION_PROMPT_ACTIONS])
  assert.equal(
    selectionInstruction(englishUi.selectionPrompts, 'explain'),
    original.selectionPrompts.explain
  )
})
