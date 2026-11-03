import React, { useCallback } from 'react'

import { Diff } from './Diff'
import { useWorkspaceController } from './workspace'

export function ReviewDiff({
  baseText,
  candidateText,
  path,
  sessionId,
  previewKey,
  readOnly
}: {
  baseText: string
  candidateText: string
  path: string
  sessionId: string
  previewKey: string
  readOnly: boolean
}): React.JSX.Element {
  const workspace = useWorkspaceController()
  const updateCandidate = useCallback((text: string): void => {
    workspace.updateText(sessionId, text)
  }, [sessionId, workspace])
  return <Diff
    baseText={baseText}
    candidateText={candidateText}
    identity={`${sessionId}:${path}:${previewKey}`}
    path={path}
    readOnly={readOnly}
    testId="review-diff"
    onCandidateChange={readOnly ? undefined : updateCandidate}
  />
}
