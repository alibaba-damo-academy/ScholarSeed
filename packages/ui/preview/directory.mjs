import { contracts, GROUPS } from './catalog.mjs'
import { discover } from './schema.mjs'

export function createDirectory(exports, native = []) {
  const names = new Set(native.flatMap(entry => [entry.name, ...entry.aliases]))
  const discovered = [...native, ...discover(exports, contracts).filter(entry => !names.has(entry.name))]
    .sort((left, right) => left.name.localeCompare(right.name))
  const internal = discovered.filter((entry) => entry.internal)
  const entries = discovered.filter((entry) => !entry.internal)
  const sections = Object.entries(GROUPS).map(([id, label]) => ({
    id,
    label,
    items: entries.filter((entry) => entry.group === label),
  }))
  const missing = entries.filter((entry) => !Object.values(GROUPS).includes(entry.group))
  if (missing.length) sections.push({ id: 'missing', label: '缺少数据契约', items: missing })
  return { entries, sections, internal }
}
