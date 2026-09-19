import React, { useCallback } from 'react'

import { Diff } from './Diff'
import { useWorkspaceController } from './workspace'

export function ReviewDiff({
  baseText,
  candidateText,
  path,
  sessionId
}: {
  baseText: string
  candidateText: string
  path: string
  sessionId: string
}): React.JSX.Element {
  const workspace = useWorkspaceController()
  const updateCandidate = useCallback((text: string): void => {
    workspace.updateText(sessionId, text)
  }, [sessionId, workspace])
  return <Diff
    baseText={baseText}
    candidateText={candidateText}
    identity={`${sessionId}:${path}`}
    path={path}
    readOnly={false}
    testId="review-diff"
    onCandidateChange={updateCandidate}
  />
}
