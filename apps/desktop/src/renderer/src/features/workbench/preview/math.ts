import { strFromU8, unzipSync, zipSync } from 'fflate'

import { readXml, writeXml } from './xml.ts'
import { mathFontText } from './math-fonts.ts'

export const WORD_MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'

function children(element: Element): Element[] {
  return Array.from(element.childNodes).filter(
    (node): node is Element => node.nodeType === node.ELEMENT_NODE
  )
}

function part(element: Element, name: string, required = true): Element | undefined {
  const found = children(element).filter(
    (node) => node.namespaceURI === WORD_MATH_NS && node.localName === name
  )
  if (found.length > 1 || (required && !found.length)) {
    throw new Error(`Invalid equation argument: ${name}`)
  }
  return found[0]
}

function property(element: Element, group: string, name: string): string | null {
  return (
    part(part(element, group, false) ?? element, name, false)?.getAttributeNS(
      WORD_MATH_NS,
      'val'
    ) ?? null
  )
}

const EXPRESSIONS = ['r', 'f', 'rad', 'acc', 'sSub', 'sSup', 'sSubSup']
const CONTENT_RULES = new Map<string, readonly string[]>([
  ...['oMath', 'e', 'sub', 'sup', 'num', 'den', 'deg'].map((name): [string, string[]] => [
    name,
    EXPRESSIONS,
  ]),
  ['r', ['rPr', 't']],
  ['rPr', ['sty', 'scr']],
  ['f', ['fPr', 'num', 'den']],
  ['fPr', ['type']],
  ['rad', ['radPr', 'deg', 'e']],
  ['radPr', ['degHide']],
  ['acc', ['accPr', 'e']],
  ['accPr', ['chr']],
  ['sSub', ['sSubPr', 'e', 'sub']],
  ['sSubPr', []],
  ['sSup', ['sSupPr', 'e', 'sup']],
  ['sSupPr', []],
  ['sSubSup', ['sSubSupPr', 'e', 'sub', 'sup']],
  ['sSubSupPr', []],
  ...['t', 'sty', 'scr', 'type', 'degHide', 'chr'].map((name): [string, string[]] => [name, []]),
])
const REQUIRED_PARTS: Readonly<Record<string, readonly string[]>> = {
  r: ['t'],
  f: ['num', 'den'],
  rad: ['e'],
  acc: ['e'],
  sSub: ['e', 'sub'],
  sSup: ['e', 'sup'],
  sSubSup: ['e', 'sub', 'sup'],
}
const PROPERTY_VALUES = new Map<string, readonly string[]>([
  ['sty', ['p', 'b', 'i', 'bi']],
  ['scr', ['roman', 'script', 'fraktur', 'double-struck', 'sans-serif', 'monospace']],
  ['type', ['bar', 'skw', 'noBar']],
  ['degHide', ['0', '1', 'false', 'true', 'off', 'on']],
])

