import type { MessageReference } from '../../model.ts'
import type { AssistantContextRef, AnswerAnnotation } from '../../contracts/assistant.ts'

export function draftReferenceGroups(
  references: readonly AssistantContextRef[],
  annotations: readonly AnswerAnnotation[],
  deletableAnnotations?: ReadonlySet<string>
): AssistantContextRef[][] {
  const sessions = new Map(
    annotations.map((annotation) => [annotation.annotation_id, annotation.session_id])
  )
  const groups = new Map<string, AssistantContextRef[]>()
  for (const reference of references) {
    const sessionId = reference.kind === 'note' ? sessions.get(reference.source_id) : undefined
    const identity = sessionId
      ? [
          'note',
          reference.project_id ?? null,
          sessionId,
          deletableAnnotations?.has(reference.source_id),
        ]
      : reference.anchor &&
          (reference.kind === 'selection' || reference.kind === 'literature') &&
          reference.source_id
        ? [
            reference.kind,
            reference.project_id ?? null,
            reference.source_id,
            reference.anchor.document_id ?? null,
          ]
        : [reference.ref_id]
    const key = JSON.stringify(identity)
    const group = groups.get(key)
    if (group) group.push(reference)
    else groups.set(key, [reference])
  }
  return [...groups.values()]
}

export interface ReferenceGroup {
  identity: string
  references: MessageReference[]
}

export function selectionReferenceGroups(
  references: readonly MessageReference[]
): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>()
  for (const reference of references) {
    if (!reference.anchor || reference.kind === 'pdf_comment' || reference.kind === 'note') continue
    const identity = JSON.stringify([
      reference.kind,
      reference.sourceId ?? reference.id,
      reference.anchor.documentId ?? null,
    ])
    const group = groups.get(identity)
    if (group) group.references.push(reference)
    else groups.set(identity, { identity, references: [reference] })
  }
  return [...groups.values()]
}
