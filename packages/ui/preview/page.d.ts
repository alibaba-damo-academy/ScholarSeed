import type { ReactElement } from 'react'
import type { ComponentType } from 'react'
import type { PreviewEntry } from './directory.mjs'

export interface PreviewExample {
  id: string
  label?: string
  labelKey?: string
  sample?: string
  data: unknown
}

export interface PreviewCollection {
  entries: PreviewEntry[]
  storageKey: string
  examples?: Record<string, PreviewExample[]>
  canvas?: boolean
  render: ComponentType<{ name: string; data: unknown; onAction: (message: string) => void; surface?: 'conversation' | 'sidebar' | 'canvas' }>
}

export function Preview(props?: {
  sample?: string
  example?: string
  onOpenWebSource?: (url: string) => void | Promise<void>
  collection?: PreviewCollection
}): ReactElement
