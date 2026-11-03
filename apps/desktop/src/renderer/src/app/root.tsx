import React, { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/noto-serif-sc/600.css'

import '../browser'
import '../styles.css'
import '../shell/workbench.css'
import { featureRegistry } from './composition'
import { ErrorBoundary } from './Error'
import { Startup } from './Startup'
import { WindowCloseDialog } from '../shell/Close'
import { LocalizationProvider } from './localization'
import { DisplayCardProvider } from '../components/business/Cards'
import { AnswerCopyContext } from '../components/business/clipboard'
import { copyAnswer } from '../features/assistant/copy'
import { InteractionPolicyProvider } from '../components/business/Interactions'
import { TaskCenterProvider } from '../components/business/Tasks'
import { Toaster, ToastProvider } from '../components/ui'
import { resolveDocumentWorkspaceProject } from '../features/workbench/scope'
import { DocumentWorkspaceContext, documentWorkspaces } from '../features/workbench/workspace'
import { installRendererDiagnostics } from '../diagnostics'
import { assistantProject, StoreProvider, useApp } from '../store'
import { NavigationRecoveryContext } from '../contracts/navigation'

function ProjectWorkspaceProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { state } = useApp()
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

export function RendererProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [recovery, setRecovery] = useState(0)
  return (
    <LocalizationProvider>
      <NavigationRecoveryContext.Provider value={() => setRecovery((current) => current + 1)}>
        <ErrorBoundary key={recovery}>
          <ToastProvider>
            <WindowCloseDialog />
            <Startup>
              <StoreProvider
                assistantSources={featureRegistry.assistantSources}
                recoverHome={recovery > 0}
              >
                <ProjectWorkspaceProvider>
                  <TaskCenterProvider sources={featureRegistry.taskSources}>
                    <DisplayCardProvider
                      cards={featureRegistry.displayCards}
                      publicComponents={featureRegistry.publicComponents}
                    >
                      <InteractionPolicyProvider policies={featureRegistry.interactionPolicies}>
                        <AnswerCopyContext.Provider value={copyAnswer}>
                          {children}
                        </AnswerCopyContext.Provider>
                      </InteractionPolicyProvider>
                    </DisplayCardProvider>
                  </TaskCenterProvider>
                </ProjectWorkspaceProvider>
              </StoreProvider>
            </Startup>
            <Toaster placement="top-right" />
          </ToastProvider>
        </ErrorBoundary>
      </NavigationRecoveryContext.Provider>
    </LocalizationProvider>
  )
}

export function mountRenderer(
  content: React.ReactNode,
  element = document.getElementById('root')
): Root {
  if (!element) throw new Error('Renderer root element is missing')
  installRendererDiagnostics()
  const root = createRoot(element)
  root.render(
    <React.StrictMode>
      <RendererProviders>{content}</RendererProviders>
    </React.StrictMode>
  )
  return root
}
