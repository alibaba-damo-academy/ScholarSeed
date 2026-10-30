// Shared Office component inventory; ZIP production remains in payload.py.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { sha256 } = require('../shared/digest.cjs')
const OFFICE_DIRECTORY = 'zeta-20250513'

async function officeContentId(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, OFFICE_DIRECTORY, 'manifest.json'), 'utf8'))
  if (manifest.build_id !== 'zeta-24-2-20250513' || !manifest.files || Array.isArray(manifest.files)) {
    throw new Error('invalid frozen Office asset manifest')
  }
  const files = []
  const visit = async (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      const filename = path.join(directory, item.name)
      if (item.isDirectory()) await visit(filename, relative)
      else if (item.isFile()) files.push([relative, fs.statSync(filename).size, await sha256(filename)])
      else throw new Error(`unsafe Office asset: ${relative}`)
    }
  }
  await visit(root)
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = files.find(([relative]) => relative === `${OFFICE_DIRECTORY}/${name}`)
    if (!actual || actual[1] !== expected.bytes || actual[2] !== expected.sha256) {
      throw new Error(`frozen Office asset changed: ${name}`)
    }
  }
  if (!files.some(([name]) => name === 'THIRD_PARTY_NOTICES.md')) {
    throw new Error('Office third-party notices missing')
  }
  if (files.length !== Object.keys(manifest.files).length + 2 || files.some(([name]) =>
    name !== 'THIRD_PARTY_NOTICES.md' && name !== `${OFFICE_DIRECTORY}/manifest.json` &&
    !Object.hasOwn(manifest.files, name.slice(OFFICE_DIRECTORY.length + 1))
  )) {
    throw new Error('unexpected frozen Office asset')
  }
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

module.exports = { officeContentId }
