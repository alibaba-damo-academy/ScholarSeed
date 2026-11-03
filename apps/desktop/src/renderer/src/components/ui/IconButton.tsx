import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { Button, type ButtonVariant } from './Button'
import {
  buttonClassName,
  iconButtonClassName,
  iconButtonContentClassName,
  iconButtonStyleClassName,
  type IconButtonSize,
} from './classes'
import { cx } from './utils'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: IconButtonSize
  variant?: ButtonVariant
  icon: ReactNode
  loading?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, icon, label, size = 'md', variant = 'primary', ...props }, ref) => (
    <Button
      aria-label={label}
      className={cx(
        buttonClassName({ size: size === 'mini' ? 'xs' : size, variant }),
        iconButtonClassName({ size }),
        iconButtonStyleClassName({ size, variant }),
        className
      )}
      unstyled
      ref={ref}
      size={size === 'mini' ? 'xs' : size}
      title={label}
      icon={
        <span aria-hidden="true" className={iconButtonContentClassName}>
          {icon}
        </span>
      }
      {...props}
    />
  )
)

IconButton.displayName = 'IconButton'
