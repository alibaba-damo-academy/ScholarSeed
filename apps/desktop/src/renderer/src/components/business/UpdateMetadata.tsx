import React from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import type { LatestVersionMeta } from '../../../../updates'

/** Candidate metadata shared by the update panel and installation overlay. */
export function UpdateMetadata({ candidate }: { candidate?: LatestVersionMeta }): React.JSX.Element | null {
  const { t, i18n } = useTranslation('components')
  if (!candidate) return null
  const builtAt = candidate.version_built_at ? Date.parse(candidate.version_built_at) : NaN
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  return <>
    {t('update.versionOnly', { version: candidate.version })}
    {Number.isFinite(builtAt) && <>
      {' · '}
      <time dateTime={candidate.version_built_at}>
        {format.date(builtAt, { year: 'numeric', month: 'numeric', day: 'numeric' })}
      </time>
    </>}
  </>
}
