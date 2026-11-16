import { createRoot } from 'react-dom/client'
import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { LocalizationProvider } from '../../app/localization'
import { StoreProvider, useApp } from '../../store'
import { DocumentWorkspaceContext, documentWorkspaces } from '../../features/workbench/workspace'
import { Button, ToastProvider } from '../ui'
import { ComponentsPage } from './ComponentsPage'
import { OfficialDirectory, OfficialPreview, officialEntries } from './Official'
import '../../styles.css'

function OfficialCatalog(): JSX.Element {
  const { t } = useTranslation('examples')
  const { act } = useApp()
  const [selected, setSelected] = useState('Markdown')
  return (
    <div className="flex h-screen min-h-0 flex-col">
      <header className="flex gap-[var(--vds-space-2)]">
        <Button onClick={() => act.setLang('zh')}>{t('chinese')}</Button>
        <Button onClick={() => act.setLang('en')}>{t('english')}</Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[var(--vds-project-nav-width)] shrink-0 overflow-y-auto">
          <OfficialDirectory
            activeId={`official-${selected}`}
            onSelect={(id) => {
              const entry = officialEntries.find((entry) => entry.id === id)
              if (entry) setSelected(entry.name)
            }}
          />
        </aside>
        <main className="min-h-0 min-w-0 flex-1">
          <OfficialPreview name={selected} />
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <LocalizationProvider>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(null)}>
          {new URLSearchParams(location.search).has('catalog') ? (
            <OfficialCatalog />
          ) : (
            <ComponentsPage />
          )}
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </LocalizationProvider>
)
