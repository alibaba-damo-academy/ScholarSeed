import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WebNavigationContext } from '../../contracts/navigation'
import { ANSWER_SOURCES_CHANGED_EVENT } from '../../contracts/citations'
import {
  CitationLink as CitationLinkView,
  CitationSources as CitationSourcesView,
  WebCitationLink as WebCitationLinkView,
} from '../../components/business/Citation'
import {
  groupCitationReferences,
  groupWebCitationSources,
} from '../../components/business/grouping'
import type { MarkdownCitationEntry } from '../../components/markdown/citations'
import type { CitationLinkRange, CitationResolution } from '../../contracts/citations'
import type { AnswerCoverage, AnswerSource } from '../../model'
import { activeThread, useApp } from '../../store'
import { Button } from '../../components/ui'
import { answerProjectSource } from './sources'
import { useWorkspaceController } from '../workbench/workspace'
import { webSearchSiteIconUrl, webSourcePreview } from '../resources/api'
import { sha256Text } from './anchors'
import type { TurnSourceViewport } from './viewport'
import {
  citationPreviewUrl,
  citationSources,
  isUnverifiableCitationError,
  resolveCitation,
  turnCitationSources,
} from './api'

const EMPTY_CITATION_SOURCES: CitationResolution[] = []

export function TurnCitationSources({
  sessionId,
  turnId,
  textVersion,
  coverage,
  viewport,
}: {
  sessionId: string
  turnId: string
  textVersion: string
  coverage?: AnswerCoverage
  viewport: TurnSourceViewport
}): React.JSX.Element | null {
  const { state, act } = useApp()
  const openWebSource = React.useContext(WebNavigationContext)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof turnCitationSources>>>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = true
    let request: AbortController | undefined
    setSnapshot(undefined)
    setFailed(false)
    const refresh = (): void => {
      if (!stale || !viewport.isVisible(turnId)) return
      const controller = new AbortController()
      request = controller
      stale = false
      void turnCitationSources(sessionId, turnId, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return
          setSnapshot(value)
          setFailed(false)
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true)
        })
        .finally(() => {
          if (request === controller) request = undefined
        })
    }
    const invalidate = (): void => {
      request?.abort()
      stale = true
      refresh()
    }
    const unsubscribe = viewport.subscribe(turnId, refresh)
    refresh()
    window.addEventListener(ANSWER_SOURCES_CHANGED_EVENT, invalidate)
    return () => {
      request?.abort()
      unsubscribe()
      window.removeEventListener(ANSWER_SOURCES_CHANGED_EVENT, invalidate)
    }
  }, [sessionId, turnId, textVersion, viewport])
  const reveal = useCitationReveal()
  const loadSources = useCallback(async () => {
    if (failed || !snapshot) throw new Error('citation_sources_unavailable')
    return citationSources(sessionId, snapshot.answer_id, await sha256Text(snapshot.markdown))
  }, [failed, snapshot, sessionId])
  const resolveSource = useCallback(
    async (handle: string) => {
      if (!snapshot || failed) throw new Error('citation_sources_unavailable')
      return resolveCitation(
        sessionId,
        snapshot.answer_id,
        await sha256Text(snapshot.markdown),
        0,
        0,
        handle
      )
    },
    [snapshot, failed, sessionId]
  )
  if (!snapshot && !failed) return null
  return (
    <CitationSourcesView
      sourceIconUrl={webSearchSiteIconUrl}
      sourceKey={JSON.stringify([sessionId, turnId, snapshot, failed])}
      loadSources={
        failed || snapshot?.sources.some((source) => source.kind === 'receipt')
          ? loadSources
          : undefined
      }
      resolveSource={resolveSource}
      reveal={reveal}
      previewUrl={citationPreviewUrl}
      isUnverifiable={isUnverifiableCitationError}
      openWebSource={openWebSource}
      answerSources={snapshot?.sources}
      renderProjectSource={(source) => {
        const project = state.projects.find((candidate) => candidate.id === source.project_id)
        const target = project && answerProjectSource(source.url, project, [])
        const thread = activeThread(state)
        if (
          !project ||
          !target ||
          thread.sessionId !== sessionId ||
          thread.projectPath !== project.path
        )
          return source.title
        return (
          <Button
            unstyled
            className="inline text-[var(--vds-link)] underline [overflow-wrap:anywhere]"
            data-testid="answer-project-source"
            onClick={() => {
              if (target.kind === 'resource') act.openResourceFile(target.path, project.id)
              else void act.openLiteratureItem(target.id, project.id)
            }}
          >
            {source.title}
          </Button>
        )
      }}
      coverage={coverage}
    />
  )
}

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

