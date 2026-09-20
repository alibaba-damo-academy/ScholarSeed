import { useEffect, useState } from 'react'

const PREFIX = 'scholarseed.literature.sidebar.v1.'
const LEGACY_PREFIX = 'shushen.literature.sidebar.v1.'
type SidebarStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readSidebarState(key: string, storage?: SidebarStorage): unknown {
  try {
    const target = storage ?? localStorage
    const current = target.getItem(PREFIX + key)
    if (current !== null) return JSON.parse(current)
    const legacy = target.getItem(LEGACY_PREFIX + key)
    if (legacy === null) return null
    const value: unknown = JSON.parse(legacy)
    writeSidebarState(key, value, target)
    return value
  } catch {
    return null
  }
}

export function writeSidebarState(key: string, value: unknown, storage?: SidebarStorage): void {
  try {
    const target = storage ?? localStorage
    target.setItem(PREFIX + key, JSON.stringify(value))
    target.removeItem(LEGACY_PREFIX + key)
  } catch { /* Session state still works when storage is unavailable. */ }
}
export function useSidebarBoolean(key: string, fallback = true) {
  const [value, setValue] = useState(() => { const saved = readSidebarState(key); return typeof saved === 'boolean' ? saved : fallback })
  useEffect(() => writeSidebarState(key, value), [key, value])
  return [value, setValue] as const
}
export function useSidebarSet(key: string) {
  const [value, setValue] = useState<Set<string>>(() => {
    const saved = readSidebarState(key)
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [])
  })
  useEffect(() => writeSidebarState(key, [...value]), [key, value])
  return [value, setValue] as const
}
