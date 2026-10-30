// Keep load commands, symbols and binding data; exclude only the code-signature
// blob and the two __LINKEDIT sizes that codesign necessarily resizes with it.
const fs = require('node:fs')
const crypto = require('node:crypto')
const MACHO64 = 0xfeedfacf
const HEADER_BYTES = 32
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

function fingerprint(filename) {
  const bytes = fs.readFileSync(filename)
  if (bytes.length < HEADER_BYTES || bytes.readUInt32LE(0) !== MACHO64)
    throw new Error('ShipIt must be a thin little-endian 64-bit Mach-O')
  const commands = bytes.readUInt32LE(16)
  const commandEnd = HEADER_BYTES + bytes.readUInt32LE(20)
  if (commandEnd > bytes.length) throw new Error('invalid ShipIt load command area')
  let offset = HEADER_BYTES
  let signature = null
  let linkedit = null
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > commandEnd) throw new Error('truncated ShipIt load command')
    const command = bytes.readUInt32LE(offset)
    const size = bytes.readUInt32LE(offset + 4)
    if (size < 8 || offset + size > commandEnd) throw new Error('invalid ShipIt load command size')
    if (command === LC_CODE_SIGNATURE) {
      if (signature || size !== 16) throw new Error('invalid ShipIt signature command')
      signature = { command: offset, start: bytes.readUInt32LE(offset + 8), size: bytes.readUInt32LE(offset + 12) }
    }
    if (command === LC_SEGMENT_64 && size >= 72 &&
        bytes.toString('ascii', offset + 8, offset + 24).replace(/\0+$/, '') === '__LINKEDIT') {
      if (linkedit) throw new Error('duplicate ShipIt LINKEDIT')
      linkedit = { command: offset, start: Number(bytes.readBigUInt64LE(offset + 40)), size: Number(bytes.readBigUInt64LE(offset + 48)) }
    }
    offset += size
  }
  if (offset !== commandEnd || !signature || !linkedit || signature.size <= 0 ||
      signature.start < commandEnd || signature.start < linkedit.start ||
      signature.start + signature.size !== bytes.length ||
      linkedit.start + linkedit.size !== bytes.length)
    throw new Error('ShipIt requires a terminal code-signature slot inside LINKEDIT')
  const normalized = Buffer.from(bytes.subarray(0, signature.start))
  normalized.writeUInt32LE(0, signature.command + 12)
  // The signature's location stays bound. No dylib, rpath, entrypoint, binding,
  // export, symbol or section content is omitted from this fingerprint.
  normalized.writeBigUInt64LE(0n, linkedit.command + 32)
  normalized.writeBigUInt64LE(BigInt(signature.start - linkedit.start), linkedit.command + 48)
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

module.exports = { fingerprint }
