import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ONBOARDING_GROUPS, type OnboardingGroup } from '../../../../onboarding'
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle, useToast } from '../../components/ui'
import { Onboarding } from '../../contracts/onboarding'
import { documentSelectionInteractionProps } from '../workbench/focus'
import { useApp } from '../../store'
import { guideSteps, guideValid, navigateGuide, type Notice } from './adapter'
import { OB_COPY } from './copy'
import { clearSelection, cardPosition, OB_GEOMETRY, prepare, rectangle, settle, target, type Rectangle } from './dom'
import { GuideEngine, type GuideRequest, type GuideStep } from './engine'

const STEP_COPY = {
  'project-switcher': OB_COPY.project.switcher, 'project-resources': OB_COPY.project.resources,
  'project-discovery': OB_COPY.project.discovery, 'project-literature': OB_COPY.project.literature,
  'project-ai': OB_COPY.project.ai, 'global-library': OB_COPY.globalLib.library,
  'global-import': OB_COPY.globalLib.import, 'global-discovery': OB_COPY.globalLib.discovery,
  'global-categories': OB_COPY.globalLib.categories, 'global-ai': OB_COPY.globalLib.ai,
  'pdf-figure': OB_COPY.pdf.figure, 'pdf-tools': OB_COPY.pdf.tools,
  'pdf-selection': OB_COPY.pdf.selection, 'pdf-sample-selection': OB_COPY.pdf.sampleSelection, 'pdf-ai': OB_COPY.pdf.ai
} as const
const DIALOG_CLASS = 'ob-dialog !z-[var(--vds-z-modal)] !w-max !max-w-[var(--vds-onboarding-card-width)] max-h-[var(--vds-onboarding-card-height)] overflow-y-auto'
const OVERLAY_CLASS = 'ob-overlay !z-[var(--vds-z-overlay)]'

function Spotlight({ step, ready, children, onSkip }: { step: GuideStep; ready: boolean; children: React.ReactNode; onSkip: () => void }): React.JSX.Element {
  const [areas, setAreas] = useState<Array<Rectangle & { extra: boolean }>>([])
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: OB_GEOMETRY.margin, top: OB_GEOMETRY.margin })
  const maskId = React.useId()
  const measure = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    let frame = 0
    const layout = (): void => {
      const boxes = [...step.targets.map(name => ({ name, extra: false })), ...(step.extra ?? []).map(name => ({ name, extra: true }))]
        .flatMap(({ name, extra }) => { const element = target(name); return element ? [{ ...rectangle(element), extra }] : [] })
      setAreas(boxes)
      const card = target('guide-card')?.getBoundingClientRect()
      if (card) setPosition(cardPosition(boxes[0], card.width, card.height, { width: innerWidth, height: innerHeight }))
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout) }
    const resize = new ResizeObserver(schedule)
    if (measure.current) resize.observe(measure.current)
    for (const name of [...step.targets, ...(step.extra ?? [])]) { const element = target(name); if (element) resize.observe(element) }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true) }
  }, [step, ready])
  // Geometry comes exclusively from live anchor and card rectangles.
  const style = { '--ob-left': `${position.left}px`, '--ob-top': `${position.top}px` } as CSSProperties
  return <>
    <svg className="ob-mask pointer-events-none fixed inset-0 z-[var(--vds-z-overlay)] h-full w-full" aria-hidden>
      <defs><mask id={maskId}><rect width="100%" height="100%" fill="white" />{areas.map((r, i) => <rect key={i} x={r.left} y={r.top} width={r.width} height={r.height} rx={OB_GEOMETRY.radius} fill="black" />)}</mask></defs>
      <rect width="100%" height="100%" fill="var(--vds-bg-mask)" mask={`url(#${maskId})`} />
    </svg>
    <Dialog open onOpenChange={open => { if (!open) onSkip() }}>
      <DialogContent {...documentSelectionInteractionProps} hideCloseButton data-ob="guide-card" overlayClassName={`${OVERLAY_CLASS} !bg-transparent`} className={`${DIALOG_CLASS} !left-[var(--ob-left)] !top-[var(--ob-top)] ![transform:none]`} style={style}>
        <div ref={measure} className="ob-card grid gap-[var(--vds-space-4)]">{children}</div>
      </DialogContent>
    </Dialog>
  </>
}

