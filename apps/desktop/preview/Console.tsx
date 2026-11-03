import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle, SearchBox } from '../src/renderer/src/components/ui'
import { LocalizationProvider, rendererLocalization } from '../src/renderer/src/app/localization'
import { useThemeEffect } from '../src/renderer/src/theme'
import { PREVIEW_HOME } from './home.ts'
import '../src/renderer/src/styles.css'
import type { PreferenceLanguage, PreferenceTheme, RendererPreferences } from '../src/preferences.ts'
import { PREVIEW_CATALOG, type PreviewScenario } from './catalog.ts'
import { DEFAULT_PREVIEW_SCENE, PREVIEW_DIAGNOSTIC_EVENT, PREVIEW_INSTANCE_PARAMETER, PREVIEW_SCENE_PARAMETER, previewStatePath } from './bridge.ts'
import zh from './locales/zh.json'
import en from './locales/en.json'
import type { PreviewDiagnosticSnapshot } from './diagnostics.ts'
import { PREVIEW_ARCHIVE } from './archive.ts'
import { PREVIEW_BROWSER } from './browser.ts'
import { PREVIEW_ARTIFACTS } from './publications.ts'
import { PREVIEW_STORAGE_READ } from './directory.ts'
import { PREVIEW_BROWSING } from './listing.ts'
import { PREVIEW_CONTENT } from './content.ts'
import { pdfeFeatureTarget, pdfeGuidance, pdfeNavigationPages, pdfeTitle, pdfeStateLabel, type PdfeTranslate } from './collaboration.ts'
import { PdfeNavigation } from './Navigation'
import { PdfeHeader } from './Header'
import { PdfeDivider } from './Divider'
import { PdfeControls } from './Controls'
import { isPreviewLoginMode, PREVIEW_LOGIN, type PreviewAccountBootstrap, type PreviewLoginMode } from './accounts.ts'

const PREVIEW_NAMESPACE = 'preview'
const PREVIEW_PAGE_PARAMETER = 'page'
const PREVIEW_CONSOLE_ROOT_ID = 'scholarseed-preview-console'
const CONSOLE_PANEL_CLASS = 'grid min-h-0 min-w-0 grid-cols-1 content-start gap-[var(--vds-space-4)] overflow-auto break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
const SECTION_CLASS = 'grid min-w-0 grid-cols-1 gap-[var(--vds-space-2)]'
const FEATURE_TARGET_PREFIX = 'pdfe-feature-target:'
type PreviewKey = keyof typeof zh
const RECOVERY_CONTROLS: readonly { id: string; path: string; label: PreviewKey; scope: PreviewKey; available: (simulation: PreviewScenario['simulation'], scenario?: PreviewScenario) => boolean }[] = [
  { id: 'preview-home-projects-recover', path: PREVIEW_HOME.recoveryPath, label: 'homeProjectRecovery', scope: 'homeProjectRecoveryScope', available: (_simulation, scenario) => scenario?.home?.projectRead === 'failed' },
  { id: 'preview-content-recover', path: PREVIEW_CONTENT.recoveryPath, label: 'contentRecovery', scope: 'contentRecoveryScope', available: simulation => simulation?.contentRead?.mode === 'failed' },
  { id: 'preview-browsing-recover', path: PREVIEW_BROWSING.recoveryPath, label: 'browsingRecovery', scope: 'browsingRecoveryScope', available: simulation => [simulation?.browsing?.listingRead, simulation?.browsing?.explorerRead].includes('failed') },
  { id: 'preview-storage-recover', path: PREVIEW_STORAGE_READ.recoveryPath, label: 'storageRecovery', scope: 'storageRecoveryScope', available: simulation => [simulation?.storage?.homeRead, simulation?.storage?.workspaceRead].includes('failed') },
  { id: 'preview-artifacts-recover', path: PREVIEW_ARTIFACTS.recoveryPath, label: 'artifactRecovery', scope: 'artifactRecoveryScope', available: simulation => [simulation?.artifacts?.catalogRead, simulation?.artifacts?.historyRead, simulation?.artifacts?.contentRead].includes('failed') },
  { id: 'preview-archive-recover', path: PREVIEW_ARCHIVE.recoveryPath, label: 'archiveRecovery', scope: 'archiveRecoveryScope', available: simulation => simulation?.archives?.projectRead === 'failed' },
  { id: 'preview-browser-recover', path: PREVIEW_BROWSER.recoveryPath, label: 'browserRecovery', scope: 'browserRecoveryScope', available: simulation => simulation?.browser?.policyRead === 'failed' },
]

