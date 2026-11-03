import React from 'react'
import { Checkbox, Radio, cx } from '../ui'

export function QuestionOption({
  label,
  description,
  checked,
  disabled,
  readOnly = false,
  multiSelect,
  onSelect,
  testId,
}: {
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  readOnly?: boolean
  multiSelect?: boolean
  onSelect: () => void
  testId?: string
}): React.JSX.Element {
  const Control = multiSelect ? Checkbox : Radio
  return (
    <Control
      align="first-line"
      type="button"
      data-testid={testId}
      disabled={disabled || readOnly}
      onCheckedChange={onSelect}
      checked={checked}
      aria-label={`${label}${description ? ` ${description}` : ''}`}
      className={cx(
        'flex w-full min-w-0 gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] !border border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left disabled:cursor-default',
        checked ? '!bg-[var(--vds-surface-hover)]' : 'bg-transparent',
        readOnly && 'disabled:!cursor-default disabled:!opacity-[var(--vds-opacity-full)]',
        readOnly &&
          checked &&
          '[&>span:first-child]:!border-[var(--vds-text-tertiary)] [&>span:first-child]:!bg-[var(--vds-text-tertiary)]'
      )}
    >
      <span className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]">
        <span
          className={cx(
            'block font-[number:var(--vds-fw-medium)] [overflow-wrap:anywhere]',
            readOnly ? 'text-[var(--vds-text-tertiary)]' : 'text-[var(--vds-text-primary)]'
          )}
        >
          {label}
        </span>
        {description && (
          <span
            className={cx(
              'mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] [overflow-wrap:anywhere]',
              readOnly ? 'text-[var(--vds-text-tertiary)]' : 'text-[var(--vds-text-secondary)]'
            )}
          >
            {description}
          </span>
        )}
      </span>
    </Control>
  )
}
