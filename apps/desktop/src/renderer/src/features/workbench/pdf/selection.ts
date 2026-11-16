import type { TranslationChoice } from '../../translation/model'
import type { PdfAiResult, PdfSelection } from './analysis'

const PDF_REVISION_PREFIX = 'sha256:'

function canonicalRevision(revision: string): string {
  return revision.startsWith(PDF_REVISION_PREFIX)
    ? revision.slice(PDF_REVISION_PREFIX.length)
    : revision
}

export interface SelectionTranslationSnapshot {
  readonly document: string
  readonly selection: string
  readonly choice: Readonly<TranslationChoice>
  readonly modelKey: string
  readonly revision: string
  readonly attemptId: string
  readonly text: string
  readonly page: number
  readonly quads: string
}

export function translationSnapshot({
  document,
  selection,
  choice,
  modelKey,
  revision,
  attemptId,
}: {
  document: string
  selection: readonly PdfSelection[]
  choice: TranslationChoice
  modelKey: string
  revision: string
  attemptId: string
}): SelectionTranslationSnapshot {
  return Object.freeze({
    document,
    selection: JSON.stringify(selection),
    choice: Object.freeze({ ...choice }),
    modelKey,
    revision: canonicalRevision(revision),
    attemptId,
    text: selection.map((item) => item.text).join('\n'),
    page: selection[0]?.page ?? 1,
    quads: JSON.stringify(
      selection.filter((item) => item.page === selection[0]?.page).flatMap((item) => item.quads)
    ),
  })
}

export function selectionSnapshotCurrent(
  snapshot: SelectionTranslationSnapshot | undefined,
  document: string,
  selection: string
): boolean {
  return snapshot?.document === document && snapshot.selection === selection
}

export function selectionResultForSnapshot(
  result: PdfAiResult | undefined,
  snapshot: SelectionTranslationSnapshot | undefined
): PdfAiResult | undefined {
  if (
    !result ||
    !snapshot ||
    typeof result.revision !== 'string' ||
    typeof result.selected_text !== 'string' ||
    result.kind !== 'selection_translation' ||
    result.client_attempt_id !== snapshot.attemptId ||
    canonicalRevision(result.revision) !== snapshot.revision ||
    result.page !== snapshot.page ||
    JSON.stringify(result.quads ?? []) !== snapshot.quads ||
    result.selected_text.replace(/\s+/g, ' ').trim() !==
      snapshot.text.replace(/\s+/g, ' ').trim() ||
    result.target_language !== snapshot.choice.target ||
    result.model_key !== snapshot.modelKey
  )
    return undefined
  return result
}