function verify(source: Element): void {
  const allowed = CONTENT_RULES.get(source.localName)
  if (source.namespaceURI !== WORD_MATH_NS || !allowed) {
    throw new Error(`Unsupported equation structure: ${source.localName}`)
  }
  for (const attribute of Array.from(source.attributes)) {
    if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue
    if (
      source.localName === 't' &&
      attribute.namespaceURI === 'http://www.w3.org/XML/1998/namespace' &&
      attribute.localName === 'space' &&
      ['default', 'preserve'].includes(attribute.value)
    )
      continue
    if (
      ['sty', 'scr', 'type', 'degHide', 'chr'].includes(source.localName) &&
      attribute.namespaceURI === WORD_MATH_NS &&
      attribute.localName === 'val'
    )
      continue
    throw new Error(`Unsupported equation attribute: ${source.localName}`)
  }
  const nodes = children(source)
  if (
    nodes.some((node) => node.namespaceURI !== WORD_MATH_NS || !allowed.includes(node.localName))
  ) {
    throw new Error(`Unsupported equation child: ${source.localName}`)
  }
  if (
    source.localName !== 't' &&
    Array.from(source.childNodes).some(
      (node) =>
        (node.nodeType === node.TEXT_NODE || node.nodeType === node.CDATA_SECTION_NODE) &&
        node.textContent?.trim()
    )
  ) {
    throw new Error(`Unexpected equation text: ${source.localName}`)
  }
  const required = REQUIRED_PARTS[source.localName] ?? []
  for (const name of required) part(source, name)
  // Argument containers can contain repeated expression nodes. Fixed shapes
  // and property groups have at most one of each declared child.
  if (!['oMath', 'e', 'sub', 'sup', 'num', 'den', 'deg'].includes(source.localName)) {
    for (const name of allowed) part(source, name, required.includes(name))
  }
  const values = PROPERTY_VALUES.get(source.localName)
  if (
    values &&
    !(source.localName === 'degHide' && !source.hasAttributeNS(WORD_MATH_NS, 'val')) &&
    !values.includes(source.getAttributeNS(WORD_MATH_NS, 'val') ?? '')
  ) {
    throw new Error(`Unsupported equation property value: ${source.localName}`)
  }
  if (
    source.localName === 'chr' &&
    [...(source.getAttributeNS(WORD_MATH_NS, 'val') ?? '')].length !== 1
  ) {
    throw new Error('Unsupported equation accent character')
  }
  for (const node of nodes) verify(node)
}

/** Translate structure, never infer mathematics from flattened text or numbers. */
function expression(source: Element, document: Document): Element {
  const make = (tag: string, nodes: Node[] = []): Element => {
    const result = document.createElementNS(MATHML_NS, tag)
    for (const node of nodes) result.appendChild(node)
    return result
  }
  const content = (element: Element): Element[] =>
    children(element)
      .filter(
        (node) =>
          !['rPr', 'fPr', 'radPr', 'accPr', 'sSubPr', 'sSupPr', 'sSubSupPr'].includes(
            node.localName
          )
      )
      .map((node) => expression(node, document))
  const argument = (name: string): Element => expression(part(source, name)!, document)
  const operator = (value: string): Element => {
    const result = make('mo')
    result.textContent = value
    return result
  }
  if (source.namespaceURI !== WORD_MATH_NS) {
    throw new Error('Unsupported equation namespace')
  }
  switch (source.localName) {
    case 'oMath':
      return make('math', content(source))
    case 'e':
    case 'sub':
    case 'sup':
    case 'num':
    case 'den':
    case 'deg':
      return make('mrow', content(source))
    case 'r': {
      // OMML runs carry text and declared styling, not content-MathML token
      // classes. Preserve literal runs; obtain relationships from their
      // structural arguments rather than guessing from a value's spelling.
      const result = make('mtext')
      const text = children(source).filter((node) => !node.localName.endsWith('Pr'))
      if (text.some((node) => node.namespaceURI !== WORD_MATH_NS || node.localName !== 't')) {
        throw new Error('Unsupported equation run content')
      }
      const style = property(source, 'rPr', 'sty')
      const script = property(source, 'rPr', 'scr')
      result.textContent = mathFontText(text.map((node) => node.textContent ?? '').join(''), script)
      const bold = style === 'b' || style === 'bi'
      const italic = style === 'i' || style === 'bi'
      // Weight and slant are source-document data. CSS is needed because the
      // browser's Core MathML renderer ignores the legacy mathvariant values.
      if (bold || italic) {
        result.setAttribute(
          'style',
          [bold ? 'font-weight:bold' : '', italic ? 'font-style:italic' : '']
            .filter(Boolean)
            .join(';')
        )
      }
      return result
    }
    case 'f': {
      const result = make('mfrac', [argument('num'), argument('den')])
      const type = property(source, 'fPr', 'type')
      if (type === 'noBar') result.setAttribute('linethickness', '0')
      if (type === 'skw') result.setAttribute('bevelled', 'true')
      return result
    }
    case 'sSub':
      return make('msub', [argument('e'), argument('sub')])
    case 'sSup':
      return make('msup', [argument('e'), argument('sup')])
    case 'sSubSup':
      return make('msubsup', [argument('e'), argument('sub'), argument('sup')])
    case 'rad': {
      const degree = part(source, 'deg', false)
      const hidden = property(source, 'radPr', 'degHide')
      const hideNode = part(part(source, 'radPr', false) ?? source, 'degHide', false)
      const hide =
        hideNode &&
        (!hideNode.hasAttributeNS(WORD_MATH_NS, 'val') ||
          hidden === '1' ||
          hidden === 'true' ||
          hidden === 'on')
      return degree && degree.textContent && !hide
        ? make('mroot', [argument('e'), expression(degree, document)])
        : make('msqrt', [argument('e')])
    }
    case 'acc': {
      const result = make('mover', [
        argument('e'),
        operator(property(source, 'accPr', 'chr') ?? '\u0302'),
      ])
      result.setAttribute('accent', 'true')
      return result
    }
    default:
      throw new Error(`Unsupported equation structure: ${source.localName}`)
  }
}

