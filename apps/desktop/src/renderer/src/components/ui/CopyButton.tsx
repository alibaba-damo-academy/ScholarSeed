import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { forwardRef, useEffect, useRef, useState } from 'react'

import { Button, type ButtonSize, type ButtonVariant } from './Button'
import { copyButtonClassName, copyButtonStatusClassName, copyButtonStyleClassName } from './classes'
import { cx } from './utils'

export interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'value'> {
  value?: string
  getValue?: () => string | Promise<string>
  children?: ReactNode
  copiedLabel?: string
  errorLabel?: string
  feedbackDuration?: number
  idleLabel?: string
  icon?: ReactNode
  size?: ButtonSize
  variant?: ButtonVariant
  writeText?: (text: string) => Promise<void>
}

type CopyStatus = 'error' | 'idle' | 'success'
const DEFAULT_COPY_FEEDBACK_DURATION_MS = 2_000

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    children,
    className,
    copiedLabel,
    disabled,
    errorLabel,
    feedbackDuration = DEFAULT_COPY_FEEDBACK_DURATION_MS,
    getValue,
    icon,
    idleLabel,
    onClick,
    size = 'sm',
    title,
    value,
    variant = 'secondary',
    writeText,
    ...props
  },
  ref
): JSX.Element {
  const { t } = useTranslation('ui')
  const [status, setStatus] = useState<CopyStatus>('idle')
  const [copying, setCopying] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  const idleText = idleLabel ?? t('copy.idle')
  const copiedText = copiedLabel ?? t('copy.success')
  const errorText = errorLabel ?? t('copy.error')
  const label = status === 'success' ? copiedText : status === 'error' ? errorText : idleText

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

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

    setCopying(true)
    setStatus('idle')
    if (resetTimer.current) clearTimeout(resetTimer.current)
    try {
      const text = getValue ? await getValue() : value
      if (typeof text !== 'string') {
        throw new Error('CopyButton requires value or getValue')
      }
      await (writeText ?? navigator.clipboard.writeText.bind(navigator.clipboard))(text)
      showFeedback('success')
    } catch {
      showFeedback('error')
    } finally {
      setCopying(false)
    }
  }

  return (
    <Button
      aria-label={label}
      className={cx(copyButtonClassName({ className, status }), copyButtonStyleClassName({ status }))}
      data-copy-status={status}
      disabled={disabled}
      icon={icon}
      loading={copying}
      onClick={handleClick}
      ref={ref}
      size={size}
      title={title ?? label}
      variant={variant}
      {...props}
    >
      {children ?? (
        <span className="grid">
          <span className="invisible col-start-1 row-start-1">{idleText}</span>
          <span className="invisible col-start-1 row-start-1">{copiedText}</span>
          <span className="invisible col-start-1 row-start-1">{errorText}</span>
          <span className="col-start-1 row-start-1">{label}</span>
        </span>
      )}
      <span aria-live="polite" className={copyButtonStatusClassName}>
        {label}
      </span>
    </Button>
  )
})

CopyButton.displayName = 'CopyButton'
