import type { ElementBounds, TargetLocator, TargetSummary } from './model.ts'

const TARGET_TEXT_MAX_LENGTH = 80
const TARGET_CONTAINER_LIMIT = 4
const INTERACTIVE_TARGET_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select'])
const SEMANTIC_TARGET_SELECTOR = [
  '[data-testid]',
  '[aria-label]',
  '[role]',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]'
].join(',')

function visibleText(element: Element): string {
  return String(element.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TARGET_TEXT_MAX_LENGTH)
}

function normalizedText(value: string | null | undefined): string | undefined {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, TARGET_TEXT_MAX_LENGTH) : undefined
}

function referencedName(element: Element): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (!labelledBy || typeof document.getElementById !== 'function') return undefined
  return normalizedText(labelledBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' '))
}

function associatedLabel(element: Element): string | undefined {
  if (!('labels' in element)) return undefined
  const labels = (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).labels
  return normalizedText(Array.from(labels || [], (label) => label.textContent || '').join(' '))
}

function accessibleName(element: Element, ariaLabel: string | undefined): string | undefined {
  return normalizedText(ariaLabel) || referencedName(element) || associatedLabel(element)
}

function locator(
  tag: string,
  testId: string | undefined,
  ariaLabel: string | undefined,
  role: string | undefined,
  text: string | undefined,
  id: string | undefined,
  name: string | undefined,
  href: string | undefined
): TargetLocator {
  if (testId) return { kind: 'testId', value: testId }
  if (ariaLabel) return { kind: 'ariaLabel', value: ariaLabel }
  if (id) return { kind: 'id', value: id }
  if (name) return { kind: 'name', value: name }
  if (href) return { kind: 'href', value: href }
  if (role && text) return { kind: 'roleName', value: `${role}\n${text}` }
  if (text) return { kind: 'text', value: text }
  return { kind: 'tag', value: tag }
}

function implicitRole(tag: string, href: string | undefined): string | undefined {
  if (tag === 'button') return 'button'
  if (tag === 'a' && href) return 'link'
  return undefined
}

function containerTestIds(element: Element): readonly string[] {
  const values: string[] = []
  let parent = element.parentElement
  while (parent && values.length < TARGET_CONTAINER_LIMIT) {
    const testId = parent.getAttribute('data-testid')
    if (testId && !values.includes(testId)) values.push(testId)
    parent = parent.parentElement
  }
  return values
}

function bounds(element: Element): ElementBounds | undefined {
  if (typeof element.getBoundingClientRect !== 'function') return undefined
  const rect = element.getBoundingClientRect()
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every(Number.isFinite)) return undefined
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

export function summarizeTarget(target: EventTarget | null): TargetSummary {
  if (!(target instanceof Element)) return { tag: 'unknown' }
  const element = target.closest(SEMANTIC_TARGET_SELECTOR) || target
  const role = element.getAttribute('role') || undefined
  const ariaLabel = element.getAttribute('aria-label') || undefined
  const elementAccessibleName = accessibleName(element, ariaLabel)
  const testId = element.getAttribute('data-testid') || undefined
  const text = visibleText(element) || undefined
  const id = element.getAttribute('id') || undefined
  const name = element.getAttribute('name') || undefined
  const href = element.getAttribute('href') || undefined
  const containers = containerTestIds(element)
  const elementBounds = bounds(element)
  return {
    tag: element.tagName.toLowerCase(),
    ...(testId ? { testId } : {}),
    ...(role ? { role } : {}),
    ...(ariaLabel ? { ariaLabel } : {}),
    ...(elementAccessibleName ? { accessibleName: elementAccessibleName } : {}),
    ...(text ? { text } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(href ? { href } : {}),
    locator: locator(
      element.tagName.toLowerCase(),
      testId,
      ariaLabel,
      role || implicitRole(element.tagName.toLowerCase(), href),
      text,
      id,
      name,
      href
    ),
    ...(containers.length ? { containerTestIds: containers } : {}),
    ...(elementBounds ? { bounds: elementBounds } : {})
  }
}

export function targetLabel(target: TargetSummary): string {
  return target.testId || target.ariaLabel || target.role || target.text || target.tag
}

export function targetDisplayLabel(target: TargetSummary): string {
  if (target.accessibleName) return target.accessibleName
  if (target.ariaLabel) return target.ariaLabel
  if ((target.role || INTERACTIVE_TARGET_TAGS.has(target.tag)) && target.text) return target.text
  return target.testId || target.text || target.role || target.tag
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

export function targetLocatorLabel(target: TargetSummary): string {
  const targetLocator = target.locator
  if (!targetLocator) return targetLabel(target)
  switch (targetLocator.kind) {
    case 'testId': return `[data-testid=${quoted(targetLocator.value)}]`
    case 'ariaLabel': return `${target.tag}[aria-label=${quoted(targetLocator.value)}]`
    case 'roleName': {
      const [role, name] = targetLocator.value.split('\n', 2)
      return `role=${role}, name=${quoted(name || '')}`
    }
    case 'id': return `#${targetLocator.value}`
    case 'name': return `${target.tag}[name=${quoted(targetLocator.value)}]`
    case 'href': return `${target.tag}[href=${quoted(targetLocator.value)}]`
    case 'text': return `${target.tag}, text=${quoted(targetLocator.value)}`
    case 'tag': return targetLocator.value
  }
}
