import { listAllSessions, type ServeSession, type SessionListOptions } from '../../api.ts'

export async function listTaskHistory(
  options: SessionListOptions,
  active: () => boolean
): Promise<ServeSession[] | null> {
  const sessions = await listAllSessions({ ...options, includeAgentReplyAt: true }, active)
  return (
    sessions?.sort(
      (left, right) =>
        (right.last_agent_reply_at ?? 0) - (left.last_agent_reply_at ?? 0) ||
        right.session_id.localeCompare(left.session_id)
    ) ?? null
  )
}
