const TURN_ANCHORS = '[data-message-turn-id], [data-turn-id]'
const TURN_ANCHOR_ATTRIBUTES = ['data-message-turn-id', 'data-turn-id']

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
  let observer: IntersectionObserver | undefined

  const notify = (turnId: string): void => {
    subscribers.get(turnId)?.forEach((listener) => listener())
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
    isVisible: (turnId: string): boolean => visibleCounts.has(turnId),
    subscribe(turnId: string, listener: () => void): () => void {
      const listeners = subscribers.get(turnId) ?? new Set()
      subscribers.set(turnId, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) subscribers.delete(turnId)
      }
    },
    observe(root: Element | null, column: Element): () => void {
      const current = new IntersectionObserver(
        (entries) => {
          if (observer !== current) return
          const changed = new Set<string>()
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
            changed.add(target.turnId)
          }
          changed.forEach(notify)
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
