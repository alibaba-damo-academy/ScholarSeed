import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { STARTUP_PHASE, SCHEMA_UPGRADE_REQUIRED } from '../../../startup'
import { Progress } from '../components/primitive/Progress'
import { useThemeEffect } from '../theme'
import { useStartup } from './connection'
import { FeedbackRecovery } from '../components/business/Feedback'

export function Startup({ children }: { children: React.ReactNode }): React.JSX.Element {
  const snapshot = useStartup()
  const [entered, setEntered] = useState(snapshot.phase === STARTUP_PHASE.ready)
  useEffect(() => {
    if (snapshot.phase === STARTUP_PHASE.ready) setEntered(true)
  }, [snapshot.phase])
  if (entered) return <>{children}</>
  return (
    <div className="relative flex h-screen">
      <StartupProgress />
    </div>
  )
}

function StartupProgress(): React.JSX.Element {
  const snapshot = useStartup()
  const { t } = useTranslation('shell')
  const { t: foundation } = useTranslation('foundation')
  useThemeEffect(window.scholarseed?.preferences.theme ?? 'system')
  const failed = snapshot.phase === STARTUP_PHASE.failed
  const upgradeRequired = snapshot.error === SCHEMA_UPGRADE_REQUIRED
  if (failed)
    return (
      <FeedbackRecovery
        title={
          upgradeRequired ? t('workspaceLoading.upgradeTitle') : t('workspaceLoading.failedTitle')
        }
        detail={
          upgradeRequired
            ? foundation('backendFailure.schemaUpgradeRequired')
            : t('workspaceLoading.failedDetail')
        }
        actionLabel={snapshot.retryable ? t('workspaceLoading.reload') : undefined}
        onAction={
          snapshot.retryable
            ? () => {
                void window.scholarseed?.retryStartup?.()
              }
            : undefined
        }
      />
    )
  return (
    <Progress
      surface="screen"
      title={t(failed ? 'workspaceLoading.failedTitle' : 'workspaceLoading.loadingTitle')}
      detail={t(failed ? 'workspaceLoading.failedDetail' : 'workspaceLoading.connecting')}
      error={failed}
      actionLabel={failed && snapshot.retryable ? t('workspaceLoading.reload') : undefined}
      onAction={
        failed && snapshot.retryable
          ? () => {
              void window.scholarseed?.retryStartup?.()
            }
          : undefined
      }
    />
  )
}
