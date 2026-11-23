const TURN_ANCHORS = '[data-message-turn-id], [data-turn-id]'
const TURN_ANCHOR_ATTRIBUTES = ['data-message-turn-id', 'data-turn-id']
const MAX_CONCURRENT_SOURCE_REQUESTS = 2

function hasTurnAnchor(node: Node): boolean {
  return (
    node instanceof Element &&
    (node.matches(TURN_ANCHORS) || Boolean(node.querySelector(TURN_ANCHORS)))
  )
}

function changesTurnAnchors(change: MutationRecord): boolean {
  if (change.type === 'attributes') return true
  const nodes = [...change.addedNodes, ...change.removedNodes]
  return (
    nodes.some(hasTurnAnchor) ||
    (nodes.some((node) => node instanceof Element) &&
      change.target instanceof Element &&
      change.target.closest(TURN_ANCHORS) !== null &&
      getComputedStyle(change.target).display === 'contents')
  )
}

export function createTurnSourceViewport() {
  const targets = new Map<Element, { turnId: string; visible: boolean }>()
  const visibleCounts = new Map<string, number>()
  const subscribers = new Map<string, Set<() => void>>()
  let inFlight = 0
  let observer: IntersectionObserver | undefined

  const dispatchVisible = (): void => {
    // The current viewport is the queue: leaving it drops any unsent demand.
    for (const turnId of visibleCounts.keys()) {
      for (const start of subscribers.get(turnId) ?? []) {
        if (inFlight >= MAX_CONCURRENT_SOURCE_REQUESTS) return
        start()
      }
    }
  }
  const count = (turnId: string, change: number): void => {
    const total = (visibleCounts.get(turnId) ?? 0) + change
    if (total > 0) visibleCounts.set(turnId, total)
    else visibleCounts.delete(turnId)
  }

  const update = (column: Element, current: IntersectionObserver): void => {
    const next = new Map<Element, string>()
    const collect = (element: Element, turnId: string): void => {
      if (getComputedStyle(element).display !== 'contents') {
        next.set(element, turnId)
        return
      }
      for (const child of element.children) collect(child, turnId)
    }
    for (const anchor of column.querySelectorAll<HTMLElement>(TURN_ANCHORS)) {
      const turnId = anchor.dataset.messageTurnId || anchor.dataset.turnId
      if (turnId) collect(anchor, turnId)
    }
    for (const [element, previous] of targets) {
      if (next.get(element) === previous.turnId) continue
      current.unobserve(element)
      targets.delete(element)
      if (previous.visible) count(previous.turnId, -1)
    }
    for (const [element, turnId] of next) {
      if (targets.has(element)) continue
      targets.set(element, { turnId, visible: false })
      current.observe(element)
    }
  }

  return {
    watch(turnId: string, load: (signal: AbortSignal) => Promise<void>) {
      let stale = true
      let request: AbortController | undefined
      const settled = (): void => {
        request = undefined
        inFlight--
        dispatchVisible()
      }
      const start = (): void => {
        if (!stale || request) return
        stale = false
        request = new AbortController()
        inFlight++
        void load(request.signal).then(settled, settled)
      }
      const listeners = subscribers.get(turnId) ?? new Set()
      subscribers.set(turnId, listeners)
      listeners.add(start)
      if (visibleCounts.has(turnId)) dispatchVisible()
      return {
        invalidate() {
          stale = true
          request?.abort()
          if (visibleCounts.has(turnId)) dispatchVisible()
        },
        dispose() {
          listeners.delete(start)
          if (!listeners.size) subscribers.delete(turnId)
          request?.abort()
        },
      }
    },
    observe(root: Element | null, column: Element): () => void {
      const current = new IntersectionObserver(
        (entries) => {
          if (observer !== current) return
          for (const entry of entries) {
            const target = targets.get(entry.target)
            if (!target) continue
            const visible =
              entry.isIntersecting &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height > 0
            if (target.visible === visible) continue
            target.visible = visible
            count(target.turnId, visible ? 1 : -1)
          }
          dispatchVisible()
        },
        // A target touching the boundary can intersect without any visible pixels.
        { root, threshold: [0, Number.EPSILON] }
      )
      observer = current
      const changes = new MutationObserver((records) => {
        if (observer === current && records.some(changesTurnAnchors)) update(column, current)
      })
      changes.observe(column, {
        subtree: true,
        childList: true,
        attributeFilter: TURN_ANCHOR_ATTRIBUTES,
      })
      update(column, current)
      return () => {
        changes.disconnect()
        current.disconnect()
        observer = undefined
        targets.clear()
        visibleCounts.clear()
      }
    },
  }
}

export type TurnSourceViewport = ReturnType<typeof createTurnSourceViewport>
