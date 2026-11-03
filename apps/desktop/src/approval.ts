export const BROWSER_APPROVAL_RESPONSE_CHANNEL = 'scholarseed:browser-approval-response'
export const BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL = 'scholarseed:browser-history-approval-response'

export interface BrowserHistoryApprovalResponseRequest {
  sessionId: string
  requestId: string
  proofId: string
  turnId: string
  search: string
  offset: number
  limit: number
  intent: string
  queryDigest: string
  historyRevision: number
  expiresAt: number
  decision: 'deny' | 'allow_once'
}

export type BrowserHistoryApprovalResponseReply = BrowserApprovalResponseReply

export interface BrowserApprovalResponseRequest {
  sessionId: string
  requestId: string
  proofId: string
  turnId: string
  tabId: string
  targetInstanceId: string
  targetGeneration: number
  origin: string
  sourceOrigin?: string | null
  destinationUrl?: string
  destinationOrigin?: string
  preparedId?: string
  snapshotId?: string
  elementRef?: string
  browserAction?: 'click' | 'fill' | 'submit'
  element?: { role: string; name: string }
  action: string
  intent: string
  expiresAt: number
  decision: 'deny' | 'allow_once'
}

export interface BrowserApprovalResponseReply {
  ok: boolean
  outcome?: 'unknown' | 'stale'
  interaction?: { state?: string; decision?: string; reason?: string }
}
