import { LIMITS, validate } from './schema.mjs'
import zh from '../../../apps/desktop/src/localization/locales/zh/official.json' with { type: 'json' }

const PROPERTY_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'minimum', 'maximum', 'oneOf', 'anyOf', 'const', 'enum', 'default', 'description'])

export function nativeEntries(library, auxiliary, labels = {}, aliases = {}) {
  const schema = library.toJSONSchema()
  const names = new Set(Object.keys(library.components))
  const hidden = new Set([library.root, ...auxiliary])
  const convert = (input, ancestors = []) => {
    if (input.$ref) {
      const name = input.$ref.split('/').at(-1)
      if (!schema.$defs?.[name] || ancestors.includes(name)) throw new Error(`不能预览递归或未知 Schema：${name}`)
      const props = convert(schema.$defs[name], [...ancestors, name])
      return names.has(name) ? {
        type: 'object', properties: {
          type: { const: 'element' }, typeName: { const: name }, props, partial: { const: false },
        }, required: ['type', 'typeName', 'props', 'partial'], additionalProperties: false,
      } : props
    }
    const output = Object.fromEntries(Object.entries(input).filter(([key]) => PROPERTY_KEYS.has(key)))
    if (output.properties) output.properties = Object.fromEntries(Object.entries(output.properties).map(([key, value]) => [key, convert(value, ancestors)]))
    if (output.items) output.items = convert(output.items, ancestors)
    for (const union of ['oneOf', 'anyOf']) if (output[union]) output[union] = output[union].map(value => convert(value, ancestors))
    if (output.type === 'array') output.maxItems = Math.min(output.maxItems ?? LIMITS.rows, LIMITS.rows)
    if (!Object.keys(output).length) output.default = ['合成 A', '合成 B']
    return output
  }
  return [...names].filter(name => !hidden.has(name)).flatMap(name => {
    const props = convert(schema.$defs[name])
    const group = labels[name]?.group ?? library.componentGroups?.find(group => group.components.includes(name))?.name ?? '正文与富内容'
    const variant = group === '图表' ? ['variant', 'type'].find(key => props.properties?.[key]?.enum?.length > 1) : undefined
    const variants = variant ? props.properties[variant].enum : [undefined]
    return variants.map((value, index) => {
      const previewName = index ? `${name}/${value}` : (labels[name]?.nativePreviewName ?? name)
      return {
        name: previewName,
        component: name,
        label: zh.labels[previewName] ?? `${labels[name]?.label ?? name}${value ? ` · ${value}` : ''}`,
        group,
        aliases: Object.entries(aliases).filter(([, alias]) => alias.component === name && alias.variant === value).map(([alias]) => alias),
        native: true,
        schema: value ? { ...props, properties: { ...props.properties, [variant]: { const: value, default: value } } } : props,
      }
    })
  })
}

export function nativeTree(component, props, root) {
  return { type: 'element', typeName: root,
    props: { children: [{ type: 'element', typeName: component, props, partial: false }] }, partial: false }
}

export function previewExamples(entries, examples, labels = {}) {
  const result = {}
  for (const [name, presets] of Object.entries(examples)) {
    const requested = entries.find(entry => entry.name === name || entry.aliases.includes(name))
    for (const preset of presets) {
      let owner = requested
      if (requested?.native && validate(requested.schema, preset.data).length) {
        const candidates = entries.filter(entry => !entry.native && entry.schema && !validate(entry.schema, preset.data).length)
        if (candidates.length === 1) owner = candidates[0]
      }
      const target = owner?.name ?? name
      const routed = owner && owner !== requested
        ? { ...preset, id: `${name}/${preset.id}`, label: `${labels[name]?.label ?? name} · ${preset.label}` }
        : preset
      result[target] ??= []
      result[target].push(routed)
    }
  }
  return result
}

export function groupedPreviewExamples(entries, presets, owner, group) {
  return entries.filter(entry => entry.name === owner || entry.group === group).flatMap(entry =>
    (presets[entry.name] ?? []).map(preset => ({
      ...preset,
      id: `${entry.name}/${preset.id}`,
      sample: entry.name,
    }))
  )
}
