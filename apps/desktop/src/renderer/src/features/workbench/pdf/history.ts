import type { PdfRecordSnapshot, PdfRecords } from '../../../contracts/workbench'

export class PdfUndoHistory {
  private entries: PdfRecords[] = []
  private current: PdfRecordSnapshot | null = null

  private synchronize(snapshot: PdfRecordSnapshot): void {
    const current = this.current
    if (!current
      || snapshot.source_state !== 'available'
      || snapshot.record_revision !== current.record_revision
      || snapshot.source_revision !== current.source_revision
      || snapshot.record_target.owner !== current.record_target.owner
      || snapshot.record_target.scope_id !== current.record_target.scope_id
      || snapshot.record_target.subject_id !== current.record_target.subject_id) {
      this.entries = []
    }
    this.current = snapshot
  }

  record(previous: PdfRecordSnapshot, saved: PdfRecordSnapshot): void {
    this.synchronize(previous)
    this.entries.push(previous.records)
    this.current = saved
  }

  peek(snapshot: PdfRecordSnapshot): PdfRecords | null {
    this.synchronize(snapshot)
    return this.entries.at(-1) ?? null
  }

  consume(saved: PdfRecordSnapshot): void {
    this.entries.pop()
    this.current = saved
  }
}
