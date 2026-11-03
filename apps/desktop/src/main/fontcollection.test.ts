import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fontPostscriptNames, selectFontCollection } from './fontcollection.ts'

interface FaceFixture { name: string; platform?: number; instances?: string[]; format?: 0 | 1; omitInstancePostscriptNames?: boolean }

function collection(faces: FaceFixture[], version = 0x00020000): Buffer {
  const bytes = Buffer.alloc(8192)
  bytes.write('ttcf'); bytes.writeUInt32BE(version, 4); bytes.writeUInt32BE(faces.length, 8)
  let cursor = 256
  const shared = 128
  bytes.set([11, 22, 33, 44, 55, 66, 77, 88], shared)
  faces.forEach((face, index) => {
    const offset = cursor
    bytes.writeUInt32BE(offset, 12 + index * 4)
    const count = face.instances ? 3 : 2
    bytes.writeUInt32BE(0x00010000, offset); bytes.writeUInt16BE(count, offset + 4)
    cursor += 12 + count * 16
    const names = [{ id: 6, value: face.name }, ...(face.instances || []).map((value, i) => ({ id: 256 + i, value }))]
    const nameOffset = cursor
    const storage = 6 + names.length * 12 + (face.format === 1 ? 6 : 0)
    bytes.writeUInt16BE(face.format || 0, cursor)
    bytes.writeUInt16BE(names.length, cursor + 2); bytes.writeUInt16BE(storage, cursor + 4)
    let stringOffset = 0
    for (const [i, name] of names.entries()) {
      const record = cursor + 6 + i * 12
      const platform = face.platform ?? 3
      bytes.writeUInt16BE(platform, record); bytes.writeUInt16BE(platform === 3 ? 1 : 0, record + 2)
      bytes.writeUInt16BE(0x409, record + 4); bytes.writeUInt16BE(name.id, record + 6)
      const encoded = platform === 1 ? Buffer.from(name.value, 'ascii') : Buffer.from(name.value, 'utf16le').swap16()
      bytes.writeUInt16BE(encoded.length, record + 8); bytes.writeUInt16BE(stringOffset, record + 10)
      encoded.copy(bytes, cursor + storage + stringOffset)
      stringOffset += encoded.length
    }
    if (face.format === 1) {
      const languages = cursor + 6 + names.length * 12
      bytes.writeUInt16BE(1, languages); bytes.writeUInt16BE(4, languages + 2)
      bytes.writeUInt16BE(stringOffset, languages + 4)
      bytes.set([0, 0x65, 0, 0x6e], cursor + storage + stringOffset)
      stringOffset += 4
    }
    cursor += storage + stringOffset
    const table = (tableIndex: number, tag: string, tableOffset: number, length: number): void => {
      const record = offset + 12 + tableIndex * 16
      bytes.write(tag, record); bytes.writeUInt32BE(tableOffset, record + 8); bytes.writeUInt32BE(length, record + 12)
    }
    table(0, 'name', nameOffset, cursor - nameOffset)
    table(1, 'glyf', shared, 8)
    if (face.instances) {
      const fvar = cursor
      const instanceSize = face.omitInstancePostscriptNames ? 8 : 10
      bytes.writeUInt16BE(1, fvar); bytes.writeUInt16BE(16, fvar + 4); bytes.writeUInt16BE(2, fvar + 6)
      bytes.writeUInt16BE(1, fvar + 8); bytes.writeUInt16BE(20, fvar + 10)
      bytes.writeUInt16BE(face.instances.length, fvar + 12); bytes.writeUInt16BE(instanceSize, fvar + 14)
      bytes.write('wght', fvar + 16)
      bytes.writeInt32BE(100 * 65536, fvar + 20); bytes.writeInt32BE(400 * 65536, fvar + 24); bytes.writeInt32BE(900 * 65536, fvar + 28)
      face.instances.forEach((_name, i) => {
        const instance = fvar + 36 + i * instanceSize
        bytes.writeUInt16BE(256 + i, instance); bytes.writeInt32BE((i ? 700 : 300) * 65536, instance + 4)
        if (!face.omitInstancePostscriptNames) bytes.writeUInt16BE(256 + i, instance + 8)
      })
      cursor += 36 + face.instances.length * instanceSize
      table(2, 'fvar', fvar, cursor - fvar)
    }
    cursor = Math.ceil(cursor / 4) * 4
  })
  return bytes.subarray(0, cursor)
}

