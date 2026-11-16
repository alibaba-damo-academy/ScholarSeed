import React, { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clarificationOption, QUESTION_FIELDS_PRESENTATION } from '../../hil'
import { Card, CardTitle, Checkbox, Radio, Tag, cx } from '../ui'

function isQuestionField(field: unknown): field is { label: string; value: string } {
  return (
    typeof field === 'object' &&
    field !== null &&
    'label' in field &&
    typeof field.label === 'string' &&
    'value' in field &&
    typeof field.value === 'string'
  )
}

export function QuestionPrompt({
  presentation,
  children,
}: {
  presentation?: Record<string, unknown>
  children: React.ReactNode
}): React.JSX.Element {
  const { kind, title, summary, fields, notice } = presentation ?? {}
  if (
    kind !== QUESTION_FIELDS_PRESENTATION ||
    typeof title !== 'string' ||
    typeof summary !== 'string' ||
    typeof notice !== 'string' ||
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every(isQuestionField)
  ) {
    return <>{children}</>
  }

  return (
    <Card
      data-testid="hil-question-fields"
      padding="md"
      className="grid min-w-0 gap-[var(--vds-space-3)] [overflow-wrap:anywhere]"
    >
      <CardTitle>{title}</CardTitle>
      {summary && (
        <p className="m-0 whitespace-pre-wrap text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)] text-[var(--vds-text-primary)]">
          {summary}
        </p>
      )}
      <dl className="m-0 grid grid-cols-2 gap-x-[var(--vds-space-4)] gap-y-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)]">
        {fields.map(({ label, value }, index) => (
          <div key={index} className="grid min-w-0 content-start gap-[var(--vds-space-1)]">
            <dt className="text-[var(--vds-text-secondary)]">{label}</dt>
            <dd className="m-0 text-[var(--vds-text-primary)]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)] text-[var(--vds-text-placeholder)]">
        {notice}
      </p>
    </Card>
  )
}

export function QuestionOptionsReveal({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = (): void => setHeight(element.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      className="overflow-clip transition-[height] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none"
      style={{ height }}
    >
      <div ref={content} className="flow-root">
        {children}
      </div>
    </div>
  )
}

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
  onSelect?: () => void
  testId?: string
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const presentation = clarificationOption(label)
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
        '[&>span:last-child]:min-w-0 [&>span:last-child]:flex-1',
        checked ? '!bg-[var(--vds-brand-light-bg-default)]' : 'bg-transparent',
        readOnly && 'disabled:!cursor-default disabled:!opacity-[var(--vds-opacity-full)]',
        readOnly &&
          checked &&
          '[&>span:first-child]:!border-[var(--vds-text-tertiary)] [&>span:first-child]:!bg-[var(--vds-text-tertiary)]'
      )}
    >
      <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]">
        <span
          className={cx(
            'flex items-start justify-between gap-[var(--vds-space-2)] font-[number:var(--vds-fw-medium)]',
            readOnly ? 'text-[var(--vds-text-tertiary)]' : 'text-[var(--vds-text-primary)]'
          )}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{presentation.label}</span>
          {presentation.recommended && (
            <Tag size="small" className="shrink-0">
              {t('clarification.recommended')}
            </Tag>
          )}
        </span>
        {description && (
          <span
            className={cx(
              'block text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]',
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
