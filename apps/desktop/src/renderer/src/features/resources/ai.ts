import type { SelectionLocator } from '../../contracts/workbench.ts'
import type { AssistantTranslationTarget } from '../../contracts/assistant.ts'
import { postActionStream, type ActionActivity } from '../../action.ts'
import { apiFetch } from '../../api.ts'

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
  target_language?: AssistantTranslationTarget
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
export type ResourceActivity = ActionActivity
const PREFIX = '/api/resource/ai'
const STREAM_ERROR = 'resource_stream_incomplete'

function parseResourceResult(value: unknown): ResourceResult | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  return typeof result.task_id === 'string' && result.task_id
    && typeof result.invocation_id === 'string' && result.invocation_id === result.task_id
    && typeof result.output === 'string'
    ? result as unknown as ResourceResult
    : null
}

export async function invokeResource(action: ResourceAction, request: ResourceRequest, signal: AbortSignal, observe: (event: ResourceActivity) => void): Promise<ResourceResult> {
  return postActionStream({
    path: PREFIX + '/' + action,
    body: request,
    signal,
    protocolError: STREAM_ERROR,
    parseResult: parseResourceResult,
    onActivity: observe
  })
}

export async function cancelResource(taskId: string): Promise<boolean> {
  const response = await apiFetch(`${PREFIX}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
  return response.ok
}