test('TTC selection preserves original face offsets, shared tables and input bytes', () => {
  const input = collection([{ name: 'Public-Regular' }, { name: '.Hidden' }, { name: 'Public-Bold', platform: 1 }])
  const original = Buffer.from(input)
  const selected = selectFontCollection(input, ['Public-Regular', 'Public-Bold', 'Public-Bold'])
  const view = new DataView(selected.buffer, selected.byteOffset, selected.byteLength)
  assert.equal(view.getUint32(4), 0x00010000)
  assert.equal(view.getUint32(8), 2)
  assert.equal(view.getUint32(12), input.readUInt32BE(12))
  assert.equal(view.getUint32(16), input.readUInt32BE(20))
  assert.deepEqual(Buffer.from(selected.subarray(36)), original.subarray(36))
  assert.deepEqual(input, original)
})

test('variable named instance selects its whole face without changing any axis, instance or name bytes', () => {
  const input = collection([{ name: '.Hidden' }, { name: 'Variable-Default', instances: ['Variable-Light', 'Variable-Bold'] }])
  const selected = selectFontCollection(input, ['Variable-Light', 'Variable-Bold'])
  const view = new DataView(selected.buffer, selected.byteOffset, selected.byteLength)
  assert.equal(view.getUint32(8), 1)
  assert.equal(view.getUint32(12), input.readUInt32BE(16))
  assert.deepEqual(Buffer.from(selected.subarray(32)), input.subarray(32))
})

test('native base name selects a variable face whose instances omit optional PostScript IDs', () => {
  for (const platform of [0, 1, 3]) {
    const input = collection([{ name: '.Hidden' }, { name: 'Variable-Base', platform, instances: ['Light', 'Bold'], omitInstancePostscriptNames: true }])
    const directory = input.readUInt32BE(16)
    const offset = input.readUInt32BE(directory + 20)
    const length = input.readUInt32BE(directory + 24)
    const nameTable = input.subarray(offset, offset + length)
    assert.deepEqual(fontPostscriptNames(nameTable), ['Variable-Base'])
    const selected = selectFontCollection(input, fontPostscriptNames(nameTable))
    assert.equal(new DataView(selected.buffer).getUint32(12), directory)
    assert.deepEqual(Buffer.from(selected.subarray(32)), input.subarray(32))
    assert.throws(() => fontPostscriptNames(nameTable.subarray(0, 5)), /font collection/i)
  }
})

test('explicit native face indices select variable faces independently of synthesized names', () => {
  const input = collection([{ name: '.Hidden' }, { name: 'Variable-Base', instances: ['Light', 'Bold'], omitInstancePostscriptNames: true }])
  const selected = selectFontCollection(input, ['Variable_Bold'], [1, 1])
  assert.equal(new DataView(selected.buffer).getUint32(8), 1)
  assert.equal(new DataView(selected.buffer).getUint32(12), input.readUInt32BE(16))
  assert.deepEqual(Buffer.from(selected.subarray(32)), input.subarray(32))
  assert.deepEqual(selectFontCollection(input, [], [1]), selected)
  assert.equal(selectFontCollection(input, [], [1, 0]), input)
  for (const indices of [[], [-1], [2], [0.5], [NaN], [Infinity]]) {
    assert.throws(() => selectFontCollection(input, ['Variable-Base'], indices), /face index/i)
  }
  const standalone = Buffer.from('OTTO')
  assert.equal(selectFontCollection(standalone, [], [0]), standalone)
  assert.throws(() => selectFontCollection(standalone, [], [1]), /face index/i)
})

