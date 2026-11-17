import React from 'react'
import { Hammer } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ComposerReference } from '../../store'
import { ReferenceAttachment } from '../primitive'

export const SKILL_REF_KIND = 'skill'

export function ComposerSkillRefs({
  refs,
  onRemove,
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
        <div key={ref.type + ref.id} className="box-border flex max-w-full shrink-0 items-center">
          <ReferenceAttachment
            variant="text"
            title={ref.title}
            icon={<Hammer size={12} strokeWidth={1.5} />}
            label={ref.title}
            closeLabel={t('skills.removeNamed', { title: ref.title })}
            onClose={onRemove ? () => onRemove(index) : undefined}
          />
        </div>
      ))}
    </div>
  )
}
