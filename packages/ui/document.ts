export const OPENUI_SLOT = 'conversation.ui'
export const OPENUI_FORMAT = 'openui-lang'
export const OPENUI_VERSION = 1
export const OPENUI_ROOT = 'Conversation'
export const OPENUI_REGISTRY = 'host-v3'
export const OPENUI_LIMITS = Object.freeze({
  bytes: 65536,
  depth: 16,
  nodes: 512,
  items: 1024,
  statements: 512,
  parseMilliseconds: 1000,
  startupMilliseconds: 15000,
})

export interface ConversationDocument {
  format: typeof OPENUI_FORMAT
  version: typeof OPENUI_VERSION
  source: string
}

export interface ConversationLayout {
  component: typeof OPENUI_ROOT
  args: unknown[]
}
