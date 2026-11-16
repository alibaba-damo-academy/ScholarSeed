import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ANSWER_SOURCES_CHANGED_EVENT } from '../../contracts/citations'
import {
  componentAction,
  componentCopy,
  componentCopyText,
  componentPlotExport,
  createComponentGesture,
  componentDraft,
  componentHeight,
  componentRequest,
  componentRPC,
  PLUGIN_FRAME_HEIGHT,
  PLUGIN_FRAME_PHASES,
  PLUGIN_FRAME_START_TIMEOUT_MS,
  PLUGIN_MAX_PENDING_REQUESTS,
  PLUGIN_MAX_REQUESTS,
  PLUGIN_MESSAGE_CHANNEL,
  PUBLIC_COMPONENT_PENDING,
  type PluginComponent,
  type PluginMount,
  type PluginReference,
  type PluginRequestHandler,
  type PluginCopyContent,
} from '../../../../plugins'
import {
  pluginErrorCode,
  PLUGIN_RPC_ERRORS,
  PUBLIC_COMPONENT_PLUGIN,
  isPublicComponentFingerprint,
  RETIRED_PUBLIC_COMPONENT_FINGERPRINT,
} from '../../../../plugins'
import { PublicComponentsContext } from './publicComponents'
import { DeclarativeContent, RegisteredContent } from './Declarative'
import type { DraftBuffer } from './drafts'
import { retainDraft, releaseDraft, waitForDraft, type DraftReceipt } from './drafts'
import { OPENUI_SLOT } from '../../../../../../../packages/ui/document'
import type { PublicComponentProps } from '../../contracts/components'
import { CANVAS_REVISION, CANVAS_SLOT } from '../../../../../../../packages/ui/canvas'
import { CanvasMount, useCanvasLocation } from '../../features/canvas/Scope'
import { CanvasPreview } from '../primitive/Preview'
import { writeClipboard, writeClipboardImage } from '../primitive/clipboard'
import {
  Alert,
  AlertDescription,
  Button,
  renderLegacyChartSVG,
  prepareChartExport,
  rasterizeChartSVG,
  validateLegacyChartExport,
} from '../ui'

