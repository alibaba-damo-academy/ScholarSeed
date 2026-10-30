import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { mountRenderer } from '../src/renderer/src/app/root'
import { App } from '../src/renderer/src/App'
import { ErrorBoundary } from '../src/renderer/src/app/Error'
import { rendererLocalization } from '../src/renderer/src/app/localization'
import { featureRegistry } from '../src/renderer/src/app/composition'
import { SettingsContent } from '../src/renderer/src/components/business/AccountPanel'
import { Browser } from '../src/renderer/src/features/browser/Browser'
import { LanguageSwitchDialog } from '../src/renderer/src/components/business/Preferences'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle, Page, PageBody, PageHeader, RadioGroup, RadioGroupItem, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger, useToast } from '../src/renderer/src/components/ui'
import { WindowCloseContent } from '../src/renderer/src/shell/Close'
import type { WindowCloseAction, WindowCloseReply } from '../src/window.ts'
import { dropSession } from '../src/renderer/src/account'
import type { AccountSettingsPage } from '../src/navigation.ts'
import { useApp } from '../src/renderer/src/store'
import { useThemeEffect } from '../src/renderer/src/theme'
import { OfficeFrameFactoryContext } from '../src/renderer/src/features/workbench/office/transport'
import { PREVIEW_CATALOG, type PreviewScenario } from './catalog.ts'
import { PREVIEW_DIAGNOSTIC_EVENT, PREVIEW_SCENE_PARAMETER } from './bridge.ts'
import zh from './locales/zh.json'
import en from './locales/en.json'
import { previewOfficeFrameFactory } from './frames.ts'
import { PREVIEW_TOOLBAR_ACTIONS_ID } from './constants.ts'
import { previewDirectoryPicker, type PreviewDirectoryChoice } from './directory.ts'

rendererLocalization.addResourceBundle('zh', 'preview', zh, true, true)
rendererLocalization.addResourceBundle('en', 'preview', en, true, true)

const PREVIEW_CLOSE_REPLY_DELAY_MS = 3_000
type CloseSimulation = NonNullable<PreviewScenario['simulation']>['close']

function PreviewDirectoryDialog(): React.JSX.Element {
  const { i18n } = useTranslation('native')
  const translate = i18n.getFixedT(null, 'preview' as never) as (key: keyof typeof zh) => string
  const [choices, setChoices] = useState<readonly PreviewDirectoryChoice[]>([])
  const [selected, setSelected] = useState('')
  useEffect(() => {
    const unsubscribe = previewDirectoryPicker.subscribe(value => { setChoices(value); setSelected('') })
    return () => { unsubscribe(); previewDirectoryPicker.finish(null) }
  }, [])
  return <Dialog open={choices.length > 0} onOpenChange={open => { if (!open) previewDirectoryPicker.finish(null) }}>
    <DialogPortal>
      <DialogContent className="!z-[var(--vds-z-modal-nested)]" overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]" data-testid="preview-directory-dialog">
        <DialogHeader>
          <DialogTitle>{translate('directoryTitle')}</DialogTitle>
          <DialogDescription>{translate('directoryScope')}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={selected} onValueChange={setSelected} aria-label={translate('directoryTitle')}>
          {choices.map(choice => <RadioGroupItem key={choice.id} value={choice.id} data-testid={`preview-directory-choice-${choice.id}`}>
            <span className="grid gap-[var(--vds-space-1)] text-left">
              <span>{translate('directoryVirtualLabel')} · {choice.label}</span>
              <span className="break-all text-[var(--vds-text-secondary)]">{choice.path}</span>
            </span>
          </RadioGroupItem>)}
        </RadioGroup>
        <DialogFooter>
          <Button variant="secondary" data-testid="preview-directory-cancel" onClick={() => previewDirectoryPicker.finish(null)}>{translate('directoryCancel')}</Button>
          <Button disabled={!selected} data-testid="preview-directory-confirm" onClick={() => previewDirectoryPicker.finish(selected)}>{translate('directoryConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </Dialog>
}

function mountPreviewRenderer(content: React.ReactNode): Root {
  return mountRenderer(<>{content}<PreviewDirectoryDialog /></>)
}

function PreviewFault({ active }: { active: boolean }): React.JSX.Element | null {
  if (active) throw new Error('preview-only-render-failure')
  return null
}

function RendererDemo({ kind, closeSimulation = 'success' }: { kind: 'close' | 'error'; closeSimulation?: CloseSimulation }): React.JSX.Element {
  const { state } = useApp()
  const { t, i18n } = useTranslation('native')
  const translate = i18n.getFixedT(null, 'preview' as never) as (key: keyof typeof zh) => string
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const [reply, setReply] = useState<WindowCloseReply | null>(null)
  const [generation, setGeneration] = useState(0)
  const [fault, setFault] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const responding = useRef(false)
  const attempts = useRef(0)
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTrigger = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!open && generation > 0) closeTrigger.current?.focus({ preventScroll: true })
  }, [open, generation])
  useEffect(() => () => {
    if (replyTimer.current !== null) clearTimeout(replyTimer.current)
  }, [])
  const respond = (action: WindowCloseAction): void => {
    if (responding.current) return
    responding.current = true
    setPending(true)
    setFailed(false)
    const complete = (): void => {
      replyTimer.current = null
      responding.current = false
      setPending(false)
      attempts.current += 1
      if (closeSimulation === 'fail-once' && attempts.current === 1) {
        setFailed(true)
        return
      }
      setReply({ requestId: generation + 1, action, remember })
      setGeneration(value => value + 1)
      setOpen(false)
    }
    if (closeSimulation === 'delayed') replyTimer.current = setTimeout(complete, PREVIEW_CLOSE_REPLY_DELAY_MS)
    else complete()
  }
  useThemeEffect(state.theme)
  return (
    <Page className="h-full overflow-auto" data-testid={`preview-${kind}-host`}>
      <PageHeader title={kind === 'close' ? t('tray.closeTitle') : translate('faultTrigger')} description={translate('rendererDemo')} />
      <PageBody>
        {kind === 'close' ? <>
          <Button ref={closeTrigger} data-testid="preview-close-open" onClick={() => { setRemember(false); setFailed(false); setReply(null); attempts.current = 0; setOpen(true) }}>{t('tray.closeTitle')}</Button>
          {reply && <pre data-testid="preview-close-reply">{JSON.stringify(reply)}</pre>}
          {open && <WindowCloseContent remember={remember} pending={pending} failed={failed} onRemember={setRemember} onRespond={respond} />}
        </> : <>
          <Button data-testid="preview-error-trigger" disabled={fault} onClick={() => setFault(true)}>{translate('faultTrigger')}</Button>
          <Button data-testid="preview-error-recover" variant="secondary" disabled={!fault} onClick={() => { setFault(false); setGeneration(value => value + 1) }}>{translate('faultRecover')}</Button>
          <ErrorBoundary embedded key={generation}><PreviewFault active={fault} /></ErrorBoundary>
        </>}
      </PageBody>
    </Page>
  )
}

