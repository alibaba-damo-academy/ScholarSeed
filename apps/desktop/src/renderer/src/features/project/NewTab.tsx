import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FolderTree, Folders } from 'lucide-react'

import { Button } from '../../components/ui'
import { useApp } from '../../store'
import { resolveProjectTabSelection } from '../workbench/tabs'

export function NewTab({ tabId }: { tabId?: string }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { set } = useApp()
  const choose = (kind: 'library' | 'explorer'): void => {
    if (!tabId) return
    set((current) => resolveProjectTabSelection(current.tabs, tabId, kind))
  }

  return (
    <div
      className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-[var(--vds-layout-page-padding)]"
      data-testid="project-new-tab"
    >
      <div className="w-full max-w-[var(--vds-layout-new-tab-options-width)]">
        <div className="relative after:pointer-events-none after:absolute after:bottom-0 after:left-[var(--vds-space-4)] after:right-[var(--vds-space-4)] after:border-b after:border-[var(--vds-divider-default)]">
          <Button
            variant="ghost"
            icon={<Folders />}
            className="!h-auto w-full !justify-start !rounded-[var(--vds-radius-4)] !border-0 !p-[var(--vds-space-4)] text-[var(--vds-text-secondary)]"
            onClick={() => choose('library')}
          >
            {t('tabs.projectFiles')}
            <ChevronRight className="ml-auto" />
          </Button>
        </div>
        <Button
          variant="ghost"
          icon={<FolderTree />}
          className="!h-auto w-full !justify-start !rounded-[var(--vds-radius-4)] !border-0 !p-[var(--vds-space-4)] text-[var(--vds-text-secondary)]"
          onClick={() => choose('explorer')}
        >
          {t('tabs.projectExplorer')}
          <ChevronRight className="ml-auto" />
        </Button>
      </div>
    </div>
  )
}
