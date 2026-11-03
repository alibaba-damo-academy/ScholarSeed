import { useTranslation } from 'react-i18next'
import type { InputHTMLAttributes } from 'react'
import { forwardRef, useId, useState } from 'react'

import {
  fieldClassName,
  fieldLabelClassName,
  fieldMessageClassName,
  inputClassName,
  inputStyleClassName,
  type ControlSize,
} from './classes'
import { cx } from './utils'
import { IconFont } from '../primitive/Iconfont'
import type { LocalizationMetadata } from './metadata'

export type InputSize = ControlSize

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, LocalizationMetadata {
  error?: string
  helperText?: string
  invalid?: boolean
  label?: string
  labelClassName?: string
  size?: InputSize
  unstyled?: boolean
}

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  hideLabel?: string
  showLabel?: string
  toggleClassName?: string
}

const PASSWORD_INPUT_WRAP_CLASS_NAME = 'relative min-w-0'
const PASSWORD_INPUT_CLASS_NAME = 'pr-[calc(var(--vds-space-8)+var(--vds-space-2))]'
const PASSWORD_TOGGLE_CLASS_NAME = [
  'absolute right-[var(--vds-space-2)] top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center',
  'rounded-[var(--vds-radius-2)] border-0 bg-transparent p-0',
  'text-base leading-none text-[var(--vds-text-tertiary)]',
  'hover:text-[var(--vds-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]',
  'disabled:cursor-not-allowed disabled:text-[var(--vds-text-disabled)]',
].join(' ')

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      error,
      helperText,
      id,
      invalid = false,
      label,
      labelClassName,
      size = 'md',
      unstyled = false,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const message = error ?? helperText
    const labelSource = import.meta.env.DEV ? props['data-i18n-label'] : undefined
    const messageSource = import.meta.env.DEV
      ? error
        ? props['data-i18n-error']
        : props['data-i18n-helper-text']
      : undefined
    const isInvalid = Boolean(error) || invalid
    const messageId = message ? `${inputId}-message` : undefined

    return (
      <label className={fieldClassName({})} htmlFor={inputId}>
        {label ? (
          <span
            className={fieldLabelClassName({ className: labelClassName })}
            {...(labelSource ? { 'data-i18n-text': labelSource } : {})}
          >
            {label}
            {props.required ? (
              <span
                aria-hidden="true"
                className="ml-[var(--vds-space-1)] text-[var(--vds-error-text-primary)]"
              >
                *
              </span>
            ) : null}
          </span>
        ) : null}
        <input
          aria-describedby={messageId}
          aria-invalid={isInvalid ? true : undefined}
          className={cx(
            inputClassName({ invalid: isInvalid, size }),
            !unstyled && inputStyleClassName({ invalid: isInvalid, size }),
            className
          )}
          id={inputId}
          ref={ref}
          {...props}
        />
        {message ? (
          <span
            className={fieldMessageClassName({})}
            id={messageId}
            {...(messageSource ? { 'data-i18n-text': messageSource } : {})}
          >
            {message}
          </span>
        ) : null}
      </label>
    )
  }
)

Input.displayName = 'Input'

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      className,
      disabled,
      error,
      helperText,
      hideLabel,
      id,
      invalid = false,
      label,
      labelClassName,
      showLabel,
      size = 'md',
      toggleClassName,
      unstyled = false,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const generatedId = useId()
    const inputId = id ?? generatedId
    const message = error ?? helperText
    const labelSource = import.meta.env.DEV ? props['data-i18n-label'] : undefined
    const isInvalid = Boolean(error) || invalid
    const messageId = message ? `${inputId}-message` : undefined
    const [visible, setVisible] = useState(false)
    const toggleLabel = visible
      ? (hideLabel ?? t('password.hide'))
      : (showLabel ?? t('password.show'))

    return (
      <label className={fieldClassName({})} htmlFor={inputId}>
        {label ? (
          <span
            className={fieldLabelClassName({ className: labelClassName })}
            {...(labelSource ? { 'data-i18n-text': labelSource } : {})}
          >
            {label}
          </span>
        ) : null}
        <span className={PASSWORD_INPUT_WRAP_CLASS_NAME}>
          <input
            aria-describedby={messageId}
            aria-invalid={isInvalid ? true : undefined}
            className={cx(
              inputClassName({ invalid: isInvalid, size }),
              !unstyled && inputStyleClassName({ invalid: isInvalid, size }),
              PASSWORD_INPUT_CLASS_NAME,
              className
            )}
            disabled={disabled}
            id={inputId}
            ref={ref}
            type={visible ? 'text' : 'password'}
            {...props}
          />
          <button
            aria-controls={inputId}
            aria-label={toggleLabel}
            className={cx(PASSWORD_TOGGLE_CLASS_NAME, toggleClassName)}
            disabled={disabled}
            type="button"
            onClick={() => setVisible((current) => !current)}
          >
            <IconFont
              className="text-base leading-none"
              type={visible ? 'line-operation-hide' : 'line-yulan'}
            />
          </button>
        </span>
        {message ? (
          <span className={fieldMessageClassName({})} id={messageId}>
            {message}
          </span>
        ) : null}
      </label>
    )
  }
)

PasswordInput.displayName = 'PasswordInput'
