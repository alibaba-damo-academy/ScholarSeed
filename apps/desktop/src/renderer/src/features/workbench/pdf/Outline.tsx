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
    <ul
      className={
        depth === 0
          ? 'm-0 grid w-full list-none p-0'
          : 'm-0 grid min-w-0 list-none py-0 pl-[var(--vds-pdf-outline-inset)] pr-0'
      }
    >
      {items.map((item, index) => {
        const itemPath = `${path}${index}`
        const row = (
          <Button
            variant="ghost"
            size="content"
            aria-disabled={item.page === null}
            className="!h-[var(--vds-pdf-outline-row-height)] min-w-0 flex-1 justify-start overflow-hidden rounded-[var(--vds-radius-4)] !px-[var(--vds-pdf-outline-inset)] !py-0 text-left text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] whitespace-nowrap! aria-disabled:cursor-not-allowed aria-disabled:text-[var(--vds-text-disabled)] aria-disabled:hover:bg-transparent"
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
              <Collapsible className="gap-0">
                <div className="flex min-w-0 items-center">
                  {row}
                  <CollapsibleTrigger asChild>
                    <IconButton
                      className="group flex-none"
                      data-testid={`pdf-outline-toggle-${itemPath}`}
                      icon={
                        <span className="inline-flex transition-transform group-data-[state=open]:rotate-90">
                          <Icon name="chevron-right" size={14} />
                        </span>
                      }
                      label={item.title}
                      size="sm"
                      variant="ghost"
                    />
                  </CollapsibleTrigger>
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
              <div className="flex min-w-0 items-center">{row}</div>
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
