// Native metadata contracts; these do not replace Desktop layout acceptance.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const policy = require('./toolchain.json')

const leaseLibrary = process.env.SCHOLARSEED_LEASE_LIBRARY
const library = process.env.SCHOLARSEED_FONTS_LIBRARY
  || (leaseLibrary && path.join(path.dirname(leaseLibrary), 'fonts.node'))
assert.ok(library && path.isAbsolute(library), 'select the compiled fonts library')
assert.equal(process.versions.node, policy.node)
const native = require(library)
const COLLECTION_TAG = 'ttcf'
const NAME_TAG = 'name'
const SFNT_HEADER_BYTES = 12
const TABLE_RECORD_BYTES = 16
const OFFSET_BYTES = 4

function nameTables(filename) {
  const descriptor = fs.openSync(filename, 'r')
  try {
    const size = fs.fstatSync(descriptor).size
    const read = (offset, length) => {
      assert.ok(offset >= 0 && length >= 0 && offset + length <= size)
      const bytes = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        const count = fs.readSync(descriptor, bytes, done, length - done, offset + done)
        assert.ok(count > 0, 'font table is truncated')
        done += count
      }
      return bytes
    }
    const header = read(0, SFNT_HEADER_BYTES)
    const offsets = header.toString('ascii', 0, OFFSET_BYTES) === COLLECTION_TAG
      ? Array.from({ length: header.readUInt32BE(8) }, (_, index) =>
        read(SFNT_HEADER_BYTES + index * OFFSET_BYTES, OFFSET_BYTES).readUInt32BE())
      : [0]
    return offsets.map(offset => {
      const directory = read(offset, SFNT_HEADER_BYTES)
      const tables = read(offset + SFNT_HEADER_BYTES, directory.readUInt16BE(4) * TABLE_RECORD_BYTES)
      for (let index = 0; index < tables.length; index += TABLE_RECORD_BYTES) {
        if (tables.toString('ascii', index, index + OFFSET_BYTES) === NAME_TAG) {
          return read(tables.readUInt32BE(index + 8), tables.readUInt32BE(index + 12))
        }
      }
      return null
    })
  } finally { fs.closeSync(descriptor) }
}

test('native font metadata identifies source faces without relying on synthesized instance names', async () => {
  const catalog = await native.enumerateFonts()
  assert.ok(Array.isArray(catalog) && catalog.length > 0)
  const files = new Map()
  for (const face of catalog) {
    assert.ok(path.isAbsolute(face.path))
    assert.ok(typeof face.postscriptName === 'string' && face.postscriptName.length > 0)
    let tables = files.get(face.path)
    if (!tables) { tables = nameTables(face.path); files.set(face.path, tables) }
    if (process.platform === 'darwin') {
      assert.ok(face.nameTable instanceof Uint8Array && face.nameTable.length > 0)
      assert.ok(tables.some(table => table?.equals(face.nameTable)), `CoreText name table differs from source: ${face.postscriptName}`)
      assert.equal(face.faceIndex, undefined)
    } else {
      assert.ok(Number.isInteger(face.faceIndex) && face.faceIndex >= 0 && face.faceIndex < tables.length)
      assert.equal(face.nameTable, undefined)
    }
  }
})
