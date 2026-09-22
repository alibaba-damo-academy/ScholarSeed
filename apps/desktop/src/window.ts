export const LOGIN_WINDOW_CHANNEL = 'scholarseed:login-window'
export const LOGIN_WINDOW_SIZE = { width: 900, height: 600 } as const
export const WORKSPACE_WINDOW_SIZE = { width: 1280, height: 840 } as const
export const WORKSPACE_WINDOW_MINIMUM = { width: 1040, height: 660 } as const

export const WINDOW_CLOSE_PLATFORM = 'win32'
export const WINDOW_CLOSE_REQUEST_CHANNEL = 'scholarseed:window-close-request'
export const WINDOW_CLOSE_REPLY_CHANNEL = 'scholarseed:window-close-reply'
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
