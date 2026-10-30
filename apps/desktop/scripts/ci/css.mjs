/** CSS ownership: immutable legacy rule identities plus reviewed vendor overrides. */
import { createHash } from 'node:crypto'
import postcss from 'postcss'

const HASH_ALGORITHM = 'sha256'
const FORBIDDEN_AT_RULES = new Set(['apply'])
const CONTAINER_PATTERN = /^\.[a-zA-Z_][\w-]*$/
const TAILWIND_IMPORT = /^(['"])tailwindcss\1(?:\s+source\(none\))?$/
const TAILWIND_SOURCE = /^(['"])[^'"\r\n]+\1$/

function shape(node) {
  if (node.type === 'comment') return null
  if (node.type === 'decl') return ['decl', node.prop, node.value.trim(), Boolean(node.important)]
  return [node.type, node.selector ?? node.name, node.params?.trim() ?? '',
    node.nodes?.map(shape).filter(Boolean) ?? []]
}

/** Record each rule's own declarations; child rules carry the ancestor context. */
export function cssInventory(source, path = 'source.css') {
  const entries = []
  function visit(node, ancestors) {
    if (node.type === 'comment') return
    const context = [...ancestors, node.type === 'rule' ? node.selector : `@${node.name} ${node.params ?? ''}`]
    const leaves = node.nodes?.filter((child) => child.type === 'decl') ?? []
    if (leaves.length || !node.nodes) {
      const identity = JSON.stringify([context, leaves.length ? leaves.map(shape) : shape(node)])
      entries.push({ context: context.join(' → '), digest: createHash(HASH_ALGORITHM).update(identity).digest('hex') })
    }
    for (const child of node.nodes ?? []) if (child.type !== 'decl') visit(child, context)
  }
  const root = postcss.parse(source, { from: path })
  for (const node of root.nodes) visit(node, [])
  return entries
}

export function validateCssExceptions(exceptions) {
  const errors = []
  const seen = new Set()
  for (const entry of exceptions) {
    const label = `${entry.path}: ${entry.selector}`
    for (const field of ['path', 'scope', 'selector', 'library', 'reason', 'verification']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(`${label}: missing ${field}`)
    }
    if (!CONTAINER_PATTERN.test(entry.scope ?? '')) errors.push(`${label}: scope must be one integration class`)
    try {
      const parsed = postcss.parse(`${entry.selector} {}`)
      const rule = parsed.nodes[0]
      if (parsed.nodes.length !== 1 || rule?.type !== 'rule' || !rule.selectors.every((selector) => selector.startsWith(`${entry.scope} `))) {
        errors.push(`${label}: every selector must be inside the integration scope`)
      }
    } catch { errors.push(`${label}: invalid selector`) }
    if (seen.has(label)) errors.push(`${label}: duplicate exception`)
    seen.add(label)
  }
  return errors
}

export function cssDebtErrors(sources, baseline, exceptions = []) {
  const errors = validateCssExceptions(exceptions)
  if (errors.length) return errors
  for (const [path, source] of sources) {
    const allowed = new Map()
    for (const entry of baseline[path] ?? []) allowed.set(entry.digest, (allowed.get(entry.digest) ?? 0) + 1)
    const root = postcss.parse(source, { from: path })
    const tailwindEntry = root.nodes.some((node) => node.type === 'atrule' && node.name === 'import' && !node.nodes && TAILWIND_IMPORT.test(node.params))
    for (const node of [...root.nodes]) {
      if (node.type !== 'atrule' || node.nodes) continue
      if ((node.name === 'import' && TAILWIND_IMPORT.test(node.params)) ||
          (tailwindEntry && node.name === 'source' && TAILWIND_SOURCE.test(node.params))) node.remove()
    }
    root.walkAtRules((node) => {
      if (FORBIDDEN_AT_RULES.has(node.name)) errors.push(`${path}: @${node.name} bypasses Tailwind ownership`)
    })
    const vendor = exceptions.filter((entry) => entry.path === path)
    // Only top-level, exact vendor selectors are exceptions; nested contexts need separate review.
    for (const rule of [...root.nodes]) {
      if (rule.type === 'rule' && vendor.some((entry) => entry.selector === rule.selector) &&
          rule.nodes.every((node) => node.type === 'decl' || node.type === 'comment')) rule.remove()
    }
    for (const entry of cssInventory(root.toString(), path)) {
      const remaining = allowed.get(entry.digest) ?? 0
      if (remaining > 0) allowed.set(entry.digest, remaining - 1)
      else errors.push(`${path}: new or changed owned CSS must use Tailwind: ${entry.context}`)
    }
  }
  return errors
}
