import { createParser, type ASTNode, type LibraryJSONSchema } from '@openuidev/lang-core'
import { OPENUI_LIMITS } from './document'
import { validateSource } from './validation'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ source: string; schema: LibraryJSONSchema; root: string }>) => void) | null
  postMessage: (value: { ready?: boolean; valid?: boolean; error?: string; bindings?: Record<string, string>; defaults?: Record<string, unknown> }) => void
}

scope.postMessage({ ready: true })
scope.onmessage = ({ data }) => {
  try {
    validateSource(data.source)
    const result = createParser(data.schema, data.root).parse(data.source)
    if (!result.root || result.rootExpression || result.meta.incomplete || result.meta.errors.length || result.meta.unresolved.length ||
        result.meta.statementCount > OPENUI_LIMITS.statements || result.queryStatements.length || result.mutationStatements.length)
      throw new Error('canvas_description_invalid')
    const allowed = new Set(Object.keys(data.schema.properties ?? {}))
    const bindings: Record<string, string> = {}
    const stack = [{ value: result.root as unknown, depth: 0 }]
    let nodes = 0
    while (stack.length) {
      const { value, depth } = stack.pop()!
      if (depth > OPENUI_LIMITS.depth) throw new Error('canvas_tree_depth')
      if (!value || typeof value !== 'object') continue
      if (++nodes > OPENUI_LIMITS.nodes + OPENUI_LIMITS.items) throw new Error('canvas_tree_size')
      const object = value as Record<string, unknown>
      if (object.type === 'element') {
        const props = object.props as Record<string, unknown>
        const binding = props?.value as ASTNode | undefined
        if (typeof props?.name === 'string' && binding?.k === 'StateRef') bindings[props.name] = binding.n
        else if (typeof props?.name === 'string' && binding?.k === 'Assign') bindings[props.name] = binding.target
      }
      if (object.type === 'element' && !allowed.has(String(object.typeName))) throw new Error('canvas_component_unknown')
      if (Object.keys(object).some(key => ['__proto__', 'constructor', 'prototype', 'action', 'href', 'src', 'url', 'pattern'].includes(key)))
        throw new Error('canvas_capability_unavailable')
      for (const child of Object.values(object)) stack.push({ value: child, depth: depth + 1 })
    }
    scope.postMessage({ valid: true, bindings, defaults: result.stateDeclarations })
  } catch (failure) {
    scope.postMessage({ valid: false, error: failure instanceof Error ? failure.message : 'canvas_validation_failed' })
  }
}
