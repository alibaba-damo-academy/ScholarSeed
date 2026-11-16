import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Renderer } from '@openuidev/react-lang'
import { ThemeProvider } from '@openuidev/react-ui'
import { useTranslation } from 'react-i18next'
import { CanvasPreview } from '../../apps/desktop/src/renderer/src/components/primitive/Preview'
import { Alert, Button } from '../../apps/desktop/src/renderer/src/components/ui'
import { canvasLibrary } from './canvases'
import { CANVAS_CHANNEL, CANVAS_HANDLER_TIMEOUT_MS, canvasHtml, canvasValues, type CanvasAction, type CanvasDocument, type CanvasValues } from './canvas'
import { validateSource } from './validation'
import { OPENUI_LIMITS } from './document'
import { conversationTheme, useConversationMode } from '../../apps/desktop/src/renderer/src/design/conversation'
import '@openuidev/react-ui/components.css'

export interface CanvasProps {
  document: CanvasDocument
  title?: string
  draft?: CanvasValues
  status?: string
  full?: boolean
  onOpen?: () => void
  onDraft?: (values: CanvasValues) => Promise<unknown>
  onAction?: (action: string, values: CanvasValues) => void | Promise<void>
}

const HANDLERS: Record<CanvasAction, string> = { rollback: 'onRollback', cancel: 'onCancel', submit: 'onSubmit' }

