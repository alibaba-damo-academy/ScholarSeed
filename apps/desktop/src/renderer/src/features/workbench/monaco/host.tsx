import React, { useEffect, useMemo, useRef } from 'react'

import type { PreferenceLanguage } from '../../../../../preferences'
import {
  MONACO_FRAME_LANGUAGE_PARAM,
  MONACO_FRAME_MESSAGE,
  MONACO_FRAME_TOKEN_PARAM,
  type MonacoFrameContext,
  type MonacoFrameReadyMessage,
  type MonacoFrameWindow
} from './contract'

const MONACO_LIGHT_THEME = 'vs'
const MONACO_DARK_THEME = 'vs-dark'
const MONACO_RUNTIME_STYLE_SELECTOR = 'link[rel="stylesheet"], style'

type RuntimeStyleElement = HTMLLinkElement | HTMLStyleElement

interface RuntimeStyleMirror {
  dispose: () => void
  ready: Promise<void>
  sync: () => void
}

function applyTheme(context: MonacoFrameContext, theme: 'light' | 'dark'): void {
  context.element.contentDocument!.documentElement.dataset.theme = theme
  context.runtime.monaco.editor.setTheme(theme === 'dark' ? MONACO_DARK_THEME : MONACO_LIGHT_THEME)
}

function waitForStylesheet(link: HTMLLinkElement): Promise<void> {
  return new Promise((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => resolve(), { once: true })
  })
}

function mirrorRuntimeStyles(frameDocument: Document): RuntimeStyleMirror {
  const mirrors = new Map<RuntimeStyleElement, RuntimeStyleElement>()
  const pendingStylesheets: Promise<void>[] = []
  const sync = (): void => {
    const sources = [...frameDocument.head.querySelectorAll<RuntimeStyleElement>(MONACO_RUNTIME_STYLE_SELECTOR)]
    const activeSources = new Set(sources)
    for (const [source, mirror] of mirrors) {
      if (activeSources.has(source)) continue
      mirror.remove()
      mirrors.delete(source)
    }
    for (const source of sources) {
      const existing = mirrors.get(source)
      if (existing instanceof HTMLStyleElement && source.tagName === 'STYLE') {
        existing.textContent = source.textContent
        continue
      }
      if (existing) continue
      const mirror = document.importNode(source, true)
      mirror.dataset.monacoRuntimeStyle = 'true'
      if (mirror instanceof HTMLLinkElement) pendingStylesheets.push(waitForStylesheet(mirror))
      document.head.append(mirror)
      mirrors.set(source, mirror)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(frameDocument.head, { attributes: true, characterData: true, childList: true, subtree: true })
  return {
    dispose: () => {
      observer.disconnect()
      for (const mirror of mirrors.values()) mirror.remove()
      mirrors.clear()
    },
    ready: Promise.all(pendingStylesheets).then(() => undefined),
    sync
  }
}

function frameSource(language: PreferenceLanguage, token: string): string {
  const url = new URL('./monaco.html', window.location.href)
  url.searchParams.set(MONACO_FRAME_LANGUAGE_PARAM, language)
  url.searchParams.set(MONACO_FRAME_TOKEN_PARAM, token)
  return url.toString()
}

export function MonacoFrame({
  language,
  onReady,
  testId,
  theme
}: {
  language: PreferenceLanguage
  onReady: (context: MonacoFrameContext | null) => void
  testId: string
  theme: 'light' | 'dark'
}): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const contextRef = useRef<MonacoFrameContext | null>(null)
  const styleMirrorRef = useRef<RuntimeStyleMirror | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const token = useMemo(() => crypto.randomUUID(), [language])
  const source = useMemo(() => frameSource(language, token), [language, token])

  useEffect(() => {
    let active = true
    onReady(null)
    const receive = async (event: MessageEvent<MonacoFrameReadyMessage>): Promise<void> => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.origin !== window.location.origin) return
      if (event.data?.kind !== MONACO_FRAME_MESSAGE || event.data.token !== token) return
      const frameWindow = frameRef.current.contentWindow as MonacoFrameWindow | null
      const frameDocument = frameRef.current.contentDocument
      const host = hostRef.current
      if (!frameWindow?.scholarseedMonaco || !frameDocument || !host) return
      styleMirrorRef.current?.dispose()
      const styleMirror = mirrorRuntimeStyles(frameDocument)
      styleMirrorRef.current = styleMirror
      await styleMirror.ready
      if (!active || styleMirrorRef.current !== styleMirror) return
      const context = { element: frameRef.current, host, runtime: frameWindow.scholarseedMonaco }
      contextRef.current = context
      applyTheme(context, themeRef.current)
      styleMirror.sync()
      onReady(context)
    }
    window.addEventListener('message', receive)
    return () => {
      active = false
      window.removeEventListener('message', receive)
      styleMirrorRef.current?.dispose()
      styleMirrorRef.current = null
      contextRef.current = null
      onReady(null)
    }
  }, [onReady, source, token])

  useEffect(() => {
    if (!contextRef.current) return
    applyTheme(contextRef.current, theme)
    styleMirrorRef.current?.sync()
  }, [theme])

  return <>
    <div className="vds-monaco relative size-full min-h-0 min-w-0" data-testid={testId} ref={hostRef} />
    <iframe aria-hidden="true" className="hidden" ref={frameRef} src={source} title="Monaco runtime" />
  </>
}
