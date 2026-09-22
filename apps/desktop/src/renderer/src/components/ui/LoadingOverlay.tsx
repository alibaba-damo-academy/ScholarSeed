import { useTranslation } from 'react-i18next'
import type { HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import {
  loadingOverlayClassName,
  loadingOverlayContentClassName,
  loadingOverlayLabelClassName,
  loadingOverlayStyleClassName,
  type LoadingOverlayTone
} from './classes'
import { Spinner } from './Spinner'
import { cx } from './utils'

export interface LoadingOverlayProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode
  tone?: LoadingOverlayTone
  visible: boolean
}

export const LoadingOverlay = forwardRef<HTMLDivElement, LoadingOverlayProps>(
  ({ className, label, tone = 'default', visible, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const resolvedLabel = label === undefined ? t('loading') : label
    if (!visible) {
      return null
    }

    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className={cx(loadingOverlayClassName({ className, tone, visible }), loadingOverlayStyleClassName({ tone }))}
        ref={ref}
        role="status"
        {...props}
      >
        <div className={loadingOverlayContentClassName}>
          <Spinner size="md" />
          {resolvedLabel ? <span className={loadingOverlayLabelClassName}>{resolvedLabel}</span> : null}
        </div>
      </div>
    )
  }
)

LoadingOverlay.displayName = 'LoadingOverlay'
