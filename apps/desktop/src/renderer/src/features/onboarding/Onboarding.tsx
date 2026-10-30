import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ONBOARDING_GROUPS, type OnboardingGroup } from '../../../../onboarding'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useToast,
} from '../../components/ui'
import { Onboarding, PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding'
import { listProjects, type Project } from '../../api'
import { focusComposer } from '../../reference'
import { Welcome } from './Welcome'
import { documentSelectionInteractionProps } from '../workbench/focus'
import { useApp } from '../../store'
import { guideSteps, guideValid, navigateGuide, type Notice } from './adapter'
import { OB_COPY } from './copy'
import {
  clearSelection,
  cardPosition,
  OB_GEOMETRY,
  prepare,
  rectangle,
  settle,
  target,
  type Rectangle,
} from './dom'
import { GuideEngine, type GuideRequest, type GuideStep } from './engine'

const STEP_COPY = {
  'project-switcher': OB_COPY.project.switcher,
  'project-capabilities': OB_COPY.project.capabilities,
  'project-composer': OB_COPY.project.composer,
  'project-files': OB_COPY.project.files,
  'project-workspace': OB_COPY.project.workspace,
  'global-library': OB_COPY.globalLib.library,
  'global-import': OB_COPY.globalLib.import,
  'global-categories': OB_COPY.globalLib.categories,
  'global-ai': OB_COPY.globalLib.ai,
  'pdf-figure': OB_COPY.pdf.figure,
  'pdf-tools': OB_COPY.pdf.tools,
  'pdf-selection': OB_COPY.pdf.selection,
  'pdf-sample-selection': OB_COPY.pdf.sampleSelection,
  'pdf-ai': OB_COPY.pdf.ai,
} as const
const FILE_CATEGORIES = [
  {
    anchor: PROJECT_GUIDE_ANCHORS.materialsTab,
    titleKey: 'project.files.materials.title',
    bodyKey: 'project.files.materials.body',
  },
  {
    anchor: PROJECT_GUIDE_ANCHORS.literatureTab,
    titleKey: 'project.files.literature.title',
    bodyKey: 'project.files.literature.body',
  },
  {
    anchor: PROJECT_GUIDE_ANCHORS.outputsTab,
    titleKey: 'project.files.outputs.title',
    bodyKey: 'project.files.outputs.body',
  },
] as const
const DIALOG_CLASS =
  'ob-dialog !z-[var(--vds-z-modal)] !w-max !max-w-[var(--vds-onboarding-card-width)] max-h-[var(--vds-onboarding-card-height)] overflow-y-auto'
const OVERLAY_CLASS = 'ob-overlay !z-[var(--vds-z-overlay)]'

function Spotlight({
  step,
  ready,
  children,
  onSkip,
}: {
  step: GuideStep
  ready: boolean
  children: React.ReactNode
  onSkip: () => void
}): React.JSX.Element {
  const [areas, setAreas] = useState<Array<Rectangle & { extra: boolean }>>([])
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: OB_GEOMETRY.margin,
    top: OB_GEOMETRY.margin,
  })
  const maskId = React.useId()
  useLayoutEffect(() => {
    let frame = 0
    const layout = (): void => {
      const boxes = [
        ...step.targets.map((name) => ({ name, extra: false })),
        ...(step.extra ?? []).map((name) => ({ name, extra: true })),
      ].flatMap(({ name, extra }) => {
        const element = target(name)
        return element ? [{ ...rectangle(element), extra }] : []
      })
      setAreas((previous) =>
        previous.length === boxes.length &&
        previous.every((area, index) => {
          const box = boxes[index]
          return (
            area.left === box.left &&
            area.top === box.top &&
            area.width === box.width &&
            area.height === box.height &&
            area.extra === box.extra
          )
        })
          ? previous
          : boxes
      )
      const card = target('guide-card')?.getBoundingClientRect()
      if (card) {
        const next = cardPosition(
          boxes[0],
          card.width,
          card.height,
          {
            width: innerWidth,
            height: innerHeight,
          },
          step.placement
        )
        setPosition((previous) =>
          previous.left === next.left && previous.top === next.top ? previous : next
        )
      }
      // Panel transitions move anchors without resizing them. Track live geometry while
      // the guide is visible; unchanged rectangles do not trigger React renders.
      frame = requestAnimationFrame(layout)
    }
    layout()
    return () => cancelAnimationFrame(frame)
  }, [step, ready])
  // Geometry comes exclusively from live anchor and card rectangles.
  const style = {
    '--ob-left': `${position.left}px`,
    '--ob-top': `${position.top}px`,
  } as CSSProperties
  return (
    <>
      <svg
        className="ob-mask pointer-events-none fixed inset-0 z-[var(--vds-z-overlay)] h-full w-full"
        aria-hidden
      >
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {areas.map((r, i) => (
              <rect
                key={i}
                x={r.left}
                y={r.top}
                width={r.width}
                height={r.height}
                rx={OB_GEOMETRY.radius}
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="var(--vds-bg-mask)" mask={`url(#${maskId})`} />
      </svg>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onSkip()
        }}
      >
        <DialogContent
          {...documentSelectionInteractionProps}
          hideCloseButton
          data-ob="guide-card"
          overlayClassName={`${OVERLAY_CLASS} !bg-transparent`}
          className={`${step.id.startsWith('project-') ? DIALOG_CLASS.replace('!w-max', '!w-[var(--vds-onboarding-project-width)]') : DIALOG_CLASS} !left-[var(--ob-left)] !top-[var(--ob-top)] ![transform:none]`}
          style={style}
        >
          <div className="ob-card grid gap-[var(--vds-space-4)]">{children}</div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function OnboardingHost({ blocked }: { blocked: boolean }): React.JSX.Element | null {
  const store = useApp(),
    { t } = useTranslation('onboarding'),
    { toast } = useToast()
  const latest = useRef({ store, blocked, t, toast })
  latest.current = { store, blocked, t, toast }
  const navigateFlight = useRef<AbortController | null>(null)
  const pendingProject = useRef(false)
  const [navigating, setNavigating] = useState(false)
  const notice = (key: Notice): void => {
    const context = latest.current
    context.toast({ description: context.t(OB_COPY[key]) })
  }
  const engineRef = useRef<GuideEngine | null>(null)
  if (!engineRef.current)
    engineRef.current = new GuideEngine({
      seen: (group) => latest.current.store.state.onboarding.seen[group] === true,
      markSeen: (group) => {
        // Welcome is marked explicitly after creation or an intentional skip.
        if (group !== 'home') latest.current.store.act.markOnboardingSeen(group)
      },
      valid: (request) => guideValid(latest.current.store, request),
      blocked: () => {
        const { state } = latest.current.store
        return (
          latest.current.blocked ||
          navigatingRef.current ||
          !state.backendReady ||
          state.workspaceLoadState !== 'ready' ||
          Boolean(
            state.projectForm ||
            state.accountSettingsPage ||
            state.accountMenuOpen ||
            state.homeProjectMenuOpen ||
            state.globalSearchOpen
          )
        )
      },
      steps: (group) => guideSteps(() => latest.current.store, group),
      prepare,
      cleanup: clearSelection,
      unavailable: () => notice('unavailable'),
    })
  const engine = engineRef.current
  const navigatingRef = useRef(false)
  const snapshot = useSyncExternalStore(engine.subscribe, engine.snapshot)
  const { state } = store

  useEffect(
    () =>
      Onboarding.subscribe((event) => {
        if (event.type === 'center') {
          navigateFlight.current?.abort()
          navigatingRef.current = false
          setNavigating(false)
          pendingProject.current = false
          engine.openCenter()
        } else {
          const request: GuideRequest = { group: event.group, projectId: event.projectId }
          if (event.group === 'project' && pendingProject.current) {
            pendingProject.current = false
            engine.replay(request)
          } else engine.enqueue(request)
          requestAnimationFrame(() => {
            void engine.drain()
          })
        }
      }),
    [engine]
  )

  useEffect(() => {
    if (
      state.homeSelectedProjectId &&
      state.onboarding.recentProjectId !== state.homeSelectedProjectId
    ) {
      store.act.rememberOnboardingProject(state.homeSelectedProjectId)
    }
  }, [state.homeSelectedProjectId, state.onboarding.recentProjectId, store.act])

  // View transitions are observed, not reimplemented. Seen resets do not rerun this effect.
  useEffect(() => {
    if (navigatingRef.current || blocked || state.workspaceLoadState !== 'ready') return
    if (state.mainView === 'home' && !state.homeSelectedProjectId) engine.enqueue({ group: 'home' })
    if (state.mainView === 'literature' && !state.homeSelectedProjectId)
      engine.enqueue({ group: 'globalLib' })
    if (
      state.homeSelectedProjectId &&
      ['resource', 'literature', 'writing'].includes(state.mainView)
    )
      engine.enqueue({ group: 'project', projectId: state.homeSelectedProjectId })
  }, [blocked, state.workspaceLoadState, state.mainView, state.homeSelectedProjectId, engine])

  useEffect(() => {
    let documentId: string | undefined
    const inspect = (): void => {
      const id = target('pdf-reader')?.dataset.obDocument
      if (id && id !== documentId && !navigatingRef.current)
        engine.enqueue({ group: 'pdf', documentId: id })
      documentId = id
      const active = engine.snapshot().request
      if (active && !guideValid(latest.current.store, active)) engine.cancel()
      void engine.drain()
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ob-document'],
    })
    inspect()
    return () => observer.disconnect()
  }, [engine])

  useEffect(() => {
    const active = engine.snapshot().request
    if (active && (blocked || !guideValid(store, active))) engine.cancel()
    const frame = requestAnimationFrame(() => {
      void engine.drain()
    })
    return () => cancelAnimationFrame(frame)
  }, [state, blocked, snapshot.request, snapshot.center, engine])
  useEffect(
    () => () => {
      navigateFlight.current?.abort()
      engine.dispose()
    },
    [engine]
  )

  const replay = async (group: OnboardingGroup): Promise<void> => {
    navigateFlight.current?.abort()
    const flight = new AbortController()
    navigateFlight.current = flight
    navigatingRef.current = true
    setNavigating(true)
    engine.cancel()
    engine.closeCenter()
    try {
      pendingProject.current = group === 'project' && !latest.current.store.state.projects.length
      const request = await navigateGuide(
        () => latest.current.store,
        group,
        flight.signal,
        notice,
        t(OB_COPY.sampleTitle)
      )
      if (flight.signal.aborted) return
      if (request) engine.replay(request)
    } catch (error) {
      if (!flight.signal.aborted) {
        notice('openFailed')
        engine.openCenter()
        console.error('[onboarding] navigation failed', error)
      }
    } finally {
      if (navigateFlight.current === flight) {
        navigatingRef.current = false
        setNavigating(false)
        void engine.drain()
      }
    }
  }
  const completeWelcome = async (project: Project): Promise<void> => {
    const flight = new AbortController()
    navigateFlight.current?.abort()
    navigateFlight.current = flight
    navigatingRef.current = true
    try {
      const catalogue = await listProjects()
      flight.signal.throwIfAborted()
      if (!catalogue || !catalogue.projects.some((item) => item.id === project.id))
        throw new Error('onboarding_project_not_ready')
      store.set({ projects: catalogue.projects, defaultWorkspacePath: catalogue.default })
      await settle(flight.signal)
      store.act.markOnboardingSeen('home')
      engine.finish()
      store.act.selectProject(project.id)
      store.act.openWorkbenchView('resource')
      await settle(flight.signal)
      target(PROJECT_GUIDE_ANCHORS.closeWorkspace)?.click()
      await settle(flight.signal)
      engine.replay({ group: 'project', projectId: project.id })
    } finally {
      if (navigateFlight.current === flight) {
        navigatingRef.current = false
        void engine.drain()
      }
    }
  }
  const skip = (): void => {
    navigateFlight.current?.abort()
    store.act.markOnboardingSeen('home')
    store.act.markOnboardingSeen('project')
    engine.finish()
    store.act.openWorkbenchView('home')
  }
  const finish = (): void => {
    if (snapshot.request?.group === 'project') {
      target(PROJECT_GUIDE_ANCHORS.closeWorkspace)?.click()
      requestAnimationFrame(() => focusComposer())
    }
    engine.finish()
  }
  const group = snapshot.request?.group,
    step = snapshot.steps[snapshot.index]
  const center = snapshot.center && !blocked
  const visible = snapshot.ready && !blocked && step
  const stepCopy = step ? STEP_COPY[step.id as keyof typeof STEP_COPY] : undefined
  const spotlightVisible = Boolean(
    group &&
    group !== 'home' &&
    step &&
    stepCopy &&
    !blocked &&
    (snapshot.ready || snapshot.index > 0)
  )
  return createPortal(
    <>
      {center && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) engine.closeCenter()
          }}
        >
          <DialogContent
            className={DIALOG_CLASS}
            overlayClassName={OVERLAY_CLASS}
            data-ob="guide-center"
            aria-label={t(OB_COPY.center)}
          >
            <DialogHeader>
              <DialogTitle>{t(OB_COPY.center)}</DialogTitle>
            </DialogHeader>
            <div className="ob-list grid gap-[var(--vds-space-4)]">
              {ONBOARDING_GROUPS.filter((key) => key !== 'project').map((key) => (
                <div
                  key={key}
                  className="ob-row flex flex-wrap items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] py-[var(--vds-space-3)]"
                >
                  <div className="ob-label min-w-0 flex-1">
                    <strong>{t(OB_COPY[key].name)}</strong>
                    <p className="m-0 text-[var(--vds-text-secondary)]">
                      {t(OB_COPY[key].descriptionKey)}
                    </p>
                  </div>
                  <Badge
                    tone={
                      (
                        key === 'home'
                          ? state.onboarding.seen.home && state.onboarding.seen.project
                          : state.onboarding.seen[key]
                      )
                        ? 'neutral'
                        : 'success'
                    }
                  >
                    {t(
                      (
                        key === 'home'
                          ? state.onboarding.seen.home && state.onboarding.seen.project
                          : state.onboarding.seen[key]
                      )
                        ? OB_COPY.seen
                        : OB_COPY.unseen
                    )}
                  </Badge>
                  <Button
                    variant="secondary"
                    disabled={navigating}
                    data-ob={`guide-view-${key}`}
                    onClick={() => {
                      void replay(key)
                    }}
                  >
                    {t(OB_COPY.view)}
                  </Button>
                </div>
              ))}
            </div>
            <div className="ob-footer mt-[var(--vds-space-4)] flex flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
              <Button
                variant="ghost"
                data-ob="guide-reset"
                onClick={() => store.act.resetOnboardingSeen()}
              >
                {t(OB_COPY.reset)}
              </Button>
              <Button onClick={() => engine.closeCenter()}>{t(OB_COPY.done)}</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {visible && group === 'home' && <Welcome onComplete={completeWelcome} onSkip={skip} />}
      {spotlightVisible && step && stepCopy && (
        <Spotlight step={step} ready={snapshot.ready} onSkip={skip}>
          <DialogTitle>{t(stepCopy.titleKey)}</DialogTitle>
          <p className="ob-body m-0 text-[var(--vds-text-secondary)]">{t(stepCopy.body)}</p>
          {step.id === 'project-files' && (
            <div className="grid gap-[var(--vds-space-2)]">
              {FILE_CATEGORIES.map(({ anchor, titleKey, bodyKey }) => (
                <Button
                  key={anchor}
                  variant="ghost"
                  size="content"
                  className="!justify-start !whitespace-normal !text-left !p-[var(--vds-space-3)] !bg-[var(--vds-surface-muted)] hover:!bg-[var(--vds-brand-light-bg-default)] focus-visible:!bg-[var(--vds-brand-light-bg-default)]"
                  onMouseEnter={() => target(anchor)?.click()}
                  onFocus={() => target(anchor)?.click()}
                  onClick={() => target(anchor)?.click()}
                >
                  <span className="grid gap-[var(--vds-space-1)]">
                    <strong>{t(titleKey)}</strong>
                    <span className="text-[var(--vds-text-secondary)]">{t(bodyKey)}</span>
                  </span>
                </Button>
              ))}
            </div>
          )}
          <div className="ob-footer flex flex-wrap items-center justify-between gap-[var(--vds-space-4)]">
            <span className="ob-count text-[var(--vds-text-tertiary)]">
              {t(OB_COPY.step, { current: snapshot.index + 1, total: snapshot.steps.length })}
            </span>
            <div className="ob-buttons flex max-w-full flex-wrap justify-end gap-[var(--vds-space-2)]">
              {group === 'project' && snapshot.index > 0 && (
                <Button
                  variant="ghost"
                  disabled={!snapshot.ready}
                  onClick={() => {
                    void engine.previous()
                  }}
                >
                  {t('previous')}
                </Button>
              )}
              <Button
                variant="ghost"
                className="ob-dismiss !text-[var(--vds-text-tertiary)]"
                onClick={skip}
              >
                {t(OB_COPY.skip)}
              </Button>
              <Button
                data-ob="guide-next"
                disabled={!snapshot.ready}
                onClick={() => {
                  if (group === 'project' && snapshot.index === snapshot.steps.length - 1) finish()
                  else void engine.next()
                }}
              >
                {t(
                  snapshot.index === snapshot.steps.length - 1
                    ? group === 'project'
                      ? OB_COPY.start
                      : OB_COPY.done
                    : OB_COPY.next
                )}
              </Button>
            </div>
          </div>
        </Spotlight>
      )}
    </>,
    document.body
  )
}
