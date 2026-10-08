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
  align?: 'center' | 'first-line'
  checked?: boolean | 'mixed'
  defaultChecked?: boolean
  label?: string
  onCheckedChange?: (checked: boolean) => void
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ align = 'center', checked, children, className, defaultChecked = false, disabled, label, onCheckedChange, type = 'button', ...props }, ref) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked)
    const isChecked = checked ?? internalChecked

    return (
      <button
        aria-checked={isChecked}
        aria-label={label}
        className={cx(checkboxClassName({ checked: isChecked, className }), checkboxStyleClassName(), align === 'first-line' && 'items-start')}
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
        <span aria-hidden="true" className={cx(checkboxBoxClassName, align === 'first-line' && 'mt-[calc((var(--vds-lh-body-lv2)_-_var(--vds-checkbox-size))_/_2)]')}>
          <span aria-hidden="true" className={checkboxMarkClassName} />
        </span>
        {label ? <span className={cx('vds-checkbox__label', controlLabelClassName)}>{label}</span> : null}
        {children}
      </button>
    )
  }
)

Checkbox.displayName = 'Checkbox'
