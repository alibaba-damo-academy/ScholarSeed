import type { ButtonHTMLAttributes } from 'react'
import { forwardRef, useState } from 'react'

import {
  checkboxBoxClassName,
  checkboxClassName,
  checkboxMarkClassName,
  checkboxStyleClassName,
  controlLabelClassName
} from './classes'
import { cx } from './utils'

export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked?: boolean | 'mixed'
  defaultChecked?: boolean
  label?: string
  onCheckedChange?: (checked: boolean) => void
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, className, defaultChecked = false, disabled, label, onCheckedChange, type = 'button', ...props }, ref) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked)
    const isChecked = checked ?? internalChecked

    return (
      <button
        aria-checked={isChecked}
        aria-label={label}
        className={cx(checkboxClassName({ checked: isChecked, className }), checkboxStyleClassName())}
        disabled={disabled}
        ref={ref}
        role="checkbox"
        type={type}
        onClick={() => {
          if (disabled) return
          const nextChecked = isChecked !== true
          if (checked === undefined) setInternalChecked(nextChecked)
          onCheckedChange?.(nextChecked)
        }}
        {...props}
      >
        <span aria-hidden="true" className={checkboxBoxClassName}>
          <span aria-hidden="true" className={checkboxMarkClassName} />
        </span>
        {label ? <span className={cx('vds-checkbox__label', controlLabelClassName)}>{label}</span> : null}
      </button>
    )
  }
)

Checkbox.displayName = 'Checkbox'
