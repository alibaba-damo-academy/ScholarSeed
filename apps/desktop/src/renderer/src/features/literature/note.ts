import type { DocumentPanelContext } from '../../contracts/features'
import type { LiteratureNote } from '../../contracts/literature'
import type { SaveCopyBridge } from './export'

export const LITERATURE_NOTES_PANEL_ID = 'literature-notes'
export const LITERATURE_ATTACHMENT_OWNER = 'literature_attachment'

const NOTE_EXPORT_FILENAME_PATTERN = /[\\/:*?"<>|]/g
export const LITERATURE_NOTES_CHANGED = 'literature-notes-changed'

export type NoteSaveStatus = 'saved' | 'dirty' | 'saving'

export interface NoteDraft {
  title: string
  text: string
  version: number
}

export function draftOf(note: LiteratureNote): NoteDraft {
  return { title: note.title, text: note.text, version: note.version }
}

export function literatureIdFromDocument(
  context: DocumentPanelContext
): string | null {
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

export function markdownNoteExport(
  note: Pick<LiteratureNote, 'title' | 'text'>,
  position: number,
  fallbackTitle: (position: number) => string
): { suggestedName: string; bytes: Uint8Array } {
  const trimmedTitle = note.title.trim()
  const title = trimmedTitle || fallbackTitle(position)
  const content = trimmedTitle ? `# ${trimmedTitle}\n\n${note.text}` : note.text
  const fileName = `${title.replace(NOTE_EXPORT_FILENAME_PATTERN, '-').trim() || `note-${position}`}.md`
  return { suggestedName: fileName, bytes: new TextEncoder().encode(content) }
}

export async function exportNoteAsMarkdown(
  note: Pick<LiteratureNote, 'title' | 'text'>,
  position: number,
  fallbackTitle: (position: number) => string,
  bridge: SaveCopyBridge | undefined = window.scholarseed
): Promise<void> {
  if (!bridge) throw new Error('desktop save bridge unavailable')
  const result = await bridge.saveFileCopy(
    markdownNoteExport(note, position, fallbackTitle)
  )
  if (!result.ok && !result.canceled)
    throw new Error(result.error || 'note export failed')
}
