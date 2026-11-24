export const LOGIN_WINDOW_CHANNEL = 'scholarseed:login-window'
export const LOGIN_WINDOW_SIZE = { width: 900, height: 600 } as const
export const WORKSPACE_WINDOW_SIZE = { width: 1280, height: 840 } as const
export const WORKSPACE_WINDOW_MINIMUM = { width: 1040, height: 660 } as const

export const WINDOW_CLOSE_PLATFORM = 'win32'
export const WINDOW_CLOSE_REQUEST_CHANNEL = 'scholarseed:window-close-request'
export const WINDOW_CLOSE_REPLY_CHANNEL = 'scholarseed:window-close-reply'
export const WINDOW_FULLSCREEN_CHANNEL = 'scholarseed:window-fullscreen'
export const STARTUP_TASK_RECOVERY_MS = 15_000
export const TASK_RECOVERY_CHANNEL = {
  status: 'scholarseed:task-recovery-status',
  begin: 'scholarseed:task-recovery-begin',
  finish: 'scholarseed:task-recovery-finish',
  manualOpen: 'scholarseed:task-recovery-manual-open',
} as const
export const TASK_RECOVERY_STATUS = {
  eligible: 'eligible',
  home: 'home',
  attempted: 'attempted',
} as const
export type TaskRecoveryStatus = (typeof TASK_RECOVERY_STATUS)[keyof typeof TASK_RECOVERY_STATUS]
export interface TaskRecoverySnapshot {
  status: TaskRecoveryStatus
  skippedSessionId: string | null
  needsManualAcknowledgement: boolean
  preparedToken?: string
}
export const TASK_RECOVERY_OUTCOME = { restored: 'restored', skipped: 'skipped' } as const
export type TaskRecoveryOutcome = (typeof TASK_RECOVERY_OUTCOME)[keyof typeof TASK_RECOVERY_OUTCOME]
export interface TaskRecoveryBridge {
  getTaskRecoveryStatus(sessionId: string | null): Promise<TaskRecoverySnapshot>
  beginTaskRecovery(sessionId: string): Promise<string | null>
  finishTaskRecovery(token: string, outcome: TaskRecoveryOutcome): Promise<boolean>
  clearTaskRecoveryOnManualOpen(sessionId: string): Promise<boolean>
}

export const WINDOW_CLOSE_ACTION = { cancel: 'cancel', minimize: 'minimize', quit: 'quit' } as const
export type WindowCloseAction = typeof WINDOW_CLOSE_ACTION[keyof typeof WINDOW_CLOSE_ACTION]
export type WindowCloseRequest = number | null
export interface WindowCloseReply {
  requestId: number
  action: WindowCloseAction
  remember: boolean
}

export function isWindowCloseReply(value: unknown): value is WindowCloseReply {
  if (!value || typeof value !== 'object') return false
  const reply = value as Partial<WindowCloseReply>
  return typeof reply.requestId === 'number' && Number.isSafeInteger(reply.requestId)
    && reply.requestId > 0 && typeof reply.remember === 'boolean'
    && Object.values(WINDOW_CLOSE_ACTION).some((action) => action === reply.action)
}
