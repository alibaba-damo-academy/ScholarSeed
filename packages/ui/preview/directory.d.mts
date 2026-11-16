export interface PreviewEntry {
  name: string
  label?: string
  group?: string
  aliases: string[]
  missing: boolean
}

export interface PreviewSection {
  id: string
  label: string
  items: PreviewEntry[]
}

export function createDirectory(exports: Record<string, unknown>): {
  entries: PreviewEntry[]
  sections: PreviewSection[]
}
