import type { PluginScenario, PreviewResponse } from '../../../../plugins'

const PREVIEW_MAX_DEPTH = 32
const PREVIEW_UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PREVIEW_INPUT_REFERENCE = '$input'
const PREVIEW_STATE_REFERENCE = '$state'
const PREVIEW_DATA_REFERENCE = '$data'
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

function reference(root: Record<string, unknown>, path: unknown, fallback: unknown, optional: boolean): unknown {
  if (typeof path !== 'string') throw new Error('plugin_preview_reference_invalid')
  let value: unknown = root
  for (const key of path.split('.')) {
    if (PREVIEW_UNSAFE_KEYS.has(key)) throw new Error('plugin_preview_reference_invalid')
    if (!value || typeof value !== 'object' || !own(value, key)) {
      if (optional) return structuredClone(fallback)
      throw new Error('plugin_preview_reference_invalid')
    }
    value = (value as Record<string, unknown>)[key]
  }
  return structuredClone(value)
}

function resolve(value: unknown, input: Record<string, unknown>, state: Record<string, unknown>, data: Record<string, unknown>, depth = 0): unknown {
  if (depth > PREVIEW_MAX_DEPTH) throw new Error('plugin_preview_depth_exceeded')
  if (Array.isArray(value)) return value.map(item => resolve(item, input, state, data, depth + 1))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (Object.keys(object).every(key => [PREVIEW_INPUT_REFERENCE, PREVIEW_STATE_REFERENCE, PREVIEW_DATA_REFERENCE, '$default'].includes(key))) {
    if (own(object, PREVIEW_DATA_REFERENCE)) return reference(data, object[PREVIEW_DATA_REFERENCE], object.$default, own(object, '$default'))
    if (own(object, PREVIEW_INPUT_REFERENCE)) return reference(input, object[PREVIEW_INPUT_REFERENCE], object.$default, own(object, '$default'))
    if (own(object, PREVIEW_STATE_REFERENCE)) return reference(state, object[PREVIEW_STATE_REFERENCE], object.$default, own(object, '$default'))
  }
  if (own(object, '$if')) {
    const condition = resolve(object.$if, input, state, data, depth + 1)
    return resolve(condition === object.equals ? object.then : object.else, input, state, data, depth + 1)
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => {
    if (PREVIEW_UNSAFE_KEYS.has(key)) throw new Error('plugin_preview_reference_invalid')
    return [key, resolve(item, input, state, data, depth + 1)]
  }))
}

export function createPreviewSession(scenario: PluginScenario): {
  execute: (action: string, values: Record<string, unknown>) => PreviewResponse
} {
  let state = structuredClone(scenario.state ?? {})
  const calls = new Map<string, number>()
  return { execute(action, values) {
    const declaration = scenario.responses[action]
    if (!declaration) throw new Error('plugin_preview_response_missing')
    const attempt = calls.get(action) ?? 0
    const response = declaration.steps?.[attempt] ?? declaration
    const next = { ...state }
    for (const [key, value] of Object.entries(response.set ?? {})) {
      if (PREVIEW_UNSAFE_KEYS.has(key)) throw new Error('plugin_preview_reference_invalid')
      next[key] = resolve(value, values, state, scenario.data)
    }
    for (const [key, value] of Object.entries(response.append ?? {})) {
      if (PREVIEW_UNSAFE_KEYS.has(key) || !Array.isArray(next[key])) throw new Error('plugin_preview_state_invalid')
      next[key] = [...next[key] as unknown[], resolve(value, values, state, scenario.data)]
    }
    const data = resolve(response.data, values, next, scenario.data) as Record<string, unknown>
    state = next
    calls.set(action, attempt + 1)
    return { state: response.state, data }
  } }
}
