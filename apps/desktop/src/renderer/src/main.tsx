import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/noto-serif-sc/600.css'

import './browser'
import './styles.css'
import './shell/workbench.css'
import { App } from './App'
import { LocalizationProvider } from './app/localization'
import { featureRegistry } from './app/composition'
import { DisplayCardProvider } from './components/business/Cards'
import { InteractionPolicyProvider } from './components/business/Interactions'
import { TaskCenterProvider } from './components/business/Tasks'
import { Toaster, ToastProvider } from './components/ui'
import { resolveDocumentWorkspaceProject } from './features/workbench/scope'
import { DocumentWorkspaceContext, documentWorkspaces } from './features/workbench/workspace'
import { assistantProject, StoreProvider, useApp } from './store'

function ProjectWorkspaceProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { state } = useApp()
  // A docked assistant may show a conversation from another project while the
  // center keeps the explicitly selected project's document workspace open.
  // Conversation-only surfaces can clear homeSelectedProjectId before activation,
  // so the provider and document actions share the same project resolution policy.
  const projectId = resolveDocumentWorkspaceProject(
    state.homeSelectedProjectId,
    assistantProject(state).projectId
  )
  const workspace = documentWorkspaces.forProject(projectId)
  useEffect(() => {
    documentWorkspaces.activateProject(projectId)
  }, [projectId])
  return (
    <DocumentWorkspaceContext.Provider value={workspace}>
      {children}
    </DocumentWorkspaceContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocalizationProvider>
    <ToastProvider>
      <StoreProvider assistantSources={featureRegistry.assistantSources}>
        <ProjectWorkspaceProvider>
          <TaskCenterProvider sources={featureRegistry.taskSources}>
            <DisplayCardProvider cards={featureRegistry.displayCards}>
              <InteractionPolicyProvider policies={featureRegistry.interactionPolicies}>
                <App />
              </InteractionPolicyProvider>
            </DisplayCardProvider>
          </TaskCenterProvider>
        </ProjectWorkspaceProvider>
      </StoreProvider>
      <Toaster placement="top-right" />
    </ToastProvider>
    </LocalizationProvider>
  </React.StrictMode>
)