export interface WordMathPreview {
  bytes: Uint8Array
  restore(nodes: readonly Node[]): Node[]
}

/**
 * The pinned reader drops sSubSup and acc, including their base operands.
 * Give it opaque roots, then restore exact MathML before mounting. Markers map
 * individual source roots; natural nested scripts are never guessed or merged.
 * This projection cannot be saved: sessions, editing and anchors use source bytes.
 */
export function mathPreview(bytes: Uint8Array): WordMathPreview {
  const entries = unzipSync(bytes)
  const prefix = `scholarseedmath${crypto.randomUUID().replace(/-/g, '')}`
  const roots = new Map<string, { source: Element; block: boolean }>()
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith('word/') || !path.endsWith('.xml')) continue
    const xml = strFromU8(data)
    if (xml.includes(prefix)) throw new Error('Duplicate preview equation identity')
    // XML can encode characters inside a namespace URI. The element's local
    // name is a safe cheap filter; the parser resolves namespace identity.
    if (!xml.includes('oMath')) continue
    const document = readXml(data)
    let changed = false
    for (const root of Array.from(document.getElementsByTagNameNS(WORD_MATH_NS, 'oMath'))) {
      if (
        !['sSubSup', 'acc'].some((name) => root.getElementsByTagNameNS(WORD_MATH_NS, name).length)
      )
        continue
      const token = `${prefix}n${roots.size}end`
      const parent = root.parentNode as Element | null
      roots.set(token, {
        source: root.cloneNode(true) as Element,
        block: parent?.namespaceURI === WORD_MATH_NS && parent.localName === 'oMathPara',
      })
      while (root.firstChild) root.removeChild(root.firstChild)
      const run = document.createElementNS(WORD_MATH_NS, 'm:r')
      const text = document.createElementNS(WORD_MATH_NS, 'm:t')
      text.textContent = token
      run.appendChild(text)
      root.appendChild(run)
      changed = true
    }
    if (changed) entries[path] = writeXml(document)
  }
  return {
    bytes: roots.size ? zipSync(entries) : bytes,
    restore(nodes) {
      if (!roots.size) return Array.from(nodes)
      const visit = (node: Node): Node => {
        if (node.nodeType === node.ELEMENT_NODE) {
          const element = node as Element
          const original = roots.get(element.textContent ?? '')
          if (original && element.namespaceURI === MATHML_NS && element.localName === 'math') {
            verify(original.source)
            const result = expression(original.source, element.ownerDocument)
            if (original.block) result.setAttribute('display', 'block')
            return result
          }
        }
        for (const child of Array.from(node.childNodes ?? [])) {
          const restored = visit(child)
          if (restored !== child) node.replaceChild(restored, child)
        }
        return node
      }
      const result = nodes.map(visit)
      if (result.some((node) => node.textContent?.includes(prefix))) {
        throw new Error('Unresolved preview equation identity')
      }
      return result
    },
  }
}
