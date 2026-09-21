import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui'
import { Icon } from '../../icons'
import type { SessionNode } from '../../model'
import { useApp } from '../../store'
import { findSessionNode } from '../../tree'
import { fetchResourceAgentOrigin, type ResourceAgentOrigin } from './api'

export function ResourceAgentOriginAction({
  path,
  projectId
}: {
  path: string
  projectId: string
}): React.JSX.Element | null {
  const { state, act } = useApp()
  const { t } = useTranslation('resources')
  const [origin, setOrigin] = useState<ResourceAgentOrigin | null>(null)

  useEffect(() => {
    let active = true
    setOrigin(null)
    void fetchResourceAgentOrigin(projectId, path).then((result) => {
      if (active) setOrigin(result)
    })
    return () => {
      active = false
    }
  }, [path, projectId])

  if (!origin) return null
  const sourceSession: SessionNode = findSessionNode(state.sessions, origin.sessionId) ?? {
    id: origin.sessionId,
    title: origin.sessionId,
    status: 'dormant',
    openable: true
  }
  return (
    <Button
      data-testid="resource-agent-origin"
      icon={<Icon name="talk" size={14} />}
      onClick={() => act.openPanelSession(sourceSession, {
        turnId: origin.turnId,
        itemId: origin.itemId,
        sourceRange: origin.sourceRange
      })}
      size="sm"
      title={origin.sourceKind === 'artifact' ? t('origin.artifact') : t('origin.answer')}
      variant="secondary"
    >
      {t('origin.view')}
    </Button>
  )
}
