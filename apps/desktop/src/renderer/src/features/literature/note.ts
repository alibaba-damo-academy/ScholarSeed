import type { DocumentPanelContext } from '../../contracts/features'
import type { LiteratureNote } from '../../contracts/literature'

export const LITERATURE_NOTES_PANEL_ID = 'literature-notes'
export const LITERATURE_ATTACHMENT_OWNER = 'literature_attachment'

export function literatureIdFromDocument(context: DocumentPanelContext): string | null {
  return context.recordTarget?.owner === LITERATURE_ATTACHMENT_OWNER
    ? context.recordTarget.scope_id
    : null
}

export function literatureNoteTitle(
  note: Pick<LiteratureNote, 'title'>,
  index: number,
  fallback: (position: number) => string
): string {
  return note.title?.trim() || fallback(index + 1)
}
