import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'

export const CANVAS_TAB_PREFIX = 'canvas/'
interface CanvasEntry {
  id: string
  title: string
  content: React.ReactNode
  sessionId: string | null
  node: HTMLDivElement
  inline?: HTMLElement
  target?: HTMLElement
  full: boolean
}
interface CanvasRegistry {
  entries: Map<string, CanvasEntry>
  subscribe: (listener: () => void) => () => void
  attach: (id: string, title: string, content: React.ReactNode, inline: HTMLElement) => void
  detach: (id: string, inline: HTMLElement) => void
  target: (id: string, element: HTMLElement | null) => void
  open: (id: string) => void
  close: (id: string) => void
}
const CanvasContext = createContext<CanvasRegistry | null>(null)
const CanvasLocation = createContext<{ full: boolean; open?: () => void }>({
  full: false,
})

export const useCanvasLocation = () => useContext(CanvasLocation)

function move(entry: CanvasEntry, target: HTMLElement): void {
  if (entry.node.parentElement === target) return
  if (!entry.node.isConnected) target.appendChild(entry.node)
  else {
    const container = target as HTMLElement & {
      moveBefore: (node: Node, child: Node | null) => void
    }
    if (typeof container.moveBefore !== 'function')
      throw new Error('canvas_state_preserving_move_unavailable')
    container.moveBefore(entry.node, null)
  }
}

export function CanvasProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { state, set, act } = useApp()
  const stateRef = useRef(state)
  stateRef.current = state
  const actions = useRef(act)
  actions.current = act
  const parking = useRef<HTMLDivElement>(null)
  const [, changed] = useState(0)
  const registry = useMemo<CanvasRegistry>(() => {
    const entries = new Map<string, CanvasEntry>()
    const targets = new Map<string, HTMLElement>()
    const listeners = new Set<() => void>()
    const emit = (): void => {
      changed((version) => version + 1)
      listeners.forEach((listener) => listener())
    }
    const tabId = (id: string): string => `${CANVAS_TAB_PREFIX}${encodeURIComponent(id)}`
    const hasTab = (id: string): boolean =>
      stateRef.current.tabs.some((tab) => tab.id === tabId(id))
    const inCurrentSession = (entry: CanvasEntry): boolean =>
      Boolean(entry.sessionId && entry.sessionId === stateRef.current.activeSession)
    return {
      entries,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      attach(id, title, content, inline) {
        let entry = entries.get(id)
        if (!entry) {
          const node = document.createElement('div')
          node.className = 'h-full min-h-0 min-w-0'
          parking.current?.appendChild(node)
          entry = {
            id,
            title,
            content,
            node,
            full: false,
            sessionId: stateRef.current.activeSession,
          }
          entries.set(id, entry)
        }
        entry.inline = inline
        entry.content = content
        entry.target = targets.get(id)
        entry.full = Boolean(entry.target)
        move(entry, entry.target ?? inline)
        emit()
      },
      detach(id, inline) {
        const entry = entries.get(id)
        if (!entry || entry.inline !== inline) return
        entry.inline = undefined
        if (!entry.target && !hasTab(id) && !inCurrentSession(entry)) {
          entry.node.remove()
          entries.delete(id)
        } else if (!entry.target && parking.current) move(entry, parking.current)
        emit()
      },
      target(id, element) {
        if (element) targets.set(id, element)
        else targets.delete(id)
        const entry = entries.get(id)
        if (!entry) return
        entry.target = element ?? undefined
        entry.full = Boolean(element)
        const destination = element ?? entry.inline ?? parking.current
        if (destination) move(entry, destination)
        emit()
      },
      close: (id) => actions.current.closeWorkbenchTab(tabId(id)),
      open(id) {
        const entry = entries.get(id)
        const sessionId = entry?.sessionId
        if (!sessionId) return
        set((current) => {
          if (current.activeSession !== sessionId) return {}
          return {
            tabs: current.tabs.some((tab) => tab.id === tabId(id))
              ? current.tabs
              : [
                  ...current.tabs,
                  {
                    id: tabId(id),
                    kind: 'canvas',
                    title: entry.title,
                    closable: true,
                    projectId: current.homeSelectedProjectId,
                    canvasSessionId: sessionId,
                  },
                ],
            activeTab: tabId(id),
            mainView: 'resource',
            workbenchLayout: {
              ...current.workbenchLayout,
              open: true,
              full: false,
              taskTab: false,
              conversationFull: false,
            },
            aiPanel: { ...current.aiPanel, cover: false },
          }
        })
      },
    }
  }, [set])
  useEffect(() => {
    for (const entry of registry.entries.values()) {
      const id = `${CANVAS_TAB_PREFIX}${encodeURIComponent(entry.id)}`
      if (
        !entry.inline &&
        !entry.target &&
        !state.tabs.some((tab) => tab.id === id) &&
        (!entry.sessionId || entry.sessionId !== state.activeSession)
      ) {
        entry.node.remove()
        registry.entries.delete(entry.id)
        changed((version) => version + 1)
      }
    }
  }, [registry, state.tabs, state.activeSession])
  return (
    <CanvasContext.Provider value={registry}>
      <div ref={parking} hidden />
      {children}
      {[...registry.entries.values()].map((entry) =>
        createPortal(
          <CanvasLocation.Provider
            value={{
              full: entry.full,
              open: () => registry.open(entry.id),
            }}
          >
            {entry.content}
          </CanvasLocation.Provider>,
          entry.node,
          entry.id
        )
      )}
    </CanvasContext.Provider>
  )
}

