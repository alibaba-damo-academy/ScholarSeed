import type { AnnotationPoint } from './model'

export interface TextDraft {
  id: number
  alignRight: boolean
  fontSize?: number
  color: string
  point: AnnotationPoint
  surfaceX: number
  surfaceY: number
  value: string
}

export function commitActiveTextDraft(
  draft: TextDraft | null,
  commit: (draft: TextDraft) => void
): boolean {
  if (!draft) return false
  commit(draft)
  return true
}
