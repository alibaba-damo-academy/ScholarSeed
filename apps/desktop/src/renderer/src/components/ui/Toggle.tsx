import type { ButtonHTMLAttributes } from 'react'
import { forwardRef, useState } from 'react'

import { toggleClassName, toggleStyleClassName, type ToggleSize, type ToggleVariant } from './classes'
import { cx } from './utils'

export type { ToggleSize, ToggleVariant }

export interface ToggleVariantsOptions {
  className?: string
  pressed?: boolean
  size?: ToggleSize
  variant?: ToggleVariant
}

export function toggleVariants(options: ToggleVariantsOptions = {}): string {
  return cx(toggleClassName(options), toggleStyleClassName(options))
}

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  defaultPressed?: boolean
  onPressedChange?: (pressed: boolean) => void
  pressed?: boolean
  size?: ToggleSize
  variant?: ToggleVariant
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  (
    {
      children,
      className,
      defaultPressed = false,
      disabled,
      onClick,
      onPressedChange,
      pressed,
      size = 'md',
      type = 'button',
      variant = 'secondary',
      ...props
    },
    ref
  ) => {
    const [uncontrolledPressed, setUncontrolledPressed] = useState(defaultPressed)
    const currentPressed = pressed ?? uncontrolledPressed

    const setPressed = (nextPressed: boolean): void => {
      if (disabled) return
      if (pressed === undefined) setUncontrolledPressed(nextPressed)
      onPressedChange?.(nextPressed)
    }

    return (
      <button
        aria-pressed={currentPressed}
        className={toggleVariants({ className, pressed: currentPressed, size, variant })}
        data-state={currentPressed ? 'on' : 'off'}
        disabled={disabled}
        ref={ref}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) setPressed(!currentPressed)
        }}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Toggle.displayName = 'Toggle'
