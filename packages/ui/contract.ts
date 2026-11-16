import type React from 'react'
import type { useTranslation } from 'react-i18next'
import type * as controls from './controls'
import type { catalog } from './catalog'
import type * as Conversation from './conversation'
import type { createLiteraturePorts } from './ports'
import type { ChartExporter } from '../../apps/desktop/src/renderer/src/components/ui/charting'

export interface CardState {
  revision?: number
  slot: string
  language: string
  theme?: string
  status: string
  data: Record<string, unknown>
  draft?: Record<string, unknown>
}

export interface CardBridge {
  exportPlot?: ChartExporter
  copyPlot?: ChartExporter
  copyText?: (text: string) => Promise<unknown>
  setCopyContent: (content: { text: string; markdown?: string }) => Promise<unknown>
  onState: (callback: (state: CardState) => void) => () => void
  submit: (action: string, values: Record<string, unknown>) => void
  save: (values: Record<string, unknown>) => Promise<unknown>
  request: (action: string, values: Record<string, unknown>) => Promise<unknown>
}

export interface OfficialUI extends Readonly<typeof controls> {
  React: typeof React
  Conversation: typeof Conversation
  Plot: typeof Conversation.Plot
  DataTable: typeof Conversation.DataTable
  createLiteraturePorts: typeof createLiteraturePorts
  catalog: typeof catalog
  useTranslation: typeof useTranslation
  useCopyContent: (text: string | null) => void
  version: string
  compatibility: string
  mount: (render: (state: CardState) => React.ReactNode) => () => void
}

declare global {
  interface Window {
    scholarseedUI: OfficialUI
    plugin: CardBridge
  }
}
