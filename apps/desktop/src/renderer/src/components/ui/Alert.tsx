import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
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
  alertStyleClassName,
  alertTitleClassName,
  type AlertTone,
} from './classes'
import { cx } from './utils'
import type { LocalizationMetadata } from './metadata'

export type { AlertTone }
export type AlertLayout = 'inline' | 'stacked'

const ALERT_ICON_BY_TONE = {
  neutral: Info,
  error: TriangleAlert,
  info: Info,
  success: CircleCheck,
  warning: CircleAlert,
}

const CLOSABLE_ICON_BY_TONE: Record<AlertTone, ReactNode> = {
  neutral: <IconFont type="fill-status-tips" />,
  error: <IconFont type="fill-status-error" />,
  info: <IconFont type="fill-status-tips" />,
  success: <IconFont type="fill-status-success" />,
  warning: <IconFont type="fill-status-warning" />,
}

export interface AlertProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, LocalizationMetadata {
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
  (
    {
      action,
      children,
      className,
      closable = false,
      description,
      icon,
      layout = 'inline',
      onClose,
      title,
      tone = 'info',
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const titleSource = import.meta.env.DEV ? props['data-i18n-title'] : undefined
    const descriptionSource = import.meta.env.DEV ? props['data-i18n-description'] : undefined
    const StatusIcon = ALERT_ICON_BY_TONE[tone]
    const resolvedIcon =
      icon === false
        ? null
        : (icon ??
          (closable ? (
            CLOSABLE_ICON_BY_TONE[tone]
          ) : (
            <StatusIcon className="size-[var(--vds-icon-8)]" />
          )))
    const iconAlignment = closable
      ? cx(
          '!w-[var(--vds-icon-7)] [&_.iconfont]:!text-[length:var(--vds-icon-7)]',
          title ? '!h-[var(--vds-lh-body-lv2)]' : '!h-[var(--vds-icon-7)]'
        )
      : undefined
    const titleNode = title ? (
      <div
        className={cx(alertTitleClassName, layout === 'stacked' && '!font-[var(--vds-fw-regular)]')}
        {...(titleSource ? { 'data-i18n-text': titleSource } : {})}
      >
        {title}
      </div>
    ) : null
    const descriptionNode = description ? (
      <div
        className={alertDescriptionClassName}
        {...(descriptionSource ? { 'data-i18n-text': descriptionSource } : {})}
      >
        {description}
      </div>
    ) : null
    const asideNode =
      action || closable ? (
        <div
          className={cx(
            alertAsideClassName,
            closable && Boolean(title) && 'min-h-[var(--vds-lh-body-lv2)] self-start'
          )}
        >
          {action ? <div className={alertActionClassName}>{action}</div> : null}
          {closable ? (
            <button
              aria-label={t('close')}
              className={alertCloseClassName}
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" className="size-[var(--vds-icon-8)]" />
            </button>
          ) : null}
        </div>
      ) : null
    if (layout === 'stacked') {
      return (
        <div
          className={cx(
            alertClassName({ className, tone }),
            alertStyleClassName({ tone }),
            alertStackedClassName,
            closable && '!items-start'
          )}
          ref={ref}
          role={tone === 'error' ? 'alert' : 'status'}
          {...props}
        >
          {resolvedIcon ? <AlertIcon className={iconAlignment}>{resolvedIcon}</AlertIcon> : null}
          <div className={cx(alertContentClassName, 'basis-1/2')}>
            {titleNode}
            <div className={alertStackedBodyClassName}>{children ?? descriptionNode}</div>
          </div>
          {asideNode}
        </div>
      )
    }
    return (
      <div
        className={cx(alertClassName({ className, tone }), alertStyleClassName({ tone }))}
        ref={ref}
        role={tone === 'error' ? 'alert' : 'status'}
        {...props}
      >
        {resolvedIcon ? <AlertIcon className={iconAlignment}>{resolvedIcon}</AlertIcon> : null}
        <div
          className={cx(
            alertContentClassName,
            'font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]'
          )}
        >
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
  ({ className, ...props }, ref) => (
    <h5 className={cx(alertTitleClassName, className)} ref={ref} {...props} />
  )
)

AlertTitle.displayName = 'AlertTitle'

export interface AlertDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {
  truncate?: boolean
}

export const AlertDescription = forwardRef<HTMLParagraphElement, AlertDescriptionProps>(
  ({ className, truncate = true, ...props }, ref) => (
    <p
      className={cx(
        alertDescriptionClassName,
        !truncate && 'line-clamp-none overflow-visible',
        className
      )}
      ref={ref}
      {...props}
    />
  )
)

AlertDescription.displayName = 'AlertDescription'
