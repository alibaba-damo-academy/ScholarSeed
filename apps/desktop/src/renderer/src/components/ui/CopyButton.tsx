import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { forwardRef, useEffect, useRef, useState } from 'react'

import { Button, type ButtonSize, type ButtonVariant } from './Button'
import { IconButton, type IconButtonProps } from './IconButton'
import { Tooltip } from './Tooltip'
import { copyButtonClassName, copyButtonStatusClassName, copyButtonStyleClassName } from './classes'
import { cx } from './utils'

interface CopyButtonBaseProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'value'
> {
  value?: string
  getValue?: () => string | Promise<string>
  children?: ReactNode
  copiedLabel?: string
  copiedIcon?: ReactNode
  copy?: () => Promise<void>
  errorLabel?: string
  feedbackDuration?: number
  idleLabel?: string
  showLoading?: boolean
  stableLabelWidth?: boolean
  statusStyle?: boolean
  tooltip?: boolean
  variant?: ButtonVariant
  writeText?: (text: string) => Promise<void>
}

export type CopyButtonProps = CopyButtonBaseProps &
  (
    | { iconOnly: true; icon: ReactNode; size?: IconButtonProps['size'] }
    | { iconOnly?: false; icon?: ReactNode; size?: ButtonSize }
  )

type CopyStatus = 'error' | 'idle' | 'success'
const DEFAULT_COPY_FEEDBACK_DURATION_MS = 2_000

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    children,
    className,
    copiedLabel,
    copiedIcon,
    copy,
    disabled,
    errorLabel,
    feedbackDuration = DEFAULT_COPY_FEEDBACK_DURATION_MS,
    getValue,
    icon,
    iconOnly,
    idleLabel,
    showLoading = true,
    onClick,
    size,
    stableLabelWidth = true,
    statusStyle = true,
    title,
    tooltip = false,
    value,
    variant = 'secondary',
    writeText,
    ...props
  },
  ref
): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [status, setStatus] = useState<CopyStatus>('idle')
  const [copying, setCopying] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const idleText = idleLabel ?? t('copy.idle')
  const copiedText = copiedLabel ?? t('copy.success')
  const errorText = errorLabel ?? t('copy.error')
  const label = status === 'success' ? copiedText : status === 'error' ? errorText : idleText

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  const showFeedback = (next: Exclude<CopyStatus, 'idle'>): void => {
    setStatus(next)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setStatus('idle'), feedbackDuration)
  }

  async function handleClick(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    onClick?.(event)
    if (event.defaultPrevented || disabled || copying) {
      return
    }

    const clipboard =
      event.currentTarget.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard
    setCopying(true)
    setStatus('idle')
    if (resetTimer.current) clearTimeout(resetTimer.current)
    try {
      if (copy) {
        await copy()
      } else {
        const text = getValue ? await getValue() : value
        if (typeof text !== 'string') throw new Error('CopyButton requires value or getValue')
        await (writeText ?? clipboard.writeText.bind(clipboard))(text)
      }
      showFeedback('success')
    } catch {
      showFeedback('error')
    } finally {
      setCopying(false)
    }
  }

  const buttonProps = {
    'aria-label': label,
    className: cx(
      copyButtonClassName({ className, status: statusStyle ? status : 'idle' }),
      copyButtonStyleClassName({ status: statusStyle ? status : 'idle' })
    ),
    'data-copy-status': status,
    disabled,
    loading: showLoading && copying,
    onClick: handleClick,
    ref,
    title: tooltip ? undefined : (title ?? label),
    variant,
    ...props,
  }
  const feedback = (
    <span aria-live="polite" className={copyButtonStatusClassName}>
      {label}
    </span>
  )

  if (iconOnly) {
    const button = (
      <IconButton
        {...buttonProps}
        icon={status === 'success' && copiedIcon ? copiedIcon : icon}
        label={label}
        size={size ?? 'sm'}
      >
        {feedback}
      </IconButton>
    )
    return tooltip ? (
      <Tooltip content={label} portalled>
        {button}
      </Tooltip>
    ) : (
      button
    )
  }

  const button = (
    <Button {...buttonProps} icon={icon} size={size ?? 'sm'}>
      {(status === 'success' && copiedIcon ? copiedIcon : children) ??
        (stableLabelWidth ? (
          <span className="grid">
            <span className="invisible col-start-1 row-start-1">{idleText}</span>
            <span className="invisible col-start-1 row-start-1">{copiedText}</span>
            <span className="invisible col-start-1 row-start-1">{errorText}</span>
            <span className="col-start-1 row-start-1">{label}</span>
          </span>
        ) : (
          <span>{label}</span>
        ))}
      {feedback}
    </Button>
  )
  return tooltip ? (
    <Tooltip content={label} portalled>
      {button}
    </Tooltip>
  ) : (
    button
  )
})

CopyButton.displayName = 'CopyButton'
