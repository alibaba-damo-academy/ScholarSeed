import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, cx } from '../ui'
import { OpenUIDirectory } from './OpenUI'
import {
  conversationOverview,
  conversationSections,
  type ConversationDirectoryEntry,
} from './navigation'

export function ConversationDirectory({
  activeId,
  onSelect,
}: {
  activeId: string
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation('examples')
  const entry = (item: ConversationDirectoryEntry): JSX.Element =>
    'directory' in item ? (
      <OpenUIDirectory
        key={item.id}
        activeId={activeId}
        onSelect={onSelect}
        label={t(item.labelKey)}
        number={item.number}
        testId="a2ui-openui-directory"
      />
    ) : (
      <Button
        key={item.id}
        variant="ghost"
        size="content"
        aria-label={t(item.labelKey)}
        aria-current={item.id === activeId ? 'page' : undefined}
        title={item.status === 'unbuilt' ? t('prototype.unbuilt') : undefined}
        onClick={() => onSelect(item.id)}
        data-scene-number={item.number}
        data-construction={item.status}
        className={cx(
          '!flex w-full min-w-0 items-start justify-start gap-[var(--vds-space-2)] !whitespace-normal rounded-[var(--vds-radius-3)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv1)]',
          item.id === activeId &&
            '![background:var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-text-primary)] font-[var(--vds-fw-medium)]'
        )}
      >
        <span
          aria-hidden
          className="shrink-0 font-[var(--vds-font-code)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
        >
          {item.number}
        </span>
        <span className="min-w-0 flex-1 break-words">{t(item.labelKey)}</span>
        {item.status === 'unbuilt' && (
          <span
            aria-hidden
            className="shrink-0 rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] px-[var(--vds-space-1)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
          >
            {t('prototype.unbuilt')}
          </span>
        )}
      </Button>
    )
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-3)]" data-testid="conversation-directory">
      {entry(conversationOverview)}
      {conversationSections.map((section) => (
        <div
          key={section.id}
          role="group"
          aria-label={t(section.labelKey)}
          className="grid min-w-0 gap-[var(--vds-space-1)]"
        >
          <h3 className="mb-[var(--vds-space-1)] mt-[var(--vds-space-2)] px-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] font-[var(--vds-fw-medium)] text-[var(--vds-text-tertiary)]">
            {t(section.labelKey)}
          </h3>
          {section.items.map(entry)}
        </div>
      ))}
    </div>
  )
}
