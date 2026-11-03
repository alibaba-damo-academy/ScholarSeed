import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { I18nextProvider, useTranslation } from 'react-i18next'
import * as controls from './controls'
import * as Conversation from './conversation'
import { ToastProvider, Toaster } from '../../apps/desktop/src/renderer/src/components/ui'
import { catalog } from './catalog'
import zh from '../../apps/desktop/src/localization/locales/zh/literature.json'
import en from '../../apps/desktop/src/localization/locales/en/literature.json'
import zhUi from '../../apps/desktop/src/localization/locales/zh/ui.json'
import enUi from '../../apps/desktop/src/localization/locales/en/ui.json'
import zhAssistant from '../../apps/desktop/src/localization/locales/zh/assistant.json'
import enAssistant from '../../apps/desktop/src/localization/locales/en/assistant.json'
import zhComponents from '../../apps/desktop/src/localization/locales/zh/components.json'
import enComponents from '../../apps/desktop/src/localization/locales/en/components.json'
import manifest from './manifest.json'
import zhConversation from '../../apps/desktop/src/localization/locales/zh/conversation.json'
import enConversation from '../../apps/desktop/src/localization/locales/en/conversation.json'
import zhResources from '../../apps/desktop/src/localization/locales/zh/resources.json'
import enResources from '../../apps/desktop/src/localization/locales/en/resources.json'
import zhWorkbench from '../../apps/desktop/src/localization/locales/zh/workbench.json'
import enWorkbench from '../../apps/desktop/src/localization/locales/en/workbench.json'
import type { CardState, OfficialUI } from './contract'
import { CopyProvider, useCopyContent } from './copying'
import './ui.css'

const ROOT_ID = 'root'
const STYLESHEET = 'ui.css'
const translator = i18next.createInstance()
const ready = translator.init({ resources: { zh: { literature: zh, ui: zhUi, assistant: zhAssistant, components: zhComponents, conversation: zhConversation, resources: zhResources, workbench: zhWorkbench }, en: { literature: en, ui: enUi, assistant: enAssistant, components: enComponents, conversation: enConversation, resources: enResources, workbench: enWorkbench } }, lng: 'zh', fallbackLng: 'en', interpolation: { escapeValue: false } })
const stylesheet = document.createElement('link')
stylesheet.rel = 'stylesheet'
stylesheet.href = new URL(STYLESHEET, (document.currentScript as HTMLScriptElement).src).href
document.head.append(stylesheet)
document.body.classList.add('m-0', 'text-[var(--vds-text-primary)]', 'bg-[var(--vds-surface-raised)]')
document.documentElement.dataset.uiVersion = manifest.version

function mount(render: (state: CardState) => React.ReactNode): () => void {
  const root = createRoot(document.getElementById(ROOT_ID)!)
  let disposed = false
  let revision = 0
  const unsubscribe = window.plugin.onState(state => {
    const requested = ++revision
    void ready.then(async () => {
      if (disposed || requested !== revision) return
      await translator.changeLanguage(state.language)
      if (disposed || requested !== revision) return
      document.documentElement.classList.toggle('dark', state.theme === 'dark')
      root.render(<StrictMode><I18nextProvider i18n={translator}><ToastProvider><CopyProvider snapshot={state}>{render(state)}</CopyProvider><Toaster /></ToastProvider></I18nextProvider></StrictMode>)
    })
  })
  return () => { disposed = true; unsubscribe(); root.unmount() }
}

const runtime: OfficialUI = { React, ...controls, Conversation, catalog, useTranslation, useCopyContent, mount, version: manifest.version, compatibility: manifest.compatibility }
Object.defineProperty(window, 'scholarseedUI', { value: Object.freeze(runtime) })
