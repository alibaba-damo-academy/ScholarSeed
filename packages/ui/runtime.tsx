import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import * as controls from './controls'
import * as Conversation from './conversation'
import { catalog } from './catalog'
import { createLiteraturePorts } from './ports'
import manifest from './manifest.json'
import { Providers, translator, ready } from './localization'
import type { CardState, OfficialUI } from './contract'
import { CopyProvider, useCopyContent } from './copying'
import { PlotCopyContext, PlotExportContext } from '../../apps/desktop/src/renderer/src/components/primitive/Plot'
import type { ChartExporter } from '../../apps/desktop/src/renderer/src/components/ui/charting'
import './ui.css'

const ROOT_ID = 'root'
const STYLESHEET = 'ui.css'
const exportPlot: ChartExporter = async (request) => {
  if (!window.plugin.exportPlot) throw new Error('plot_export_unavailable')
  return window.plugin.exportPlot(request)
}
const copyPlot: ChartExporter = async (request) => {
  if (!window.plugin.copyPlot) throw new Error('plot_copy_unavailable')
  return window.plugin.copyPlot(request)
}
const stylesheet = document.createElement('link')
const styled = new Promise<void>((resolve, reject) => {
  stylesheet.addEventListener('load', () => resolve(), { once: true })
  stylesheet.addEventListener('error', () => reject(new Error('official_ui_styles_unavailable')), { once: true })
})
stylesheet.rel = 'stylesheet'
stylesheet.href = new URL(STYLESHEET, (document.currentScript as HTMLScriptElement).src).href
document.head.append(stylesheet)
const diagram = document.createElement('script')
const diagrams = new Promise<void>((resolve, reject) => {
  diagram.addEventListener('load', () => resolve(), { once: true })
  diagram.addEventListener('error', () => reject(new Error('official_ui_diagram_unavailable')), { once: true })
})
diagram.src = new URL('mermaid.js', (document.currentScript as HTMLScriptElement).src).href
document.head.append(diagram)
document.body.classList.add('m-0', 'bg-transparent', '[font-family:var(--vds-font-main)]', 'text-[length:var(--vds-font-body-lv2)]', 'leading-[var(--vds-lh-body-lv2)]', 'font-[var(--vds-fw-medium)]', 'text-[var(--vds-text-primary)]', 'antialiased')
document.documentElement.dataset.uiVersion = manifest.version

function mount(render: (state: CardState) => React.ReactNode): () => void {
  const root = createRoot(document.getElementById(ROOT_ID)!)
  let disposed = false
  let revision = 0
  const unsubscribe = window.plugin.onState(state => {
    const requested = ++revision
    void Promise.all([ready, styled, diagrams]).then(async () => {
      if (disposed || requested !== revision) return
      await translator.changeLanguage(state.language)
      if (disposed || requested !== revision) return
      document.documentElement.classList.toggle('dark', state.theme === 'dark')
      document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light'
      root.render(<StrictMode><Providers><PlotExportContext.Provider value={window.plugin.exportPlot ? exportPlot : undefined}><PlotCopyContext.Provider value={window.plugin.copyPlot ? copyPlot : undefined}><CopyProvider snapshot={state}>{render(state)}</CopyProvider></PlotCopyContext.Provider></PlotExportContext.Provider></Providers></StrictMode>)
    })
  })
  return () => { disposed = true; unsubscribe(); root.unmount() }
}

const runtime: OfficialUI = { React, ...controls, Conversation, Plot: Conversation.Plot, DataTable: Conversation.DataTable, createLiteraturePorts, catalog, useTranslation, useCopyContent, mount, version: manifest.version, compatibility: manifest.compatibility }
Object.defineProperty(window, 'scholarseedUI', { value: Object.freeze(runtime) })
