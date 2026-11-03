// Loaded after the locked npm dependencies are prepared.
const fs = require('node:fs')
const PE = require('pe-library')
const ResEdit = require('resedit')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const { openExecutable } = require('../shared/utils.cjs')
const LAUNCHER = 'ScholarSeed.exe'

function brandLauncher(filename, { icon, version, productName, companyName, originalFilename = LAUNCHER }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !productName || !icon)
    throw new Error('launcher branding requires the frozen product version and icon')
  const executable = PE.NtExecutable.from(readExecutable(filename, 'branding.read'))
  const resources = PE.NtExecutableResource.from(executable)
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(icon))
  if (!icons.icons.length) throw new Error('launcher icon has no images')
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033,
    icons.icons.map(item => item.data))
  const info = ResEdit.Resource.VersionInfo.createEmpty()
  info.setFileVersion(version, 1033)
  info.setProductVersion(version, 1033)
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: productName, ProductName: productName,
    CompanyName: companyName || productName, OriginalFilename: originalFilename,
    InternalName: productName,
  })
  info.outputToResourceEntries(resources.entries)
  resources.outputResource(executable)
  const bytes = Buffer.from(executable.generate())
  timed('branding.write', () => {
    // Acquire without truncation. A sharing violation leaves the original intact.
    const fd = openExecutable(filename, 'r+', 'branding.write')
    try {
      fs.writeFileSync(fd, bytes)
      fs.ftruncateSync(fd, bytes.length)
    } finally { fs.closeSync(fd) }
  })
  timed('branding.verify', () => {
    const readback = PE.NtExecutableResource.from(PE.NtExecutable.from(readExecutable(filename, 'branding.readback')))
    const versions = ResEdit.Resource.VersionInfo.fromEntries(readback.entries)
    const values = versions[0]?.getStringValues({ lang: 1033, codepage: 1200 })
    if (versions.length !== 1 || !readback.entries.some(entry => entry.type === 14) ||
        values.ProductName !== productName || values.OriginalFilename !== originalFilename ||
        values.FileVersion !== `${version}.0` || values.ProductVersion !== `${version}.0`)
      throw new Error('launcher branding readback failed')
  })
}

function readExecutable(filename, stage) {
  return timed(stage, () => {
    const fd = openExecutable(filename, 'r', stage)
    try { return fs.readFileSync(fd) } finally { fs.closeSync(fd) }
  })
}

module.exports = { brandLauncher }
