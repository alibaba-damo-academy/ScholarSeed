import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
} from '../../../components/ui'
import { TranslationTargetPicker } from '../../../components/business/Language'
import type { TranslationDirection, TranslationSentence } from './analysis'
import { translationOutline, type TranslationNode } from './structure'

export function Language({
  value,
  disabled,
  onChange,
}: {
  value: TranslationDirection
  disabled?: boolean
  onChange: (value: TranslationDirection) => void
}): React.JSX.Element {
  return <TranslationTargetPicker value={value} disabled={disabled} onChange={onChange} />
}

export function Translation({
  sentences,
  active,
  onSelect,
  compact = false,
  sections = false,
  collapsed,
  onCollapse,
}: {
  sentences: TranslationSentence[]
  active: string
  onSelect: (sentence: TranslationSentence) => void
  compact?: boolean
  sections?: boolean
  collapsed?: Record<string, boolean>
  onCollapse?: (id: string, collapsed: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>({})
  const folded = collapsed ?? localCollapsed
  const toggle = (id: string, value: boolean): void => {
    if (onCollapse) onCollapse(id, value)
    else setLocalCollapsed((previous) => ({ ...previous, [id]: value }))
  }
  const selected = (sentence: TranslationSentence): boolean =>
    active === (sentence.source_id ?? sentence.source_text)
  const locate = (sentence: TranslationSentence) => ({
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected(sentence),
    onDoubleClick: () => {
      window.getSelection()?.removeAllRanges()
      onSelect(sentence)
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect(sentence)
      }
    },
  })
  const text = (items: TranslationSentence[]): React.ReactNode =>
    items.map((sentence, index) => (
      <React.Fragment key={sentence.source_id ?? `${sentence.source_text}:${index}`}>
        <span
          {...locate(sentence)}
          className={`cursor-text box-decoration-clone focus-visible:outline-[var(--vds-border-brand)] ${sentence.heading ? 'font-[var(--vds-fw-semibold)]' : ''} ${selected(sentence) ? 'bg-[var(--vds-brand-light-bg-default)]' : ''}`}
        >
          {sentence.translated_spans?.length &&
          sentence.translated_spans.map((span) => span.text).join('') === sentence.translated_text
            ? sentence.translated_spans.map((span, spanIndex) =>
                span.bold ? (
                  <strong key={spanIndex}>{span.text}</strong>
                ) : (
                  <React.Fragment key={spanIndex}>{span.text}</React.Fragment>
                )
              )
            : sentence.translated_text}
        </span>{' '}
      </React.Fragment>
    ))
  const render = (node: TranslationNode): React.JSX.Element => {
    if (!sections || !node.level)
      return (
        <React.Fragment key={node.id}>
          <p
            className="mb-[var(--vds-space-3)] text-justify last:mb-0"
            data-translation-paragraph={node.id}
          >
            {text(node.sentences)}
          </p>
          {node.children.map(render)}
        </React.Fragment>
      )
    const title = node.sentences.map((sentence) => sentence.translated_text).join(' ')
    const open = !folded[node.id]
    return (
      <Collapsible
        key={node.id}
        open={open}
        onOpenChange={(value) => toggle(node.id, !value)}
        className="mb-[var(--vds-space-3)] !gap-[var(--vds-space-1)] last:mb-0"
        data-translation-section={node.id}
      >
        <div
          className={`group/translation-heading relative min-w-0 ${node.level > 1 ? '[--pdf-translation-heading-size:var(--vds-pdf-translation-body-font-size)]' : '[--pdf-translation-heading-size:var(--vds-pdf-translation-heading-font-size)]'}`}
        >
          <div
            role="heading"
            aria-level={node.level}
            className="min-w-0 py-[var(--vds-space-1)] text-[length:var(--pdf-translation-heading-size)] font-[var(--vds-fw-semibold)] leading-[var(--vds-pdf-translation-heading-line-height)]"
          >
            <span
              {...locate(node.sentences[0])}
              className={
                selected(node.sentences[0]) ? 'bg-[var(--vds-brand-light-bg-default)]' : undefined
              }
            >
              {title}
            </span>
          </div>
          <CollapsibleTrigger asChild>
            <IconButton
              label={open ? t('translation.collapseHeading') : t('translation.expandHeading')}
              icon={<ChevronDown className={open ? undefined : '-rotate-90'} />}
              size="xs"
              variant="ghostIcon"
              className="pointer-events-none absolute right-full top-[calc(var(--vds-space-1)+var(--pdf-translation-heading-size)*var(--vds-pdf-translation-heading-line-height)/2)] -translate-y-1/2 opacity-0 group-hover/translation-heading:pointer-events-auto group-hover/translation-heading:opacity-[var(--vds-opacity-full)] group-focus-within/translation-heading:pointer-events-auto group-focus-within/translation-heading:opacity-[var(--vds-opacity-full)]"
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0 !text-[var(--vds-text-primary)]">
          {node.children.map(render)}
        </CollapsibleContent>
      </Collapsible>
    )
  }
  return (
    <div
      className={`cursor-text select-text [overflow-wrap:anywhere] ${compact ? 'text-[length:var(--vds-pdf-translation-body-font-size)] font-[var(--vds-fw-regular)] leading-[var(--vds-pdf-translation-line-height)]' : 'text-sm leading-[var(--vds-pdf-reading-content-line-height)]'}`}
      data-testid="translation-sentences"
    >
      {translationOutline(sentences).map(render)}
      {sentences.some((sentence) => sentence.emphasis_complete === false) && (
        <p
          role="status"
          className="mt-[var(--vds-space-4)] border-t border-[var(--vds-border-default)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
        >
          {t('translation.emphasisIncomplete')}
        </p>
      )}
    </div>
  )
}
