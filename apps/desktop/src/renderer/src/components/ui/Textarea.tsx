import type { TextareaHTMLAttributes } from 'react'
import { forwardRef, useId } from 'react'

import {
  fieldClassName,
  fieldLabelClassName,
  fieldMessageClassName,
  textareaClassName,
  textareaStyleClassName,
  type ComponentSize
} from './classes'
import { cx } from './utils'
import type { LocalizationMetadata } from './metadata'

export type TextareaSize = ComponentSize

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, LocalizationMetadata {
  error?: string
  helperText?: string
  invalid?: boolean
  label?: string
  labelClassName?: string
  size?: TextareaSize
  unstyled?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, helperText, id, invalid = false, label, labelClassName, size = 'md', unstyled = false, ...props }, ref) => {
    const generatedId = useId()
    const textareaId = id ?? generatedId
    const message = error ?? helperText
    const labelSource = import.meta.env.DEV ? props['data-i18n-label'] : undefined
    const messageSource = import.meta.env.DEV
      ? error ? props['data-i18n-error'] : props['data-i18n-helper-text']
      : undefined
    const isInvalid = Boolean(error) || invalid
    const messageId = message ? `${textareaId}-message` : undefined
    const textarea = (
      <textarea
        aria-describedby={messageId}
        aria-invalid={isInvalid ? true : undefined}
        className={cx(textareaClassName({ invalid: isInvalid, size }), !unstyled && textareaStyleClassName({ invalid: isInvalid, size }), className)}
        id={textareaId}
        ref={ref}
        {...props}
      />
    )

    if (!label && !message) return textarea

    return (
      <label className={fieldClassName({})} htmlFor={textareaId}>
        {label ? <span className={fieldLabelClassName({ className: labelClassName })} {...(labelSource ? { 'data-i18n-text': labelSource } : {})}>{label}</span> : null}
        {textarea}
        {message ? (
          <span className={fieldMessageClassName({})} id={messageId} {...(messageSource ? { 'data-i18n-text': messageSource } : {})}>
            {message}
          </span>
        ) : null}
      </label>
    )
  }
)

Textarea.displayName = 'Textarea'
