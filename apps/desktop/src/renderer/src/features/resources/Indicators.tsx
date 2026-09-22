import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, TriangleAlert } from 'lucide-react'

import { BadgeDot, Button, IconButton, Popover, PopoverContent, PopoverTrigger, Tooltip } from '../../components/ui'
import { useApp } from '../../store'
import { useDocumentWorkspace, useWorkspaceController } from '../workbench/workspace'
import { resourceTreeIndicators, type ResourceNode } from './state'

const RESOURCE_STATUS_ICON_SIZE = 14

export function ResourceStatus({ node }: { node: ResourceNode }): React.JSX.Element {
  const { t } = useTranslation('resources')
  const { state, act } = useApp()
  const documents = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const indicators = resourceTreeIndicators(node, state.homeSelectedProjectId, Object.values(documents.sessions))
  const warningLabel = indicators.warnings.map((key) => t(key)).join(' · ')
  const saveLabel = t(indicators.session?.saveState === 'saving' ? 'treeStatus.saving' : 'treeStatus.unsaved')
  return <span className="inline-flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    {indicators.dirty && <Tooltip portalled content={saveLabel}><BadgeDot role="img" aria-label={saveLabel} tabIndex={0} data-testid={`tree-dirty-${node.path}`} /></Tooltip>}
    {indicators.needsReview && <Tooltip portalled content={t('treeStatus.review')}><IconButton
      size="sm" variant="ghostIcon" title={undefined} label={t('treeStatus.review')} data-testid={`tree-review-${node.path}`}
      icon={<span className="relative"><MessageSquare size={RESOURCE_STATUS_ICON_SIZE} /><BadgeDot tone="neutral" className="absolute -right-0.5 -top-0.5" /></span>}
      onClick={() => void act.openResourceReview(node.path)} /></Tooltip>}
    {indicators.warnings.length > 0 && <Popover>
      <Tooltip portalled content={warningLabel}><PopoverTrigger asChild><IconButton size="sm" variant="ghostIcon" title={undefined} label={warningLabel}
        className="text-[var(--vds-warning-text-primary)]" data-testid={`tree-warning-${node.path}`} icon={<TriangleAlert size={RESOURCE_STATUS_ICON_SIZE} />} /></PopoverTrigger></Tooltip>
      <PopoverContent className="max-w-[min(320px,calc(100vw-24px))] p-[var(--vds-space-3)]" onClick={(event) => event.stopPropagation()}>
        <strong>{t('treeStatus.warning')}</strong>
        {indicators.warnings.map((key) => <p key={key}>{t(key)}</p>)}
        {indicators.session?.dirty && <Button size="md" disabled={!indicators.session.capabilities.can_save || indicators.session.saveState === 'saving'}
          onClick={() => void workspace.save(indicators.session!.id)}>{t('treeStatus.saveFile')}</Button>}
        {indicators.session?.saveState === 'conflict' && <Button size="md" variant="secondary" onClick={() => act.openResourceFile(node.path)}>{t('treeStatus.openFile')}</Button>}
        <Button size="md" variant="secondary" onClick={() => void act.reloadResourceTree()}>{t('treeStatus.retry')}</Button>
      </PopoverContent>
    </Popover>}
  </span>
}