export function ComponentFrame({
  mount,
  component,
  data,
  status,
  onAction,
  onRequest,
  draft = {},
  onDraft,
  onCopy,
  revision = 0,
  readOnly = false,
  fillWorkbench = false,
  onReload,
}: {
  mount: PluginMount
  component: PluginComponent
  data: Record<string, unknown>
  status: string
  onAction: (action: string, values: Record<string, unknown>) => void
  onRequest?: PluginRequestHandler
  draft?: Record<string, unknown>
  onDraft?: (values: Record<string, unknown>) => Promise<unknown>
  onCopy?: (content: PluginCopyContent, revision: number) => Promise<unknown>
  revision?: number
  readOnly?: boolean
  fillWorkbench?: boolean
  onReload?: () => void
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const { t, i18n } = useTranslation('skills')
  const { t: plotText } = useTranslation('conversation')
  const { t: chartText } = useTranslation('ui')
  const exportLabels = useRef({ sources: '', version: '', frequency: '' })
  exportLabels.current = {
    sources: plotText('plot.sources'),
    version: plotText('plot.version'),
    frequency: chartText('chart.frequency'),
  }
  const [revoked, setRevoked] = useState(false)
  const [height, setHeight] = useState(PLUGIN_FRAME_HEIGHT)
  const [attempt, retry] = useState(0)
  const [failure, setFailure] = useState<'load' | 'mount' | 'resource' | 'script'>()
  const binding = mount.frames[component.id]
  const gesture = useMemo(() => createComponentGesture(), [binding.lease, attempt])
  const serializedData = JSON.stringify(data)
  const scope = useMemo(
    () => JSON.parse(serializedData) as Record<string, unknown>,
    [serializedData]
  )
  const latest = useRef({
    data: scope,
    status,
    onAction,
    onRequest,
    draft,
    onDraft,
    onCopy,
    revision,
    readOnly,
  })
  latest.current = {
    data: scope,
    status,
    onAction,
    onRequest,
    draft,
    onDraft,
    onCopy,
    revision,
    readOnly,
  }
  const published = useRef<string | null>(null)
  const publish = useCallback(
    (force = false): void => {
      const target = frame.current?.contentWindow
      if (!target) return
      const message = {
        channel: PLUGIN_MESSAGE_CHANNEL,
        lease: binding.lease,
        state: {
          revision: latest.current.revision,
          data: latest.current.data,
          draft: latest.current.draft,
          status: latest.current.status,
          language: i18n.language,
          slot: component.slot,
          theme:
            document.documentElement.classList.contains('dark') ||
            document.documentElement.dataset.theme === 'dark'
              ? 'dark'
              : 'light',
        },
      }
      const serialized = JSON.stringify(message)
      if (!force && published.current === serialized) return
      target.postMessage(message, '*')
      published.current = serialized
    },
    [binding.lease, component.slot, i18n.language]
  )
  useEffect(() => {
    publish()
  }, [data, draft, status, revision, publish])
  useEffect(() => {
    const observer = new MutationObserver(() => publish())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [publish])
  useLayoutEffect(() => {
    let active = true
    setRevoked(false)
    setFailure(undefined)
    setHeight(PLUGIN_FRAME_HEIGHT)
    // Startup belongs to this iframe document; receipt updates keep the same document.
    let documentLoaded = false
    let failed = false
    const fail = (reason: NonNullable<typeof failure>): void => {
      if (failed) return
      failed = true
      window.clearTimeout(startup)
      setFailure(reason)
      console.warn('[plugin-frame]', { component: component.id, reason })
    }
    const startup = window.setTimeout(
      () => fail(documentLoaded ? 'mount' : 'load'),
      PLUGIN_FRAME_START_TIMEOUT_MS
    )
    let sequence = 0
    const pending = new Set<string>()
    const completed = new Set<string>()
    const unsubscribe = window.scholarseed.onPluginRevoked((lease) => {
      if (lease !== binding.lease) return
      active = false
      setRevoked(true)
    })
    const receive = (event: MessageEvent): void => {
      if (!active || failed || event.source !== frame.current?.contentWindow) return
      const signal = event.data
      if (signal?.channel === PLUGIN_MESSAGE_CHANNEL && signal.lease === binding.lease) {
        if (signal.phase === PLUGIN_FRAME_PHASES.document) {
          documentLoaded = true
          return
        }
        if (signal.phase === PLUGIN_FRAME_PHASES.ready) {
          window.clearTimeout(startup)
          return
        }
        if (
          signal.phase === PLUGIN_FRAME_PHASES.resource ||
          signal.phase === PLUGIN_FRAME_PHASES.script
        ) {
          fail(signal.phase)
          return
        }
      }
      if (gesture.receive(event.data, binding.lease, latest.current.revision)) return
      const exporting = componentPlotExport(event.data, binding.lease)
      if (exporting) {
        if (pending.has(exporting.requestId) || completed.has(exporting.requestId)) return
        const reply = (payload: Record<string, unknown>): void => {
          if (active)
            frame.current?.contentWindow?.postMessage(
              {
                channel: PLUGIN_MESSAGE_CHANNEL,
                lease: binding.lease,
                requestId: exporting.requestId,
                ...payload,
              },
              '*'
            )
        }
        if (pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS) {
          reply({ error: PLUGIN_RPC_ERRORS.requestLimit })
          return
        }
        if (latest.current.readOnly) {
          reply({ error: PLUGIN_RPC_ERRORS.readOnly })
          return
        }
        const clicked = gesture.consume(exporting.revision)
        if (exporting.revision !== latest.current.revision || !clicked) {
          reply({ error: PLUGIN_RPC_ERRORS.plotGestureRequired })
          return
        }
        const owner = latest.current.data
        const current = (): boolean =>
          active &&
          !latest.current.readOnly &&
          latest.current.data === owner &&
          latest.current.revision === exporting.revision
        pending.add(exporting.requestId)
        void window.scholarseed
          .deviceSkills({ operation: 'plugin-valid', lease: binding.lease })
          .then(async (response) => {
            if (response.status !== 200 || !current()) throw new Error('plugin_instance_revoked')
            const plot = exporting.plot
            const svg =
              prepareChartExport(plot) ??
              (!exporting.copy && validateLegacyChartExport(plot)
                ? renderLegacyChartSVG(
                    {
                      model: plot.model,
                      width: plot.width,
                      height: plot.height,
                      title: plot.title,
                    },
                    getComputedStyle(frame.current!),
                    exportLabels.current
                  )
                : null)
            if (!svg) throw new Error('plot_export_invalid')
            if (!current()) throw new Error('plugin_instance_revoked')
            if (exporting.copy) {
              const png = await rasterizeChartSVG(svg)
              if (!current()) throw new Error('plugin_instance_revoked')
              await writeClipboardImage(png)
              reply({ result: { ok: true } })
              return
            }
            const result = await window.scholarseed.saveFileCopy({
              suggestedName: 'chart.svg',
              bytes: new TextEncoder().encode(svg),
            })
            reply({
              result: {
                ok: result.ok,
                canceled: result.canceled,
                ...(result.ok || result.canceled
                  ? {}
                  : { error: PLUGIN_RPC_ERRORS.plotSaveFailed }),
              },
            })
          })
          .catch((error) =>
            reply({ error: error instanceof Error ? error.message : PLUGIN_RPC_ERRORS.plotFailed })
          )
          .finally(() => {
            pending.delete(exporting.requestId)
            completed.add(exporting.requestId)
          })
        return
      }
      const copyText = componentCopyText(event.data, binding.lease)
      if (copyText) {
        if (pending.has(copyText.requestId) || completed.has(copyText.requestId)) return
        const reply = (payload: Record<string, unknown>): void => {
          if (active)
            frame.current?.contentWindow?.postMessage(
              {
                channel: PLUGIN_MESSAGE_CHANNEL,
                lease: binding.lease,
                requestId: copyText.requestId,
                ...payload,
              },
              '*'
            )
        }
        if (pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS) {
          reply({ error: PLUGIN_RPC_ERRORS.requestLimit })
          return
        }
        if (latest.current.readOnly || copyText.revision !== latest.current.revision) {
          gesture.consume(copyText.revision)
          reply({ error: PLUGIN_RPC_ERRORS.copyUnavailable })
          return
        }
        if (!gesture.consume(copyText.revision)) {
          reply({ error: PLUGIN_RPC_ERRORS.copyGestureRequired })
          return
        }
        const owner = latest.current.data
        const current = (): boolean =>
          active &&
          !latest.current.readOnly &&
          latest.current.data === owner &&
          latest.current.revision === copyText.revision
        pending.add(copyText.requestId)
        void window.scholarseed
          .deviceSkills({
            operation: 'plugin-valid',
            lease: binding.lease,
          })
          .then(async (response) => {
            if (response.status !== 200 || !current()) throw new Error('plugin_instance_revoked')
            await writeClipboard(copyText.text)
            reply({ result: { copied: true } })
          })
          .catch((error) =>
            reply({
              error: error instanceof Error ? error.message : PLUGIN_RPC_ERRORS.copyFailed,
            })
          )
          .finally(() => {
            pending.delete(copyText.requestId)
            completed.add(copyText.requestId)
          })
        return
      }
      const copy = componentCopy(event.data, binding.lease)
      if (copy) {
        const diagnostic = (stage: string, detail: Record<string, unknown> = {}): void => {
          console.info(
            '[plugin-copy]',
            JSON.stringify({ stage, component: component.id, requestId: copy.requestId, ...detail })
          )
        }
        if (pending.has(copy.requestId) || completed.has(copy.requestId)) {
          diagnostic('duplicate', {
            pending: pending.has(copy.requestId),
            completed: completed.has(copy.requestId),
          })
          return
        }
        const reply = (payload: Record<string, unknown>): void => {
          if (active)
            frame.current?.contentWindow?.postMessage(
              {
                channel: PLUGIN_MESSAGE_CHANNEL,
                lease: binding.lease,
                requestId: copy.requestId,
                ...payload,
              },
              '*'
            )
        }
        if (latest.current.readOnly && copy.revision === latest.current.revision) {
          // Archived bundles still register copy text on render. The receipt already owns it.
          reply({ result: { revision: copy.revision } })
          return
        }
        if (!latest.current.onCopy || copy.revision !== latest.current.revision) {
          diagnostic('rejected', { revisionMatches: copy.revision === latest.current.revision })
          reply({ error: PLUGIN_RPC_ERRORS.copyUnavailable })
          return
        }
        if (pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS) {
          reply({ error: PLUGIN_RPC_ERRORS.requestLimit })
          return
        }
        const owner = latest.current.data
        diagnostic('received')
        pending.add(copy.requestId)
        void window.scholarseed
          .deviceSkills({ operation: 'plugin-valid', lease: binding.lease })
          .then(async (response) => {
            diagnostic('validated', {
              httpStatus: response.status,
              active,
              dataCurrent: latest.current.data === owner,
              revisionCurrent: latest.current.revision === copy.revision,
            })
            if (
              !active ||
              latest.current.readOnly ||
              response.status !== 200 ||
              latest.current.data !== owner ||
              latest.current.revision !== copy.revision
            )
              throw new Error('plugin_instance_revoked')
            return latest.current.onCopy!(copy.content, copy.revision)
          })
          .then((result) => {
            diagnostic('saved', { replyActive: active })
            reply({ result })
          })
          .catch((error) => {
            diagnostic('failed', {
              reason: error instanceof Error ? error.message : PLUGIN_RPC_ERRORS.copyFailed,
            })
            reply({ error: PLUGIN_RPC_ERRORS.copyFailed })
          })
          .finally(() => {
            pending.delete(copy.requestId)
            completed.add(copy.requestId)
          })
        return
      }
      const requestedHeight = componentHeight(event.data, binding.lease)
      if (requestedHeight !== null) {
        setHeight(requestedHeight)
        return
      }
      const save = componentDraft(event.data, binding.lease)
      if (save) {
        if (pending.has(save.requestId) || completed.has(save.requestId)) return
        const reply = (payload: Record<string, unknown>): void => {
          if (active)
            frame.current?.contentWindow?.postMessage(
              {
                channel: PLUGIN_MESSAGE_CHANNEL,
                lease: binding.lease,
                requestId: save.requestId,
                ...payload,
              },
              '*'
            )
        }
        if (
          latest.current.readOnly ||
          !latest.current.onDraft ||
          latest.current.status !== 'pending'
        ) {
          reply({ error: PLUGIN_RPC_ERRORS.draftUnavailable })
          return
        }
        if (pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS) {
          reply({ error: PLUGIN_RPC_ERRORS.requestLimit })
          return
        }
        pending.add(save.requestId)
        void latest.current
          .onDraft(save.values)
          .then((result) => reply({ result }))
          .catch((error) =>
            reply({ error: error instanceof Error ? error.message : PLUGIN_RPC_ERRORS.draftFailed })
          )
          .finally(() => {
            pending.delete(save.requestId)
            completed.add(save.requestId)
          })
        return
      }
      const request = componentRequest(event.data, binding.lease, component)
      if (request) {
        const handler = latest.current.onRequest
        const requestData = latest.current.data
        const reply = (payload: Record<string, unknown>): void => {
          if (active)
            frame.current?.contentWindow?.postMessage(
              {
                channel: PLUGIN_MESSAGE_CHANNEL,
                lease: binding.lease,
                requestId: request.requestId,
                ...payload,
              },
              '*'
            )
        }
        if (latest.current.readOnly || !handler) {
          reply({ error: PLUGIN_RPC_ERRORS.readOnly })
          return
        }
        if (pending.has(request.requestId) || completed.has(request.requestId)) return
        if (pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS) {
          reply({ error: PLUGIN_RPC_ERRORS.requestLimit })
          return
        }
        const capability = component.actions.find(
          (action) => action.id === request.action
        )!.capability
        if (!mount.descriptor.capabilities.includes(capability)) {
          reply({ error: PLUGIN_RPC_ERRORS.capabilityUndeclared })
          return
        }
        pending.add(request.requestId)
        console.info('[plugin-request]', {
          stage: 'received',
          component: component.id,
          action: request.action,
          requestId: request.requestId,
        })
        const authorize = async (): Promise<void> => {
          const response = await window.scholarseed.deviceSkills({
            operation: 'plugin-valid',
            lease: binding.lease,
          })
          console.info('[plugin-request]', {
            stage: 'authorized',
            component: component.id,
            action: request.action,
            active,
            status: response.status,
            sameScope: latest.current.data === requestData,
          })
          if (!active || response.status !== 200) throw new Error('plugin_instance_revoked')
          if (latest.current.readOnly) throw new Error(PLUGIN_RPC_ERRORS.readOnly)
          if (latest.current.data !== requestData) throw new Error('plugin_card_scope_changed')
        }
        void authorize()
          .then(async () => {
            const result = await handler(request.action, request.values, capability, authorize)
            await authorize()
            console.info('[plugin-request]', {
              stage: 'completed',
              component: component.id,
              action: request.action,
              requestId: request.requestId,
            })
            reply({ result })
          })
          .catch((error) => {
            console.info('[plugin-request]', {
              stage: 'failed',
              component: component.id,
              action: request.action,
              requestId: request.requestId,
              code: pluginErrorCode(error),
            })
            reply({
              error: error instanceof Error ? error.message : PLUGIN_RPC_ERRORS.requestFailed,
              code: pluginErrorCode(error),
            })
          })
          .finally(() => {
            pending.delete(request.requestId)
            completed.add(request.requestId)
          })
        return
      }
      const unsupported = componentRPC(event.data, binding.lease)
      if (unsupported) {
        if (pending.has(unsupported.requestId) || completed.has(unsupported.requestId)) return
        const limited =
          pending.size >= PLUGIN_MAX_PENDING_REQUESTS || completed.size >= PLUGIN_MAX_REQUESTS
        if (!limited) completed.add(unsupported.requestId)
        frame.current?.contentWindow?.postMessage(
          {
            channel: PLUGIN_MESSAGE_CHANNEL,
            lease: binding.lease,
            requestId: unsupported.requestId,
            error: limited
              ? PLUGIN_RPC_ERRORS.requestLimit
              : request
                ? PLUGIN_RPC_ERRORS.requestFailed
                : PLUGIN_RPC_ERRORS.capabilityUndeclared,
          },
          '*'
        )
        return
      }
      if (latest.current.readOnly || latest.current.status !== 'pending') return
      const action = componentAction(event.data, binding.lease, component)
      if (!action) return
      const submission = ++sequence
      const diagnostic = (stage: string, detail: Record<string, unknown> = {}): void => {
        console.info(
          '[plugin-submit]',
          JSON.stringify({
            stage,
            lease: binding.lease,
            component: component.id,
            action: action.action,
            submission,
            ...detail,
          })
        )
      }
      diagnostic('received')
      void window.scholarseed
        .deviceSkills({ operation: 'plugin-valid', lease: binding.lease })
        .then((response) => {
          diagnostic('authorized', {
            httpStatus: response.status,
            active,
            current: sequence === submission,
            status: latest.current.status,
          })
          if (
            active &&
            sequence === submission &&
            response.status === 200 &&
            !latest.current.readOnly &&
            latest.current.status === 'pending'
          ) {
            diagnostic('dispatched')
            latest.current.onAction(action.action, action.values)
          }
        })
        .catch((error) => {
          diagnostic('failed', { code: pluginErrorCode(error) })
          throw error
        })
    }
    window.addEventListener('message', receive)
    return () => {
      active = false
      window.clearTimeout(startup)
      unsubscribe()
      window.removeEventListener('message', receive)
    }
  }, [binding.lease, binding.url, component, gesture, mount.descriptor.capabilities])
  if (revoked) return <p role="alert">{t('plugin.unavailable')}</p>
  if (failure) {
    const messages = {
      load: t('plugin.frameFailure.load'),
      mount: t('plugin.frameFailure.mount'),
      resource: t('plugin.frameFailure.resource'),
      script: t('plugin.frameFailure.script'),
    }
    return (
      <Alert tone="error">
        <AlertDescription>{messages[failure]}</AlertDescription>
        <Button variant="secondary" onClick={onReload ?? (() => retry((current) => current + 1))}>
          {t('retry')}
        </Button>
      </Alert>
    )
  }
  return (
    <iframe
      key={attempt}
      ref={frame}
      src={binding.url}
      title={`${mount.descriptor.id}: ${component.id}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      height={height}
      className={
        fillWorkbench
          ? 'block h-full w-full border-0 bg-transparent'
          : 'block w-full border-0 bg-transparent'
      }
      onLoad={() => publish(true)}
    />
  )
}

export function PluginInteraction(
  props: React.ComponentProps<typeof PluginInteractionContent>
): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const { t: tSkill } = useTranslation('skills')
  const { reference } = props
  if (!reference.binding) return <PluginInteractionContent {...props} />
  if (reference.component === CANVAS_SLOT)
    return (
      <CanvasMount id={reference.binding} title={t('canvas.title')}>
        <PluginInteractionContent {...props} />
      </CanvasMount>
    )
  if (reference.workbench === true) {
    const title =
      typeof props.data.title === 'string' && props.data.title.trim()
        ? props.data.title.trim()
        : reference.plugin
    return (
      <CanvasMount
        id={reference.binding}
        title={title}
        renderInline={(location, content) => (
          <CanvasPreview
            title={title}
            onOpen={location?.open}
            onReturn={location?.full ? location.close : undefined}
            collapseOnOpen
            expandLabel={tSkill('plugin.expandPreview')}
            collapseLabel={tSkill('plugin.collapsePreview')}
            fitContent
            testId="conversation-plugin-preview"
          >
            {content}
          </CanvasPreview>
        )}
      >
        <WorkbenchPlugin {...props} />
      </CanvasMount>
    )
  }
  return <PluginInteractionContent {...props} />
}

function WorkbenchPlugin(
  props: React.ComponentProps<typeof PluginInteractionContent>
): React.JSX.Element {
  const { full } = useCanvasLocation()
  return <PluginInteractionContent {...props} fillWorkbench={full} />
}

function PluginInteractionContent({
  reference,
  data,
  status,
  onAction,
  onRequest,
  previewMount,
  onRestore,
  supplement,
  prepareDraft,
  submittedValues,
  fillWorkbench,
  contentRevision = 0,
  renderContainer,
  renderHosted,
  hostedPrivateSlot,
}: {
  reference: PluginReference
  data: Record<string, unknown>
  status: string
  onAction: (
    action: string,
    values: Record<string, unknown>,
    contentRevision?: number
  ) => void | Promise<void>
  onRequest?: PluginRequestHandler
  previewMount?: PluginMount
  onRestore?: (values: Record<string, unknown>) => void
  supplement?: (save: (values: Record<string, unknown>) => Promise<unknown>) => React.ReactNode
  prepareDraft?: (values: Record<string, unknown>) => Record<string, unknown>
  submittedValues?: Record<string, unknown>
  fillWorkbench?: boolean
  contentRevision?: number
  renderContainer?: (content: React.ReactNode, component?: PluginComponent) => React.ReactNode
  renderHosted?: (props: PublicComponentProps) => React.ReactNode
  hostedPrivateSlot?: string
}): React.JSX.Element {
  const publicComponents = useContext(PublicComponentsContext)
  const canvas = reference.component === CANVAS_SLOT && reference.fingerprint === CANVAS_REVISION
  const isPublic =
    reference.plugin === PUBLIC_COMPONENT_PLUGIN &&
    (isPublicComponentFingerprint(reference.fingerprint) || canvas)
  const publicComponent = isPublic ? publicComponents.get(reference.component) : undefined
  const unsupported =
    reference.plugin === PUBLIC_COMPONENT_PLUGIN &&
    reference.fingerprint === RETIRED_PUBLIC_COMPONENT_FINGERPRINT
  const { plugin: pluginId, component: componentId, fingerprint, binding: bindingId } = reference
  const { t } = useTranslation('skills')
  const [mount, setMount] = useState<PluginMount | null>(null)
  const [failed, setFailed] = useState(false)
  const [mountAttempt, setMountAttempt] = useState(0)
  const reopen = (): void => setMountAttempt((current) => current + 1)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const savedDraft = useRef<Record<string, unknown>>({})
  const draftRevision = useRef(0)
  const draftQueue = useRef(Promise.resolve())
  const generation = useRef(0)
  const [draftFailed, setDraftFailed] = useState(false)
  const buffer = useRef<DraftBuffer | null>(null)
  const draftKey = JSON.stringify([pluginId, componentId, fingerprint, bindingId])
  const submitting = useRef(false)
  const [persisting, setPersisting] = useState(false)
  const publicScope = JSON.stringify([reference, data])
  const currentPublicScope = useRef(publicScope)
  currentPublicScope.current = publicScope
  const handlers = useRef({ onAction, onRestore })
  handlers.current = { onAction, onRestore }
  useLayoutEffect(() => {
    const lifecycle = generation
    ++lifecycle.current
    draftQueue.current = Promise.resolve()
    buffer.current = null
    setDraftFailed(false)
    if (unsupported || previewMount || (isPublic && !bindingId)) return
    setMount(null)
    setFailed(false)
    let current = true
    let leases: string[] = []
    let retained: DraftBuffer | undefined
    let unsubscribe: (() => void) | undefined
    const release = (): void => {
      if (leases.length)
        void window.scholarseed.deviceSkills({ operation: 'plugin-release', leases })
      leases = []
    }
    void waitForDraft(draftKey)
      .then(() =>
        window.scholarseed.deviceSkills({
          operation: 'plugin-open',
          reference: {
            plugin: pluginId,
            component: componentId,
            fingerprint,
            ...(bindingId ? { binding: bindingId } : {}),
          },
        })
      )
      .then((response) => {
        if (response.status >= 400) throw new Error('plugin_unavailable')
        const next = JSON.parse(response.body) as PluginMount
        if (
          !current ||
          next.fingerprint !== fingerprint ||
          (!isPublic &&
            !next.frames[componentId] &&
            !next.descriptor.components.some(
              (candidate) => candidate.id === componentId && candidate.openui
            ))
        ) {
          void window.scholarseed.deviceSkills({
            operation: 'plugin-release',
            leases: Object.values(next.frames).map((frame) => frame.lease),
          })
          if (current) setFailed(true)
          return
        }
        leases = Object.values(next.frames).map((frame) => frame.lease)
        if (isPublic && bindingId && next.interaction) {
          retained = retainDraft(
            draftKey,
            next.interaction,
            next.interaction.status !== PUBLIC_COMPONENT_PENDING
          )
          buffer.current = retained
          const currentDraft = retained
          const refresh = (): void => {
            setDraft(currentDraft.state)
            savedDraft.current = currentDraft.state
            draftRevision.current = currentDraft.revision
            setDraftFailed(currentDraft.failed)
          }
          unsubscribe = currentDraft.subscribe(refresh)
          refresh()
        } else {
          setDraft(next.interaction?.state ?? {})
          savedDraft.current = next.interaction?.state ?? {}
          draftRevision.current = next.interaction?.revision ?? 0
        }
        if (Object.keys(savedDraft.current).length) handlers.current.onRestore?.(savedDraft.current)
        setMount(next)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
      ++lifecycle.current
      unsubscribe?.()
      if (retained) void releaseDraft(draftKey, retained)
      release()
    }
  }, [
    pluginId,
    fingerprint,
    componentId,
    bindingId,
    previewMount,
    isPublic,
    unsupported,
    draftKey,
    mountAttempt,
  ])
  const activeMount = previewMount ?? mount
  const nativeRevision = Math.max(contentRevision, activeMount?.interaction?.content_revision ?? 0)
  const nativeData =
    componentId === OPENUI_SLOT &&
    activeMount?.interaction &&
    (activeMount.interaction.content_revision ?? 0) > contentRevision
      ? { document: activeMount.interaction.data }
      : data
  const component = activeMount?.descriptor.components.find(
    (candidate) => candidate.id === reference.component
  )
  const present = (content: React.JSX.Element): React.JSX.Element =>
    renderContainer ? <>{renderContainer(content, component)}</> : content
  const contribution =
    publicComponent ??
    (component?.public && component.slot ? publicComponents.get(component.slot) : undefined)
  const hostedPrivate =
    Boolean(bindingId && hostedPrivateSlot && component?.slot === hostedPrivateSlot) &&
    !isPublic &&
    Boolean(activeMount?.frames[componentId]?.lease)
  const hostedRenderer =
    hostedPrivate ||
    (reference.plugin === PUBLIC_COMPONENT_PLUGIN &&
      component?.public &&
      component.slot === reference.component)
      ? renderHosted
      : undefined
  const hosted = Boolean(hostedRenderer) || contribution?.hosted === true
  const hostedLease = hosted ? activeMount?.frames[componentId]?.lease : undefined
  useEffect(() => {
    if (!hostedLease) return
    return window.scholarseed.onPluginRevoked((lease) => {
      if (lease === hostedLease) {
        ++generation.current
        setFailed(true)
      }
    })
  }, [hostedLease])
  if (unsupported) return <p role="alert">{t('plugin.unavailable')}</p>
  if (failed)
    return (
      <Alert tone="error">
        <AlertDescription>{t('plugin.unavailable')}</AlertDescription>
        <Button variant="secondary" onClick={reopen}>
          {t('retry')}
        </Button>
      </Alert>
    )
  const saveDraft = (input: Record<string, unknown>, merge = false): Promise<unknown> => {
    if (buffer.current && activeMount?.interaction) {
      const sessionId = activeMount.interaction.session_id
      const values = merge ? { ...buffer.current.state, ...input } : input
      return buffer.current.save(
        values,
        async (state, revision) => {
          const response = await window.scholarseed.deviceSkills({
            operation: 'plugin-draft',
            reference,
            session_id: sessionId,
            values: state,
            expected_revision: revision,
          })
          if (response.status >= 400) throw new Error(PLUGIN_RPC_ERRORS.draftFailed)
          return JSON.parse(response.body) as DraftReceipt
        },
        async () => {
          const response = await window.scholarseed.deviceSkills({
            operation: 'plugin-open',
            reference,
          })
          if (response.status >= 400) throw new Error(PLUGIN_RPC_ERRORS.draftFailed)
          const refreshed = JSON.parse(response.body) as PluginMount
          if (!refreshed.interaction) throw new Error(PLUGIN_RPC_ERRORS.draftFailed)
          return refreshed.interaction
        }
      )
    }
    const owner = generation.current
    const operation = draftQueue.current.then(async () => {
      if (owner !== generation.current) throw new Error('plugin_instance_revoked')
      const values = merge ? { ...savedDraft.current, ...input } : input
      if (previewMount) {
        savedDraft.current = values
        setDraft(values)
        return { state: values, revision: ++draftRevision.current }
      }
      if (!reference.binding || !activeMount?.interaction)
        throw new Error(PLUGIN_RPC_ERRORS.draftUnavailable)
      const response = await window.scholarseed.deviceSkills({
        operation: 'plugin-draft',
        reference,
        session_id: activeMount.interaction.session_id,
        values,
        expected_revision: draftRevision.current,
      })
      if (response.status >= 400) throw new Error(PLUGIN_RPC_ERRORS.draftFailed)
      const next = JSON.parse(response.body) as { state: Record<string, unknown>; revision: number }
      if (owner !== generation.current) throw new Error('plugin_instance_revoked')
      setDraft(next.state)
      savedDraft.current = next.state
      setDraftFailed(false)
      draftRevision.current = next.revision
      return next
    })
    draftQueue.current = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  const dispatch = (action: string, values: Record<string, unknown>): void | Promise<void> => {
    if (submitting.current) return
    if (componentId === CANVAS_SLOT)
      return handlers.current.onAction(action, values, nativeRevision)
    if (action === 'cancel') {
      onAction(action, values, nativeRevision)
      return
    }
    if (!reference.binding || (!onRestore && componentId !== OPENUI_SLOT)) {
      onAction(action, values, nativeRevision)
      return
    }
    submitting.current = true
    setPersisting(true)
    const commit = handlers.current.onAction
    void Promise.resolve()
      .then(() => saveDraft(prepareDraft?.(values) ?? values, true))
      .then(() => commit(action, values, nativeRevision))
      .catch(() => setDraftFailed(true))
      .finally(() => {
        submitting.current = false
        setPersisting(false)
      })
  }
  const additional = supplement?.((values) =>
    saveDraft(values, true).catch((error) => {
      setDraftFailed(true)
      throw error
    })
  )
  if (hosted || (isPublic && !activeMount?.frames[componentId])) {
    if (reference.binding && !activeMount) return <p>{t('plugin.loading')}</p>
    const request: PluginRequestHandler | undefined = onRequest
      ? async (action, values, capability) => {
          const owner = generation.current
          const authorize = async (): Promise<void> => {
            if (owner !== generation.current || currentPublicScope.current !== publicScope)
              throw new Error('plugin_card_scope_changed')
            if (hostedLease) {
              if (
                !component?.actions.some(
                  (entry) => entry.id === action && entry.capability === capability
                ) ||
                !activeMount?.descriptor.capabilities.includes(capability)
              )
                throw new Error('plugin_capability_undeclared')
              if (!previewMount) {
                const response = await window.scholarseed.deviceSkills({
                  operation: 'plugin-valid',
                  lease: hostedLease,
                })
                if (response.status !== 200) throw new Error('plugin_instance_revoked')
              }
              if (owner !== generation.current || currentPublicScope.current !== publicScope)
                throw new Error('plugin_card_scope_changed')
              return
            }
            if (previewMount || !reference.binding) return
            const response = await window.scholarseed.deviceSkills({
              operation: 'plugin-open',
              reference,
            })
            if (response.status >= 400) throw new Error('plugin_instance_revoked')
          }
          await authorize()
          const result = await onRequest(action, values, capability, authorize)
          if (hosted) await authorize()
          return result
        }
      : undefined
    return hostedRenderer ||
      componentId === OPENUI_SLOT ||
      (contribution && (!contribution.legacyOnly || bindingId)) ? (
      present(
        <>
          {draftFailed && status === PUBLIC_COMPONENT_PENDING && (
            <p role="alert">{t('plugin.draftFailed')}</p>
          )}
          <React.Fragment key={hosted ? publicScope : undefined}>
            {hostedRenderer ? (
              hostedRenderer({
                slot: contribution?.slot ?? reference.component,
                data: { ...nativeData, ...draft },
                status: persisting ? 'submitting' : status,
                onAction: dispatch,
                onRequest: request,
              })
            ) : (
              <RegisteredContent
                {...{
                  slot: contribution?.slot ?? reference.component,
                  data: nativeData,
                  draft,
                  status: persisting ? 'submitting' : status,
                  onAction: dispatch,
                  onRequest: request,
                  onDraft: async (values: Record<string, unknown>) => {
                    try {
                      return await saveDraft(values)
                    } catch (error) {
                      setDraftFailed(true)
                      throw error
                    }
                  },
                }}
              />
            )}
          </React.Fragment>
          {additional}
        </>
      )
    ) : (
      <p role="alert">{t('plugin.unavailable')}</p>
    )
  }
  if (!activeMount || !component) return <p>{t('plugin.loading')}</p>
  if (component.openui)
    return present(
      <DeclarativeContent data={activeMount.interaction?.data ?? data} layout={component.openui} />
    )
  const request: PluginRequestHandler =
    onRequest ??
    (async (action, values, _capability, authorize) => {
      if (previewMount) throw new Error('plugin_preview_response_missing')
      await authorize()
      const response = await window.scholarseed.deviceSkills({
        operation: 'plugin-call',
        reference,
        action,
        values,
      })
      if (response.status >= 400) throw new Error('plugin_action_failed')
      return JSON.parse(response.body)
    })
  const frameData = submittedValues !== undefined ? (activeMount.interaction?.data ?? data) : data
  return present(
    <>
      {draftFailed && <p role="alert">{t('plugin.draftFailed')}</p>}
      <ComponentFrame
        mount={activeMount}
        component={component}
        data={component.public ? { ...frameData, ...draft } : frameData}
        draft={submittedValues ?? draft}
        readOnly={submittedValues !== undefined}
        fillWorkbench={fillWorkbench}
        onReload={previewMount ? undefined : reopen}
        status={status}
        onAction={dispatch}
        onRequest={submittedValues ? undefined : request}
        onDraft={submittedValues ? undefined : saveDraft}
        revision={draftRevision.current}
        onCopy={
          submittedValues
            ? undefined
            : async (content, revision) => {
                const owner = generation.current
                if (revision !== draftRevision.current) throw new Error('plugin_card_scope_changed')
                if (previewMount) {
                  return { content, revision }
                }
                if (!activeMount.interaction) throw new Error('plugin_copy_unavailable')
                const response = await window.scholarseed.deviceSkills({
                  operation: 'plugin-copy',
                  reference,
                  session_id: activeMount.interaction.session_id,
                  content,
                  expected_revision: revision,
                })
                if (response.status >= 400 || generation.current !== owner)
                  throw new Error('plugin_copy_failed')
                window.dispatchEvent(new Event(ANSWER_SOURCES_CHANGED_EVENT))
                return JSON.parse(response.body)
              }
        }
      />
      {additional}
    </>
  )
}
