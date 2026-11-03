import { unzipSync, zipSync } from 'fflate'

import { OOXML_NS, readXml, relationshipOwner, resolvePart, writeXml } from './xml.ts'

const DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DIAGRAM_RELATIONSHIP = 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing'
const IMAGE_RELATIONSHIP = `${OFFICE_RELATIONSHIPS}/image`
const SLIDE_RELATIONSHIPS = /^ppt\/slides\/_rels\/[^/]+\.xml\.rels$/
const PREVIEW_RELATIONSHIP_PREFIX = 'rIdPreviewDiagram'
const EXTERNAL_TARGET = 'External'

function relations(document: XMLDocument): Element[] {
  return Array.from(document.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship'))
}

function relationshipPart(owner: string): string {
  const segments = owner.split('/')
  const name = segments.pop()!
  return [...segments, '_rels', `${name}.rels`].join('/')
}

/** SmartArt children inherit slide rels in the pinned reader. Project only image ownership. */
export function diagramPreview(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes)
  const documents = new Map<string, XMLDocument>()
  const usedIds = new Set<string>()
  for (const [path, content] of Object.entries(entries)) {
    if (!path.endsWith('.rels')) continue
    const document = readXml(content)
    documents.set(path, document)
    for (const relation of relations(document)) usedIds.add(relation.getAttribute('Id') ?? '')
  }
  const owners = new Map<string, Set<string>>()
  for (const [path, document] of documents) {
    if (!SLIDE_RELATIONSHIPS.test(path)) continue
    for (const relation of relations(document)) {
      if (
        relation.getAttribute('Type') !== DIAGRAM_RELATIONSHIP ||
        relation.getAttribute('TargetMode') === EXTERNAL_TARGET
      )
        continue
      const target = relation.getAttribute('Target')
      if (!target) continue
      const drawing = resolvePart(relationshipOwner(path), target)
      const slides = owners.get(drawing) ?? new Set<string>()
      slides.add(path)
      owners.set(drawing, slides)
    }
  }
  let sequence = 0
  let changed = false
  for (const [path, slides] of owners) {
    const content = entries[path]
    const sourceRelations = documents.get(relationshipPart(path))
    if (!content || !sourceRelations) continue
    const drawing = readXml(content)
    const replacements = new Map<string, { id: string; target: string }>()
    for (const blip of Array.from(drawing.getElementsByTagNameNS(DRAWING_NAMESPACE, 'blip'))) {
      const oldId = blip.getAttributeNS(OFFICE_RELATIONSHIPS, 'embed')
      if (!oldId) continue
      const source = relations(sourceRelations).find(
        (relation) => relation.getAttribute('Id') === oldId
      )
      if (
        !source ||
        source.getAttribute('Type') !== IMAGE_RELATIONSHIP ||
        source.getAttribute('TargetMode') === EXTERNAL_TARGET
      )
        continue
      const target = source.getAttribute('Target')
      if (!target) continue
      let replacement = replacements.get(oldId)
      if (!replacement) {
        let id: string
        do {
          id = `${PREVIEW_RELATIONSHIP_PREFIX}${++sequence}`
        } while (usedIds.has(id))
        usedIds.add(id)
        replacement = {
          id,
          target: `/${resolvePart(path, target).split('/').map(encodeURIComponent).join('/')}`,
        }
        replacements.set(oldId, replacement)
      }
      blip.setAttributeNS(OFFICE_RELATIONSHIPS, 'r:embed', replacement.id)
    }
    if (!replacements.size) continue
    entries[path] = writeXml(drawing)
    for (const slidePath of slides) {
      const document = documents.get(slidePath)!
      for (const { id, target } of replacements.values()) {
        const relation = document.createElementNS(OOXML_NS.relationships, 'Relationship')
        relation.setAttribute('Id', id)
        relation.setAttribute('Type', IMAGE_RELATIONSHIP)
        relation.setAttribute('Target', target)
        document.documentElement.appendChild(relation)
      }
      entries[slidePath] = writeXml(document)
    }
    changed = true
  }
  return changed ? zipSync(entries) : bytes
}
