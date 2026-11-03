#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ensureArtifact } = require('../../../../scripts/shared/artifacts.cjs')
const { officeContentId } = require('../cd/payload.cjs')

const OFFICE_ASSET_ROOT = path.join('src', 'renderer', 'public', 'office')
const OFFICE_BUILD_DIRECTORY = 'zeta-20250513'
const OFFICE_MANIFEST = 'manifest.json'
const OFFICE_NOTICE = 'THIRD_PARTY_NOTICES.md'
const OFFICE_COMPONENT_DIRECTORY = 'office-component'

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

async function verifyOfficeAssets(desktopRoot = path.resolve(__dirname, '../..')) {
  const root = path.join(desktopRoot, OFFICE_ASSET_ROOT, OFFICE_BUILD_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, OFFICE_MANIFEST), 'utf8'))
  for (const [name, expected] of Object.entries(manifest.files)) {
    const filename = path.join(root, name)
    if (expected.url) await ensureArtifact(filename, expected)
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

async function stageOfficeComponent(desktopRoot, destination) {
  await verifyOfficeAssets(desktopRoot)
  const source = path.join(desktopRoot, OFFICE_ASSET_ROOT)
  // Validate the complete frozen tree before copying; do not admit extra files
  // or links through a separate staging path.
  await officeContentId(source)
  fs.mkdirSync(destination)
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true })
  // A concurrent source edit must not turn a copied notice into a link that
  // normalization follows. This is a private build tree, not a runtime sandbox.
  await officeContentId(destination)
  const notice = path.join(destination, OFFICE_NOTICE)
  // The reviewed Windows r1 payload contains CRLF notices. Existing checkouts
  // and source exports can still contain LF despite Git attributes. Normalize
  // only this staged text file, preserving every other byte and the source tree.
  const bytes = fs.readFileSync(notice)
  fs.writeFileSync(notice, Buffer.from(bytes.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1'))
  await officeContentId(destination)
  return destination
}

if (require.main === module) {
  verifyOfficeAssets().catch(error => {
    console.error(`[office-assets] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { OFFICE_BUILD_DIRECTORY, OFFICE_COMPONENT_DIRECTORY, verifyOfficeAssets, stageOfficeComponent }
