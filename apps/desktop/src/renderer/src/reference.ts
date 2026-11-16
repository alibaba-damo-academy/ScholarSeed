export const COMPOSER_FOCUS_EVENT = 'scholarseed:composer-focus'
export const FILE_REF_KIND = 'file'

export function partitionComposerReferences<Reference extends { key: string; inline: boolean }>(
  references: readonly Reference[],
  order: readonly string[] = []
): { inline: Reference[]; attachments: Reference[] } {
  const positions = new Map(order.map((key, index) => [key, index]))
  const sorted = references
    .slice()
    .sort(
      (left, right) =>
        (positions.get(left.key) ?? order.length) - (positions.get(right.key) ?? order.length)
    )
  return {
    inline: sorted.filter((reference) => reference.inline),
    attachments: sorted.filter((reference) => !reference.inline),
  }
}

export function reconcileReferenceOrder(
  previous: readonly string[],
  current: readonly string[]
): string[] {
  const available = new Set(current)
  const retained = previous.filter((key) => available.has(key))
  const known = new Set(retained)
  return [...retained, ...current.filter((key) => !known.has(key))]
}

export interface ComposerFocusDetail {
  selectionStart?: number
  selectionEnd?: number
}

export function focusComposer(detail?: ComposerFocusDetail): void {
  window.dispatchEvent(new CustomEvent<ComposerFocusDetail>(COMPOSER_FOCUS_EVENT, { detail }))
}
