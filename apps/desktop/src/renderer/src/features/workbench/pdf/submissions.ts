import type { PdfAiTask } from './analysis'

/** A replacement waits for submission acknowledgement and cancellation, not model generation. */
export async function replaceSubmission(
  previous: Promise<PdfAiTask | undefined> | undefined,
  isCurrent: () => boolean,
  submit: () => Promise<PdfAiTask>,
  cancel: (taskId: string) => Promise<unknown>
): Promise<PdfAiTask | undefined> {
  if (previous) {
    // Failed submissions already have their own UI feedback and no acknowledged task.
    const task = await previous.catch(() => undefined)
    if (task && (task.status === 'pending' || task.status === 'running')) await cancel(task.task_id)
  }
  if (!isCurrent()) return undefined
  return submit()
}
