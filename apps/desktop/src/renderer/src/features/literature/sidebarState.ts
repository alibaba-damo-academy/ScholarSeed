import { useEffect, useState } from 'react'

const PREFIX = 'shushen.literature.sidebar.v1.'
function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null') } catch { return null }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* Session state still works when storage is unavailable. */ }
}
export function useSidebarBoolean(key: string, fallback = true) {
  const [value, setValue] = useState(() => { const saved = read(key); return typeof saved === 'boolean' ? saved : fallback })
  useEffect(() => write(key, value), [key, value])
  return [value, setValue] as const
}
export function useSidebarSet(key: string) {
  const [value, setValue] = useState<Set<string>>(() => {
    const saved = read(key)
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [])
  })
  useEffect(() => write(key, [...value]), [key, value])
  return [value, setValue] as const
}
