const COLLECTION_TAG = 0x74746366 // ttcf
const COLLECTION_VERSION_1 = 0x00010000
const COLLECTION_VERSION_2 = 0x00020000
const SIGNATURE_TAG = 0x44534947 // DSIG
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031])
const COLLECTION_HEADER_BYTES = 12
const SIGNATURE_HEADER_BYTES = 12
const OFFSET_BYTES = 4
const SFNT_HEADER_BYTES = 12
const TABLE_RECORD_BYTES = 16
const NAME_TABLE_TAG = 0x6e616d65
const VARIATION_TABLE_TAG = 0x66766172
const NAME_HEADER_BYTES = 6
const NAME_RECORD_BYTES = 12
const LANGUAGE_RECORD_BYTES = 4
const POSTSCRIPT_NAME_ID = 6
const VARIATION_HEADER_BYTES = 16
const AXIS_RECORD_BYTES = 20
const INSTANCE_HEADER_BYTES = 4
const OPTIONAL_NAME_BYTES = 2
const NO_POSTSCRIPT_NAME = 0xffff

function invalid(detail: string): never {
  throw new Error(`Invalid Office font collection: ${detail}`)
}

function range(view: DataView, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset > view.byteLength || length > view.byteLength - offset) {
    invalid('table data is out of bounds')
  }
}

function region(view: DataView, offset: number, length: number): DataView {
  range(view, offset, length)
  return new DataView(view.buffer, view.byteOffset + offset, length)
}

function instanceNameIds(table: DataView): number[] {
  range(table, 0, VARIATION_HEADER_BYTES)
  if (table.getUint16(0) !== 1) invalid('unsupported variation table version')
  const axesOffset = table.getUint16(4)
  const axisCount = table.getUint16(8)
  const axisSize = table.getUint16(10)
  const instanceCount = table.getUint16(12)
  const instanceSize = table.getUint16(14)
  const minimumInstanceSize = INSTANCE_HEADER_BYTES + axisCount * OFFSET_BYTES
  if (axesOffset < VARIATION_HEADER_BYTES || axisSize < AXIS_RECORD_BYTES
    || instanceSize < minimumInstanceSize) invalid('invalid variation record sizes')
  range(table, axesOffset, axisCount * axisSize)
  const instancesOffset = axesOffset + axisCount * axisSize
  range(table, instancesOffset, instanceCount * instanceSize)
  const ids: number[] = []
  if (instanceSize >= minimumInstanceSize + OPTIONAL_NAME_BYTES) {
    for (let index = 0; index < instanceCount; index += 1) {
      const id = table.getUint16(instancesOffset + index * instanceSize + minimumInstanceSize)
      if (id !== NO_POSTSCRIPT_NAME) ids.push(id)
    }
  }
  return ids
}

function postscriptName(bytes: DataView, platform: number, encoding: number): string | null {
  const unicode = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))
  const roman = platform === 1 && encoding === 0
  if ((!unicode && !roman) || !bytes.byteLength || (unicode && bytes.byteLength % 2)) return null
  let name = ''
  for (let index = 0; index < bytes.byteLength; index += unicode ? 2 : 1) {
    const character = unicode ? bytes.getUint16(index) : bytes.getUint8(index)
    // PostScript names share the printable ASCII subset of UTF-16BE and Mac Roman.
    if (character < 0x21 || character > 0x7e) return null
    name += String.fromCharCode(character)
  }
  return name
}

function names(table: DataView, ids: ReadonlySet<number>): Set<string> {
  range(table, 0, NAME_HEADER_BYTES)
  const format = table.getUint16(0)
  if (format !== 0 && format !== 1) invalid('unsupported name table format')
  const count = table.getUint16(2)
  const storage = table.getUint16(4)
  let recordsEnd = NAME_HEADER_BYTES + count * NAME_RECORD_BYTES
  range(table, NAME_HEADER_BYTES, count * NAME_RECORD_BYTES)
  if (format === 1) {
    range(table, recordsEnd, OPTIONAL_NAME_BYTES)
    const languageCount = table.getUint16(recordsEnd)
    recordsEnd += OPTIONAL_NAME_BYTES
    range(table, recordsEnd, languageCount * LANGUAGE_RECORD_BYTES)
    for (let index = 0; index < languageCount; index += 1) {
      const record = recordsEnd + index * LANGUAGE_RECORD_BYTES
      range(table, storage + table.getUint16(record + 2), table.getUint16(record))
    }
    recordsEnd += languageCount * LANGUAGE_RECORD_BYTES
  }
  if (storage < recordsEnd) invalid('name strings overlap records')
  range(table, storage, 0)
  const result = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    const record = NAME_HEADER_BYTES + index * NAME_RECORD_BYTES
    const bytes = region(table, storage + table.getUint16(record + 10), table.getUint16(record + 8))
    if (!ids.has(table.getUint16(record + 6))) continue
    const name = postscriptName(bytes, table.getUint16(record), table.getUint16(record + 2))
    if (name) result.add(name)
  }
  return result
}

