import { useTranslation } from 'react-i18next'
import type { LabelHTMLAttributes } from 'react'
import { forwardRef } from 'react'

import { cx } from './utils'

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  disabled?: boolean
  optional?: boolean
  required?: boolean
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ children, className, disabled = false, optional = false, required = false, ...props }, ref) => {
    const { t } = useTranslation('ui')
    return (
    <label
      className={cx(
        'vds-label inline-flex items-center gap-[var(--vds-label-gap)] [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] font-medium leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]',
        disabled && 'vds-label--disabled cursor-default text-[var(--vds-text-disabled)]',
        className
      )}
      ref={ref}
      {...props}
    >
      <span className="vds-label__text">{children}</span>
      {required ? <span className="vds-label__required text-[var(--vds-error-text-primary)]">*</span> : null}
      {!required && optional ? (
        <span className="vds-label__optional text-[length:var(--vds-font-body-lv1)] font-normal text-[var(--vds-text-tertiary)]">
          {t('optional')}
        </span>
      ) : null}
    </label>
    )
  }
)

Label.displayName = 'Label'
