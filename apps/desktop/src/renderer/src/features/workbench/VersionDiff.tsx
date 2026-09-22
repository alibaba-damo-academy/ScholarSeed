import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, EllipsisText, SegmentedControl, ToggleGroupItem } from '../../components/ui'
import { fetchResourceVersionContent } from '../../contracts/resources'
import { Diff } from './Diff'
import { OfficeSnapshot } from './OfficeDocument'
import type { OfficeViewBinding } from './office/runtime'
import { parseVersionDiffTab, viewerForPath, type VersionDiffReference } from './tabs'

const HISTORICAL_VIEW_SUFFIX = 'historical'
const CURRENT_VIEW_SUFFIX = 'current'

interface LoadedComparison {
  current: Uint8Array
  historical: Uint8Array
  reference: VersionDiffReference
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

function OfficeComparison({ comparison }: { comparison: LoadedComparison }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [selected, setSelected] = useState<'historical' | 'current'>('historical')
  const viewer = viewerForPath(comparison.reference.path)
  const officeViewer = viewer === 'spreadsheet' ? 'spreadsheet' : 'office'
  const name = fileName(comparison.reference.path)
  const historical = useMemo<OfficeViewBinding>(() => ({
    bytes: comparison.historical,
    revision: comparison.reference.historicalVersionId,
    title: name,
    viewId: `${comparison.reference.historicalVersionId}:${HISTORICAL_VIEW_SUFFIX}`,
    viewer: officeViewer,
    processor: comparison.reference.processor
  }), [comparison, name, officeViewer])
  const current = useMemo<OfficeViewBinding>(() => ({
    bytes: comparison.current,
    revision: comparison.reference.currentVersionId,
    title: name,
    viewId: `${comparison.reference.currentVersionId}:${CURRENT_VIEW_SUFFIX}`,
    viewer: officeViewer,
    processor: comparison.reference.processor
  }), [comparison, name, officeViewer])
  const active = selected === 'historical' ? historical : current

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="version-office-diff">
      <header className="flex min-w-0 items-center justify-between gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] bg-[var(--vds-bg-component)] px-4 py-2 text-sm">
        <span className="min-w-0 truncate text-[var(--vds-text-secondary)]">{comparison.reference.path}</span>
        <SegmentedControl
          allowEmpty={false}
          aria-label={t('history.compare.switchVersion')}
          onValueChange={(value) => setSelected(value === 'current' ? 'current' : 'historical')}
          size="sm"
          value={selected}
        >
          <ToggleGroupItem value="historical">
            {t('history.compare.historical', { sequence: comparison.reference.historicalSequence })}
          </ToggleGroupItem>
          <ToggleGroupItem value="current">{t('history.compare.current')}</ToggleGroupItem>
        </SegmentedControl>
      </header>
      <OfficeSnapshot binding={active} />
    </div>
  )
}

export function VersionDiff({ tabId }: { tabId: string }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const reference = useMemo(() => parseVersionDiffTab(tabId), [tabId])
  const [comparison, setComparison] = useState<LoadedComparison | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setComparison(null)
    setFailed(false)
    if (!reference) {
      setFailed(true)
      return () => { active = false }
    }
    void Promise.all([
      fetchResourceVersionContent(reference.project, reference.historicalVersionId),
      fetchResourceVersionContent(reference.project, reference.currentVersionId)
    ]).then(([historical, current]) => {
      if (!active) return
      if (!historical || !current) {
        setFailed(true)
        return
      }
      setComparison({ current, historical, reference })
    })
    return () => { active = false }
  }, [reference])

  const viewer = reference ? viewerForPath(reference.path) : 'unsupported'
  const office = viewer === 'office' || viewer === 'spreadsheet'
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--vds-bg-app)]" data-testid="version-diff-view">
      {!office && <header className="grid grid-cols-2 border-b border-[var(--vds-border-default)] bg-[var(--vds-bg-component)] text-sm">
        <div className="flex min-w-0 items-center border-r border-[var(--vds-border-default)] px-4 py-2">
          <strong className="shrink-0">{t('history.compare.historical', { sequence: reference?.historicalSequence ?? 0 })}</strong>
          <EllipsisText wrapperClassName="ml-[var(--vds-space-2)] flex-1" className="text-[var(--vds-text-secondary)]" tooltipPortalled>{reference?.path ?? ''}</EllipsisText>
        </div>
        <div className="flex min-w-0 items-center px-4 py-2">
          <strong className="shrink-0">{t('history.compare.current')}</strong>
          <EllipsisText wrapperClassName="ml-[var(--vds-space-2)] flex-1" className="text-[var(--vds-text-secondary)]" tooltipPortalled>{reference?.path ?? ''}</EllipsisText>
        </div>
      </header>}
      {failed && <Alert tone="warning" title={t('history.compare.failed')} />}
      {!failed && !comparison && <div className="p-4 text-sm text-[var(--vds-text-secondary)]">{t('history.compare.loading')}</div>}
      {comparison && office && <OfficeComparison comparison={comparison} />}
      {comparison && !office && <Diff
        baseText={new TextDecoder().decode(comparison.historical)}
        candidateText={new TextDecoder().decode(comparison.current)}
        identity={tabId}
        path={comparison.reference.path}
        readOnly
        testId="version-text-diff"
      />}
    </div>
  )
}
