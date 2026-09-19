#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OFFICE_ASSET_ROOT = path.join('src', 'renderer', 'public', 'office')
const OFFICE_BUILD_DIRECTORY = 'zeta-20250513'
const OFFICE_MANIFEST = 'manifest.json'

function digest(filename) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function verifyOfficeAssets(desktopRoot = path.resolve(__dirname, '..')) {
  const root = path.join(desktopRoot, OFFICE_ASSET_ROOT, OFFICE_BUILD_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, OFFICE_MANIFEST), 'utf8'))
  for (const [name, expected] of Object.entries(manifest.files)) {
    const filename = path.join(root, name)
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size !== expected.bytes) {
      throw new Error(`Office runtime asset size mismatch: ${name}`)
    }
    if (digest(filename) !== expected.sha256) {
      throw new Error(`Office runtime asset digest mismatch: ${name}`)
    }
  }
  return manifest
}

if (require.main === module) verifyOfficeAssets()

module.exports = { OFFICE_BUILD_DIRECTORY, verifyOfficeAssets }