test('complete collections and standalone TTF/OTF retain the original byte object', () => {
  const all = collection([{ name: 'Regular' }, { name: 'Bold', platform: 0 }], 0x00010000)
  assert.equal(selectFontCollection(all, ['Regular', 'Bold']), all)
  for (const signature of [Buffer.from([0, 1, 0, 0]), Buffer.from('OTTO'), Buffer.from('true'), Buffer.from('typ1')]) {
    assert.equal(selectFontCollection(signature, ['OS-Synthesized-Instance']), signature)
  }
})

test('name format 1 and a signed v2 TTC preserve data while removing the obsolete collection signature header', () => {
  const collectionBytes = collection([{ name: 'Public', platform: 0, format: 1 }, { name: 'Hidden' }])
  const bytes = Buffer.concat([collectionBytes, Buffer.from('signature')])
  bytes.write('DSIG', 20); bytes.writeUInt32BE(9, 24); bytes.writeUInt32BE(collectionBytes.length, 28)
  const selected = selectFontCollection(bytes, ['Public'])
  assert.equal(new DataView(selected.buffer).getUint32(4), 0x00010000)
  assert.deepEqual(Buffer.from(selected.subarray(32)), bytes.subarray(32))
  const malformed = Buffer.from(bytes)
  const directory = malformed.readUInt32BE(12)
  const name = malformed.readUInt32BE(directory + 20)
  malformed.writeUInt16BE(0xffff, name + 22)
  assert.throws(() => selectFontCollection(malformed, ['Public']), /font collection/i)
})

test('TTC views respect byteOffset and reject missing catalog names instead of exposing unrequested faces', () => {
  const original = collection([{ name: 'Regular' }, { name: 'Bold' }])
  const padded = Buffer.concat([Buffer.alloc(7, 1), original, Buffer.alloc(9, 2)])
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, original.length)
  assert.equal(new DataView(selectFontCollection(view, ['Bold']).buffer).getUint32(12), original.readUInt32BE(16))
  assert.throws(() => selectFontCollection(view, []), /catalog/i)
  assert.throws(() => selectFontCollection(view, ['Missing']), /Missing/)
  assert.throws(() => selectFontCollection(view, ['Regular', 'Missing']), /Missing/)
})

test('malformed TTC headers, directories, name strings and variation records fail with bounds checks', () => {
  const input = collection([{ name: 'Regular', instances: ['Light'] }, { name: 'Bold' }])
  const first = input.readUInt32BE(12)
  const name = input.readUInt32BE(first + 20)
  const variation = input.readUInt32BE(first + 52)
  const invalid = [
    (bytes: Buffer) => bytes.writeUInt32BE(0x00030000, 4),
    (bytes: Buffer) => bytes.writeUInt32BE(0xffffffff, 8),
    (bytes: Buffer) => bytes.writeUInt32BE(4, 12),
    (bytes: Buffer) => bytes.writeUInt32BE(bytes.length - 1, 12),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, first + 4),
    (bytes: Buffer) => bytes.writeUInt32BE(bytes.length, first + 20),
    (bytes: Buffer) => bytes.writeUInt32BE(0xffffffff, first + 24),
    (bytes: Buffer) => bytes.writeUInt16BE(2, name),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, name + 2),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, name + 4),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, name + 16),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, variation + 4),
    (bytes: Buffer) => bytes.writeUInt16BE(0xffff, variation + 8),
    (bytes: Buffer) => bytes.writeUInt16BE(2, variation + 14),
  ]
  for (const mutate of invalid) {
    const bytes = Buffer.from(input); mutate(bytes)
    assert.throws(() => selectFontCollection(bytes, ['Regular']), /font collection/i)
  }
  for (const length of [0, 3, 4, 8, 11, 19]) {
    assert.throws(() => selectFontCollection(input.subarray(0, length), ['Regular']), /font collection/i)
  }
})
