export type TranslationTarget = 'en' | 'zh'

/** A local first choice, not another model call; mixed selections can be corrected by the user. */
export function translationTarget(text: string): TranslationTarget {
  const chinese = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const english = text.match(/[a-z]+/gi)?.length ?? 0
  return chinese > english ? 'en' : 'zh'
}
