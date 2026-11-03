import { useTranslation } from 'react-i18next'
import React from 'react'

import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EllipsisText,
  IconButton,
} from '../../../components/ui'
import { Icon } from '../../../icons'
import type { PdfOutlineItem } from './navigation'

function OutlineBranch({
  items,
  depth,
  path,
  onNavigate,
}: {
  items: PdfOutlineItem[]
  depth: number
  path: string
  onNavigate: (page: number) => void
}): React.JSX.Element {
  return (
    <ul className={depth === 0 ? 'm-0 grid list-none p-0' : 'm-0 grid list-none py-0 pl-5 pr-0'}>
      {items.map((item, index) => {
        const itemPath = `${path}${index}`
        const row = (
          <Button
            variant="ghost"
            size="content"
            aria-disabled={item.page === null}
            className="min-w-0 flex-1 justify-start overflow-hidden text-left whitespace-nowrap! aria-disabled:cursor-not-allowed aria-disabled:text-[var(--vds-text-disabled)] aria-disabled:hover:bg-transparent"
            data-outline-depth={depth}
            data-testid={`pdf-outline-row-${itemPath}`}
            onClick={() => {
              if (item.page !== null) onNavigate(item.page)
            }}
            tabIndex={item.page === null ? -1 : undefined}
          >
            <EllipsisText
              className="w-full"
              tooltip={item.title}
              tooltipAlign="start"
              tooltipPortalled
              tooltipSide="right"
            >
              {item.title}
            </EllipsisText>
          </Button>
        )
        return (
          <li key={`${item.title}-${index}`} className="min-w-0">
            {item.children.length > 0 ? (
              <Collapsible defaultOpen className="gap-0">
                <div className="flex min-w-0 items-start gap-[var(--vds-space-1)]">
                  <CollapsibleTrigger asChild>
                    <IconButton
                      className="group mt-[var(--vds-space-half)] flex-none"
                      data-testid={`pdf-outline-toggle-${itemPath}`}
                      icon={
                        <span className="inline-flex transition-transform group-data-[state=open]:rotate-90">
                          <Icon name="chevron-right" size={14} />
                        </span>
                      }
                      label={item.title}
                      size="xs"
                      variant="ghost"
                    />
                  </CollapsibleTrigger>
                  {row}
                </div>
                <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0">
                  <OutlineBranch
                    items={item.children}
                    depth={depth + 1}
                    path={`${itemPath}-`}
                    onNavigate={onNavigate}
                  />
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <div className="flex min-w-0 items-start gap-[var(--vds-space-1)]">
                <span aria-hidden="true" className="w-[var(--vds-control-height-xs)] flex-none" />
                {row}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function PdfOutline({
  items,
  onNavigate,
}: {
  items: PdfOutlineItem[]
  onNavigate: (page: number) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <nav aria-label={t('outline.label')}>
      <OutlineBranch items={items} depth={0} path="" onNavigate={onNavigate} />
    </nav>
  )
}
