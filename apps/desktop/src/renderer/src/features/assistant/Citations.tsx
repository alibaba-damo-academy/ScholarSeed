import React, { useCallback, useEffect, useRef } from 'react'
import {
  CitationLink as CitationLinkView,
  CitationSources as CitationSourcesView,
  WebCitationLink as WebCitationLinkView,
} from '../../components/business/Citation'
import type { CitationLinkRange, CitationResolution } from '../../contracts/citations'
import type { AnswerCoverage, AnswerSource } from '../../model'
import { useApp } from '../../store'
import { useWorkspaceController } from '../workbench/workspace'
import { sha256Text } from './anchors'
import {
  citationPreviewUrl,
  citationSources,
  isUnverifiableCitationError,
  resolveCitation,
} from './api'

function useCitationReveal(): (source: CitationResolution) => Promise<void> {
  const { act } = useApp()
  const workspace = useWorkspaceController()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return async (source) => {
    const tabId = await workspace.revealCitation(source, source.matches[0])
    if (mounted.current) act.activateTab(tabId, { returnToExpandedAssistantOnClose: true })
  }
}

function openWebSource(url: string): void {
  if (window.scholarseed?.openExternal) void window.scholarseed.openExternal(url)
}

export function CitationLink({
  sessionId,
  answerId,
  text,
  range,
  handle,
  children,
  displayNumber,
  onResolved,
}: {
  sessionId: string
  answerId: string
  text: string
  range?: CitationLinkRange
  handle?: string
  children: React.ReactNode
  displayNumber?: number
  onResolved?: (source: CitationResolution) => void
}): React.JSX.Element {
  const reveal = useCitationReveal()
  const resolve = useCallback(
    async () =>
      resolveCitation(
        sessionId,
        answerId,
        await sha256Text(text),
        range?.start ?? 0,
        range?.end ?? 0,
        handle
      ),
    [sessionId, answerId, text, range?.start, range?.end, handle]
  )
  return (
    <CitationLinkView
      resolve={resolve}
      reveal={reveal}
      previewUrl={citationPreviewUrl}
      isUnverifiable={isUnverifiableCitationError}
      displayNumber={displayNumber}
      onResolved={onResolved}
    >
      {children}
    </CitationLinkView>
  )
}

export function WebCitationLink({
  source,
  named = false,
}: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  named?: boolean
}): React.JSX.Element {
  return <WebCitationLinkView source={source} named={named} openWebSource={openWebSource} />
}

export function CitationSources({
  sessionId,
  answerId,
  text,
  answerSources,
  coverage,
  resolveEnabled = true,
}: {
  sessionId: string
  answerId: string
  text: string
  answerSources?: AnswerSource[]
  coverage?: AnswerCoverage
  resolveEnabled?: boolean
}): React.JSX.Element {
  const reveal = useCitationReveal()
  const loadSources = useCallback(
    async () => citationSources(sessionId, answerId, await sha256Text(text)),
    [sessionId, answerId, text]
  )
  const resolveSource = useCallback(
    async (handle: string) =>
      resolveCitation(sessionId, answerId, await sha256Text(text), 0, 0, handle),
    [sessionId, answerId, text]
  )
  return (
    <CitationSourcesView
      sourceKey={JSON.stringify([sessionId, answerId, text])}
      loadSources={resolveEnabled && text.includes('scholarseed-cite:') ? loadSources : undefined}
      resolveSource={resolveSource}
      reveal={reveal}
      previewUrl={citationPreviewUrl}
      isUnverifiable={isUnverifiableCitationError}
      openWebSource={openWebSource}
      answerSources={answerSources}
      coverage={coverage}
    />
  )
}
