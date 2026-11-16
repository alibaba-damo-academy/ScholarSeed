import { useTranslation } from 'react-i18next'
import type { LabelHTMLAttributes } from 'react'
import { forwardRef } from 'react'

import { cx } from './utils'
import { labelStyleClassName, type LabelVariant } from './classes'

export type { LabelVariant }

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  disabled?: boolean
  optional?: boolean
  required?: boolean
  variant?: LabelVariant
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  (
    {
      children,
      className,
      disabled = false,
      optional = false,
      required = false,
      variant = 'form',
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    return (
      <label
        className={cx(
          'vds-label inline-flex items-center gap-[var(--vds-label-gap)]',
          labelStyleClassName(variant),
          disabled && 'vds-label--disabled cursor-default text-[var(--vds-text-disabled)]',
          className
        )}
        ref={ref}
        {...props}
      >
        <span className="vds-label__text">{children}</span>
        {required ? (
          <span className="vds-label__required text-[var(--vds-error-text-primary)]">*</span>
        ) : null}
        {!required && optional ? (
          <span className="vds-label__optional text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
            {t('optional')}
          </span>
        ) : null}
      </label>
    )
  }
)

Label.displayName = 'Label'
