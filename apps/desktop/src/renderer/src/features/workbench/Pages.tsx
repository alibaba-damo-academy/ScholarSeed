import React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { IconButton } from '../../components/ui'
import { useApp } from '../../store'
import { newProjectTab } from './tabs'
import { hasSplitPanes } from './layout'
import { useDocumentWorkspace, useWorkspaceController } from './workspace'

export function NewTabButton({ leafId }: { leafId: string }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { state, set } = useApp()
  const workspace = useWorkspaceController()
  const documents = useDocumentWorkspace()
  return (
    <IconButton
      variant="ghostIcon"
      size={hasSplitPanes(documents.layout) ? 'xs' : 'md'}
      label={t('tabs.newTab')}
      icon={<Plus />}
      data-testid="workspace-new-tab"
      onClick={() => {
        const tab = newProjectTab(state.homeSelectedProjectId)
        if (!workspace.openPageTab(tab.id, leafId)) return
        set((current) => ({
          tabs: [...current.tabs, tab],
          activeTab: tab.id,
          workbenchLayout: { ...current.workbenchLayout, open: true, taskTab: false },
        }))
      }}
    />
  )
}
