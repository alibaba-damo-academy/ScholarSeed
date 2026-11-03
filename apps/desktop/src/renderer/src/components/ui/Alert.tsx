import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { IconFont } from '../primitive/Iconfont'
import {
  alertActionClassName,
  alertAsideClassName,
  alertClassName,
  alertCloseClassName,
  alertContentClassName,
  alertDescriptionClassName,
  alertIconClassName,
  alertStackedBodyClassName,
  alertStackedClassName,
  alertStackedHeaderClassName,
  alertStyleClassName,
  alertTitleClassName,
  type AlertTone
} from './classes'
import { cx } from './utils'
import type { LocalizationMetadata } from './metadata'

export type { AlertTone }
export type AlertLayout = 'inline' | 'stacked'

const ALERT_ICON_BY_TONE: Record<AlertTone, string> = {
  error: 'fill-status-error',
  info: 'fill-status-tips',
  success: 'fill-status-success',
  warning: 'fill-status-warning'
}

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, LocalizationMetadata {
  action?: ReactNode
  closable?: boolean
  description?: ReactNode
  icon?: ReactNode
  layout?: AlertLayout
  onClose?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  title?: ReactNode
  tone?: AlertTone
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ action, children, className, closable = false, description, icon, layout = 'inline', onClose, title, tone = 'info', ...props }, ref) => {
    const { t } = useTranslation('ui')
    const titleSource = import.meta.env.DEV ? props['data-i18n-title'] : undefined
    const descriptionSource = import.meta.env.DEV ? props['data-i18n-description'] : undefined
    const resolvedIcon = icon === false ? null : icon ?? <IconFont type={ALERT_ICON_BY_TONE[tone]} />
    const titleNode = title ? <div className={alertTitleClassName} {...(titleSource ? { 'data-i18n-text': titleSource } : {})}>{title}</div> : null
    const descriptionNode = description ? <div className={alertDescriptionClassName} {...(descriptionSource ? { 'data-i18n-text': descriptionSource } : {})}>{description}</div> : null
    const asideNode = action || closable ? (
      <div className={alertAsideClassName}>
        {action ? <div className={alertActionClassName}>{action}</div> : null}
        {closable ? (
          <button aria-label={t('close')} className={alertCloseClassName} onClick={onClose} type="button">
            <IconFont type="line-operation-close" />
          </button>
        ) : null}
      </div>
    ) : null
    if (layout === 'stacked') {
      return (
        <div className={cx(alertClassName({ className, tone }), alertStyleClassName({ tone }), alertStackedClassName)} ref={ref} role={tone === 'error' ? 'alert' : 'status'} {...props}>
          <div className={alertStackedHeaderClassName}>
            {resolvedIcon ? <AlertIcon>{resolvedIcon}</AlertIcon> : null}
            <div className={alertContentClassName}>{titleNode}</div>
            {asideNode}
          </div>
          <div className={alertStackedBodyClassName}>{children ?? descriptionNode}</div>
        </div>
      )
    }
    return (
    <div className={cx(alertClassName({ className, tone }), alertStyleClassName({ tone }))} ref={ref} role={tone === 'error' ? 'alert' : 'status'} {...props}>
      {resolvedIcon ? <AlertIcon>{resolvedIcon}</AlertIcon> : null}
      <div className={alertContentClassName}>
        {children}
        {!children ? titleNode : null}
        {!children ? descriptionNode : null}
      </div>
      {asideNode}
    </div>
    )
  }
)

Alert.displayName = 'Alert'

export type AlertIconProps = HTMLAttributes<HTMLSpanElement>

export const AlertIcon = forwardRef<HTMLSpanElement, AlertIconProps>(
  ({ className, ...props }, ref) => (
    <span aria-hidden="true" className={cx(alertIconClassName, className)} ref={ref} {...props} />
  )
)

AlertIcon.displayName = 'AlertIcon'

export type AlertTitleProps = HTMLAttributes<HTMLHeadingElement>

export const AlertTitle = forwardRef<HTMLHeadingElement, AlertTitleProps>(
  ({ className, ...props }, ref) => <h5 className={cx(alertTitleClassName, className)} ref={ref} {...props} />
)

AlertTitle.displayName = 'AlertTitle'

export interface AlertDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {
  truncate?: boolean
}

export const AlertDescription = forwardRef<HTMLParagraphElement, AlertDescriptionProps>(
  ({ className, truncate = true, ...props }, ref) => (
    <p
      className={cx(alertDescriptionClassName, !truncate && 'line-clamp-none overflow-visible', className)}
      ref={ref}
      {...props}
    />
  )
)

AlertDescription.displayName = 'AlertDescription'
