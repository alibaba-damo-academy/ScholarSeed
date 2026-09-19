export const SELECTION_COPY_ROLE = 'copy' as const

export function canCopySelection({ selectionText, canCopy }: {
  selectionText: string
  canCopy: boolean
}): boolean {
  return canCopy && selectionText.trim().length > 0
}
