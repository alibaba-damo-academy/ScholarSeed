import React, { useEffect, useMemo, useRef } from 'react'

import type { PreferenceLanguage } from '../../../../../preferences'
import {
  MONACO_FRAME_HOST_ID,
  MONACO_FRAME_LANGUAGE_PARAM,
  MONACO_FRAME_MESSAGE,
  MONACO_FRAME_TOKEN_PARAM,
  type MonacoFrameContext,
  type MonacoFrameReadyMessage,
  type MonacoFrameWindow
} from './contract'

const MONACO_LIGHT_THEME = 'vs'
const MONACO_DARK_THEME = 'vs-dark'

function applyTheme(context: MonacoFrameContext, theme: 'light' | 'dark'): void {
  context.element.contentDocument!.documentElement.dataset.theme = theme
  context.runtime.monaco.editor.setTheme(theme === 'dark' ? MONACO_DARK_THEME : MONACO_LIGHT_THEME)
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
  const contextRef = useRef<MonacoFrameContext | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const token = useMemo(() => crypto.randomUUID(), [language])
  const source = useMemo(() => frameSource(language, token), [language, token])

  useEffect(() => {
    onReady(null)
    const receive = (event: MessageEvent<MonacoFrameReadyMessage>): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.origin !== window.location.origin) return
      if (event.data?.kind !== MONACO_FRAME_MESSAGE || event.data.token !== token) return
      const frameWindow = frameRef.current.contentWindow as MonacoFrameWindow | null
      const frameDocument = frameRef.current.contentDocument
      const host = frameDocument?.getElementById(MONACO_FRAME_HOST_ID)
      if (!frameWindow?.scholarseedMonaco || !frameDocument || !host) return
      const context = { element: frameRef.current, host, runtime: frameWindow.scholarseedMonaco }
      contextRef.current = context
      applyTheme(context, themeRef.current)
      onReady(context)
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      contextRef.current = null
      onReady(null)
    }
  }, [onReady, source, token])

  useEffect(() => {
    if (contextRef.current) applyTheme(contextRef.current, theme)
  }, [theme])

  return <iframe className="vds-monaco size-full min-h-0 min-w-0 border-0" data-testid={testId} ref={frameRef} src={source} title="Monaco runtime" />
}
