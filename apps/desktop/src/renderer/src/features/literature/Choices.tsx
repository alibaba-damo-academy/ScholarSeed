import React from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '../../components/ui'
import { QuestionOption } from '../../components/business/Options'

export interface ChoiceData {
  options?: {
    label: string
    description?: string
    displayLabel?: string
    displayDescription?: string
  }[]
  answers?: string[]
  papers?: { id: string; label: string; description?: string }[]
  selected_paper_ids?: string[]
  multiSelect?: boolean
}

export function LiteratureChoices({
  data,
  status,
  slot,
  submit,
}: {
  data: ChoiceData
  status: string
  slot: string
  submit: (action: string, values: Record<string, unknown>) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const disabled = status !== 'pending'
  const papers = data.papers ?? []
  if (slot === 'literature.authorization')
    return (
      <ul className="m-0 grid list-none gap-[var(--vds-space-2)] p-0">
        {papers.map((paper) => (
          <li
            key={paper.id}
            className="min-w-0 rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-hover)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] [overflow-wrap:anywhere]"
          >
            <span className="font-[number:var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
              {paper.label}
            </span>
            {paper.description && (
              <p className="m-0 mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                {paper.description}
              </p>
            )}
          </li>
        ))}
      </ul>
    )
  if (slot === 'literature.selection') {
    const selected = new Set(data.selected_paper_ids ?? [])
    return (
      <div
        className="grid gap-[var(--vds-space-3)]"
        role="group"
        aria-label={t('review.authorization.subsetHint')}
      >
        <Checkbox
          disabled={disabled}
          checked={selected.size === 0 ? false : selected.size === papers.length ? true : 'mixed'}
          label={t('review.authorization.subsetSelectAll')}
          onCheckedChange={() =>
            submit('select', {
              selected_paper_ids:
                selected.size === papers.length ? [] : papers.map((paper) => paper.id),
            })
          }
        />
        {papers.map((paper) => (
          <Checkbox
            key={paper.id}
            disabled={disabled}
            checked={selected.has(paper.id)}
            onCheckedChange={() => {
              const next = new Set(selected)
              if (next.has(paper.id)) next.delete(paper.id)
              else next.add(paper.id)
              submit('select', { selected_paper_ids: [...next] })
            }}
          >
            <span>
              {paper.label}
              {paper.description && (
                <span className="block text-[var(--vds-text-secondary)]">{paper.description}</span>
              )}
            </span>
          </Checkbox>
        ))}
      </div>
    )
  }
  const selected = data.answers ?? []
  return (
    <div className="grid gap-[var(--vds-space-3)]" role={data.multiSelect ? 'group' : 'radiogroup'}>
      {(data.options ?? []).map((option) => (
        <QuestionOption
          key={option.label}
          disabled={disabled}
          checked={selected.includes(option.label)}
          multiSelect={data.multiSelect}
          label={option.displayLabel ?? option.label}
          description={option.displayDescription ?? option.description}
          onSelect={() =>
            submit('choose', {
              answers: data.multiSelect
                ? selected.includes(option.label)
                  ? selected.filter((label) => label !== option.label)
                  : [...selected, option.label]
                : [option.label],
            })
          }
        />
      ))}
    </div>
  )
}
