import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'

import type { UpdateInstallation, UpdateInstallStep } from '../../../../updates.ts'

const CLOCK_INTERVAL_MS = 1_000
const SECONDS_PER_MINUTE = 60
const DURATION_DIGITS = 2

const STEP_LABELS = {
  package: 'update.stepPackage',
  image: 'update.stepImage',
  mounts: 'update.stepMounts',
  mounting: 'update.stepMounting',
  identity: 'update.stepIdentity',
  signature: 'update.stepSignature',
  gatekeeper: 'update.stepGatekeeper',
  notarization: 'update.stepNotarization',
  publisher: 'update.stepPublisher',
  'staging-cleanup': 'update.stepStagingCleanup',
  copying: 'update.stepCopying',
  cleanup: 'update.stepCleanup',
  restarting: 'update.restarting',
} as const satisfies Record<UpdateInstallStep, string>

export function installationStepText(
  installation: UpdateInstallation,
  t: TFunction<'components'>
): string {
  const step = t(STEP_LABELS[installation.step])
  return installation.application === 'staged' ? t('update.stagedStep', { step }) : step
}

/** Elapsed duration only. Command limits cannot predict completion percentages or remaining time. */
export function installationDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / CLOCK_INTERVAL_MS))
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(DURATION_DIGITS, '0')}`
}

export function useInstallationClock(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}
