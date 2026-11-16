import type {
  AssistantContextCandidate,
  AssistantContextTarget,
  AssistantIngress,
} from '../../contracts/assistant'
import type { PdfRecordSnapshot, SelectionAnchor } from '../../contracts/workbench'
import { focusComposer } from '../../reference.ts'
import { captureSelectionSnapshot, digestText, documentIdFor, preparePdfComments } from './api.ts'
import { pdfSelectionShape } from './pdf/geometry.ts'
import type { DocumentSession, DocumentWorkspace } from './workspace'

export async function addSelectionContext(
  session: DocumentSession,
  selection: SelectionAnchor,
  controller: DocumentWorkspace,
  ingress: AssistantIngress,
  additionalCandidates: AssistantContextCandidate[] = [],
  expectedTarget: AssistantContextTarget = ingress.captureContextTarget()
): Promise<'selectionActions.contextSaveFailed' | 'selectionActions.contextAddFailed' | null> {
  const source = session.source
  if (
    source.kind !== 'project' &&
    source.kind !== 'literature' &&
    source.kind !== 'session-artifact'
  )
    return 'selectionActions.contextAddFailed'
  let sourceRevision = session.revision
  if (source.kind === 'project' && session.dirty) {
    try {
      const saved = await controller.save(session.id)
      const committed = controller.getSnapshot().sessions[session.id]
      if (!saved || !committed || committed.dirty) return 'selectionActions.contextSaveFailed'
      sourceRevision = committed.revision
    } catch {
      return 'selectionActions.contextSaveFailed'
    }
  }
  try {
    let snapshotText = selection.text
    if (selection.locator.kind === 'calc' && selection.locator.content_mode === 'reference') {
      if (source.kind === 'session-artifact') return 'selectionActions.contextAddFailed'
      const snapshot = await captureSelectionSnapshot(source, sourceRevision, selection)
      snapshotText = snapshot.snapshot_text
      sourceRevision = snapshot.source_revision
    }
    const locator =
      selection.locator.kind === 'pdf'
        ? {
            ...selection.locator,
            text_shape_hash: await digestText(pdfSelectionShape(selection.text)),
          }
        : selection.locator
    const literature = source.kind === 'literature'
    const candidate: AssistantContextCandidate = {
      kind: literature ? 'literature' : 'selection',
      source_id: literature
        ? source.literatureId
        : source.kind === 'session-artifact'
          ? documentIdFor(source)
          : source.path,
      label: session.title || selection.locator.kind,
      selection_source_label: session.title,
      source_revision: sourceRevision,
      retention: 'next_turn',
      origin: 'explicit',
      anchor: {
        ...(literature ? { document_id: source.attachmentId } : {}),
        locator,
        selected_text_hash: await digestText(selection.text),
        preview_text: selection.text,
        snapshot_text: snapshotText,
      },
    }
    const result = additionalCandidates.length
      ? await ingress.addContexts([candidate, ...additionalCandidates], expectedTarget)
      : await ingress.addContext(candidate, expectedTarget)
    if (!result.accepted_ref_ids.length || result.rejected?.length)
      return 'selectionActions.contextAddFailed'
    ingress.openPanel('context_added')
    if (selection.locator.kind !== 'pdf') focusComposer()
    return null
  } catch {
    return 'selectionActions.contextAddFailed'
  }
}

export async function addPdfCommentContext(
  session: DocumentSession,
  snapshot: PdfRecordSnapshot,
  markId: string,
  selection: SelectionAnchor | null,
  controller: DocumentWorkspace,
  ingress: AssistantIngress
): Promise<boolean> {
  const expectedTarget = ingress.captureContextTarget()
  try {
    const refs = await preparePdfComments(snapshot, markId)
    if (selection)
      return !(await addSelectionContext(
        session,
        selection,
        controller,
        ingress,
        refs,
        expectedTarget
      ))
    if (!refs.length) return false
    const result = await ingress.addContexts(refs, expectedTarget)
    if (!result.accepted_ref_ids.length || result.rejected.length) return false
    ingress.openPanel('context_added')
    return true
  } catch {
    return false
  }
}