export function useOpenWebSource(onOpened?: () => void): (url: string) => void {
  const openWebSource = React.useContext(WebNavigationContext)
  return useCallback((url: string) => openWebSource(url, onOpened), [openWebSource, onOpened])
}

export function CitationLink({
  sessionId,
  answerId,
  text,
  range,
  handle,
  children,
  displayNumber,
  identity,
  onResolved,
}: {
  sessionId: string
  answerId: string
  text: string
  range?: CitationLinkRange
  handle?: string
  children: React.ReactNode
  displayNumber?: number
  identity?: Pick<CitationResolution, 'path' | 'title' | 'bibliography'>
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
      identity={identity}
      onResolved={onResolved}
    >
      {children}
    </CitationLinkView>
  )
}

export function useAnswerCitationSources(
  sessionId: string | null | undefined,
  answerId: string | null,
  text: string,
  enabled: boolean
): CitationResolution[] {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string
    answerId: string
    text: string
    sources: CitationResolution[]
  }>()
  useEffect(() => {
    let active = true
    let generation = 0
    setSnapshot(undefined)
    if (!enabled || !sessionId || !answerId) return
    const revision = sha256Text(text)
    const refresh = (): void => {
      const requested = ++generation
      void revision
        .then((value) => citationSources(sessionId, answerId, value))
        .then((result) => {
          if (active && requested === generation)
            setSnapshot({ sessionId, answerId, text, sources: result.sources })
        })
        .catch((error) => {
          if (active && requested === generation)
            console.warn('Citation grouping metadata unavailable', error)
        })
    }
    refresh()
    window.addEventListener(ANSWER_SOURCES_CHANGED_EVENT, refresh)
    return () => {
      active = false
      window.removeEventListener(ANSWER_SOURCES_CHANGED_EVENT, refresh)
    }
  }, [sessionId, answerId, text, enabled])
  return enabled &&
    snapshot &&
    snapshot.sessionId === sessionId &&
    snapshot.answerId === answerId &&
    snapshot.text === text
    ? snapshot.sources
    : EMPTY_CITATION_SOURCES
}

export function CitationGroup({
  sessionId,
  answerId,
  text,
  entries,
  sources,
  answerSources,
}: {
  sessionId: string
  answerId: string
  text: string
  entries: MarkdownCitationEntry[]
  sources: CitationResolution[]
  answerSources?: AnswerSource[]
}): React.JSX.Element | null {
  const reveal = useCitationReveal()
  const references = useMemo(
    () =>
      groupCitationReferences(
        entries,
        sources,
        async (source, entry) =>
          resolveCitation(
            sessionId,
            answerId,
            await sha256Text(text),
            entry.start,
            entry.end,
            source.handle
          ),
        answerSources
      ),
    [sessionId, answerId, text, entries, sources, answerSources]
  )
  const [firstWebSource, ...additionalSources] = groupWebCitationSources(entries, answerSources)
  if (firstWebSource)
    return <WebCitationLink source={firstWebSource} additionalSources={additionalSources} />
  if (!references.length) return null
  return (
    <CitationLinkView
      references={references}
      resolve={references[0].resolve}
      reveal={reveal}
      previewUrl={citationPreviewUrl}
      isUnverifiable={isUnverifiableCitationError}
    >
      {references[0].source.title}
    </CitationLinkView>
  )
}

export function WebCitationLink({
  source,
  additionalSources,
}: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  additionalSources?: readonly Extract<AnswerSource, { kind: 'searched' }>[]
}): React.JSX.Element {
  const openWebSource = React.useContext(WebNavigationContext)
  return (
    <WebCitationLinkView
      source={source}
      additionalSources={additionalSources}
      loadPreview={webSourcePreview}
      openWebSource={openWebSource}
      sourceIconUrl={webSearchSiteIconUrl}
    />
  )
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
  const openWebSource = React.useContext(WebNavigationContext)
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
      sourceIconUrl={webSearchSiteIconUrl}
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
