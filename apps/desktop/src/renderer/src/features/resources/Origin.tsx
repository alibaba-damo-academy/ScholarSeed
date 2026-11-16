import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui'
import { Icon } from '../../icons'
import type { SessionNode } from '../../model'
import { useApp } from '../../store'
import { findSessionNode } from '../../tree'
import { fetchResourceAgentOrigin, type ResourceAgentOrigin } from './api'

type OriginProps = {
  path: string
  projectId: string
}

export function ResourceAgentOriginAction(props: OriginProps): React.JSX.Element {
  return <ResourceOriginButton key={JSON.stringify([props.projectId, props.path])} {...props} />
}

function ResourceOriginButton({ path, projectId }: OriginProps): React.JSX.Element | null {
  const { state, act } = useApp()
  const { t } = useTranslation('resources')
  const [origin, setOrigin] = useState<ResourceAgentOrigin | null>(null)
  const [checking, setChecking] = useState(false)
  const requests = useRef({ generation: 0 }).current

  const refresh = useCallback(async () => {
    const request = ++requests.generation
    const result = await fetchResourceAgentOrigin(projectId, path)
    if (request !== requests.generation) return null
    setOrigin(result)
    return result
  }, [path, projectId, requests])

  useEffect(() => {
    void refresh()
    return () => {
      requests.generation++
    }
  }, [refresh, requests])

  if (!origin) return null
  if (origin.sessionDeleted) {
    return <span data-testid="resource-agent-origin-deleted">{t('origin.deleted')}</span>
  }
  return (
    <Button
      data-testid="resource-agent-origin"
      disabled={checking}
      icon={<Icon name="talk" size={14} />}
      onClick={async () => {
        setChecking(true)
        const current = await refresh()
        setChecking(false)
        if (!current || current.sessionDeleted) return
        const sourceSession: SessionNode = findSessionNode(state.sessions, current.sessionId) ?? {
          id: current.sessionId,
          title: current.sessionId,
          status: 'dormant',
          openable: true,
        }
        act.openPanelSession(sourceSession, {
          turnId: current.turnId,
          itemId: current.itemId,
          sourceRange: current.sourceRange,
        })
      }}
      size="sm"
      title={origin.sourceKind === 'artifact' ? t('origin.artifact') : t('origin.answer')}
      variant="secondary"
    >
      {t('origin.view')}
    </Button>
  )
}