rendererLocalization.addResourceBundle('zh', PREVIEW_NAMESPACE, zh, true, true)
rendererLocalization.addResourceBundle('en', PREVIEW_NAMESPACE, en, true, true)
const translate = rendererLocalization.getFixedT(null, PREVIEW_NAMESPACE as never) as unknown as PdfeTranslate

async function request(path: string, init?: RequestInit): Promise<{ preferences: RendererPreferences; login?: PreviewLoginMode; account?: PreviewAccountBootstrap; unhandled?: unknown[]; diagnostics?: PreviewDiagnosticSnapshot }> {
  const response = await fetch(path, { ...init, credentials: 'omit' })
  if (!response.ok) throw new Error(`Preview console request failed: ${response.status}`)
  return response.json()
}

function PreviewConsole(): React.JSX.Element {
  const native = window.pdfe
  if (native?.kind !== 'controls') throw new Error('PDFE control window required')
  useThemeEffect(window.scholarseed.preferences.theme)
  const url = new URL(window.location.href)
  const instance = url.searchParams.get(PREVIEW_INSTANCE_PARAMETER) ?? ''
  const currentScene = url.searchParams.get(PREVIEW_SCENE_PARAMETER) ?? DEFAULT_PREVIEW_SCENE
  const initialPage = PREVIEW_CATALOG.find((page) => page.id === url.searchParams.get(PREVIEW_PAGE_PARAMETER))
    ?? PREVIEW_CATALOG.find((page) => page.id === currentScene || page.scenarios.some((scenario) => scenario.id === currentScene))
    ?? PREVIEW_CATALOG[0]
  const materials = initialPage.launch?.kind === 'components'
  const featureTargetKey = FEATURE_TARGET_PREFIX + instance
  useEffect(() => {
    if (!materials) sessionStorage.setItem(featureTargetKey, JSON.stringify({ pageId: initialPage.id, sceneId: currentScene }))
  }, [materials, featureTargetKey, initialPage.id, currentScene])
  const changeOpen = (value: boolean): void => {
    if (!value) void native.hideControls()
  }
  const [helpOpen, setHelpOpen] = useState(false)
  const [dock, setDock] = useState(native.dock)
  useEffect(() => native.onDockChange(setDock), [native])
  const [pageId, setPageId] = useState(initialPage.id)
  const [query, setQuery] = useState('')
  const selectedPage = PREVIEW_CATALOG.find((page) => page.id === pageId) ?? initialPage
  const selectedScenario = selectedPage.scenarios.find((scenario) => scenario.id === currentScene) ?? selectedPage.scenarios[0]
  const guidance = pdfeGuidance(selectedPage, selectedScenario, translate)
  const currentScenario = initialPage.scenarios.find((scenario) => scenario.id === currentScene)
  const accountControl = true
  const matches = pdfeNavigationPages(PREVIEW_CATALOG, query, translate)
  const [theme, setTheme] = useState<PreferenceTheme>(window.scholarseed.preferences.theme)
  const [language, setLanguage] = useState<PreferenceLanguage>(window.scholarseed.preferences.language)
  const [login, setLogin] = useState<PreviewLoginMode>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [diagnostics, setDiagnostics] = useState<unknown[]>([])
  const [activity, setActivity] = useState<PreviewDiagnosticSnapshot | null>(null)
  const [navigationDiagnostics, setNavigationDiagnostics] = useState<unknown[]>([])
  useEffect(() => {
    document.title = translate('title')
  }, [])
  useEffect(() => {
    if (!accountControl) return
    let active = true
    void request(previewStatePath(instance, currentScene, initialPage.id)).then(state => {
      if (!isPreviewLoginMode(state.login)) throw new Error('Invalid preview login control state')
      if (active) setLogin(state.login)
    }).catch(failure => {
      if (active) { setError(true); console.error('[preview-console]', failure) }
    })
    return () => { active = false }
  }, [accountControl, instance, currentScene, initialPage.id])
  useEffect(() => {
    const receive = (event: Event): void => {
      if (event instanceof CustomEvent) setNavigationDiagnostics((current) => [...current, event.detail])
    }
    window.addEventListener(PREVIEW_DIAGNOSTIC_EVENT, receive)
    return () => window.removeEventListener(PREVIEW_DIAGNOSTIC_EVENT, receive)
  }, [])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError(false)
    try { await action() } catch (failure) { setError(true); console.error('[preview-console]', failure) } finally { setPending(false) }
  }
  const reset = async (scene: string, targetPage: string): Promise<void> => {
    await native.openScenario({ pageId: targetPage, sceneId: scene })
  }
  const saveAppearance = async (patch: Partial<Pick<RendererPreferences, 'theme' | 'language'>>): Promise<void> => {
    const state = await request(previewStatePath(instance, currentScene, initialPage.id))
    const saved = await request(previewStatePath(instance, currentScene, initialPage.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferences: { ...state.preferences, ...patch } }) })
    setTheme(saved.preferences.theme)
    setLanguage(saved.preferences.language)
    await native.reload()
  }
  const refreshDiagnostics = async (): Promise<void> => {
    const state = await request(previewStatePath(instance, currentScene))
    setDiagnostics(state.unhandled ?? [])
    setActivity(state.diagnostics ?? null)
  }

  const components = PREVIEW_CATALOG.find(page => page.launch?.kind === 'components')
  return <Dialog modal={false} open onOpenChange={changeOpen}>
    <div id={PREVIEW_CONSOLE_ROOT_ID} className="h-full min-h-0 min-w-0 overflow-hidden">
        <DialogContent hideCloseButton aria-label={translate('title')} className="!relative !top-auto !left-auto !h-full !w-full !max-w-none !transform-none !rounded-none !border-0 !shadow-none grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
          {dock === 'docked' && <PdfeDivider label={translate('resizeWorkbench')} onResize={native.resizeControls} onError={() => setError(true)} />}
          <PdfeHeader materials={materials} dock={dock} pending={pending} translate={translate} onHelp={() => setHelpOpen(true)} onDock={() => void run(() => native.setDock(dock === 'docked' ? 'detached' : 'docked'))} onReset={() => void run(() => reset(currentScene, initialPage.id))} onReload={() => void run(() => native.reload())} onClose={() => changeOpen(false)} onSection={section => {
            if (section === 'materials' && !materials && components) void run(() => reset(components.scenarios[0].id, components.id))
            if (section === 'features' && materials) void run(() => native.openScenario(pdfeFeatureTarget(sessionStorage.getItem(featureTargetKey))))
          }} />
          <div className={SECTION_CLASS}>
            <PdfeControls theme={theme} language={language} login={login} accountControl={accountControl} pending={pending} translate={translate} onTheme={theme => void run(() => saveAppearance({ theme }))} onLanguage={language => void run(() => saveAppearance({ language }))} onLogin={mode => void run(async () => {
              const saved = await request(PREVIEW_LOGIN.path + '?' + new URLSearchParams({ [PREVIEW_INSTANCE_PARAMETER]: instance }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
              if (!isPreviewLoginMode(saved.login)) throw new Error('Invalid preview login control state')
              setLogin(saved.login)
              await native.reload()
            })} />
            {currentScenario?.simulation?.account && <p className="text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">{translate('loginOverride')}</p>}
            {!materials && <SearchBox aria-label={translate('discovery')} value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('discoveryPlaceholder')} size="standard" />}
            <p data-testid="preview-current-scene" className="text-[length:var(--vds-font-body-lv3)] leading-[var(--vds-lh-body-lv3)] text-[var(--vds-text-secondary)]">{translate('currentScene')}: {pdfeTitle(initialPage, translate)} · {pdfeTitle(currentScenario ?? initialPage.scenarios[0], translate)}</p>
            {pending && <p role="status">{translate('operationPending')}</p>}
            {error && <p role="alert">{translate('requestFailed')}</p>}
          </div>
          <div className={CONSOLE_PANEL_CLASS}>
            {materials ? <section className={SECTION_CLASS} aria-label={translate('componentsEntry')}><h2>{translate('componentsEntry')}</h2><p className="text-[var(--vds-text-secondary)]">{translate('materialsDescription')}</p></section> : <PdfeNavigation pages={matches} selected={selectedPage} activePage={initialPage.id} scene={currentScene} searching={Boolean(query.trim())} query={query} pending={pending} translate={translate} stateLabel={state => pdfeStateLabel(state, translate)} onSelect={page => setPageId(page.id)} onLaunch={(page, scene) => void run(() => reset(scene, page.id))} />}
            {!materials && !matches.length && <p role="status">{translate('discoveryEmpty')}</p>}
            {RECOVERY_CONTROLS.filter(control => control.available(currentScenario?.simulation, currentScenario)).map(control => <Button key={control.id} data-testid={control.id} variant="secondary" disabled={pending} onClick={() => void run(async () => {
              const query = new URLSearchParams({ [PREVIEW_INSTANCE_PARAMETER]: instance })
              await request(control.path + '?' + query, { method: 'POST' })
            })}>{translate(control.label)}</Button>)}
            <Collapsible>
              <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-start">{translate('tools')}</Button></CollapsibleTrigger>
              <CollapsibleContent className={SECTION_CLASS}>
                <Button variant="secondary" disabled={pending} onClick={() => void run(refreshDiagnostics)}>{translate('refresh')}</Button>
                {activity && <pre data-testid="preview-diagnostic-history" className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(activity, null, 2)}</pre>}
                {(diagnostics.length > 0 || navigationDiagnostics.length > 0) && <pre className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify([...diagnostics, ...navigationDiagnostics], null, 2)}</pre>}
              </CollapsibleContent>
            </Collapsible>
            <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
              <DialogPortal><DialogContent aria-label={translate('guide')} className="max-h-[calc(100dvh_-_var(--vds-space-6))] overflow-auto">
                <DialogHeader><DialogTitle>{translate('guide')}</DialogTitle><DialogDescription>{translate('description')}</DialogDescription></DialogHeader>
                <div className={SECTION_CLASS}>
                  <h2>{pdfeTitle(selectedPage, translate)} · {pdfeTitle(selectedScenario, translate)}</h2>
                  {guidance.entry.length > 0 && <section className={SECTION_CLASS}><h3>{translate('entrySteps')}</h3><ol>{guidance.entry.map(step => <li key={step}>{step}</li>)}</ol></section>}
                  <section className={SECTION_CLASS}><h3>{translate('expected')}</h3><ul>{guidance.expected.map(text => <li key={text}>{text}</li>)}</ul><p>{translate(selectedScenario.status)}</p></section>
                  <section className={SECTION_CLASS}><h3>{translate('limitations')}</h3><ul>{guidance.limitations.map(text => <li key={text}>{text}</li>)}</ul></section>
                  {initialPage.pendingStates?.length && <section className={SECTION_CLASS}><h3>{translate('pendingStates')}</h3><p>{initialPage.pendingStates.map(state => pdfeStateLabel(state, translate)).join(' · ')}</p></section>}
                  {RECOVERY_CONTROLS.filter(control => control.available(currentScenario?.simulation, currentScenario)).map(control => <p key={control.id}>{translate(control.scope)}</p>)}
                  <Collapsible>
                    <CollapsibleTrigger asChild><Button variant="ghost" size="content" className="w-full justify-start !whitespace-normal text-left">{translate('guideCommon')}</Button></CollapsibleTrigger>
                    <CollapsibleContent className={SECTION_CLASS}>
                      <p>{translate('guideNavigation')}</p>
                      <p>{translate('sharedFunctions')}</p>
                      <p>{translate('consoleShortcut')}</p>
                      <p>{translate('publicControlScope')}</p>
                      <p>{translate('coverage')}</p>
                      <p>{translate('diagnosticScope')}</p>
                      <p className="break-all">{translate('instance')}: {instance}</p>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </DialogContent></DialogPortal>
            </Dialog>
          </div>
        </DialogContent>
    </div>
  </Dialog>
}

export function mountConsole(): void {
  if (document.getElementById(PREVIEW_CONSOLE_ROOT_ID)) return
  const root = document.getElementById('root')
  if (!root) throw new Error('Preview workbench root is missing')
  root.classList.add('h-dvh', 'min-h-0', 'min-w-0', 'overflow-hidden')
  createRoot(root).render(<LocalizationProvider><PreviewConsole /></LocalizationProvider>)
}
