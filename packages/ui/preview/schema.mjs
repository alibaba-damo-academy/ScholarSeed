export const PROFILES = Object.freeze({
  normal: '常规',
  empty: '空集合',
  long: '长文本',
  dense: '密集数据',
})
export const LIMITS = Object.freeze({ text: 65536, rows: 64, long: 12, dense: 24 })
const HASH_OFFSET = 2166136261
const HASH_PRIME = 16777619
const WORD_BITS = 32
const RANGE = 2 ** WORD_BITS
const RANDOM_OFFSET = 0x6d2b79f5
const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'uniqueItems',
  'oneOf',
  'anyOf',
  'allOf',
  'if',
  'then',
  'else',
  'const',
  'enum',
  'default',
  'title',
  'description',
  '$comment',
  'x-rule',
  'x-count',
  'x-kind',
])

export function assertSchema(schema, path = '$') {
  for (const key of Object.keys(schema))
    if (!KEYWORDS.has(key)) throw new Error(`${path}：未支持的 Schema 关键词 ${key}`)
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    assertSchema(child, `${path}.${key}`)
  if (schema.items) assertSchema(schema.items, `${path}[]`)
  for (const child of schema.oneOf ?? []) assertSchema(child, path)
  for (const child of schema.anyOf ?? []) assertSchema(child, path)
  for (const child of schema.allOf ?? []) assertSchema(child, path)
  for (const key of ['if', 'then', 'else'])
    if (schema[key]) assertSchema(schema[key], path)
}

export const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
export const text = (title = '说明') => ({
  type: 'string',
  title,
  minLength: 1,
  maxLength: LIMITS.text,
  'x-rule': 'text',
})
export const constant = (value) => ({ const: value })
export const choice = (...values) => ({ enum: values })
export const number = (minimum = 0, maximum = 100) => ({ type: 'integer', minimum, maximum })
export const list = (items, count = 3) => ({
  type: 'array',
  items,
  maxItems: LIMITS.rows,
  'x-count': count,
})
export const identifier = () => ({ type: 'string', minLength: 1, maxLength: 128, 'x-rule': 'id' })

export function random(seed) {
  let state = HASH_OFFSET
  for (const character of String(seed))
    state = Math.imul(state ^ character.codePointAt(0), HASH_PRIME)
  return () => {
    state += RANDOM_OFFSET
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / RANGE
  }
}

export function generate(schema, seed, rules, profile = 'normal') {
  assertSchema(schema)
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('未知数据场景：' + profile)
  const next = random(seed)
  const context = {
    next,
    profile,
    integer: (minimum, maximum) => minimum + Math.floor(next() * (maximum - minimum + 1)),
  }
  const visit = (entry) => {
    if (Object.hasOwn(entry, 'const')) return structuredClone(entry.const)
    if (Object.hasOwn(entry, 'default')) return structuredClone(entry.default)
    if (entry['x-rule']) {
      const rule = rules[entry['x-rule']]
      if (!rule) throw new Error('未实现生成规则：' + entry['x-rule'])
      return rule(context, entry, visit)
    }
    if (entry.enum) return entry.enum[context.integer(0, entry.enum.length - 1)]
    if (entry.oneOf) return visit(entry.oneOf[context.integer(0, entry.oneOf.length - 1)])
    if (entry.anyOf) return visit(entry.anyOf[context.integer(0, entry.anyOf.length - 1)])
    if (Array.isArray(entry.type))
      return visit({ ...entry, type: entry.type.find((value) => value !== 'null') ?? 'null' })
    switch (entry.type) {
      case 'object':
        return Object.fromEntries(
          Object.entries(entry.properties).filter(([key, value]) =>
            (entry.required ?? []).includes(key) || Object.hasOwn(value, 'default') || value.type === 'array'
          ).map(([key, value]) => [key, visit(value)])
        )
      case 'array': {
        const desired =
          entry['x-count'] === 0
            ? 0
            : profile === 'empty'
              ? 0
              : profile === 'dense'
                ? LIMITS.dense
                : (entry['x-count'] ?? 3)
        return Array.from(
          {
            length: Math.max(entry.minItems ?? 0, Math.min(entry.maxItems ?? LIMITS.rows, desired)),
          },
          () => visit(entry.items)
        )
      }
      case 'integer':
        return context.integer(entry.minimum ?? 0, entry.maximum ?? 100)
      case 'number':
        return (entry.minimum ?? 0) + next() * ((entry.maximum ?? 100) - (entry.minimum ?? 0))
      case 'boolean':
        return next() > 0.5
      case 'null':
        return null
      case 'string':
        return `${entry.title ?? '内容'} ${context.integer(1, 9999)}`
      default:
        throw new Error('不支持的生成 schema：' + JSON.stringify(entry))
    }
  }
  return visit(schema)
}

