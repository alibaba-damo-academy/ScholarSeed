import type { JSX } from 'react'
import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button, EllipsisText, cx } from '../ui'
import { IconFont } from './Iconfont'

const AUTHORIZATION_BUTTON_CLASS_NAME =
  '!h-auto min-h-[var(--vds-control-height-md)] min-w-0 !whitespace-normal !rounded-[var(--vds-radius-4)] [overflow-wrap:anywhere]'

export type ConfirmationRisk = 'normal' | 'high'

export interface ConfirmationDetail {
  id: string
  label: string
  value: ReactNode
  highlighted?: boolean
  multiline?: boolean
}

export interface ConfirmationCardProps {
  title: string
  icon?: ReactNode
  description: ReactNode
  descriptionAction?: ReactNode
  wrapDescription?: boolean
  children?: ReactNode
  details?: readonly ConfirmationDetail[]
  disabled?: boolean
  readOnly?: boolean
  allowDisabled?: boolean
  allowVisible?: boolean
  allowAttributes?: Record<`data-${string}`, string | undefined>
  denyAttributes?: Record<`data-${string}`, string | undefined>
  compact?: boolean
  allowLabel: string
  denyLabel?: string
  open?: boolean
  risk?: ConfirmationRisk
  onAllow?: () => void
  onDeny?: () => void
  className?: string
}

export function ConfirmationCard({
  title,
  icon,
  description,
  descriptionAction,
  wrapDescription = false,
  children,
  details,
  disabled = false,
  readOnly = false,
  allowDisabled = false,
  allowVisible = true,
  allowAttributes,
  denyAttributes,
  compact = false,
  allowLabel,
  denyLabel,
  open = true,
  risk = 'normal',
  onAllow,
  onDeny,
  className,
}: ConfirmationCardProps): JSX.Element | null {
  if (!open) return null
  return (
    <div
      role="group"
      aria-label={title}
      className={cx(
        '@container/confirmation flex w-full min-w-0 max-w-[var(--vds-conversation-content-width)] flex-col rounded-[var(--vds-radius-6)] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-white-default)] px-[calc(var(--vds-space-4)-var(--vds-border-width-1))] py-[calc(var(--vds-space-3)-var(--vds-border-width-1))] text-[var(--vds-text-primary)]',
        className
      )}
    >
      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-[var(--vds-space-3)] @md/confirmation:grid-cols-[minmax(0,1fr)_minmax(0,max-content)] [&>:not([data-confirmation-header],[data-confirmation-actions])]:col-span-full">
        <div data-confirmation-header className="flex w-full min-w-0 items-center">
          <div
            className={cx(
              'flex min-w-[min(100%,calc(var(--vds-control-height-standard)*2+var(--vds-space-2)))] flex-1 gap-[var(--vds-space-2)]',
              wrapDescription ? 'items-start basis-auto' : 'items-center'
            )}
          >
            <span className="inline-flex size-[var(--vds-control-height-standard)] shrink-0 items-center justify-center rounded-[var(--vds-radius-4)] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-white-default)]">
              {icon ??
                (risk === 'high' ? (
                  <TriangleAlert
                    aria-hidden="true"
                    className="size-[var(--vds-icon-8)] text-[var(--vds-warning-bg-default)]"
                  />
                ) : (
                  <IconFont type="qingqiupizhun" className="text-[length:var(--vds-icon-8)]" />
                ))}
            </span>
            <div
              className={cx(
                'min-w-0 flex-1',
                wrapDescription ? 'max-w-full basis-auto' : 'basis-0',
                compact && '-my-[calc(var(--vds-space-1)-var(--vds-border-width-1))]'
              )}
            >
              <EllipsisText
                tooltipPortalled
                wrapperClassName="!block"
                className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-control-label-line-height)]"
              >
                {title}
              </EllipsisText>
              <div
                className={cx(
                  'mt-[var(--vds-space-1)] flex min-w-0 items-center gap-x-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]',
                  wrapDescription && 'flex-wrap gap-y-[var(--vds-space-1)]'
                )}
              >
                {wrapDescription ? (
                  <span className="min-w-0 [overflow-wrap:anywhere]">{description}</span>
                ) : (
                  <EllipsisText
                    tooltipPortalled
                    wrapperClassName="flex-1"
                    className="font-[number:var(--vds-fw-regular)]"
                  >
                    {description}
                  </EllipsisText>
                )}
                {descriptionAction}
              </div>
            </div>
          </div>
        </div>
        {details && details.length > 0 && (
          <dl className="m-0 grid max-h-[var(--vds-access-body-max-height)] gap-[var(--vds-space-1)] overflow-auto overscroll-contain py-[var(--vds-space-2)] pl-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)]">
            {details.map((detail) => (
              <div
                key={detail.id}
                className="grid min-h-[var(--vds-control-height-sm)] min-w-0 grid-cols-[calc(var(--vds-space-10)+var(--vds-space-4))_minmax(0,1fr)] items-center gap-[var(--vds-space-3)]"
              >
                <dt className="text-[var(--vds-text-tertiary)]">{detail.label}</dt>
                <dd
                  className={cx(
                    'm-0 min-w-0 rounded-[var(--vds-radius-4)] px-[calc(var(--vds-space-2)+var(--vds-space-half))] py-[var(--vds-space-1)]',
                    detail.highlighted && 'bg-[var(--vds-other-overlay-1)]'
                  )}
                >
                  {detail.multiline ? (
                    <div className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {detail.value}
                    </div>
                  ) : (
                    <EllipsisText tooltipPortalled wrapperClassName="!block">
                      {detail.value}
                    </EllipsisText>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {children}
        {!readOnly && (
          <div
            data-confirmation-actions
            className="flex min-w-0 items-center justify-end gap-[var(--vds-space-3)] empty:hidden @max-md/confirmation:flex-col @max-md/confirmation:items-stretch @md/confirmation:col-start-2 @md/confirmation:row-start-1"
          >
            {denyLabel && onDeny && (
              <Button
                size="md"
                variant={compact ? 'tertiary' : 'outline'}
                className={cx(
                  AUTHORIZATION_BUTTON_CLASS_NAME,
                  compact &&
                    '![background:var(--vds-authorization-deny-background)] enabled:hover:![background:var(--vds-other-overlay-2)] enabled:active:![background:var(--vds-other-overlay-3)]'
                )}
                disabled={disabled}
                {...denyAttributes}
                onClick={onDeny}
              >
                {denyLabel}
              </Button>
            )}
            {allowVisible && onAllow && (
              <Button
                size="md"
                variant="primary"
                className={cx(
                  AUTHORIZATION_BUTTON_CLASS_NAME,
                  !compact && '!border-[var(--vds-brand-light-border)]'
                )}
                disabled={disabled || allowDisabled}
                {...allowAttributes}
                onClick={onAllow}
              >
                {allowLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
