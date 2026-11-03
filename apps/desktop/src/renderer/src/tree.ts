import { sessionTitleFallback } from './session.ts'
import type { ServeSession } from './api'
import type { Cognitive, SessionNode, SessionStatus } from './model'

export function sessionTone(status: SessionStatus): Cognitive {
  if (status === 'failed' || status === 'abandon') return 'tension'
  if (status === 'waiting') return 'opinion'
  return 'experience'
}

/** Project one Serve catalog row into the renderer's canonical session read model. */
export function serveSessionNode(
  session: ServeSession,
  sessionActivitySeen: Record<string, number>,
  activeSession: string | null
): SessionNode {
  const running = session.running === true
  const waiting = session.waiting === true
  const activityAt = session.mtime ?? session.created_at ?? 0
  const viewedActivity = sessionActivitySeen[session.session_id] ?? 0
  const status: SessionStatus = waiting
    ? 'waiting'
    : running
      ? 'running'
      : session.last_turn_status === 'failed'
        ? 'failed'
        : session.recovery_blocked || session.last_turn_status === 'interrupted'
          ? 'abandon'
          : session.session_id !== activeSession && activityAt > viewedActivity
            ? 'done'
            : 'dormant'
  return {
    id: session.session_id,
    title: session.title || session.session_id.slice(0, 8),
    title_fallback: session.title ? sessionTitleFallback(session.title_fallback) : null,
    status,
    tone: sessionTone(status),
    meta: session.runtime?.model_id || 'Codex',
    timeLabel: undefined,
    createdAt: session.created_at,
    activityAt,
    workdir: session.runtime_workdir || session.workdir || undefined,
    projectPath: session.project_path ?? null,
    runtimeId: session.runtime_id,
    pulse: waiting ? 1.2 : running ? 1.6 : undefined,
    openable: true,
  }
}

/** Session sidebar tree operations. All callers preserve the backend's durable parent lineage. */
export function findSessionNode(nodes: SessionNode[], id: string): SessionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findSessionNode(node.children ?? [], id)
    if (child) return child
  }
  return undefined
}

function sessionActivity(node: SessionNode): number {
  return node.activityAt ?? node.createdAt ?? 0
}

/**
 * Return every user-openable conversation once, newest activity first.
 *
 * The catalog may expose a session both as a top-level row and as a child of a
 * scheduled/container row. Search is a product-wide view, so it recursively
 * flattens that tree and de-duplicates by the durable session id.
 */
export function searchSessionTitles(nodes: SessionNode[], query: string): SessionNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const sessions = new Map<string, SessionNode>()

  const visit = (rows: SessionNode[]): void => {
    for (const node of rows) {
      if (
        !node.container &&
        node.openable !== false &&
        node.title.trim() &&
        !node.title.startsWith('serve:')
      ) {
        const known = sessions.get(node.id)
        if (!known || sessionActivity(node) > sessionActivity(known)) sessions.set(node.id, node)
      }
      if (node.children?.length) visit(node.children)
    }
  }
  visit(nodes)

  return [...sessions.values()]
    .filter(
      (node) => !normalizedQuery || node.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
    )
    .sort(
      (left, right) =>
        sessionActivity(right) - sessionActivity(left) ||
        (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
        right.id.localeCompare(left.id)
    )
}

function replaceSessionNode(nodes: SessionNode[], node: SessionNode): SessionNode[] {
  return nodes.map((current) => {
    if (current.id === node.id) {
      return mergeSessionNode(current, node)
    }
    if (!current.children?.length) return current
    return { ...current, children: replaceSessionNode(current.children, node) }
  })
}

function mergeSessionNode(current: SessionNode, incoming: SessionNode): SessionNode {
  return { ...current, ...incoming, children: incoming.children ?? current.children }
}

export function upsertSessionNode(nodes: SessionNode[], node: SessionNode): SessionNode[] {
  // The session list is a newest-first creation timeline. A locally-created
  // session arrives before the next catalog refresh and therefore starts at the head.
  return findSessionNode(nodes, node.id) ? replaceSessionNode(nodes, node) : [node, ...nodes]
}

/** Preserve a branch's position in the sidebar tree when it receives its real session id. */
export function renameSessionNode(
  nodes: SessionNode[],
  oldId: string,
  newId: string
): SessionNode[] {
  return nodes.map((node) => {
    if (node.id === oldId) return { ...node, id: newId }
    if (!node.children?.length) return node
    return { ...node, children: renameSessionNode(node.children, oldId, newId) }
  })
}

export function appendSessionChildren(
  nodes: SessionNode[],
  parentId: string,
  children: SessionNode[]
): SessionNode[] {
  return nodes.map((node) => {
    if (node.id === parentId) {
      const incoming = new Map(children.map((child) => [child.id, child]))
      const current = node.children ?? []
      const refreshed = current.map((child) => {
        const update = incoming.get(child.id)
        return update ? mergeSessionNode(child, update) : child
      })
      const known = new Set(current.map((child) => child.id))
      return {
        ...node,
        children: [...refreshed, ...children.filter((child) => !known.has(child.id))],
      }
    }
    if (!node.children?.length) return node
    return { ...node, children: appendSessionChildren(node.children, parentId, children) }
  })
}

export function removeSessionNode(nodes: SessionNode[], id: string): SessionNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) =>
      node.children?.length ? { ...node, children: removeSessionNode(node.children, id) } : node
    )
}