export function CanvasMount({
  id,
  title,
  children,
  renderInline,
}: {
  id: string
  title: string
  children: React.ReactNode
  renderInline?: (
    location: { full: boolean; open: () => void; close: () => void } | undefined,
    content: React.ReactNode
  ) => React.JSX.Element
}): React.JSX.Element {
  const registry = useContext(CanvasContext)
  const inline = useRef<HTMLDivElement>(null)
  const full = useSyncExternalStore(
    registry?.subscribe ?? (() => () => undefined),
    () => registry?.entries.get(id)?.full ?? false
  )
  useLayoutEffect(() => {
    if (!registry || !inline.current) return
    registry.attach(id, title, children, inline.current)
  }, [registry, id, title, children])
  useLayoutEffect(() => {
    const element = inline.current
    return () => {
      if (registry && element) registry.detach(id, element)
    }
  }, [registry, id])
  const content = registry ? <div ref={inline} className="min-h-0 min-w-0" /> : children
  if (!renderInline) return <>{content}</>
  const location = registry
    ? { full, open: () => registry.open(id), close: () => registry.close(id) }
    : undefined
  return renderInline(location, content)
}

export function CanvasTarget({ tabId }: { tabId: string }): React.JSX.Element | null {
  const { state } = useApp()
  return state.workbenchLayout.open ? <CanvasSurface tabId={tabId} /> : null
}

function CanvasSurface({ tabId }: { tabId: string }): React.JSX.Element {
  const registry = useContext(CanvasContext)
  const target = useRef<HTMLDivElement>(null)
  const id = decodeURIComponent(tabId.slice(CANVAS_TAB_PREFIX.length))
  const { t } = useTranslation('conversation')
  const present = useSyncExternalStore(
    registry?.subscribe ?? (() => () => undefined),
    () => registry?.entries.has(id) ?? false
  )
  useLayoutEffect(() => {
    if (target.current) registry?.target(id, target.current)
    return () => registry?.target(id, null)
  }, [registry, id])
  return (
    <div className="h-full min-h-0 min-w-0 p-[var(--vds-space-3)]" ref={target}>
      {!present && <p role="status">{t('canvas.reopen')}</p>}
    </div>
  )
}
