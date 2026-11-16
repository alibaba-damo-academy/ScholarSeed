import type { AssistantContextRef } from '../src/renderer/src/contracts/assistant.ts'
import type { MessageReference } from '../src/renderer/src/model.ts'
import type { HistoryMessageReference } from '../src/renderer/src/api.ts'
import type { AnswerAnnotation } from '../src/renderer/src/contracts/assistant.ts'

export const PREVIEW_REFERENCE_SESSION = 'preview-reference-origin'
export const PREVIEW_REFERENCE_FILES = ['sample.png', 'sample.pdf', 'measurements.csv'] as const

export function previewDraftReferences(): AssistantContextRef[] {
  return [
    ...previewContextReferences(),
    ...PREVIEW_REFERENCE_FILES.map((source) => ({
      ref_id: `preview-draft-${source}`,
      kind: 'file' as const,
      source_id: source,
      label: source,
      retention: 'next_turn' as const,
      origin: 'explicit' as const,
    })),
    {
      ref_id: 'preview-draft-session',
      kind: 'session' as const,
      source_id: PREVIEW_REFERENCE_SESSION,
      label: '模拟研究背景与实验设计',
      retention: 'next_turn' as const,
      origin: 'explicit' as const,
    },
    ...['one', 'two'].map((id) => ({
      ref_id: `preview-note-ref-${id}`,
      kind: 'note' as const,
      source_id: `preview-note-${id}`,
      label: '模拟回答注释',
      retention: 'next_turn' as const,
      origin: 'explicit' as const,
    })),
  ].map((reference) => ({ ...reference, retention: 'next_turn' }))
}

export function previewMixedReferences(): HistoryMessageReference[] {
  return [
    {
      type: 'file',
      id: 'preview-image',
      title: 'sample.png',
      path: 'sample.png',
      media_type: 'image/png',
    },
    {
      type: 'file',
      id: 'preview-image-comparison',
      title: 'comparison.png',
      path: 'sample.png',
      media_type: 'image/png',
    },
    {
      type: 'file',
      id: 'preview-pdf',
      title: 'sample.pdf',
      path: 'sample.pdf',
      media_type: 'application/pdf',
    },
    {
      type: 'file',
      id: 'preview-table',
      title: 'measurements.csv',
      path: 'measurements.csv',
      media_type: 'text/csv',
    },
    { type: 'skill', id: 'research', title: 'research' },
    {
      type: 'assistant_context',
      kind: 'session',
      id: 'preview-conversation-ref',
      title: '模拟研究背景与实验设计',
      source_id: PREVIEW_REFERENCE_SESSION,
    },
    ...['one', 'two'].map((id) => ({
      type: 'assistant_context',
      kind: 'note',
      id: `preview-note-ref-${id}`,
      title: '模拟回答注释',
      source_id: `preview-note-${id}`,
    })),
  ]
}

export function previewReferenceAnnotations(sessionId: string): AnswerAnnotation[] {
  return ['one', 'two'].map((id, index) => ({
    annotation_id: `preview-note-${id}`,
    client_annotation_id: `preview-note-${id}`,
    session_id: sessionId,
    answer_id: 'preview-context-answer',
    source_product_seq: 1,
    source_turn_id: 'preview-context-turn',
    source_item_id: 'preview-context-answer',
    answer_revision: 'preview-context-revision',
    start_utf16: index,
    end_utf16: index + 1,
    selected_text_hash: `preview-note-hash-${id}`,
    preview_text: ['需要比较实验条件与样本规模。', '应保留结果的适用范围。'][index],
    comment: ['请结合附件补充分析。', '请在结论中说明限制。'][index],
    revision: 1,
    created_at: 1,
    updated_at: 1,
  }))
}

export function previewContextReferences(): AssistantContextRef[] {
  return ['readme.md', 'readme.md', 'notes.md'].map((source, index) => ({
    ref_id: `preview-selection-${index}`,
    kind: 'selection',
    source_id: source,
    label: source,
    retention: 'session',
    origin: 'explicit',
    anchor: {
      document_id: source,
      locator: {
        kind: 'text',
        start_line: index + 1,
        start_column: 1,
        end_line: index + 1,
        end_column: 20,
      },
      selected_text_hash: `preview-${index}`,
      preview_text: `模拟划词 ${index + 1}：引用保持独立身份，同篇文章按组展示。`,
      snapshot_text: `模拟划词 ${index + 1}：引用保持独立身份，同篇文章按组展示。`,
    },
  }))
}

export function previewSubmittedReferences(
  refs: readonly AssistantContextRef[],
  snapshotId: string
): MessageReference[] {
  return refs.map((reference) => ({
    type: 'assistant_context',
    id: reference.ref_id,
    kind: reference.kind,
    title: reference.label,
    sourceId: reference.source_id,
    snapshotId,
    sourceRevision: reference.source_revision,
    anchor: reference.anchor
      ? {
          documentId: reference.anchor.document_id ?? undefined,
          previewText: reference.anchor.preview_text,
          locator: reference.anchor.locator,
        }
      : null,
  }))
}
