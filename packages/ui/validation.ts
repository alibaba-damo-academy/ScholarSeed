import { OPENUI_FORMAT, OPENUI_LIMITS, OPENUI_VERSION, type ConversationDocument } from './document.ts'

const FORBIDDEN_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const RESOURCE_PROPERTIES = new Set(['src', 'href', 'url'])
const EXECUTABLE_SOURCE = /\b(?:Query|Mutation)\s*\(|@\s*Run\b|\]\]>|<\/?script\b|=>|`/i
const OPENING = new Set(['(', '[', '{'])
const CLOSING: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function validateSource(source: string): void {
  if (!source.trim() || new TextEncoder().encode(source).byteLength > OPENUI_LIMITS.bytes)
    throw new Error('openui_source_size')
  const nesting: string[] = []
  let quote = ''
  let escaped = false
  let comment = false
  let syntax = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (comment) {
      if (character === '\n') comment = false
      else continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") { quote = character; syntax += ' '; continue }
    if (character === '#' || (character === '/' && source[index + 1] === '/')) { comment = true; continue }
    syntax += character
    if (OPENING.has(character)) {
      nesting.push(character)
      if (nesting.length > OPENUI_LIMITS.depth) throw new Error('openui_depth')
    } else if (CLOSING[character] && nesting.pop() !== CLOSING[character]) {
      throw new Error('openui_delimiter')
    }
  }
  if (quote || nesting.length) throw new Error('openui_incomplete')
  if (EXECUTABLE_SOURCE.test(syntax)) throw new Error('openui_executable_source')
}

export function validateEnvelope(value: unknown): ConversationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('openui_document')
  const document = value as Record<string, unknown>
  if (Object.keys(document).some(key => !['format', 'version', 'source'].includes(key)) ||
      document.format !== OPENUI_FORMAT || document.version !== OPENUI_VERSION || typeof document.source !== 'string')
    throw new Error('openui_document')
  validateSource(document.source)
  return document as unknown as ConversationDocument
}

export function validateTree(value: unknown, components: readonly string[]): void {
  const registered = new Set(components)
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  let items = 0
  while (stack.length) {
    const current = stack.pop()!
    if (current.depth > OPENUI_LIMITS.depth) throw new Error('openui_tree_depth')
    if (current.value === null || typeof current.value !== 'object') continue
    if (Array.isArray(current.value)) {
      items += current.value.length
      if (items > OPENUI_LIMITS.items) throw new Error('openui_items')
    } else {
      const object = current.value as Record<string, unknown>
      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('openui_property')
      if (object.type === 'element') {
        if (!registered.has(String(object.typeName))) throw new Error('openui_component')
        nodes += 1
        if (nodes > OPENUI_LIMITS.nodes) throw new Error('openui_nodes')
        const rules = (object.props as Record<string, unknown> | undefined)?.rules
        if (rules && typeof rules === 'object' && Object.hasOwn(rules, 'pattern')) throw new Error('openui_validation_rules')
        if (Object.hasOwn(object.props ?? {}, 'action')) throw new Error('openui_action')
      }
      if (Object.keys(object).some(key => FORBIDDEN_NAMES.has(key))) throw new Error('openui_property')
      if (Object.keys(object).some(key => RESOURCE_PROPERTIES.has(key))) throw new Error('openui_resource')
      if (typeof object.k === 'string') throw new Error('openui_dynamic_expression')
    }
    for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 })
  }
}
