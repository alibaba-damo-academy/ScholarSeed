import type { LiteratureNote } from '../../contracts/literature'
import { draftOf, type NoteDraft, type NoteSaveStatus } from './note.ts'

const NOTE_AUTOSAVE_DELAY_MS = 1200

export type NoteEditorError = 'saveFailed' | 'versionConflict' | 'deleteFailed'

export interface NoteEditorSnapshot {
  draft: NoteDraft | null
  selectedId: string | null
  isNew: boolean
  status: NoteSaveStatus
  errorCode: NoteEditorError | null
  removingId: string | null
}

export interface NoteEditorOperations {
  create: (draft: NoteDraft) => Promise<LiteratureNote>
  update: (id: string, draft: NoteDraft) => Promise<LiteratureNote>
  remove: (id: string) => Promise<void>
  changed: () => void
  saveError: (reason: unknown) => NoteEditorError
}

const EMPTY_EDITOR: NoteEditorSnapshot = {
  draft: null,
  selectedId: null,
  isNew: false,
  status: 'saved',
  errorCode: null,
  removingId: null,
}

export class NoteEditingSession {
  private snapshot: NoteEditorSnapshot = EMPTY_EDITOR
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<boolean> | null = null
  private navigation = 0

  constructor(
    private readonly operations: NoteEditorOperations,
    private readonly onUnused: () => void = () => {}
  ) {}

  getSnapshot = (): NoteEditorSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) void this.flush().then(() => this.releaseIfSaved())
    }
  }

  private publish(patch: Partial<NoteEditorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private releaseIfSaved(): void {
    if (
      !this.listeners.size &&
      !this.pending &&
      !this.snapshot.removingId &&
      this.snapshot.status === 'saved'
    ) {
      this.cancelTimer()
      this.onUnused()
    }
  }

  private patch(patch: Partial<NoteDraft>): void {
    if (
      !this.snapshot.draft ||
      (this.snapshot.removingId === this.snapshot.selectedId && this.snapshot.removingId !== null)
    )
      return
    this.publish({ draft: { ...this.snapshot.draft, ...patch }, status: 'dirty', errorCode: null })
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, NOTE_AUTOSAVE_DELAY_MS)
  }

  setTitle = (title: string): void => this.patch({ title })
  setText = (text: string): void => this.patch({ text })

  flush = async (): Promise<boolean> => {
    this.cancelTimer()
    if (this.pending) return this.pending
    if (this.snapshot.removingId === this.snapshot.selectedId && this.snapshot.removingId !== null)
      return false
    const request = this.save()
    this.pending = request
    try {
      return await request
    } finally {
      this.pending = null
      this.releaseIfSaved()
    }
  }

  private async save(): Promise<boolean> {
    while (this.snapshot.draft && this.snapshot.status === 'dirty') {
      const draft = this.snapshot.draft
      if (this.snapshot.isNew && !draft.title.trim() && !draft.text.trim()) {
        this.publish({ status: 'saved', errorCode: null })
        return true
      }
      this.publish({ status: 'saving', errorCode: null })
      try {
        const saved = this.snapshot.isNew
          ? await this.operations.create(draft)
          : await this.operations.update(this.snapshot.selectedId!, draft)
        const unchanged = this.snapshot.draft === draft
        this.publish({
          selectedId: saved.id,
          isNew: false,
          draft: unchanged ? draftOf(saved) : { ...this.snapshot.draft!, version: saved.version },
          status: unchanged ? 'saved' : 'dirty',
        })
        this.operations.changed()
      } catch (reason) {
        this.publish({ status: 'dirty', errorCode: this.operations.saveError(reason) })
        return false
      }
    }
    return true
  }

  private async navigate(
    next: () => Pick<NoteEditorSnapshot, 'draft' | 'selectedId' | 'isNew'>
  ): Promise<boolean> {
    const revision = ++this.navigation
    if (this.snapshot.removingId || !(await this.flush()) || revision !== this.navigation)
      return false
    this.cancelTimer()
    this.publish({ ...next(), status: 'saved', errorCode: null })
    return true
  }

  requestOpen = (note: LiteratureNote): Promise<boolean> =>
    this.navigate(() => ({
      draft:
        this.snapshot.selectedId === note.id &&
        this.snapshot.draft &&
        this.snapshot.draft.version >= note.version
          ? this.snapshot.draft
          : draftOf(note),
      selectedId: note.id,
      isNew: false,
    }))

  requestNew = (): Promise<boolean> =>
    this.navigate(() => ({
      draft: { title: '', text: '', version: 1 },
      selectedId: null,
      isNew: true,
    }))

  requestClose = (): Promise<boolean> =>
    this.navigate(() => ({ draft: null, selectedId: null, isNew: false }))

  sync(notes: readonly LiteratureNote[]): void {
    const fresh = notes.find((note) => note.id === this.snapshot.selectedId)
    if (
      fresh &&
      this.snapshot.status === 'saved' &&
      fresh.version > (this.snapshot.draft?.version ?? 0)
    )
      this.publish({ draft: draftOf(fresh) })
  }

  remove = async (id: string): Promise<boolean> => {
    if (this.snapshot.removingId) return false
    this.navigation++
    this.publish({ removingId: id, errorCode: null })
    if (id === this.snapshot.selectedId) this.cancelTimer()
    try {
      if (this.pending) await this.pending
      await this.operations.remove(id)
      if (id === this.snapshot.selectedId) {
        this.cancelTimer()
        this.publish(EMPTY_EDITOR)
      }
      this.operations.changed()
      return true
    } catch {
      this.publish({ errorCode: 'deleteFailed' })
      return false
    } finally {
      this.publish({ removingId: null })
      this.releaseIfSaved()
    }
  }
}
