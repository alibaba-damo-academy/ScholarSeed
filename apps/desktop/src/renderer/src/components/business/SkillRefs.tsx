import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import type { ComposerReference } from '../../store'
import { ComposerRefChip } from './RefChip'

export const SKILL_REF_KIND = 'skill'

export function ComposerSkillRefs({
  refs,
  onRemove
}: {
  refs: ComposerReference[]
  onRemove?: (index: number) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const skillRefs = refs
    .map((ref, index) => ({ ref, index }))
    .filter(({ ref }) => ref.type === SKILL_REF_KIND)
  if (!skillRefs.length) return null

  return (
    <div className="contents">
      {skillRefs.map(({ ref, index }) => (
        <div key={ref.type + ref.id} className="box-border max-w-full shrink-0 pb-[var(--vds-space-1)] pr-[var(--vds-space-1)]">
          <ComposerRefChip
            title={ref.title}
            icon={<Icon name="plug-simple" size={12} sw={1.8} />}
            label={ref.title}
            suffix={t('skills.kind')}
            closeLabel={t('skills.removeNamed', { title: ref.title })}
            onClose={onRemove ? () => onRemove(index) : undefined}
          />
        </div>
      ))}
    </div>
  )
}
