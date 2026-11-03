// Signature-independent artifact identity; never mutate the file being verified.
const fs = require('node:fs')
const crypto = require('node:crypto')

async function digest(filename, algorithm) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256(filename) { return digest(filename, 'sha256') }
function sha512(filename) { return digest(filename, 'sha512') }

async function executableDigest(filename) {
  if (process.platform !== 'darwin') return sha256(filename)
  const handle = fs.openSync(filename, 'r')
  try {
    const header = Buffer.alloc(32)
    fs.readSync(handle, header, 0, header.length, 0)
    if (header.readUInt32LE(0) !== 0xfeedfacf) return sha256(filename)
    const commandCount = header.readUInt32LE(16)
    const commandBytes = header.readUInt32LE(20)
    const commands = Buffer.alloc(commandBytes)
    fs.readSync(handle, commands, 0, commands.length, header.length)
    let offset = 0
    let payloadEnd = fs.statSync(filename).size
    let payloadStart = payloadEnd
    for (let index = 0; index < commandCount; index += 1) {
      const command = commands.readUInt32LE(offset)
      const size = commands.readUInt32LE(offset + 4)
      if (size < 8 || offset + size > commands.length) throw new Error('invalid Mach-O load command')
      const segname = commands.toString('ascii', offset + 8, offset + 24).replace(/\0+$/, '')
      if (command === 0x19 && segname === '__LINKEDIT') {
        payloadEnd = Number(commands.readBigUInt64LE(offset + 40))
      } else if (command === 0x19) {
        const sectionCount = commands.readUInt32LE(offset + 64)
        let section = offset + 72
        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
          const size = commands.readUInt32LE(section + 40)
          const fileOffset = commands.readUInt32LE(section + 48)
          if (size > 0 && fileOffset > 0 && fileOffset < payloadStart) {
            payloadStart = fileOffset
          }
          section += 80
        }
      }
      offset += size
    }
    if (payloadStart === payloadEnd) {
      payloadStart = header.length + commandBytes
    }
    const hash = crypto.createHash('sha256')
    hash.update(header.subarray(0, 16))
    if (payloadEnd < payloadStart) throw new Error('invalid Mach-O payload range')
    for await (const chunk of fs.createReadStream(filename, { start: payloadStart, end: payloadEnd - 1 })) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(handle)
  }
}

module.exports = { sha256, sha512, executableDigest }
