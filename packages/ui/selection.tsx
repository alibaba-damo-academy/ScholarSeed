import type { CardState } from './contract'

const { React, Checkbox, mount, useTranslation, useCopyContent } = window.scholarseedUI
const PENDING = 'pending'
const SELECT = 'select'

interface SelectionData {
  papers?: { id: string; label: string; description?: string }[]
  selected_paper_ids?: string[]
}

function Selection({ state }: { state: CardState }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const data = { ...state.data, ...state.draft } as SelectionData
  const disabled = state.status !== PENDING
  const papers = data.papers ?? []
  const selected = new Set(data.selected_paper_ids ?? [])
  useCopyContent(papers.map(paper => `${selected.has(paper.id) ? '[x]' : '[ ]'} ${paper.label}${paper.description ? ` ${paper.description}` : ''}`).join('\n\n') || null)
  const selectedCount = papers.filter(paper => selected.has(paper.id)).length
  const allSelected = papers.length > 0 && selectedCount === papers.length
  return <div className="grid gap-[var(--vds-space-3)]" role="group" aria-label={t('review.authorization.subsetHint')}>
    <Checkbox disabled={disabled || papers.length === 0} checked={selectedCount === 0 ? false : allSelected ? true : 'mixed'} label={t('review.authorization.subsetSelectAll')} onCheckedChange={() => window.plugin.submit(SELECT, { selected_paper_ids: allSelected ? [] : papers.map(paper => paper.id) })} />
    {papers.map(paper => <Checkbox key={paper.id} disabled={disabled} align="first-line" checked={selected.has(paper.id)} className={`w-full min-w-0 rounded-[var(--vds-radius-4)] !border border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left ${selected.has(paper.id) ? '!bg-[var(--vds-surface-hover)]' : 'bg-transparent'}`} onCheckedChange={() => {
      const next = new Set(selected)
      if (next.has(paper.id)) next.delete(paper.id); else next.add(paper.id)
      window.plugin.submit(SELECT, { selected_paper_ids: [...next] })
    }}><span className="min-w-0 [overflow-wrap:anywhere]"><span className="block font-[number:var(--vds-fw-medium)]">{paper.label}</span>{paper.description && <span className="mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">{paper.description}</span>}</span></Checkbox>)}
  </div>
}

mount(state => <Selection state={state} />)
