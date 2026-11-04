import { DEFAULT_LANGUAGE } from './localization/catalog.ts'
import type { PreferenceLanguage } from './preferences'

/** User-editable requirements for focused AI actions; service policies remain authoritative. */
export const MAX_SELECTION_PROMPT_CHARS = 2_000
export const MAX_SELECTION_REQUIREMENT_CHARS = 1_800
export const SELECTION_PROMPT_ACTIONS = ['explain', 'translate', 'polish', 'figure'] as const
export type SelectionPromptAction = (typeof SELECTION_PROMPT_ACTIONS)[number]
export type SelectionPrompts = Record<SelectionPromptAction, string>
const SELECTION_PROMPT_DEFAULTS = {
  zh: {
    explain: '结合上下文解释所选内容，说明关键概念，区分原文依据与推断。',
    translate: '准确翻译所选内容，保留专业术语、引用、数字和段落格式。',
    polish: '改善所选内容的清晰度、流畅度和语法，保留原意、事实、引用和格式。',
    figure: '解释图表展示的对象、坐标与图例、关键趋势和结论，区分图中直接信息与推断。',
  },
  en: {
    explain:
      'Explain the selected content in context, clarify key concepts, and distinguish statements supported by the original text from inferences.',
    translate:
      'Translate the selected content accurately, preserving technical terminology, citations, numbers, and paragraph formatting.',
    polish:
      'Improve the clarity, fluency, and grammar of the selected content while preserving its meaning, facts, citations, and formatting.',
    figure:
      'Explain what the figure shows, its axes and legend, key trends, and conclusions. Distinguish information shown directly in the figure from inferences.',
  },
} as const satisfies Record<PreferenceLanguage, Readonly<SelectionPrompts>>

export function defaultSelectionPrompts(language: PreferenceLanguage): SelectionPrompts {
  return { ...SELECTION_PROMPT_DEFAULTS[language] }
}

export function sanitizeSelectionPrompts(
  value: unknown,
  language: PreferenceLanguage = DEFAULT_LANGUAGE
): SelectionPrompts {
  const defaults = defaultSelectionPrompts(language)
  const parsed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<SelectionPrompts>)
      : {}
  return Object.fromEntries(
    SELECTION_PROMPT_ACTIONS.map((action) => {
      const prompt = parsed[action]
      return [
        action,
        typeof prompt === 'string' && prompt.trim() && prompt.length <= MAX_SELECTION_PROMPT_CHARS
          ? prompt
          : defaults[action],
      ]
    })
  ) as SelectionPrompts
}

export function selectionPromptsEqual(left: SelectionPrompts, right: SelectionPrompts): boolean {
  return SELECTION_PROMPT_ACTIONS.every((action) => left[action] === right[action])
}

export function selectionInstruction(
  prompts: SelectionPrompts,
  action: SelectionPromptAction,
  requirement = ''
): string {
  return [prompts[action].trim(), requirement.trim()].filter(Boolean).join('\n\n')
}