/** Native name tables identify a variable face even when OS instance names are synthesized. */
export function fontPostscriptNames(nameTable: Uint8Array): string[] {
  const table = new DataView(nameTable.buffer, nameTable.byteOffset, nameTable.byteLength)
  const result = [...names(table, new Set([POSTSCRIPT_NAME_ID]))]
  if (!result.length) invalid('missing PostScript base font name')
  return result
}

function nativeFaceIndices(indices: readonly number[] | undefined, count: number): Set<number> | undefined {
  if (indices === undefined) return undefined
  if (!indices.length) invalid('empty native face index catalog')
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) invalid('native face index is out of bounds')
  }
  return new Set(indices)
}

function faceNames(view: DataView, offset: number, collectionHeaderSize: number): Set<string> {
  if (offset < collectionHeaderSize) invalid('face directory overlaps collection header')
  range(view, offset, SFNT_HEADER_BYTES)
  if (!SFNT_VERSIONS.has(view.getUint32(offset))) invalid('unsupported font format')
  const count = view.getUint16(offset + 4)
  range(view, offset + SFNT_HEADER_BYTES, count * TABLE_RECORD_BYTES)
  let nameTable: DataView | undefined
  let variationTable: DataView | undefined
  for (let index = 0; index < count; index += 1) {
    const record = offset + SFNT_HEADER_BYTES + index * TABLE_RECORD_BYTES
    const tag = view.getUint32(record)
    const tableOffset = view.getUint32(record + 8)
    const length = view.getUint32(record + 12)
    if (length && tableOffset < collectionHeaderSize) invalid('table overlaps collection header')
    const table = region(view, tableOffset, length)
    if (tag === NAME_TABLE_TAG) {
      if (nameTable) invalid('duplicate name table')
      nameTable = table
    }
    if (tag === VARIATION_TABLE_TAG) {
      if (variationTable) invalid('duplicate variation table')
      variationTable = table
    }
  }
  if (!nameTable) invalid('missing name table')
  return names(nameTable, new Set([POSTSCRIPT_NAME_ID, ...(variationTable ? instanceNameIds(variationTable) : [])]))
}

/** Restrict TTC directory entries to OS-enumerated faces; all font tables remain byte-identical. */
export function selectFontCollection(bytes: Uint8Array, postscriptNames: readonly string[], faceIndices?: readonly number[]): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  range(view, 0, OFFSET_BYTES)
  if (view.getUint32(0) !== COLLECTION_TAG) {
    if (!SFNT_VERSIONS.has(view.getUint32(0))) invalid('unsupported font format')
    nativeFaceIndices(faceIndices, 1)
    return bytes
  }
  const wanted = new Set(postscriptNames)
  range(view, 0, COLLECTION_HEADER_BYTES)
  const version = view.getUint32(4)
  if (version !== COLLECTION_VERSION_1 && version !== COLLECTION_VERSION_2) invalid('unsupported TTC version')
  const count = view.getUint32(8)
  if (!count) invalid('empty TTC directory')
  const explicitIndices = nativeFaceIndices(faceIndices, count)
  if (!explicitIndices && !wanted.size) invalid('empty system font catalog')
  const offsetsEnd = COLLECTION_HEADER_BYTES + count * OFFSET_BYTES
  const headerSize = offsetsEnd + (version === COLLECTION_VERSION_2 ? SIGNATURE_HEADER_BYTES : 0)
  range(view, 0, headerSize)
  if (version === COLLECTION_VERSION_2) {
    const tag = view.getUint32(offsetsEnd)
    const length = view.getUint32(offsetsEnd + 4)
    const offset = view.getUint32(offsetsEnd + 8)
    if (tag !== 0 && tag !== SIGNATURE_TAG) invalid('invalid collection signature tag')
    if (tag === 0 && (length || offset)) invalid('invalid collection signature metadata')
    if (tag === SIGNATURE_TAG) range(view, offset, length)
  }
  const selected: number[] = []
  const found = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    const offset = view.getUint32(COLLECTION_HEADER_BYTES + index * OFFSET_BYTES)
    const matching = [...faceNames(view, offset, headerSize)].filter(name => wanted.has(name))
    if (explicitIndices ? !explicitIndices.has(index) : !matching.length) continue
    selected.push(offset)
    for (const name of matching) found.add(name)
  }
  const missing = explicitIndices ? [] : [...wanted].filter(name => !found.has(name))
  if (missing.length) invalid(`catalog names were not found: ${missing.join(', ')}`)
  if (selected.length === count) return bytes
  // A v1 header has no collection signature; offsets remain relative to the original file.
  // TTC head.checksumAdjustment is unused, and no table or table checksum changes here.
  const selectedBytes = new Uint8Array(bytes)
  const selectedView = new DataView(selectedBytes.buffer)
  selectedView.setUint32(4, COLLECTION_VERSION_1)
  selectedView.setUint32(8, selected.length)
  selected.forEach((offset, index) => selectedView.setUint32(COLLECTION_HEADER_BYTES + index * OFFSET_BYTES, offset))
  return selectedBytes
}