export function OnboardingHost({ blocked }: { blocked: boolean }): React.JSX.Element | null {
  const store = useApp(), { t } = useTranslation('onboarding'), { toast } = useToast()
  const latest = useRef({ store, blocked, t, toast })
  latest.current = { store, blocked, t, toast }
  const navigateFlight = useRef<AbortController | null>(null)
  const pendingProject = useRef(false)
  const [navigating, setNavigating] = useState(false)
  const notice = (key: Notice): void => { const context = latest.current; context.toast({ description: context.t(OB_COPY[key]) }) }
  const engineRef = useRef<GuideEngine | null>(null)
  if (!engineRef.current) engineRef.current = new GuideEngine({
    seen: group => latest.current.store.state.onboarding.seen[group] === true,
    markSeen: group => latest.current.store.act.markOnboardingSeen(group),
    valid: request => guideValid(latest.current.store, request),
    blocked: () => {
      const { state } = latest.current.store
      return latest.current.blocked || navigatingRef.current || !state.backendReady || state.workspaceLoadState !== 'ready' || Boolean(state.projectForm || state.accountSettingsPage || state.accountMenuOpen || state.homeProjectMenuOpen || state.globalSearchOpen)
    },
    steps: group => guideSteps(() => latest.current.store, group),
    prepare, cleanup: clearSelection, unavailable: () => notice('unavailable')
  })
  const engine = engineRef.current
  const navigatingRef = useRef(false)
  const snapshot = useSyncExternalStore(engine.subscribe, engine.snapshot)
  const { state } = store

  useEffect(() => Onboarding.subscribe(event => {
    if (event.type === 'center') {
      navigateFlight.current?.abort(); navigatingRef.current = false; setNavigating(false)
      pendingProject.current = false; engine.openCenter()
    } else {
      const request: GuideRequest = { group: event.group, projectId: event.projectId }
      if (event.group === 'project' && pendingProject.current) {
        pendingProject.current = false; engine.replay(request)
      } else engine.enqueue(request)
      requestAnimationFrame(() => { void engine.drain() })
    }
  }), [engine])

  useEffect(() => {
    if (state.homeSelectedProjectId && state.onboarding.recentProjectId !== state.homeSelectedProjectId) {
      store.act.rememberOnboardingProject(state.homeSelectedProjectId)
    }
  }, [state.homeSelectedProjectId, state.onboarding.recentProjectId, store.act])

  // View transitions are observed, not reimplemented. Seen resets do not rerun this effect.
  useEffect(() => {
    if (navigatingRef.current || blocked || state.workspaceLoadState !== 'ready') return
    if (state.mainView === 'home' && !state.homeSelectedProjectId) engine.enqueue({ group: 'home' })
    if (state.mainView === 'literature' && !state.homeSelectedProjectId) engine.enqueue({ group: 'globalLib' })
    if (state.homeSelectedProjectId && ['resource', 'literature', 'writing'].includes(state.mainView)) engine.enqueue({ group: 'project', projectId: state.homeSelectedProjectId })
  }, [blocked, state.workspaceLoadState, state.mainView, state.homeSelectedProjectId, engine])

  useEffect(() => {
    let documentId: string | undefined
    const inspect = (): void => {
      const id = target('pdf-reader')?.dataset.obDocument
      if (id && id !== documentId && !navigatingRef.current) engine.enqueue({ group: 'pdf', documentId: id })
      documentId = id
      const active = engine.snapshot().request
      if (active && !guideValid(latest.current.store, active)) engine.cancel()
      void engine.drain()
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ob-document'] })
    inspect()
    return () => observer.disconnect()
  }, [engine])

  useEffect(() => {
    const active = engine.snapshot().request
    if (active && (blocked || !guideValid(store, active))) engine.cancel()
    const frame = requestAnimationFrame(() => { void engine.drain() })
    return () => cancelAnimationFrame(frame)
  }, [state, blocked, snapshot.request, snapshot.center, engine])
  useEffect(() => () => { navigateFlight.current?.abort(); engine.dispose() }, [engine])

  const replay = async (group: OnboardingGroup): Promise<void> => {
    navigateFlight.current?.abort()
    const flight = new AbortController(); navigateFlight.current = flight
    navigatingRef.current = true; setNavigating(true)
    engine.cancel(); engine.closeCenter()
    try {
      pendingProject.current = group === 'project' && !latest.current.store.state.projects.length
      const request = await navigateGuide(() => latest.current.store, group, flight.signal, notice, t(OB_COPY.sampleTitle))
      if (flight.signal.aborted) return
      if (request) engine.replay(request)
    } catch (error) {
      if (!flight.signal.aborted) { notice('openFailed'); engine.openCenter(); console.error('[onboarding] navigation failed', error) }
    } finally {
      if (navigateFlight.current === flight) { navigatingRef.current = false; setNavigating(false); void engine.drain() }
    }
  }
  const begin = async (kind: 'project' | 'literature'): Promise<void> => {
    engine.finish()
    if (kind === 'project') { store.set({ projectForm: { mode: 'create' } }); return }
    store.act.resetOnboardingGroup('globalLib')
    navigatingRef.current = true
    const flight = new AbortController()
    navigateFlight.current = flight
    try {
      store.act.openWorkbenchView('literature')
      await settle(flight.signal)
      engine.replay({ group: 'globalLib' })
    } catch (error) {
      if (!flight.signal.aborted) { notice('openFailed'); console.error('[onboarding] import navigation failed', error) }
    } finally {
      navigatingRef.current = false
      if (navigateFlight.current === flight) void engine.drain()
    }
  }
  const group = snapshot.request?.group, step = snapshot.steps[snapshot.index]
  const center = snapshot.center && !blocked
  const visible = snapshot.ready && !blocked && step
  const stepCopy = step ? STEP_COPY[step.id as keyof typeof STEP_COPY] : undefined
  const spotlightVisible = Boolean(group && group !== 'home' && step && stepCopy && !blocked && (snapshot.ready || snapshot.index > 0))
  return createPortal(<>
    {center && <Dialog open onOpenChange={open => { if (!open) engine.closeCenter() }}>
      <DialogContent className={DIALOG_CLASS} overlayClassName={OVERLAY_CLASS} data-ob="guide-center" aria-label={t(OB_COPY.center)}>
        <DialogHeader><DialogTitle>{t(OB_COPY.center)}</DialogTitle></DialogHeader>
        <div className="ob-list grid gap-[var(--vds-space-4)]">
          {ONBOARDING_GROUPS.map(key => <div key={key} className="ob-row flex flex-wrap items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] py-[var(--vds-space-3)]">
            <div className="ob-label min-w-0 flex-1"><strong>{t(OB_COPY[key].name)}</strong><p className="m-0 text-[var(--vds-text-secondary)]">{t(OB_COPY[key].description)}</p></div>
            <Badge tone={state.onboarding.seen[key] ? 'neutral' : 'success'}>{t(state.onboarding.seen[key] ? OB_COPY.seen : OB_COPY.unseen)}</Badge>
            <Button variant="secondary" disabled={navigating} data-ob={`guide-view-${key}`} onClick={() => { void replay(key) }}>{t(OB_COPY.view)}</Button>
          </div>)}
        </div>
        <div className="ob-footer mt-[var(--vds-space-4)] flex flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
          <Button variant="ghost" data-ob="guide-reset" onClick={() => store.act.resetOnboardingSeen()}>{t(OB_COPY.reset)}</Button>
          <Button onClick={() => engine.closeCenter()}>{t(OB_COPY.done)}</Button>
        </div>
      </DialogContent>
    </Dialog>}
    {visible && group === 'home' && <Dialog open onOpenChange={open => { if (!open) engine.finish() }}>
      <DialogContent hideCloseButton data-ob="guide-home" className={DIALOG_CLASS} overlayClassName={OVERLAY_CLASS}>
        <DialogHeader><DialogTitle>{t(OB_COPY.home.title)}</DialogTitle></DialogHeader>
        <div className="ob-choices flex flex-wrap gap-[var(--vds-space-4)]">
          {(['literature', 'project'] as const).map(kind => <Button key={kind} variant="outline" size="content" data-ob={`guide-start-${kind}`} className="ob-choice min-w-0 flex-1 !whitespace-normal !p-[var(--vds-space-4)] text-left" onClick={() => { void begin(kind) }}>
            <span className="ob-choice-content grid min-w-0 w-full gap-[var(--vds-space-3)]"><strong>{t(kind === 'project' ? OB_COPY.home.projectTitle : OB_COPY.home.literatureTitle)}</strong><span className="text-[var(--vds-text-secondary)]">{t(kind === 'project' ? OB_COPY.home.projectBody : OB_COPY.home.literatureBody)}</span><span className="text-[var(--vds-brand-text-primary)]">{t(kind === 'project' ? OB_COPY.home.projectLink : OB_COPY.home.literatureLink)}</span></span>
          </Button>)}
        </div>
        <div className="ob-footer flex justify-end"><Button variant="ghost" className="ob-dismiss !text-[var(--vds-text-tertiary)]" onClick={() => engine.finish()}>{t(OB_COPY.home.browse)}</Button></div>
      </DialogContent>
    </Dialog>}
    {spotlightVisible && step && stepCopy && <Spotlight step={step} ready={snapshot.ready} onSkip={() => engine.finish()}>
      <DialogTitle>{t(stepCopy.title)}</DialogTitle>
      <p className="ob-body m-0 text-[var(--vds-text-secondary)]">{t(stepCopy.body)}</p>
      <div className="ob-footer flex items-center justify-between gap-[var(--vds-space-4)]">
        <span className="ob-count text-[var(--vds-text-tertiary)]">{t(OB_COPY.step, { current: snapshot.index + 1, total: snapshot.steps.length })}</span>
        <div className="ob-buttons flex gap-[var(--vds-space-2)]"><Button variant="ghost" className="ob-dismiss !text-[var(--vds-text-tertiary)]" onClick={() => engine.finish()}>{t(OB_COPY.skip)}</Button><Button data-ob="guide-next" disabled={!snapshot.ready} onClick={() => { void engine.next() }}>{t(snapshot.index === snapshot.steps.length - 1 ? (group === 'project' ? OB_COPY.start : OB_COPY.done) : OB_COPY.next)}</Button></div>
      </div>
    </Spotlight>}
  </>, document.body)
}
