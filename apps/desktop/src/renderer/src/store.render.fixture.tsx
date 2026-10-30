import React, { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../localization/engine'
import { resources } from '../../localization/resources'
import type { RendererPreferences } from '../../preferences'
import { ToastProvider, Toaster } from './components/ui'
import { StoreProvider, useApp, type Store } from './store'
import { effectiveShortcutBindings } from './shortcuts'
import { ErrorBoundary } from './app/Error'
import { ModelMenu } from './components/business/ModelMenu'

const localization = createLocalization('zh', resources, { report: () => undefined })
let disk = structuredClone(window.scholarseed.preferences)
let store: Store
const pending: { value: RendererPreferences; resolve: () => void; reject: () => void }[] = []
const probe = {
  hold: false,
  saves: [] as RendererPreferences[],
  projections: [] as string[],
  get disk() {
    return disk
  },
  get state() {
    return store.state
  },
  get pending() {
    return pending.length
  },
  get shortcut() {
    return effectiveShortcutBindings('code.save')
  },
  optimistic: (stamp: number) => {
    store.act.rememberOnboardingProject(`project-${stamp}`)
    store.act.setShortcutOverride('code.save', {
      key: stamp === 1 ? 'x' : 'y',
      modifiers: ['primary'],
    })
  },
  model: (model: string) => store.act.setLiteratureAiModel('selection_translation', model),
  rememberEffort: (model: string, effort: string) => store.rememberEffort(model, effort),
  clearMessages: (dismissals: Record<string, number>) => store.act.clearTaskMessages(dismissals),
  patch: (patch: Parameters<Store['set']>[0]) => store.set(patch),
  openSession: (id: string, intent?: Parameters<Store['act']['openSession']>[2]) =>
    store.act.openSession(id, undefined, intent),
  returnHome: () => store.act.returnHome(),
  prompts: (translate: string) =>
    store.act.saveSelectionPrompts({ ...store.state.selectionPrompts, translate }),
  language: (language: 'zh' | 'en') => store.act.setLang(language),
  draft: (panel: boolean) => (panel ? store.act.startPanelDraft() : store.act.startDraft()),
  release: () => pending.shift()!.resolve(),
  fail: () => pending.shift()!.reject(),
}
Object.assign(window, { preferenceProbe: probe })
Object.assign(window.scholarseed, {
  reconcilePreferences: async () => structuredClone(disk),
  savePreferences: (value: RendererPreferences) => {
    probe.saves.push(structuredClone(value))
    return new Promise<RendererPreferences>((resolve, reject) => {
      const finish = () => {
        disk = structuredClone(value)
        resolve(structuredClone(disk))
      }
      if (probe.hold)
        pending.push({ value, resolve: finish, reject: () => reject(new Error('save failed')) })
      else finish()
    })
  },
})

function Probe(): React.JSX.Element {
  store = useApp()
  const { state } = store
  const controlled = Reflect.get(window, 'controlledModelFixture') === true
  const [controlledModel, setControlledModel] = React.useState('model-a')
  const [controlledChoices, setControlledChoices] = React.useState<string[]>([])
  useLayoutEffect(() => {
    const projection = JSON.stringify({
      models: state.literatureAiModels,
      files: state.recentFiles,
      literature: state.recentLiterature,
      sessions: state.recentSessions,
      wrap: state.editorWordWrap,
      onboarding: state.onboarding,
    })
    if (probe.projections.at(-1) !== projection) probe.projections.push(projection)
  }, [state])
  if (state.mainView === 'writing') throw new Error('navigation recovery test crash')
  return (
    <>
      <output data-testid="model">{state.literatureAiModels.selection_translation}</output>
      <output data-testid="default-model">{state.model}</output>
      <output data-testid="model-error">{JSON.stringify(state.foregroundError)}</output>
      <output data-testid="reasoning-preferences">
        {JSON.stringify(state.reasoningPreferences)}
      </output>
      {controlled && (
        <output data-testid="controlled-choices">{JSON.stringify(controlledChoices)}</output>
      )}
      <ModelMenu
        independent={controlled}
        showEffort={!controlled}
        modelKey={controlled ? controlledModel : undefined}
        onModelSelect={
          controlled
            ? (model) => {
                setControlledChoices((choices) => [...choices, model.key])
                setControlledModel(model.key)
              }
            : undefined
        }
      />
      <Toaster />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <StoreProvider assistantSources={[]}>
          <ErrorBoundary>
            <Probe />
          </ErrorBoundary>
        </StoreProvider>
      </ToastProvider>
    </I18nextProvider>
  </React.StrictMode>
)
