import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import '../../browser'
import '../../styles.css'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { Button, ToastProvider } from '../../components/ui'
import { StoreProvider, useApp } from '../../store'
import { VersionHistory } from './VersionHistory'
import { resourcesFeature } from '../resources/feature'
import { DocumentWorkspaceContext, documentWorkspaces } from './workspace'

const localization = createLocalization('zh', resources, { report: () => undefined })
const file = { project: 'history-test', fileId: 'file-test', path: 'resources/history.md' }

function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { state, set } = useApp()
  const resourceSurface = new URLSearchParams(location.search).has('resource')
  return (
    <div className="relative z-[var(--vds-z-elevated)]">
      <Button
        onClick={() => {
          if (resourceSurface)
            set({
              homeSelectedProjectId: file.project,
              resource: { ...state.resource, historyTarget: file },
            })
          else setOpen(true)
        }}
      >
        查看版本记录
      </Button>
      <output data-testid="history-active-tab">{state.activeTab}</output>
      {resourceSurface ? (
        resourcesFeature().globalSurfaces?.map((surface) => (
          <div key={surface.id}>{surface.render()}</div>
        ))
      ) : (
        <VersionHistory file={file} open={open} onOpenChange={setOpen} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(file.project)}>
          <Fixture />
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </I18nextProvider>
)
