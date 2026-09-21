/** User-editable requirements for focused AI actions; service policies remain authoritative. */
export const MAX_SELECTION_PROMPT_CHARS = 2_000
export const MAX_SELECTION_REQUIREMENT_CHARS = 1_800
export const SELECTION_PROMPT_ACTIONS = ['explain', 'translate', 'polish', 'figure'] as const
export type SelectionPromptAction = typeof SELECTION_PROMPT_ACTIONS[number]
export type SelectionPrompts = Record<SelectionPromptAction, string>
export const DEFAULT_SELECTION_PROMPTS: Readonly<SelectionPrompts> = {
  explain: '结合上下文解释所选内容，说明关键概念，区分原文依据与推断。',
  translate: '准确翻译所选内容，保留专业术语、引用、数字和段落格式。',
  polish: '改善所选内容的清晰度、流畅度和语法，保留原意、事实、引用和格式。',
  figure: '解释图表展示的对象、坐标与图例、关键趋势和结论，区分图中直接信息与推断。'
}

export function sanitizeSelectionPrompts(value: unknown): SelectionPrompts {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SelectionPrompts> : {}
  return Object.fromEntries(SELECTION_PROMPT_ACTIONS.map(action => {
    const prompt = parsed[action]
    return [action, typeof prompt === 'string' && prompt.trim() && prompt.length <= MAX_SELECTION_PROMPT_CHARS
      ? prompt : DEFAULT_SELECTION_PROMPTS[action]]
  })) as SelectionPrompts
}

export function selectionPromptsEqual(
  left: SelectionPrompts,
  right: SelectionPrompts
): boolean {
  return SELECTION_PROMPT_ACTIONS.every((action) => left[action] === right[action])
}

export function selectionInstruction(prompts: SelectionPrompts, action: SelectionPromptAction, requirement = ''): string {
  return [prompts[action].trim(), requirement.trim()].filter(Boolean).join('\n\n')
}
