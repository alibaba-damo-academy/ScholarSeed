import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'

import { Button, Divider, EllipsisText } from '../../components/ui'
import { useApp } from '../../store'
import { sessionDisplayTitle } from '../../session'
import type { ForkOrigin } from './fork'

export function ForkOriginDivider({
  origin,
  failed,
  refresh,
}: {
  origin: ForkOrigin
  failed: boolean
  refresh: () => Promise<ForkOrigin | null>
}): React.JSX.Element {
  const { act } = useApp()
  const { t } = useTranslation('conversation')
  const { t: assistantT } = useTranslation('assistant')
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const open = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    try {
      const latest = await refresh()
      if (latest?.status !== 'available' || !latest.navigation || !latest.anchor) return
      const navigation = latest.navigation
      act.openPanelSession(
        {
          id: navigation.session_id,
          title: navigation.title,
          title_fallback: navigation.title_fallback,
          status: navigation.running ? 'running' : 'dormant',
          workdir: navigation.runtime_workdir,
          projectPath: navigation.project_path,
          runtimeId: navigation.runtime_id,
        },
        { itemId: latest.anchor.item_id, turnId: latest.anchor.turn_id }
      )
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  const title =
    origin.title === null
      ? t('fork.source')
      : sessionDisplayTitle(
          {
            title: origin.title,
            title_fallback: origin.title_fallback,
          },
          assistantT
        )
  const reasons = {
    deleted: t('fork.reason.deleted'),
    forbidden: t('fork.reason.forbidden'),
    archived: t('fork.reason.archived'),
    anchor_unavailable: t('fork.reason.anchor_unavailable'),
    unavailable: t('fork.reason.unavailable'),
  }
  const reason = failed
    ? t('fork.loadFailed')
    : origin.status === 'available'
      ? null
      : reasons[origin.status]
  return (
    <div
      data-testid="fork-origin-divider"
      data-source-session-id={origin.source_session_id}
      data-source-product-seq={origin.source_product_seq}
      className="my-[var(--vds-space-4)] min-w-0"
    >
      <div className="flex min-w-0 items-center gap-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[color:var(--vds-text-tertiary)]">
        <div className="min-w-0 flex-1">
          <Divider />
        </div>
        <div className="flex min-w-0 max-w-3/4 items-center gap-[var(--vds-space-2)]">
          <GitBranch aria-hidden="true" className="size-[var(--vds-icon-8)] shrink-0" />
          <span className="shrink-0">{t('fork.label')}</span>
          <Button
            size="sm"
            variant="ghost"
            loading={pending}
            disabled={!failed && origin.status !== 'available'}
            data-testid="fork-origin-return"
            onClick={() => void open()}
            className="min-w-0"
          >
            <EllipsisText
              tooltipPortalled
              className={
                origin.status === 'available' && !failed
                  ? 'text-[color:var(--vds-brand-text-primary)]'
                  : 'text-[color:var(--vds-text-tertiary)]'
              }
            >
              {title}
            </EllipsisText>
          </Button>
        </div>
        <div className="min-w-0 flex-1">
          <Divider />
        </div>
      </div>
      {reason && (
        <p
          role="status"
          data-testid="fork-origin-reason"
          className="m-0 text-center text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[color:var(--vds-text-tertiary)]"
        >
          {reason}
        </p>
      )}
    </div>
  )
}
