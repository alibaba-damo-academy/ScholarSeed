export const TRASH_COMPLETION_RETRY_DELAY_MS = 100
export const TRASH_COMPLETION_MAX_ATTEMPTS = 30
export const TRASH_NOT_COMPLETED_ERROR = 'trash_not_completed'

export interface TrashCompletionAttempt {
  ok: boolean
  retryable?: boolean
  error?: string
}

export type TrashCompletionRequest = () => Promise<TrashCompletionAttempt>
export type TrashCompletionSleep = (milliseconds: number) => Promise<void>

export async function waitForTrashCompletion(
  request: TrashCompletionRequest,
  sleep: TrashCompletionSleep = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
): Promise<TrashCompletionAttempt> {
  let last: TrashCompletionAttempt = { ok: false, error: TRASH_NOT_COMPLETED_ERROR }
  for (let attempt = 0; attempt < TRASH_COMPLETION_MAX_ATTEMPTS; attempt += 1) {
    last = await request()
    if (last.ok || !last.retryable) return last
    if (attempt + 1 < TRASH_COMPLETION_MAX_ATTEMPTS) {
      await sleep(TRASH_COMPLETION_RETRY_DELAY_MS)
    }
  }
  return last
}
