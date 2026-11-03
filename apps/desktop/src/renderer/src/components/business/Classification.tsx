import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ToggleGroup, ToggleGroupItem } from '../ui'
import { IconFont } from '../primitive/Iconfont'

interface ClassificationProps {
  labels: { slug: string; displayName: string }[]
  value: string
  disabled: boolean
  onValueChange: (value: string) => void
}

export function Classification({
  labels,
  value,
  disabled,
  onValueChange,
}: ClassificationProps): JSX.Element {
  const { t } = useTranslation('skills')
  const id = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [limit, setLimit] = useState(labels.length + 1)
  const items = [{ slug: '', displayName: t('classification.all') }, ...labels]
  const overflowing = limit < items.length

  useLayoutEffect(() => {
    const container = containerRef.current
    const group = groupRef.current
    const more = moreRef.current
    if (!container || !group || !more) return
    const measure = (): void => {
      const widths = Array.from(group.children, (item) => item.getBoundingClientRect().width)
      const gap = parseFloat(getComputedStyle(group).columnGap) || 0
      const available = container.clientWidth
      const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1)
      if (total <= available) {
        setLimit(widths.length)
        return
      }
      const budget = available - more.getBoundingClientRect().width - gap
      let used = 0
      let count = 0
      for (const width of widths) {
        const next = used + (count ? gap : 0) + width
        if (next > budget) break
        used = next
        count += 1
      }
      setLimit(count)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(more)
    for (const item of group.children) observer.observe(item)
    measure()
    return () => observer.disconnect()
  }, [labels, t])

  return (
    <div
      ref={containerRef}
      className="relative flex min-w-0 items-start gap-[var(--vds-space-3)] py-[var(--vds-space-1)]"
      data-testid="skills-classification-scroll"
    >
      <ToggleGroup
        ref={groupRef}
        id={id}
        value={value}
        allowEmpty={false}
        disabled={disabled}
        onValueChange={(next) => onValueChange(String(next))}
        aria-label={t('classification.label')}
        variant="ghost"
        size="sm"
        className="relative min-w-0 flex-1 flex-wrap !justify-between !gap-[var(--vds-space-3)] !border-0 !bg-transparent !p-0"
        data-testid="skills-classifications"
      >
        {items.map((item, index) => {
          const concealed = !expanded && index >= limit
          return (
            <ToggleGroupItem
              key={item.slug}
              value={item.slug}
              disabled={concealed}
              aria-hidden={concealed || undefined}
              className={`max-w-full shrink-0 truncate !font-[var(--vds-fw-regular)] !rounded-[var(--vds-radius-4)] data-[state=off]:![background:var(--vds-other-overlay-1)] ${concealed ? 'invisible absolute left-0 top-0 pointer-events-none' : ''}`}
              data-testid={`skills-classification-${item.slug || 'all'}`}
            >
              {item.displayName}
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
      <Button
        ref={moreRef}
        variant="tertiary"
        size="sm"
        className={`shrink-0 !rounded-[var(--vds-radius-4)] ${overflowing ? '' : 'invisible absolute right-0 pointer-events-none'}`}
        aria-hidden={!overflowing || undefined}
        aria-expanded={expanded}
        aria-controls={id}
        tabIndex={overflowing ? undefined : -1}
        onClick={() => setExpanded((current) => !current)}
        data-testid="skills-classification-more"
      >
        {expanded ? t('classification.collapse') : t('classification.more')}
        <IconFont type={expanded ? 'a-line-switch-arrow-up-s' : 'a-line-switch-arrow-down-s'} />
      </Button>
    </div>
  )
}
