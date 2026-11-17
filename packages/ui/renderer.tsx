import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Renderer, type Library } from '@openuidev/react-lang'
import { ThemeProvider, type Theme } from '@openuidev/react-ui'
import { OPENUI_LIMITS, type ConversationDocument } from './document'
import { conversationLibrary } from './library'
import { validateEnvelope } from './validation'
import '@openuidev/react-ui/components.css'

export interface ConversationSurfaceProps {
  document: ConversationDocument
  library?: Library
  onError: (code: string) => void
  errorLabel: string
  loadingLabel: string
  mode: 'light' | 'dark'
  theme: Theme
}

export function ConversationSurface({ document, library = conversationLibrary, onError, errorLabel, loadingLabel, mode, theme }: ConversationSurfaceProps): React.JSX.Element {
  const [validated, setValidated] = useState<string | null>(null)
  const [error, setError] = useState('')
  const surface = useRef<HTMLDivElement>(null)
  const focus = useRef<{ element: HTMLElement; signature: string; index: number; start?: number | null; end?: number | null } | null>(null)
  const controls = (): HTMLElement[] => Array.from(surface.current?.querySelectorAll<HTMLElement>('input,textarea,select,button,[tabindex]') ?? [])
  const signature = (element: HTMLElement): string => JSON.stringify([
    element.tagName, element.getAttribute('name'), element.getAttribute('type'), element.getAttribute('aria-label'),
    element.tagName === 'BUTTON' ? element.textContent : '',
  ])
  const remember = (element: EventTarget | null): void => {
    if (!(element instanceof HTMLElement)) return
    const identity = signature(element)
    focus.current = { element, signature: identity, index: controls().filter(candidate => signature(candidate) === identity).indexOf(element),
      ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? { start: element.selectionStart, end: element.selectionEnd } : {}) }
  }
  useLayoutEffect(() => {
    const previous = focus.current
    const owner = surface.current?.ownerDocument
    if (!previous || !owner || error || validated !== document.source ||
        (owner.activeElement !== owner.body && owner.activeElement !== previous.element)) return
    const next = controls().filter(candidate => signature(candidate) === previous.signature)[previous.index]
    if (!next || next.matches(':disabled')) return
    next.focus({ preventScroll: true })
    if ((next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && previous.start !== undefined &&
        previous.start !== null && previous.end !== undefined && previous.end !== null)
      next.setSelectionRange(previous.start, previous.end)
    remember(next)
  }, [validated, document.source, error])
  const callbacks = useRef({ onError })
  callbacks.current = { onError }
  useEffect(() => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let current = true
    setError('')
    const fail = (code: string): void => {
      if (!current) return
      setError(code)
      callbacks.current.onError(code)
      worker?.terminate()
      clearTimeout(timer)
    }
    try {
      validateEnvelope(document)
      worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' })
      timer = setTimeout(() => fail('openui_worker_timeout'), OPENUI_LIMITS.startupMilliseconds)
      worker.onmessage = ({ data }: MessageEvent<{ ready?: boolean; valid?: boolean; error?: string }>) => {
        if (!current) return
        if (data.ready) {
          clearTimeout(timer)
          timer = setTimeout(() => fail('openui_validation_timeout'), OPENUI_LIMITS.parseMilliseconds)
          worker?.postMessage({ source: document.source, schema: library.toJSONSchema(), root: library.root })
          return
        }
        if (!data.valid) { fail(data.error ?? 'openui_description_invalid'); return }
        clearTimeout(timer)
        setValidated(document.source)
        worker?.terminate()
      }
      worker.onerror = () => fail('openui_worker_failed')
    } catch (failure) {
      fail(failure instanceof Error ? failure.message : 'openui_document')
    }
    return () => { current = false; clearTimeout(timer); worker?.terminate() }
  }, [document.format, document.version, document.source, library])
  return (
    <ThemeProvider mode={mode} lightTheme={theme} darkTheme={theme} cssSelector="[data-conversation-ui]">
      <div ref={surface} onFocusCapture={event => remember(event.target)} onSelectCapture={event => remember(event.target)}
        data-conversation-ui data-state={error ? 'error' : validated === document.source ? 'ready' : 'validating'} data-error={error || undefined}>
        {error && <p role="alert">{errorLabel}</p>}
        {!validated && !error && <p role="status">{loadingLabel}</p>}
        {validated && <Renderer response={validated} library={library} publishObservability={false}
          onError={errors => { if (errors.length) { setError('openui_render_failed'); callbacks.current.onError('openui_render_failed') } }} />}
      </div>
    </ThemeProvider>
  )
}