export function validate(schema, value, path = '$') {
  const errors = []
  const fail = (message) => errors.push(`${path}：${message}`)
  for (const child of schema.allOf ?? []) errors.push(...validate(child, value, path))
  if (schema.if) {
    const branch = validate(schema.if, value, path).length ? schema.else : schema.then
    if (branch) errors.push(...validate(branch, value, path))
  }
  if (Object.hasOwn(schema, 'const')) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const))
      fail('应为 ' + JSON.stringify(schema.const))
    return errors
  }
  if (schema.enum) {
    if (!schema.enum.includes(value))
      fail('应为 ' + schema.enum.map((item) => JSON.stringify(item)).join(' / '))
    return errors
  }
  if (schema.oneOf) {
    if (schema.oneOf.filter((entry) => validate(entry, value, path).length === 0).length !== 1)
      fail('必须符合且仅符合一个数据分支')
    return errors
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some(entry => validate(entry, value, path).length === 0)) fail('必须符合至少一个数据分支')
    return errors
  }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (
    schema.type !== undefined && !types.some(
      (type) =>
        type === actual || (type === 'integer' && actual === 'number' && Number.isInteger(value))
    )
  ) {
    fail('应为 ' + types.join(' / '))
    return errors
  }
  if (actual === 'object') {
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}：缺少必填字段`)
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_NAMES.has(key)) errors.push(`${path}.${key}：不允许此字段`)
      else if (Object.hasOwn(schema.properties ?? {}, key))
        errors.push(...validate(schema.properties[key], child, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}：未知字段`)
    }
  }
  if (actual === 'array') {
    if (value.length < (schema.minItems ?? 0)) fail('条目过少')
    if (value.length > (schema.maxItems ?? Infinity)) fail('条目过多')
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      fail('条目必须唯一')
    if (schema.items)
      value.forEach((item, index) =>
        errors.push(...validate(schema.items, item, `${path}[${index}]`))
      )
  }
  if (
    actual === 'string' &&
    (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))
  )
    fail('文本长度不符合限制')
  if (
    actual === 'number' &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    fail('数值不在允许范围内')
  return errors
}

export function discover(exports, contracts) {
  const candidates = Object.entries(exports)
    .filter(
      ([name, component]) =>
        /^[A-Z]/.test(name) &&
        (typeof component === 'function' ||
          (component && typeof component === 'object' && '$$typeof' in component))
    )
    .map(([name]) => ({ name, ...contracts[name], missing: !Object.hasOwn(contracts, name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const groups = new Map()
  for (const entry of candidates) {
    const component = exports[entry.name]
    if (!groups.has(component)) groups.set(component, [])
    groups.get(component).push(entry)
  }
  return Array.from(groups.values(), (entries) => {
    const canonical =
      entries.find((entry) => !entry.missing && !entry.aliasOf) ??
      entries.find((entry) => !entry.missing) ??
      entries[0]
    return {
      ...canonical,
      aliases: entries.filter((entry) => entry !== canonical).map((entry) => entry.name),
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}
