import {
  OPENUI_FORMAT,
  OPENUI_LIMITS,
  OPENUI_ROOT,
  OPENUI_VERSION,
  type ConversationDocument,
  type ConversationLayout,
} from './document.ts'

export function bindConversationLayout(
  layout: ConversationLayout,
  data: Record<string, unknown>,
  components: readonly string[]
): ConversationDocument {
  const allowed = new Set(components)
  let budget = OPENUI_LIMITS.items
  function literal(value: unknown, depth: number): string {
    if (depth > OPENUI_LIMITS.depth || --budget < 0) throw new Error('openui_layout_budget')
    if (Array.isArray(value)) return `[${value.map(item => literal(item, depth + 1)).join(', ')}]`
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) return JSON.stringify(value)
    throw new Error('openui_layout_literal_invalid')
  }
  function serialize(value: unknown, depth: number): string {
    if (depth > OPENUI_LIMITS.depth || --budget < 0) throw new Error('openui_layout_budget')
    if (Array.isArray(value)) return `[${value.map(item => serialize(item, depth + 1)).join(', ')}]`
    if (value === null || ['boolean', 'number', 'string'].includes(typeof value))
      return literal(value, depth)
    if (!value || typeof value !== 'object') throw new Error('openui_layout_node_invalid')
    const node = value as Record<string, unknown>
    if (Object.keys(node).length === 1 && typeof node.field === 'string') {
      if (!Object.hasOwn(data, node.field)) throw new Error('openui_layout_field_invalid')
      return literal(data[node.field], depth + 1)
    }
    if (
      Object.keys(node).length !== 2 ||
      typeof node.component !== 'string' ||
      !allowed.has(node.component) ||
      !Array.isArray(node.args)
    ) throw new Error('openui_layout_node_invalid')
    return `${node.component}(${node.args.map(arg => serialize(arg, depth + 1)).join(', ')})`
  }
  if (layout.component !== OPENUI_ROOT) throw new Error('openui_layout_root_invalid')
  return { format: OPENUI_FORMAT, version: OPENUI_VERSION, source: `root = ${serialize(layout, 0)}` }
}
