import { candidateLabel, useAssistantContextText } from '../../features/assistant/text'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'

import { createFormatters } from '../../../../localization/format'
import type { AssistantContextCandidate } from '../../contracts/assistant'
import { fetchResourceCandidatePage } from '../../features/assistant/api'
import { resourceFileIcon } from '../../features/resources/icons'
import { Icon } from '../../icons'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui'

interface ContextOptionProps {
  item: AssistantContextCandidate
  projectId: string | null
  onSelect: (item: AssistantContextCandidate) => void
}

/** Folder expansion and selecting a whole folder are separate actions. */
export function ContextOption({ item, projectId, onSelect }: ContextOptionProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText, i18n } = useTranslation('assistant')
  const { t: context } = useTranslation('assistant')
  const contextText = useAssistantContextText()
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<AssistantContextCandidate[] | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const folder = item.kind === 'dir'
  const ResourceFileIcon = resourceFileIcon(item.label)
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const metadata = item.hint || (
    item.kind === 'session' && item.created_at
      ? format.date(item.created_at * 1000, { year: 'numeric', month: 'short', day: 'numeric' })
      : ''
  )

  const load = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setFailed(false)
    const page = await fetchResourceCandidatePage(projectId, item.source_id, nextOffset ?? 0)
    setLoading(false)
    if (!page) {
      setFailed(true)
      return
    }
    setChildren((current) => [...(current ?? []), ...page.items])
    setNextOffset(page.nextOffset)
  }

  const label = (
    <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
      <span className="whitespace-normal break-words text-[length:var(--vds-font-body-lv1)] font-medium leading-relaxed">{candidateLabel(item, assistantText)}</span>
      {item.unavailable_reason && (
        <small className="whitespace-normal break-words text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
          {contextText(item.unavailable_reason)}
        </small>
      )}
      {!item.unavailable_reason && metadata && (
        <small className="whitespace-normal break-words text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
          {metadata}
        </small>
      )}
    </span>
  )

  if (!folder) {
    return (
      <Button
        data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
        variant="ghost"
        size="content"
        disabled={Boolean(item.unavailable_reason)}
        className="!h-auto min-h-8 w-full min-w-0 items-start justify-start gap-[var(--vds-space-2)] !whitespace-normal rounded-[var(--vds-radius-3)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left hover:!bg-[var(--vds-bg-white-hover)]"
        title={item.unavailable_reason ? contextText(item.unavailable_reason) : candidateLabel(item, assistantText)}
        icon={item.kind === 'literature'
          ? <Icon name="books" size={15} />
          : item.kind === 'session'
            ? <Icon name="quote" size={15} />
            : <ResourceFileIcon size={15} />}
        onClick={() => onSelect(item)}
      >
        {label}
      </Button>
    )
  }

  return (
    <Collapsible
      disabled={Boolean(item.unavailable_reason)}
      open={open}
      onOpenChange={(expanded) => {
        setOpen(expanded)
        if (expanded && children === null) void load()
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button
            aria-label={context(open ? 'contextOption.collapse' : 'contextOption.expand', { name: item.label })}
            data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
            variant="ghost"
            size="sm"
            className="h-auto min-h-8 min-w-0 flex-1 justify-start gap-[var(--vds-space-2)] whitespace-normal rounded-[var(--vds-radius-3)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left hover:!bg-[var(--vds-bg-white-hover)] focus-visible:!bg-transparent focus-visible:!shadow-none"
            title={item.unavailable_reason ? contextText(item.unavailable_reason) : context(open ? 'contextOption.collapse' : 'contextOption.expand', { name: item.label })}
            icon={<Folder size={15} />}
          >
            {label}
            <span className="ml-auto">
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            </span>
          </Button>
        </CollapsibleTrigger>
        <Button
          aria-label={context('contextOption.referenceFolder', { name: item.label })}
          data-testid={`ai-context-reference-${item.kind}-${item.source_id}`}
          variant="ghost"
          size="sm"
          className="hover:!bg-[var(--vds-bg-white-hover)]"
          disabled={Boolean(item.unavailable_reason)}
          onClick={() => onSelect(item)}
        >
          {context('contextOption.reference')}
        </Button>
      </div>
      <CollapsibleContent className="ml-3 !rounded-none !border-0 !bg-transparent !p-0">
        {children?.map((child) => (
          <ContextOption
            key={`${child.kind}:${child.source_id}`}
            item={child}
            projectId={projectId}
            onSelect={onSelect}
          />
        ))}
        {loading && <p role="status" className="px-2 text-xs">{t('context.loading')}</p>}
        {!loading && !failed && children?.length === 0 && (
          <p className="px-2 text-xs text-[var(--vds-text-tertiary)]">{t('context.empty')}</p>
        )}
        {!loading && (failed || nextOffset !== null) && (
          <Button className="hover:!bg-[var(--vds-bg-white-hover)]" variant="ghost" size="sm" onClick={() => void load()}>
            {context(failed ? 'contextOption.retry' : 'contextOption.more')}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
