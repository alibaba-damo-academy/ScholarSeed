import { strFromU8, strToU8 } from 'fflate'

export const OOXML_NS = {
  relationships: 'http://schemas.openxmlformats.org/package/2006/relationships',
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  spreadsheet: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
} as const

export function readXml(bytes: Uint8Array): XMLDocument {
  const document = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('Invalid OOXML part')
  return document
}

export function writeXml(document: XMLDocument): Uint8Array<ArrayBuffer> {
  return strToU8(new XMLSerializer().serializeToString(document))
}

export function relationshipOwner(path: string): string {
  return path.replace(/(^|\/)_rels\//, '$1').replace(/\.rels$/, '')
}

export function resolvePart(owner: string, target: string): string {
  const segments = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const segment of decodeURI(target).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) throw new Error('OOXML relationship escapes package')
      segments.pop()
    } else segments.push(segment)
  }
  return segments.join('/')
}
