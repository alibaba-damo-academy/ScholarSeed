import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import {
  buttonClassName,
  buttonStyleClassName,
  controlDisabled,
  type ButtonSize,
  type ButtonVariant
} from './classes'
import { Spinner } from './Spinner'
import { cx } from './utils'

export type { ButtonSize, ButtonVariant }

export interface ButtonVariantsOptions {
  className?: string
  size?: ButtonSize
  unstyled?: boolean
  variant?: ButtonVariant
}

const BUTTON_UNSTYLED_RESET_CLASS_NAME = [
  '[font-family:inherit] shadow-none appearance-none',
  'select-none focus-visible:outline-none disabled:!cursor-not-allowed data-[loading=true]:!cursor-not-allowed data-[loading=true]:pointer-events-none',
  '[&_svg]:shrink-0 [&_svg]:pointer-events-none [&_.iconfont]:shrink-0 [&_.iconfont]:pointer-events-none'
].join(' ')

export function buttonVariants(options: ButtonVariantsOptions = {}): string {
  const { className, size = 'md', unstyled = false, variant = 'primary' } = options
  if (unstyled) {
    return cx(BUTTON_UNSTYLED_RESET_CLASS_NAME, className)
  }
  return cx(
    buttonClassName({ size, variant }),
    buttonStyleClassName({ size, variant }),
    className
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean
  loadingIcon?: ReactNode
  size?: ButtonSize
  unstyled?: boolean
  variant?: ButtonVariant
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      disabled,
      icon,
      loading = false,
      loadingIcon,
      size = 'md',
      type = 'button',
      unstyled = false,
      variant = 'primary',
      ...props
    },
    ref
  ) => (
    <button
      className={buttonVariants({ className, size, unstyled, variant })}
      data-loading={loading ? 'true' : undefined}
      disabled={controlDisabled(disabled, loading)}
      ref={ref}
      type={type}
      {...props}
    >
      {loading ? loadingIcon ?? <Spinner className="-ms-[var(--vds-space-1)]" size="sm" /> : icon}
      {children}
    </button>
  )
)

Button.displayName = 'Button'
