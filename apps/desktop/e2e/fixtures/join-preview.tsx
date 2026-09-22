// Isolated consumer fixture: real conversation hit card + real result rows, with no model call.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../src/localization/engine'
import { resources } from '../../src/localization/resources'
import { StoreContext } from '../../src/renderer/src/storeContext'
import type { Store } from '../../src/renderer/src/store'
import { LiteratureResults } from '../../src/renderer/src/features/literature/Results'
import { LiteratureSearchView } from '../../src/renderer/src/features/literature/Search'
import { conversationSearchPapers } from '../../src/renderer/src/features/literature/result'
import { ToastProvider, Toaster } from '../../src/renderer/src/components/ui'
import '../../src/renderer/src/styles.css'

const papers = [1, 2].map(index => ({ id: `preview-${index}`, title: `AI preview admission ${index}`, authors: ['Test Author'], year: 2026, doi: '', abstract: 'Preview consumer acceptance.', venue: '', access: 'unknown', url: '', decision: 'candidate' as const, decision_reason: '', fulltext: 'unknown' as const, tier: null, citation_count: null, reasons: [], sources: [] }))
const content = { schema_version: '1.0', session_id: 'preview-session', status: 'success', papers, criteria: ['AI 命中卡菜单验收'], sources: [], warnings: [], candidates: 2, deduplicated: 2, retained: 2 }
const store = { state: { homeSelectedProjectId: null }, act: { openLiteratureResult: () => undefined, openWorkbenchView: () => undefined, activateTab: () => undefined } } as unknown as Store
const localization = createLocalization('zh', resources, { escapeValue: false })
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={localization}><ToastProvider><StoreContext.Provider value={store}>
  <main className="grid gap-[var(--vds-space-4)] p-[var(--vds-space-4)]">
    <section data-testid="preview-consumer"><LiteratureResults content={content} cardId="preview-card" /></section>
    <section data-testid="search-consumer"><LiteratureSearchView papers={conversationSearchPapers(papers)} status="completed" output="" /></section>
  </main><Toaster />
</StoreContext.Provider></ToastProvider></I18nextProvider>)
