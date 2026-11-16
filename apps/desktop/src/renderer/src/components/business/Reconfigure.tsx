import React from 'react'
import { useTranslation } from 'react-i18next'
import { currentRuntimeReconfiguration, getRuntimeReconfiguration } from '../../api'
import {
  RECONFIGURATION_POLL_MS,
  RECONFIGURATION_ERRORS,
  reconfigurationRetryDelay,
  type ReconfigurationOperation,
} from '../../../../reconfiguration'
import { Alert, type AlertTone } from '../ui'

interface ReconfigureProps {
  sessionId: string
  modelId: string
  revision?: string
}

type ReconfigureMessage = `runtimeSwitch.${
  | 'unknown'
  | 'previous'
  | 'pending'
  | 'applied'
  | 'restartRequired'
  | 'unsupported'
  | 'stale'
  | 'busy'
  | 'failed'
  | 'queryUnavailable'}`

function reconfigureStatus(
  operation: ReconfigurationOperation | null,
  modelId: string,
  unknown: boolean,
  queryFailed: boolean
): { messageKey: ReconfigureMessage; tone: AlertTone } | null {
  if (queryFailed) return { messageKey: 'runtimeSwitch.queryUnavailable', tone: 'warning' }
  if (unknown) return { messageKey: 'runtimeSwitch.unknown', tone: 'warning' }
  if (!operation) return null
  const matches = operation.model_id === modelId
  if (!matches && operation.state !== 'accepted' && operation.state !== 'restart_required')
    return null
  if (operation.state === 'accepted') {
    if (matches) return { messageKey: 'runtimeSwitch.pending', tone: 'info' }
    return { messageKey: 'runtimeSwitch.previous', tone: 'info' }
  }
  if (operation.state === 'applied') return { messageKey: 'runtimeSwitch.applied', tone: 'success' }
  if (operation.state === 'restart_required')
    return { messageKey: 'runtimeSwitch.restartRequired', tone: 'error' }
  if (operation.state === 'unsupported')
    return { messageKey: 'runtimeSwitch.unsupported', tone: 'error' }
  if (operation.error === RECONFIGURATION_ERRORS.stale)
    return { messageKey: 'runtimeSwitch.stale', tone: 'error' }
  if (
    operation.error === RECONFIGURATION_ERRORS.resourceWaitTimeout ||
    operation.error === RECONFIGURATION_ERRORS.hostBusy
  ) {
    return { messageKey: 'runtimeSwitch.busy', tone: 'error' }
  }
  return { messageKey: 'runtimeSwitch.failed', tone: 'error' }
}

export function Reconfigure(props: ReconfigureProps): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const [operation, setOperation] = React.useState<ReconfigurationOperation | null>(null)
  const [unknown, setUnknown] = React.useState(false)
  const [queryFailed, setQueryFailed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let requestId: string | undefined
    let failureCount = 0
    setOperation(null)
    setUnknown(false)
    setQueryFailed(false)
    const check = async (): Promise<void> => {
      let delay: number | undefined
      try {
        const result = requestId
          ? await getRuntimeReconfiguration(props.sessionId, requestId)
          : await currentRuntimeReconfiguration(props.sessionId)
        if (cancelled) return
        setOperation(result ?? null)
        setUnknown(false)
        setQueryFailed(false)
        failureCount = 0
        if (result) {
          requestId = result.request_id
          if (result.state === 'accepted') delay = RECONFIGURATION_POLL_MS
        }
      } catch (error) {
        if (cancelled) return
        failureCount += 1
        delay = reconfigurationRetryDelay(error, failureCount)
        setUnknown(requestId !== undefined && delay !== undefined)
        setQueryFailed(delay === undefined)
      }
      if (!cancelled && delay !== undefined) timer = window.setTimeout(() => void check(), delay)
    }
    void check()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [props.sessionId, props.modelId, props.revision])

  const status = reconfigureStatus(operation, props.modelId, unknown, queryFailed)
  if (!status) return null
  return (
    <Alert
      data-testid="runtime-reconfigure-status"
      className="mb-[var(--vds-space-3)]"
      tone={status.tone}
      title={t(status.messageKey)}
    />
  )
}