function HiddenSettings({ page }: { page: AccountSettingsPage }): React.JSX.Element {
  const { state } = useApp()
  const { t } = useTranslation('account')
  const { toast } = useToast()
  useThemeEffect(state.theme)
  const blocked = (): void => {
    toast({ title: t('loginFailure.native_unavailable'), tone: 'info' })
    window.dispatchEvent(new CustomEvent(PREVIEW_DIAGNOSTIC_EVENT, { detail: { kind: 'settings-navigation-unavailable', page } }))
  }
  return (
    <Page padding="none" className="h-full overflow-hidden" data-testid="preview-settings-host">
      <SettingsContent page={page} onPage={blocked} onClose={blocked} onLogin={blocked} onLogout={dropSession} />
      <LanguageSwitchDialog />
    </Page>
  )
}

function HiddenBrowser(): React.JSX.Element {
  const { state } = useApp()
  const { i18n } = useTranslation('native')
  const translate = i18n.getFixedT(null, 'preview' as never) as (key: keyof typeof zh) => string
  useThemeEffect(state.theme)
  return <Page padding="none" className="h-full gap-0 overflow-hidden" data-testid="preview-browser-host">
    <PageHeader headingLevel={2} title={translate('browserSurfaceTitle')} description={translate('browserSurfaceScope')} className="shrink-0 px-[var(--vds-layout-page-padding)] py-[var(--vds-space-2)]" />
    <PageBody className="flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden"><Browser /></PageBody>
  </Page>
}

function HiddenPanel({ panelKey }: { panelKey: string }): React.JSX.Element {
  const { state } = useApp()
  const { i18n } = useTranslation('native')
  const { t: uiText } = useTranslation('ui')
  const translate = i18n.getFixedT(null, 'preview' as never) as (key: keyof typeof zh) => string
  const [open, setOpen] = useState(false)
  const panel = featureRegistry.panels.find(candidate => candidate.key === panelKey && candidate.slot === 'module')
  const toolbar = document.getElementById(PREVIEW_TOOLBAR_ACTIONS_ID)
  useThemeEffect(state.theme)
  if (!panel) throw new Error(`Unknown preview module panel: ${panelKey}`)
  if (!toolbar) throw new Error('Preview toolbar is missing')
  return createPortal(
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger data-testid="preview-panel-open">{translate('openHiddenPanel')}</SheetTrigger>
      <SheetContent side="left" modal={false} className="overflow-hidden" data-testid="preview-panel-sheet">
        <SheetHeader>
          <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
            <SheetTitle>{panel.title(i18n)}</SheetTitle>
            <Button size="sm" variant="secondary" data-testid="preview-panel-close" onClick={() => setOpen(false)}>{uiText('close')}</Button>
          </div>
          <SheetDescription>{translate('hiddenPanelScope')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">{panel.render()}</div>
      </SheetContent>
    </Sheet>, toolbar
  )
}

export function mountPreviewHost(pageId: string): Root {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)
  if (!page) throw new Error(`Unknown preview page: ${pageId}`)
  if (page.host?.kind === 'settings') return mountPreviewRenderer(<HiddenSettings page={page.host.page} />)
  if (page.host?.kind === 'browser') return mountPreviewRenderer(<HiddenBrowser />)
  if (page.host?.kind === 'close' || page.host?.kind === 'error') {
    const sceneId = new URLSearchParams(window.location.search).get(PREVIEW_SCENE_PARAMETER)
    const scene = page.scenarios.find(candidate => candidate.id === sceneId) ?? page.scenarios[0]
    return mountPreviewRenderer(<RendererDemo kind={page.host.kind} closeSimulation={scene.simulation?.close} />)
  }
  if (page.host?.kind === 'panel') {
    return mountPreviewRenderer(<OfficeFrameFactoryContext.Provider value={previewOfficeFrameFactory}><App /><HiddenPanel panelKey={page.host.key} /></OfficeFrameFactoryContext.Provider>)
  }
  if (!page.target) throw new Error(`Preview page has no supported host or navigation target: ${pageId}`)
  return mountPreviewRenderer(<OfficeFrameFactoryContext.Provider value={previewOfficeFrameFactory}><App /></OfficeFrameFactoryContext.Provider>)
}
