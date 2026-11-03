import React, { useEffect, useState } from 'react'

import { useApp } from '../../store'
import { VersionHistory } from '../workbench/feature'
import { useDocumentWorkspace } from '../workbench/workspace'

export function ResourceHistory(): React.JSX.Element | null {
  const { state, act } = useApp()
  const documents = useDocumentWorkspace()
  const target = state.resource.historyTarget
  const [lastTarget, setLastTarget] = useState(target)
  const file = target ?? lastTarget
  useEffect(() => {
    if (target) setLastTarget(target)
  }, [target])
  if (!file || file.project !== state.homeSelectedProjectId) return null
  const session = Object.values(documents.sessions).find(
    (candidate) =>
      candidate.source.kind === 'project' &&
      candidate.source.project === file.project &&
      candidate.source.path === file.path
  )
  return (
    <VersionHistory
      session={session}
      file={file}
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) act.closeResourceHistory()
      }}
    />
  )
}
