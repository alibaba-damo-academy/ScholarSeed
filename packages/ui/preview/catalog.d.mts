export interface PreviewContract {
  label: string
  group: string
  schema: Record<string, unknown>
  adapter: string
  description: string
  aliasOf?: string
  internal?: string
  sidebar?: { name: string; props?: Record<string, unknown> }
  previewGroup?: string
}

export const GROUPS: Readonly<{
  content: string
  charts: string
  research: string
  citations: string
  artifacts: string
  foundations: string
}>

export const contracts: Record<string, PreviewContract>
