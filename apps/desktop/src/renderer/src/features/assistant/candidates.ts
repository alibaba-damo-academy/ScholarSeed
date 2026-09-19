import type { AssistantContextCandidate, AssistantSourceFilter } from '../../contracts/assistant'

const MINIMUM_SESSION_CONTEXT_TURNS = 1

export function assistantSourceAvailable(
  source: { requiresProject?: boolean },
  projectId: string | null
): boolean {
  return !source.requiresProject || Boolean(projectId)
}

export function resolveAssistantProject(
  activeSessionId: string | null,
  sessionProjectPath: string | null | undefined,
  draftProjectId: string | null,
  projects: readonly { id: string; path: string }[]
): { projectId: string | null; projectPath: string | null } {
  if (activeSessionId) {
    const projectPath = sessionProjectPath ?? null
    return { projectPath, projectId: projects.find((project) => project.path === projectPath)?.id ?? null }
  }
  const project = projects.find((item) => item.id === draftProjectId)
  return { projectId: project?.id ?? null, projectPath: project?.path ?? null }
}

export interface SessionContextCandidateRecord {
  session_id: string
  turns: number
}

/** Only completed, non-active conversations can provide Session context. */
export function isSessionContextCandidate(
  session: SessionContextCandidateRecord,
  activeSessionId: string | null
): boolean {
  return (
    session.session_id !== activeSessionId &&
    session.turns >= MINIMUM_SESSION_CONTEXT_TURNS
  )
}

export function filterAssistantContextCandidates(
  candidates: readonly AssistantContextCandidate[],
  filter: AssistantSourceFilter
): AssistantContextCandidate[] {
  if (filter === 'recent') {
    return candidates
      .filter((candidate) => candidate.opened_at !== undefined)
      .sort((left, right) => (right.opened_at ?? 0) - (left.opened_at ?? 0))
  }
  if (filter === 'newest') {
    return candidates
      .slice()
      .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))
  }
  return [...candidates]
}
