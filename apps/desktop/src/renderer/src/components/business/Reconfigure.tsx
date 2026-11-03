import React from 'react'
import { useTranslation } from 'react-i18next'
import { currentRuntimeReconfiguration, getRuntimeReconfiguration } from '../../api'
import {
  RECONFIGURATION_POLL_MS,
  type ReconfigurationOperation,
} from '../../../../reconfiguration'
import { Alert } from '../ui'

interface ReconfigureProps {
  sessionId: string
  modelId: string
  revision?: string
}

export function Reconfigure(props: ReconfigureProps): JSX.Element | null {
  const { t } = useTranslation('components')
  const [operation, setOperation] = React.useState<ReconfigurationOperation | null>(null)
  const [unknown, setUnknown] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let requestId = ''
    setOperation(null)
    setUnknown(false)
    const check = async (): Promise<void> => {
      let poll = false
      try {
        const result = requestId
          ? await getRuntimeReconfiguration(props.sessionId, requestId)
          : await currentRuntimeReconfiguration(props.sessionId)
        if (cancelled) return
        setOperation(result ?? null)
        setUnknown(false)
        if (result) {
          requestId = result.request_id
          poll = result.state === 'accepted'
        }
      } catch {
        if (cancelled) return
        setUnknown(true)
        poll = true
      }
      if (!cancelled && poll) timer = window.setTimeout(() => void check(), RECONFIGURATION_POLL_MS)
    }
    void check()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [props.sessionId, props.modelId, props.revision])

  if (!operation && !unknown) return null
  const matches = operation?.model_id === props.modelId
  if (operation && !matches && operation.state !== 'accepted'
    && operation.state !== 'restart_required') return null
  const applied = matches && operation?.state === 'applied'
  const pending = operation?.state === 'accepted'
  const message = unknown ? 'runtimeSwitch.unknown'
    : pending && !matches ? 'runtimeSwitch.previous'
    : pending ? 'runtimeSwitch.pending'
    : applied ? 'runtimeSwitch.applied'
    : operation?.state === 'restart_required' ? 'runtimeSwitch.restartRequired'
    : operation?.state === 'unsupported' ? 'runtimeSwitch.unsupported'
    : operation?.error === 'runtime_reconfiguration_stale' ? 'runtimeSwitch.stale'
    : operation?.error === 'runtime_resource_wait_timeout' || operation?.error === 'runtime_host_busy'
      ? 'runtimeSwitch.busy' : 'runtimeSwitch.failed'
  return <Alert
    data-testid="runtime-reconfigure-status"
    className="mb-[var(--vds-space-3)]"
    tone={unknown ? 'warning' : pending ? 'info' : applied ? 'success' : 'error'}
    title={t(message)}
  />
}
