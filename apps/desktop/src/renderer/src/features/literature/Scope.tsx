import React, { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { ConfirmationCard } from '../../components/primitive/Confirmation'
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  cx,
} from '../../components/ui'
import type { InteractionQuestion } from '../../contracts/features'

export type LiteratureAuthorizationCardProps = {
  selectable: boolean
  papers: NonNullable<InteractionQuestion['papers']>
  selectedPaperIds: string[]
  children?: ReactNode
} & (
  | {
      historical: true
      expanded?: never
      disabled?: never
      onExpandedChange?: never
      onSelectionChange?: never
      onAllow?: never
      onDeny?: never
    }
  | {
      historical?: false
      expanded: boolean
      disabled?: boolean
      onExpandedChange: (expanded: boolean) => void
      onSelectionChange: (paperIds: string[]) => void
      onAllow: () => void
      onDeny: () => void
    }
)

export function LiteratureAuthorizationCard({
  selectable,
  papers,
  selectedPaperIds,
  historical,
  expanded,
  disabled,
  children,
  onExpandedChange,
  onSelectionChange,
  onAllow,
  onDeny,
}: LiteratureAuthorizationCardProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const controlsDisabled = historical || disabled
  const selectedCount = papers.filter((paper) => selectedPaperIds.includes(paper.id)).length
  const card = (
    <ConfirmationCard
      compact
      className="min-h-0 flex-1"
      title={t('review.authorization.scopeTitle')}
      description={<span>{t('review.authorization.scopeDescription')}</span>}
      descriptionAction={
        selectable && (
          <CollapsibleTrigger asChild>
            <Button
              unstyled
              disabled={historical}
              data-testid="hil-question-toggle"
              className="inline-flex !h-auto !min-h-0 shrink-0 cursor-pointer items-center !gap-[var(--vds-space-1)] !border-0 !bg-transparent !p-0 !font-[var(--vds-fw-regular)] !leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] focus-visible:shadow-[var(--vds-focus-brand)]"
            >
              {t('review.authorization.adjustScope')}
              <ChevronRight
                aria-hidden="true"
                className="size-[var(--vds-icon-7)] text-[var(--vds-text-tertiary)] [[data-state=open]>&]:rotate-90"
              />
            </Button>
          </CollapsibleTrigger>
        )
      }
      allowLabel={t('review.authorization.authorize')}
      denyLabel={t('review.authorization.reject')}
      disabled={disabled}
      readOnly={historical}
      allowDisabled={selectable && selectedCount === 0}
      onAllow={onAllow}
      onDeny={onDeny}
    >
      {children}
      {selectable && (
        <CollapsibleContent
          className={cx(
            'min-h-0 max-h-[var(--vds-authorization-list-max-height)] w-full flex-1 flex-col data-[state=open]:flex !rounded-[var(--vds-radius-4)] !border-0 !bg-[var(--vds-authorization-list-background)] !p-0 !animate-none',
            historical &&
              '[&_[role=checkbox]:disabled]:!opacity-[var(--vds-opacity-full)] [&_[role=checkbox]:disabled]:!text-[var(--vds-text-secondary)] [&_[role=checkbox]:disabled]:[--vds-text-disabled:var(--vds-brand-light-border)] [&_[role=checkbox][aria-checked=mixed]:disabled_.vds-checkbox__box]:!border-[var(--vds-brand-light-border)] [&_[role=checkbox][aria-checked=mixed]:disabled_.vds-checkbox__box]:!bg-[var(--vds-brand-light-border)]'
          )}
        >
          <div className="mx-[var(--vds-space-2)] mt-[var(--vds-space-2)] flex min-h-[var(--vds-space-7)] min-w-0 shrink-0 items-center gap-[calc(var(--vds-space-2)-var(--vds-border-width-2))] px-[var(--vds-space-2)] py-[var(--vds-space-1)]">
            <Checkbox
              checked={
                selectedCount === 0 ? false : selectedCount === papers.length ? true : 'mixed'
              }
              data-testid="hil-subset-all-0"
              className="!gap-[calc(var(--vds-space-2)-var(--vds-border-width-2))] !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)]"
              disabled={controlsDisabled}
              label={t('review.authorization.subsetSelectAll')}
              onCheckedChange={(checked) =>
                onSelectionChange?.(checked ? papers.map((paper) => paper.id) : [])
              }
            />
            <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
              {t('review.authorization.scopeCount', { count: papers.length })}
            </span>
          </div>
          <ScrollArea
            overlay
            className="min-h-0 flex-1 [--vds-overlay-scrollbar-size:var(--vds-space-2)] [--vds-scrollbar-thumb:var(--vds-other-overlay-2)]"
            viewportClassName="max-h-full"
            viewportProps={{
              'data-testid': 'hil-question-scroll-area',
              'aria-label': t('review.authorization.subsetHint'),
            }}
          >
            <div className="grid gap-[var(--vds-space-1)] px-[var(--vds-space-2)] pb-[var(--vds-space-2)] pt-[var(--vds-space-1)]">
              {papers.map((paper) => (
                <Checkbox
                  key={paper.id}
                  checked={selectedPaperIds.includes(paper.id)}
                  aria-label={`${paper.label}${paper.description ? ` ${paper.description}` : ''}`}
                  data-testid={`hil-subset-paper-0-${paper.id}`}
                  disabled={controlsDisabled}
                  className="min-h-[var(--vds-space-7)] min-w-0 !gap-[calc(var(--vds-space-2)-var(--vds-border-width-2))] px-[var(--vds-space-2)] py-[var(--vds-space-1)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-control-label-line-height)] !text-[var(--vds-text-secondary)]"
                  onCheckedChange={(checked) =>
                    onSelectionChange?.(
                      checked
                        ? [...selectedPaperIds, paper.id]
                        : selectedPaperIds.filter((id) => id !== paper.id)
                    )
                  }
                >
                  <span className="truncate">{paper.label}</span>
                </Checkbox>
              ))}
            </div>
          </ScrollArea>
        </CollapsibleContent>
      )}
    </ConfirmationCard>
  )
  return selectable ? (
    <Collapsible
      open={historical || expanded}
      onOpenChange={onExpandedChange}
      className="!min-h-0 !min-w-0 !flex-[1_1_auto] !gap-0 !rounded-none !border-0 !bg-transparent !p-0"
    >
      {card}
    </Collapsible>
  ) : (
    card
  )
}
