/** Public renderer contract for one isolated Agent invocation. */

export const AGENT_INVOCATION_EVENT_SCHEMA_VERSION = 1
export const AGENT_INVOCATION_STARTED_EVENT = 'invocation.started'
export const AGENT_INVOCATION_COMPLETED_EVENT = 'result.completed'
export const AGENT_INVOCATION_FAILED_EVENT = 'invocation.failed'
export const AGENT_INVOCATION_INTERRUPTED_EVENT = 'invocation.interrupted'
export const AGENT_INVOCATION_UNKNOWN_EVENT = 'invocation.unknown'
export const AGENT_INVOCATION_INTERACTION_REQUIRED_EVENT = 'interaction.required'

export const AGENT_INVOCATION_TERMINAL_EVENTS = new Set([
  AGENT_INVOCATION_COMPLETED_EVENT,
  AGENT_INVOCATION_FAILED_EVENT,
  AGENT_INVOCATION_INTERRUPTED_EVENT,
  AGENT_INVOCATION_UNKNOWN_EVENT
])

export type AgentInvocationSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AgentInvocationReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface AgentInvocationExecution {
  web_search: boolean | 'optional'
  sandbox: AgentInvocationSandbox
  network_access: boolean
  reasoning_effort: AgentInvocationReasoningEffort | null
  service_tier: string
}

export interface AgentInvocationRequest {
  prompt: string
  developer_prompt?: boolean
  skill?: { id: string; profile?: string }
  execution: AgentInvocationExecution
}

export interface AgentInvocationArtifact {
  artifact_id: string
  relative_path: string
  role: string
  mime_type: string
  size_bytes: number
  sha256: string
}

export interface AgentInvocationEvent {
  schema_version: typeof AGENT_INVOCATION_EVENT_SCHEMA_VERSION
  invocation_id: string
  seq: number
  type: string
  turn_id: string
  item_id: string
  data: Record<string, unknown>
  created_at: number
}

export interface AgentInvocationInteractionResponse {
  decision: string
  values: Record<string, unknown>
}

export type AgentInvocationInteractionHandler = (
  event: AgentInvocationEvent
) => Promise<AgentInvocationInteractionResponse | null>

export type AgentInvocationStreamResult =
  | {
      ok: true
      status: number
      terminal: AgentInvocationEvent
    }
  | {
      ok: false
      status: number
      error: string
      code?: string
      terminal?: AgentInvocationEvent
    }

export type AgentInvocationArtifactTextResult =
  | { ok: true; status: number; text: string }
  | { ok: false; status: number; error: string; code?: string }

export type AgentInvocationInteractionResult =
  | { ok: true; status: number }
  | { ok: false; status: number; error: string; code?: string }
