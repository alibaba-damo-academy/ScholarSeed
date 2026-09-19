import assert from 'node:assert/strict'
import test from 'node:test'

import { documentPanelContext } from './panel.ts'
import type { DocumentSession, DocumentTab } from './workspace.ts'

test('document panel context exposes stable attachment identity without feature state', () => {
  const session = {
    id: 'session-1',
    source: {
      kind: 'literature',
      literatureId: 'paper-1',
      attachmentId: 'attachment-1',
      recordTarget: {
        owner: 'literature_attachment',
        scope_id: 'paper-1',
        subject_id: 'attachment-1'
      },
      path: 'paper.pdf'
    },
    viewer: 'pdf'
  } as DocumentSession
  const tab = { id: 'tab-1' } as DocumentTab

  assert.deepEqual(documentPanelContext(session, tab), {
    path: 'paper.pdf',
    viewer: 'pdf',
    sourceKind: 'literature',
    recordTarget: {
      owner: 'literature_attachment',
      scope_id: 'paper-1',
      subject_id: 'attachment-1'
    },
    documentSessionId: 'session-1',
    tabId: 'tab-1'
  })
})
