import React, { useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PUBLIC_COMPONENT_PLUGIN,
  PUBLIC_COMPONENT_FINGERPRINT,
  PLUGIN_ANSWER_CAPABILITY,
  PLUGIN_RPC_ERRORS,
  type PluginComponent,
  type PluginMount,
  type PluginReference,
} from '../../../../plugins'
import type { DeviceSkillRequest } from '../../../../skills'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Pagination,
} from '../ui'
import { PluginInteraction } from './Frame'
import { HilCard, type HilController } from './Stream'
import type { ConvItem, Thread } from '../../model'
import { hilEventResolution } from '../../hil'
import { createPreviewSession } from './preview'
import { PublicComponentsContext } from './publicComponents'

export type PluginPreviewRequest =
  | Extract<DeviceSkillRequest, { operation: 'plugin-preview' }>
  | { operation: 'plugin-preview-installed'; name: string }

export function PluginPreviewDialog({
  request,
  onClose,
}: {
  request: PluginPreviewRequest
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPortal>
        <DialogContent
          className="w-[var(--vds-preview-width)] !z-[var(--vds-z-modal-nested)]"
          overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
          portalClassName="z-[var(--vds-z-modal-interaction)]"
          data-testid="plugin-preview-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('plugin.preview')}</DialogTitle>
          </DialogHeader>
          <PluginPreview request={request} />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

export function PluginPreview({ request }: { request: PluginPreviewRequest }): React.JSX.Element {
  const { t } = useTranslation('skills')
  const [mount, setMount] = useState<PluginMount | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    let leases: string[] = []
    setMount(null)
    setFailed(false)
    void window.scholarseed
      .deviceSkills(request)
      .then((response) => {
        if (response.status >= 400) throw new Error('plugin_unavailable')
        const next = JSON.parse(response.body) as PluginMount
        const created = Object.values(next.frames).map((frame) => frame.lease)
        if (!current) {
          void window.scholarseed.deviceSkills({ operation: 'plugin-release', leases: created })
          return
        }
        leases = created
        setMount(next)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
      if (leases.length)
        void window.scholarseed.deviceSkills({ operation: 'plugin-release', leases })
    }
  }, [request])
  if (failed) return <p role="alert">{t('plugin.unavailable')}</p>
  if (!mount) return <p>{t('plugin.loading')}</p>
  return <PreviewPages key={mount.fingerprint} mount={mount} />
}

type PreviewTarget = { component: string; data: Record<string, unknown> }

function previewReference(mount: PluginMount, component: PluginComponent): PluginReference {
  return component.public && !mount.frames[component.id]
    ? {
        plugin: PUBLIC_COMPONENT_PLUGIN,
        component: component.slot!,
        fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
      }
    : { plugin: mount.descriptor.id, component: component.id, fingerprint: mount.fingerprint }
}

function PreviewPages({ mount }: { mount: PluginMount }): React.JSX.Element {
  const { t } = useTranslation('skills')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const component = mount.descriptor.components[page - 1]
  return (
    <div
      className="grid min-w-0 gap-[var(--vds-space-3)]"
      data-testid="plugin-conversation-preview"
    >
      <p>{t('plugin.sample')}</p>
      {mount.ui && (
        <p data-testid="preview-ui-release">
          {t('plugin.uiRelease', {
            compatibility: mount.ui.compatibility,
            version: mount.ui.version,
          })}
          <span className="block break-all text-[var(--vds-text-secondary)]">
            {mount.ui.fingerprint}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
        <span data-testid="preview-page" aria-live="polite">
          {t('plugin.page', { page, count: mount.descriptor.components.length })}
        </span>
        <Pagination
          ariaLabel={t('plugin.pagination')}
          page={page}
          pageCount={mount.descriptor.components.length}
          onPageChange={(next) => {
            setPage(next)
          }}
        />
      </div>
      {component && (
        <Scenario
          key={`${component.id}:${revision}`}
          mount={mount}
          component={component}
          onReset={() => {
            setRevision((value) => value + 1)
          }}
        />
      )}
    </div>
  )
}

function Scenario({
  mount,
  component,
  onReset,
}: {
  mount: PluginMount
  component: PluginComponent
  onReset: () => void
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const registered = useContext(PublicComponentsContext)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const scenario = mount.scenarios[component.id]
  const variant = selected === null ? null : scenario.cases?.[selected]
  const effective = variant
    ? {
        ...mount,
        scenarios: {
          ...mount.scenarios,
          [component.id]: {
            ...scenario,
            ...variant,
            data: { ...scenario.data, ...variant.data },
            responses: { ...scenario.responses, ...variant.responses },
          },
        },
      }
    : mount
  const origin = component.public
    ? mount.ui && mount.frames[component.id]
      ? 'plugin.officialComponent'
      : registered.has(component.slot!) && !registered.get(component.slot!)?.legacyOnly
        ? 'plugin.publicComponent'
        : 'plugin.unavailable'
    : 'plugin.customComponent'
  return (
    <Card data-testid="preview-component" data-component={component.id}>
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)]">
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
          <CardTitle>{component.id}</CardTitle>
          <Badge data-testid="preview-origin" tone="neutral">
            {t(origin)}
          </Badge>
        </div>
        <Button variant="secondary" onClick={onReset}>
          {t('plugin.reset')}
        </Button>
      </CardHeader>
      <CardContent
        key={revision}
        className="grid max-h-[var(--vds-preview-content-max-height)] gap-[var(--vds-space-3)] overflow-auto"
      >
        {scenario.cases?.length ? (
          <div className="flex flex-wrap gap-[var(--vds-space-2)]">
            {scenario.cases.map((variant, index) => (
              <Button
                key={variant.label}
                variant={selected === index ? 'primary' : 'outline'}
                onClick={() => {
                  setSelected(index)
                  setRevision((value) => value + 1)
                }}
              >
                {variant.label}
              </Button>
            ))}
          </div>
        ) : null}
        <ScenarioContent key={revision} mount={effective} component={component} />
      </CardContent>
    </Card>
  )
}

async function validateSubmission(
  component: PluginComponent,
  action: string,
  values: Record<string, unknown>
): Promise<string | null> {
  const response = await window.scholarseed.deviceSkills({
    operation: 'plugin-validate',
    component,
    action,
    values,
  })
  if (response.status !== 200) return 'component_validation_unavailable'
  const result = JSON.parse(response.body) as {
    valid?: boolean
    error?: string
    detail?: { layer?: string; schema_path?: unknown[] }
  }
  return result.valid === true
    ? null
    : [
        result.error ?? 'component_submission_invalid',
        result.detail?.layer,
        result.detail?.schema_path?.join('/'),
      ]
        .filter(Boolean)
        .join(': ')
}

function ScenarioContent({
  mount,
  component,
}: {
  mount: PluginMount
  component: PluginComponent
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const scenario = mount.scenarios[component.id]
  const [execution] = useState(() => createPreviewSession(scenario))
  const [data] = useState(scenario.data)
  const [status, setStatus] = useState('pending')
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  const [viewer, setViewer] = useState<{ title: string; body: string; identifier?: string } | null>(
    null
  )
  const sampleView = viewer && (
    <section data-testid="preview-viewer" className="grid gap-[var(--vds-space-3)]">
      <Button variant="outline" onClick={() => setViewer(null)}>
        {t('plugin.closeSample')}
      </Button>
      <h3>{viewer.title}</h3>
      {viewer.identifier && <p>{viewer.identifier}</p>}
      <p className="whitespace-pre-wrap">{viewer.body}</p>
    </section>
  )
  if (target) {
    const destination = mount.descriptor.components.find((item) => item.id === target.component)!
    const detailMount = {
      ...mount,
      scenarios: {
        ...mount.scenarios,
        [target.component]: { ...mount.scenarios[target.component], data: target.data },
      },
    }
    return (
      <div className="grid gap-[var(--vds-space-3)]">
        <Button variant="outline" onClick={() => setTarget(null)}>
          {t('plugin.backToSummary')}
        </Button>
        <ScenarioContent key={target.component} mount={detailMount} component={destination} />
      </div>
    )
  }
  if (
    scenario.interaction ||
    component.actions.some((action) => action.capability === PLUGIN_ANSWER_CAPABILITY)
  )
    return <InteractionScenario mount={mount} component={component} />
  return (
    <>
      {sampleView}
      <div hidden={Boolean(viewer)}>
        <PluginInteraction
          previewMount={mount}
          reference={previewReference(mount, component)}
          data={data}
          status={status}
          onAction={() => undefined}
          onRequest={async (action, values) => {
            const error = await validateSubmission(component, action, values)
            if (error) throw new Error(error)
            const response = execution.execute(action, values)
            setStatus(response.state)
            if (response.state === 'failed')
              throw new Error(String(response.data.error ?? 'plugin_preview_failed'))
            const destination = response.data.target as
              { component?: unknown; data?: unknown } | undefined
            if (destination) {
              if (
                typeof destination.component !== 'string' ||
                !mount.descriptor.components.some(
                  (component) => component.id === destination.component
                ) ||
                !destination.data ||
                typeof destination.data !== 'object' ||
                Array.isArray(destination.data)
              )
                throw new Error('plugin_preview_target_invalid')
              const component = destination.component
              const data = destination.data as Record<string, unknown>
              setTarget({ component, data })
            }
            const view = response.data.view as
              { title?: unknown; body?: unknown; identifier?: unknown } | undefined
            if (view) {
              if (
                typeof view.title !== 'string' ||
                typeof view.body !== 'string' ||
                (view.identifier !== undefined && typeof view.identifier !== 'string')
              )
                throw new Error('plugin_preview_view_invalid')
              setViewer({ title: view.title, body: view.body, identifier: view.identifier })
            }
            return response.data.result
          }}
        />
      </div>
    </>
  )
}

const PREVIEW_SESSION = 'plugin-preview'

function InteractionScenario({
  mount,
  component,
}: {
  mount: PluginMount
  component: PluginComponent
}): React.JSX.Element {
  const scenario = mount.scenarios[component.id]
  const [execution] = useState(() =>
    createPreviewSession(
      scenario.interaction
        ? {
            data: {},
            state: scenario.state,
            responses: {
              respond: { state: 'resolved', data: {}, steps: scenario.interaction?.respond },
              interrupt: { state: 'resolved', data: {}, steps: scenario.interaction?.interrupt },
            },
          }
        : scenario
    )
  )
  const questions = scenario.interaction?.questions ?? [
    { id: component.id, header: component.id, question: component.id, options: [] },
  ]
  const [thread, setThread] = useState<Thread>(() => ({
    id: PREVIEW_SESSION,
    sessionId: PREVIEW_SESSION,
    title: component.id,
    lastSeq: 0,
    conversation: [
      {
        kind: 'hil',
        id: component.id,
        requestId: component.id,
        sessionId: PREVIEW_SESSION,
        hilKind: 'question',
        hilState: 'pending',
        questions: questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({
            ...option,
            description: option.description ?? undefined,
          })),
          papers: question.papers?.map((paper) => ({
            ...paper,
            description: paper.description ?? undefined,
          })),
          component: previewReference(mount, component),
          componentData: scenario.data,
        })),
      },
    ],
  }))
  const controller: HilController = {
    sessionId: PREVIEW_SESSION,
    threadId: PREVIEW_SESSION,
    patchThread: (_id, patch) =>
      setThread((current) => ({
        ...current,
        ...(typeof patch === 'function' ? patch(current) : patch),
      })),
    respond: async (_session, request, body) => {
      const submitted =
        !scenario.interaction && body.answers && typeof body.answers === 'object'
          ? (JSON.parse(String((body.answers as Record<string, unknown>)[component.id])) as {
              action: string
              values: Record<string, unknown>
            })
          : null
      if (submitted) {
        try {
          const error = await validateSubmission(component, submitted.action, submitted.values)
          if (error) return { ok: false, error }
        } catch {
          return { ok: false, error: PLUGIN_RPC_ERRORS.validationUnavailable }
        }
      }
      const response = execution.execute(submitted?.action ?? 'respond', submitted?.values ?? body)
      if (response.state === 'cancelled') {
        setThread((current) => ({
          ...current,
          running: false,
          status: 'done',
          conversation: current.conversation.map((item) =>
            item.kind === 'hil' && item.requestId === request
              ? {
                  ...item,
                  ...hilEventResolution(undefined, 'cancelled'),
                  hilState: 'cancelled',
                  submissionError: undefined,
                  submissionErrorMessage: undefined,
                  submissionRequestFailure: undefined,
                }
              : item
          ),
        }))
        return { ok: true, request_id: request }
      }
      return response.state === 'resolved'
        ? { ok: true, request_id: request }
        : {
            ok: false,
            error: String(response.data.error ?? 'plugin_preview_failed'),
            ...(response.data.outcome === 'unknown' || response.data.outcome === 'stale'
              ? { outcome: response.data.outcome }
              : {}),
          }
    },
    interrupt: async () => {
      const response = execution.execute('interrupt', {})
      return response.state !== 'failed'
        ? { ok: true }
        : { ok: false, error: String(response.data.error ?? 'plugin_preview_failed') }
    },
  }
  return (
    <HilCard
      item={thread.conversation[0] as Extract<ConvItem, { kind: 'hil' }>}
      controller={controller}
      previewMount={mount}
    />
  )
}
