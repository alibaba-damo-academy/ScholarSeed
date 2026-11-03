import React from 'react'

import { archivedTaskForProject } from '../../session'
import { selectedProject, useApp } from '../../store'
import { AiPanel } from './AiPanel'
import { ArchivedConversation } from './Archived'

export function AssistantPanel(props: React.ComponentProps<typeof AiPanel>): React.JSX.Element {
  const { state } = useApp()
  const archived = archivedTaskForProject(state.archivedSession, selectedProject(state)?.path)
  return archived ? (
    <ArchivedConversation key={archived.session_id} task={archived} {...props} />
  ) : (
    <AiPanel {...props} />
  )
}