export function Canvas({ document: description, title, draft, status = 'resolved', full = false, onOpen, onDraft, onAction }: CanvasProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const mode = useConversationMode()
  const initial = draft?.canvas_state as CanvasValues | undefined ?? description.initial_state ?? {}
  const values = useRef<CanvasValues>(structuredClone(initial))
  const history = useRef<CanvasValues[]>([])
  const bindings = useRef<Record<string, string>>({})
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(false)
  const locked = useRef(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const callbacks = useRef({ onDraft, onAction, status })
  callbacks.current = { onDraft, onAction, status }
  const queue = useRef(Promise.resolve())
  const frame = useRef<HTMLIFrameElement>(null)
  const identity = useRef(crypto.randomUUID())
  const request = useRef<{ id: string; resolve: (values: CanvasValues) => void; reject: (error: Error) => void } | null>(null)
  const html = useMemo(() => description.format === 'html' ? canvasHtml(description.source, identity.current, document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce) : '', [description.format, description.source])
  const sourceError = useMemo(() => {
    if (description.format !== 'openui-lang') return ''
    try { validateSource(description.source); return '' }
    catch (failure) { return failure instanceof Error ? failure.message : String(failure) }
  }, [description.format, description.source])
  useEffect(() => {
    setReady(false)
    setError('')
    if (description.format !== 'openui-lang' || sourceError) return
    let active = true
    const worker = new Worker(new URL('./canvas.worker.ts', import.meta.url), { type: 'module' })
    let timer = setTimeout(() => { worker.terminate(); if (active) setError('canvas_validation_timeout') }, OPENUI_LIMITS.startupMilliseconds)
    worker.onmessage = ({ data }: MessageEvent<{ ready?: boolean; valid?: boolean; error?: string; bindings?: Record<string, string>; defaults?: CanvasValues }>) => {
      if (!active) return
      if (data.ready) {
        clearTimeout(timer)
        timer = setTimeout(() => { worker.terminate(); if (active) setError('canvas_validation_timeout') }, OPENUI_LIMITS.parseMilliseconds)
        worker.postMessage({ source: description.source, schema: canvasLibrary.toJSONSchema(), root: canvasLibrary.root })
      } else {
        clearTimeout(timer)
        bindings.current = data.bindings ?? {}
        values.current = { ...data.defaults, ...values.current }
        setReady(data.valid === true)
        if (!data.valid) setError(data.error ?? 'canvas_validation_failed')
        worker.terminate()
      }
    }
    worker.onerror = () => { if (active) setError('canvas_validation_failed') }
    return () => { active = false; clearTimeout(timer); worker.terminate() }
  }, [description.format, description.source, sourceError])
  const save = (next: CanvasValues): Promise<void> => {
    values.current = structuredClone(next)
    const snapshot = structuredClone(next)
    const operation = queue.current.then(async () => { if (callbacks.current.status === 'pending') await callbacks.current.onDraft?.({ canvas_state: snapshot }) })
    queue.current = operation.catch(() => undefined)
    return operation
  }
  const update = (next: CanvasValues): void => {
    if (JSON.stringify(next) === JSON.stringify(values.current)) return
    history.current.push(structuredClone(values.current))
    void save(next).catch(failure => setError(String(failure)))
  }
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== CANVAS_CHANNEL || event.data.identity !== identity.current) return
      const message = event.data
      if (message.event === 'ready') {
        setReady(true)
        frame.current?.contentWindow?.postMessage({ channel: CANVAS_CHANNEL, identity: identity.current, event: 'restore', values: values.current }, '*')
      } else if (message.event === 'draft' && message.values && typeof message.values === 'object' && !Array.isArray(message.values)) {
        update(message.values)
      } else if (message.event === 'error') {
        setError(String(message.error))
      } else if (message.event === 'result' && request.current?.id === message.request) {
        const pending = request.current
        if (!pending) return
        if (message.error) pending.reject(new Error(String(message.error)))
        else if (message.values && typeof message.values === 'object' && !Array.isArray(message.values)) pending.resolve(message.values)
        else pending.reject(new Error('canvas_result_object_required'))
        request.current = null
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      request.current?.reject(new Error('canvas_instance_closed'))
      request.current = null
    }
  }, [])
  const collect = (action: CanvasAction): Promise<CanvasValues> => new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      if (request.current?.id === id) request.current = null
      reject(new Error('canvas_handler_timeout'))
    }, CANVAS_HANDLER_TIMEOUT_MS)
    request.current = {
      id,
      resolve: next => { clearTimeout(timer); resolve(next) },
      reject: failure => { clearTimeout(timer); reject(failure) },
    }
    frame.current?.contentWindow?.postMessage({ channel: CANVAS_CHANNEL, identity: identity.current, event: 'action', request: id, handler: HANDLERS[action] }, '*')
  })
  const run = async (action: CanvasAction): Promise<void> => {
    if (locked.current || completed || status !== 'pending') return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      let result: CanvasValues
      if (description.format === 'html') result = await collect(action)
      else if (action === 'rollback') result = history.current.pop() ?? values.current
      else result = canvasValues(values.current, bindings.current) as CanvasValues
      if (action === 'rollback') {
        await save(result)
        if (description.format === 'openui-lang') setVersion(current => current + 1)
      } else {
        await queue.current
        if (action === 'submit') await save(values.current)
        if (!callbacks.current.onAction) throw new Error('canvas_submit_handler_missing')
        await callbacks.current.onAction(action, action === 'cancel' ? {} : result)
        setCompleted(true)
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <CanvasPreview
    title={title ?? t('canvas.title')}
    full={full}
    onOpen={onOpen}
    expandLabel={t('canvas.expandPreview')}
    collapseLabel={t('canvas.collapsePreview')}
    testId="conversation-canvas-runtime"
    notice={error || sourceError ? <Alert tone="error" title={t('canvas.failed')} description={error || sourceError} /> : null}
    footer={description.interaction && <>
      <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
        {description.interaction.actions.map(action => <Button key={action} size="sm" variant={action === 'submit' ? 'default' : 'ghost'} disabled={(!ready && !(action === 'cancel' && description.format === 'openui-lang')) || busy || completed || status !== 'pending'} onClick={() => void run(action)}>{t(`canvas.${action}`)}</Button>)}
      </div>
      {(completed || status !== 'pending') && <p role="status">{t(status === 'unknown' ? 'process.unknown' : status === 'submitting' ? 'canvas.submitting' : 'canvas.finished')}</p>}
    </>}
  >
        {description.format === 'html' ? <iframe ref={frame} title={title ?? t('canvas.title')} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} className="h-full min-h-0 w-full border-0" /> : ready && !sourceError &&
        <ThemeProvider mode={mode} lightTheme={conversationTheme} darkTheme={conversationTheme} cssSelector="[data-canvas-ui]">
          <div data-canvas-ui>
            <Renderer key={version} response={description.source} library={canvasLibrary} initialState={values.current} onStateUpdate={update} publishObservability={false}
              onAction={() => setError('canvas_host_action_required')}
              onError={errors => { if (errors.length) setError(errors.map(failure => failure.code).join(', ')) }} />
          </div>
        </ThemeProvider>}
  </CanvasPreview>
}
