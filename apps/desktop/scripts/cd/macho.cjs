// macOS only requires nested Mach-O images and bundle directories to carry their
// own signature; ordinary resources are sealed by the outer bundle's
// CodeResources. @electron/osx-sign instead codesigns every file isbinaryfile
// reports as binary, which covers most data blobs and makes distribution
// signing take an hour. This owner answers the real question by file magic.
const fs = require('node:fs')
const path = require('node:path')

const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcefaedfe, // 32-bit, little endian
  0xcffaedfe, // 64-bit, little endian
  0xcafebabe, // universal (fat)
  0xbebafeca // universal, little endian
])
const BUNDLE_EXTENSIONS = new Set(['.app', '.framework'])

function isMachO(filename) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'r')
  } catch {
    return false
  }
  try {
    const header = Buffer.alloc(4)
    if (fs.readSync(descriptor, header, 0, 4, 0) < 4) return false
    return MACHO_MAGICS.has(header.readUInt32BE(0))
  } catch {
    return false
  } finally {
    fs.closeSync(descriptor)
  }
}

function isBundle(filename) {
  return BUNDLE_EXTENSIONS.has(path.extname(filename))
}

function isSignable(filename) {
  return isBundle(filename) || isMachO(filename)
}

// osx-sign treats an ignore predicate's `true` as "skip this path".
function signableIgnore(baseIgnore) {
  return filename => {
    if (baseIgnore && baseIgnore(filename)) return true
    return !isSignable(filename)
  }
}

module.exports = { isMachO, isBundle, isSignable, signableIgnore }
