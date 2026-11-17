import type { PdfRecordSnapshot } from '../../contracts/workbench'

export interface InsightRequest {
  attachment_id: string
  source_revision: string
  record_revision: string
  mark_ids: string[]
  model_key: string
  language: 'zh' | 'en'
}

export function insightMarks(snapshot: PdfRecordSnapshot | null) {
  if (snapshot?.source_state !== 'available') return []
  return (snapshot?.records.marks ?? [])
    .filter(
      (mark) =>
        mark.anchor_state === 'anchored' &&
        ((mark.style !== 'comment' && mark.text.trim()) ||
          snapshot?.records.comments.some(
            (comment) => comment.mark_id === mark.id && comment.body.trim()
          ))
    )
    .sort((left, right) => left.page - right.page)
}

export function insightRequest(
  snapshot: PdfRecordSnapshot,
  chosen: ReadonlySet<string>,
  model: string,
  language: string
): InsightRequest {
  const marks = insightMarks(snapshot).filter((mark) => chosen.has(mark.id))
  if (!marks.length || marks.length !== chosen.size || !model)
    throw new Error('invalid_insight_selection')
  return {
    attachment_id: snapshot.record_target.subject_id,
    source_revision: snapshot.source_revision,
    record_revision: snapshot.record_revision,
    mark_ids: marks.map((mark) => mark.id),
    model_key: model,
    language: language.startsWith('zh') ? 'zh' : 'en',
  }
}
