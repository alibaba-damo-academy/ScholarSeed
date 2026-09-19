import type { SelectionLocator } from '../../contracts/workbench'
import { sseData } from '../../sse'
import type { TranslationTarget } from './language'

export type ResourceAction = 'explain' | 'polish' | 'translate'
export interface ResourceInput {
  source: { project_id: string; source_id: string; source_revision: string }
  scope: 'selection'
  selection: { locator: SelectionLocator; selected_text: string; selected_text_hash: string }
  draft?: { change_version: number; selected_text: string; context_text: string; selected_text_hash: string }
}
export interface ResourceRequest extends ResourceInput {
  model_key: string
  instruction: string
  client_action_id: string
  client_attempt_id: string
  retry_of_attempt_id?: string
  target_language?: TranslationTarget
}
export interface ResourceResult {
  task_id: string
  invocation_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  output: string
  model_key: string
  error_code: string
  error_detail: string
}
export interface ResourceActivity { type: 'accepted' | 'started' | 'output_delta' | 'output_completed'; invocation_id: string; text: string; item_id: string }
const PREFIX = '/api/resource/ai'
const base = (): string => window.scholarseed?.getApiBase() ?? ''
const ACTIVITIES = new Set(['accepted', 'started', 'output_delta', 'output_completed'])

export async function invokeResource(action: ResourceAction, request: ResourceRequest, signal: AbortSignal, observe: (event: ResourceActivity) => void): Promise<ResourceResult> {
  const response = await fetch(base() + PREFIX + '/' + action, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(request)
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(typeof payload?.detail === 'string' ? payload.detail : `http_${response.status}`)
  }
  if (!response.body) throw new Error('resource_stream_incomplete')
  let id = ''
  for await (const frame of sseData(response.body)) {
    const event = JSON.parse(frame)
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'result') {
      const result = event.result as ResourceResult
      if (!result?.task_id || typeof result.output !== 'string' || (id && id !== result.task_id)) throw new Error('resource_stream_incomplete')
      return result
    }
    if (!ACTIVITIES.has(event.type) || !event.invocation_id || (id && id !== event.invocation_id)) throw new Error('resource_stream_incomplete')
    id = event.invocation_id
    observe(event)
  }
  throw new Error('resource_stream_incomplete')
}

export async function cancelResource(taskId: string): Promise<boolean> {
  const response = await fetch(`${base()}${PREFIX}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', credentials: 'include' })
  return response.ok
}
