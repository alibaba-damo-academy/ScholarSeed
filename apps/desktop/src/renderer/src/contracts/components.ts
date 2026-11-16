import type { ReactNode } from 'react'
import type { i18n } from 'i18next'
import type { PluginRequestHandler, PluginCopyContent } from '../../../plugins'

export interface PublicComponentProps {
  slot: string
  data: Record<string, unknown>
  status: string
  onAction: (action: string, values: Record<string, unknown>) => void | Promise<void>
  onRequest?: PluginRequestHandler
  draft?: Record<string, unknown>
  onDraft?: (values: Record<string, unknown>) => Promise<unknown>
}
export interface PublicComponentContribution {
  copy?: (
    data: Record<string, unknown>,
    localization: i18n,
    context?: { cardId?: string }
  ) => PluginCopyContent | null | Promise<PluginCopyContent | null>
  slot: string
  legacyOnly?: boolean
  hosted?: boolean
  render: (props: PublicComponentProps) => ReactNode
}
