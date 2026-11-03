import ExcelJS from 'exceljs'
import { unzipSync, zipSync } from 'fflate'

import { OOXML_NS, readXml, relationshipOwner, resolvePart, writeXml } from './xml.ts'

const TABLE_PART = /^xl\/tables\/table\d+\.xml$/
const WORKBOOK_XML_PART = /^xl\/.*\.xml$/
const WORKSHEET_RELATIONSHIPS_PART = /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/
const TABLE_TARGET = /^xl\/tables\/(table\d+\.xml)$/
const TABLE_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const TABLE_READ_FILTERS = new Set(['iconFilter'])
const DEFAULT_ICON_SET = '3TrafficLights1'
const ICON_SET_COUNTS: Readonly<Record<string, number>> = {
  '3Arrows': 3,
  '3ArrowsGray': 3,
  '3Flags': 3,
  '3TrafficLights1': 3,
  '3TrafficLights2': 3,
  '3Signs': 3,
  '3Symbols': 3,
  '3Symbols2': 3,
  '4Arrows': 4,
  '4ArrowsGray': 4,
  '4RedToBlack': 4,
  '4Rating': 4,
  '4TrafficLights': 4,
  '5Arrows': 5,
  '5ArrowsGray': 5,
  '5Rating': 5,
  '5Quarters': 5,
}

function normalizeSpreadsheetNamespaces(document: XMLDocument): boolean {
  const prefixed = Array.from(document.getElementsByTagNameNS(OOXML_NS.spreadsheet, '*')).filter(
    (element) => element.prefix
  )
  for (const element of prefixed) {
    const replacement = document.createElementNS(OOXML_NS.spreadsheet, element.localName)
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name !== 'xmlns') {
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      }
    }
    replacement.setAttributeNS(XMLNS_NAMESPACE, 'xmlns', OOXML_NS.spreadsheet)
    while (element.firstChild) replacement.appendChild(element.firstChild)
    element.parentNode!.replaceChild(replacement, element)
  }
  return prefixed.length > 0
}

function normalizeTableRelationships(document: XMLDocument, owner: string): boolean {
  let changed = false
  for (const relation of Array.from(
    document.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')
  )) {
    if (
      relation.getAttribute('Type') !== TABLE_RELATIONSHIP ||
      relation.getAttribute('TargetMode') === 'External'
    )
      continue
    const target = relation.getAttribute('Target') || ''
    const table = TABLE_TARGET.exec(resolvePart(owner, target))
    if (!table) continue
    const relative = `../tables/${table[1]}`
    if (target === relative) continue
    relation.setAttribute('Target', relative)
    changed = true
  }
  return changed
}

/** ExcelJS rejects iconFilter in tables. The grid does not execute table filters. */
export function workbookPreview(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes)
  let changed = false
  for (const [path, content] of Object.entries(entries)) {
    if (WORKSHEET_RELATIONSHIPS_PART.test(path)) {
      const document = readXml(content)
      if (normalizeTableRelationships(document, relationshipOwner(path))) {
        entries[path] = writeXml(document)
        changed = true
      }
      continue
    }
    if (!WORKBOOK_XML_PART.test(path)) continue
    const document = readXml(content)
    let partChanged = normalizeSpreadsheetNamespaces(document)
    if (!TABLE_PART.test(path)) {
      if (partChanged) {
        entries[path] = writeXml(document)
        changed = true
      }
      continue
    }
    for (const name of TABLE_READ_FILTERS) {
      for (const filter of Array.from(
        document.getElementsByTagNameNS(OOXML_NS.spreadsheet, name)
      )) {
        const iconId = filter.getAttribute('iconId') ?? ''
        const count = ICON_SET_COUNTS[filter.getAttribute('iconSet') || DEFAULT_ICON_SET]
        if (
          !count ||
          !/^\d+$/.test(iconId) ||
          Number(iconId) >= count ||
          Array.from(filter.childNodes).some((node) => node.nodeType === filter.nodeType)
        )
          continue
        const column = filter.parentNode as Element | null
        const autoFilter = column?.parentNode as Element | null
        if (
          column?.localName !== 'filterColumn' ||
          column.namespaceURI !== OOXML_NS.spreadsheet ||
          autoFilter?.localName !== 'autoFilter' ||
          autoFilter.namespaceURI !== OOXML_NS.spreadsheet ||
          autoFilter.parentNode !== document.documentElement ||
          document.documentElement.localName !== 'table' ||
          document.documentElement.namespaceURI !== OOXML_NS.spreadsheet
        )
          continue
        column.removeChild(filter)
        partChanged = true
      }
    }
    if (partChanged) {
      entries[path] = writeXml(document)
      changed = true
    }
  }
  return changed ? zipSync(entries) : bytes
}

export async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Uint8Array.from(workbookPreview(bytes)).buffer)
  return book
}
