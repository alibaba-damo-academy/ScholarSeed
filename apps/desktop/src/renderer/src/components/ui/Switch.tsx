import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef, useState } from 'react'

import { IconFont } from '../primitive'
import {
  switchCheckedDecorClassName,
  switchClassName,
  switchStyleClassName,
  switchThumbClassName,
  switchUncheckedDecorClassName
} from './classes'
import { cx } from './utils'

export type SwitchVariant = 'default' | 'icon' | 'text'

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked?: boolean
  checkedContent?: ReactNode
  defaultChecked?: boolean
  label?: string
  onCheckedChange?: (checked: boolean) => void
  uncheckedContent?: ReactNode
  variant?: SwitchVariant
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      checkedContent,
      children,
      className,
      defaultChecked = false,
      disabled,
      label,
      onCheckedChange,
      type = 'button',
      uncheckedContent,
      variant = 'default',
      ...props
    },
    ref
  ) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked)
    const isChecked = checked ?? internalChecked
    const checkedDisplay =
      checkedContent ?? (variant === 'text' ? 'ON' : variant === 'icon' ? <IconFont type="line-operation-select" /> : null)
    const uncheckedDisplay =
      uncheckedContent ?? (variant === 'text' ? 'OFF' : variant === 'icon' ? <IconFont type="line-operation-close" /> : null)

    return (
      <button
        aria-checked={isChecked}
        aria-label={label}
        className={cx(switchClassName({ checked: isChecked, className, variant }), switchStyleClassName({ variant }))}
        disabled={disabled}
        ref={ref}
        role="switch"
        type={type}
        onClick={() => {
          if (disabled) return
          const nextChecked = !isChecked
          if (checked === undefined) setInternalChecked(nextChecked)
          onCheckedChange?.(nextChecked)
        }}
        {...props}
      >
        {variant !== 'default' ? (
          <>
            <span aria-hidden="true" className={switchCheckedDecorClassName}>
              {checkedDisplay}
            </span>
            <span aria-hidden="true" className={switchUncheckedDecorClassName}>
              {uncheckedDisplay}
            </span>
          </>
        ) : null}
        <span aria-hidden="true" className={switchThumbClassName} />
        {children}
      </button>
    )
  }
)

Switch.displayName = 'Switch'
