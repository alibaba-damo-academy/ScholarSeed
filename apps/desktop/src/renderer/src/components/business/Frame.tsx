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
import {
  componentAction,
  componentCopy,
  componentDraft,
  componentHeight,
  componentRequest,
  PLUGIN_FRAME_HEIGHT,
  PLUGIN_MAX_PENDING_REQUESTS,
  PLUGIN_MAX_REQUESTS,
  PLUGIN_MESSAGE_CHANNEL,
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
  PUBLIC_COMPONENT_FINGERPRINT,
} from '../../../../plugins'
import { PublicComponentsContext } from './publicComponents'

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
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const { t, i18n } = useTranslation('skills')
  const [revoked, setRevoked] = useState(false)
  const [height, setHeight] = useState(PLUGIN_FRAME_HEIGHT)
  const binding = mount.frames[component.id]
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
  })
  latest.current = { data: scope, status, onAction, onRequest, draft, onDraft, onCopy, revision }
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
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
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
  useLayoutEffect(() => {
    let active = true
    setRevoked(false)
    let sequence = 0
    const pending = new Set<string>()
    const completed = new Set<string>()
    const unsubscribe = window.scholarseed.onPluginRevoked((lease) => {
      if (lease !== binding.lease) return
      active = false
      setRevoked(true)
    })
    const receive = (event: MessageEvent): void => {
      if (!active || event.source !== frame.current?.contentWindow) return
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
        if (!latest.current.onDraft || latest.current.status !== 'pending') {
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
      if (request && latest.current.onRequest) {
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
      if (latest.current.status !== 'pending') return
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
      unsubscribe()
      window.removeEventListener('message', receive)
    }
  }, [binding.lease, component, mount.descriptor.capabilities])
  if (revoked) return <p role="alert">{t('plugin.unavailable')}</p>
  return (
    <iframe
      ref={frame}
      src={binding.url}
      title={`${mount.descriptor.id}: ${component.id}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      height={height}
      className="w-full border-0"
      onLoad={() => publish(true)}
    />
  )
}

export function PluginInteraction({
  reference,
  data,
  status,
  onAction,
  onRequest,
  previewMount,
  onRestore,
  supplement,
  prepareDraft,
}: {
  reference: PluginReference
  data: Record<string, unknown>
  status: string
  onAction: (action: string, values: Record<string, unknown>) => void
  onRequest?: PluginRequestHandler
  previewMount?: PluginMount
  onRestore?: (values: Record<string, unknown>) => void
  supplement?: (save: (values: Record<string, unknown>) => Promise<unknown>) => React.ReactNode
  prepareDraft?: (values: Record<string, unknown>) => Record<string, unknown>
}): React.JSX.Element {
  const publicComponents = useContext(PublicComponentsContext)
  const publicComponent =
    reference.plugin === PUBLIC_COMPONENT_PLUGIN &&
    reference.fingerprint === PUBLIC_COMPONENT_FINGERPRINT
      ? publicComponents.get(reference.component)
      : undefined
  const isPublic = reference.plugin === PUBLIC_COMPONENT_PLUGIN
  const { plugin: pluginId, component: componentId, fingerprint, binding: bindingId } = reference
  const { t } = useTranslation('skills')
  const [mount, setMount] = useState<PluginMount | null>(null)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const savedDraft = useRef<Record<string, unknown>>({})
  const draftRevision = useRef(0)
  const draftQueue = useRef(Promise.resolve())
  const generation = useRef(0)
  const [draftFailed, setDraftFailed] = useState(false)
  const publicScope = JSON.stringify([reference, data])
  const currentPublicScope = useRef(publicScope)
  currentPublicScope.current = publicScope
  const handlers = useRef({ onAction, onRestore })
  handlers.current = { onAction, onRestore }
  useEffect(() => {
    const lifecycle = generation
    ++lifecycle.current
    draftQueue.current = Promise.resolve()
    setDraftFailed(false)
    if (previewMount || (isPublic && !bindingId)) return
    setMount(null)
    setFailed(false)
    let current = true
    let leases: string[] = []
    const release = (): void => {
      if (leases.length)
        void window.scholarseed.deviceSkills({ operation: 'plugin-release', leases })
      leases = []
    }
    void window.scholarseed
      .deviceSkills({
        operation: 'plugin-open',
        reference: {
          plugin: pluginId,
          component: componentId,
          fingerprint,
          ...(bindingId ? { binding: bindingId } : {}),
        },
      })
      .then((response) => {
        if (response.status >= 400) throw new Error('plugin_unavailable')
        const next = JSON.parse(response.body) as PluginMount
        if (
          !current ||
          next.fingerprint !== fingerprint ||
          (!isPublic && !next.frames[componentId])
        ) {
          void window.scholarseed.deviceSkills({
            operation: 'plugin-release',
            leases: Object.values(next.frames).map((frame) => frame.lease),
          })
          if (current) setFailed(true)
          return
        }
        leases = Object.values(next.frames).map((frame) => frame.lease)
        setDraft(next.interaction?.state ?? {})
        savedDraft.current = next.interaction?.state ?? {}
        draftRevision.current = next.interaction?.revision ?? 0
        if (next.interaction?.state && Object.keys(next.interaction.state).length)
          handlers.current.onRestore?.(next.interaction.state)
        setMount(next)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
      ++lifecycle.current
      release()
    }
  }, [pluginId, fingerprint, componentId, bindingId, previewMount, isPublic])
  const activeMount = previewMount ?? mount
  const component = activeMount?.descriptor.components.find(
    (candidate) => candidate.id === reference.component
  )
  const contribution =
    publicComponent ??
    (component?.public && component.slot ? publicComponents.get(component.slot) : undefined)
  const hosted = contribution?.hosted === true
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
  if (failed) return <p role="alert">{t('plugin.unavailable')}</p>
  const saveDraft = (input: Record<string, unknown>, merge = false): Promise<unknown> => {
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
  const dispatch = (action: string, values: Record<string, unknown>): void => {
    if (!reference.binding || !onRestore) {
      onAction(action, values)
      return
    }
    void saveDraft(prepareDraft?.(values) ?? values, true)
      .then(() => handlers.current.onAction(action, values))
      .catch(() => setDraftFailed(true))
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
    return contribution && (!contribution.legacyOnly || bindingId) ? (
      <>
        {draftFailed && <p role="alert">{t('plugin.draftFailed')}</p>}
        <React.Fragment key={hosted ? publicScope : undefined}>
          {contribution.render({
            slot: contribution.slot,
            data: { ...data, ...draft },
            status,
            onAction: dispatch,
            onRequest: request,
          })}
        </React.Fragment>
        {additional}
      </>
    ) : (
      <p role="alert">{t('plugin.unavailable')}</p>
    )
  }
  if (!activeMount || !component) return <p>{t('plugin.loading')}</p>
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
  return (
    <>
      {draftFailed && <p role="alert">{t('plugin.draftFailed')}</p>}
      <ComponentFrame
        mount={activeMount}
        component={component}
        data={{ ...data, ...draft }}
        draft={draft}
        status={status}
        onAction={dispatch}
        onRequest={request}
        onDraft={saveDraft}
        revision={draftRevision.current}
        onCopy={async (content, revision) => {
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
          return JSON.parse(response.body)
        }}
      />
      {additional}
    </>
  )
}
