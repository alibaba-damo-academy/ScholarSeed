// Build-owned TeX normalization. Never run this against an installed component.
const fs = require('node:fs')
const path = require('node:path')
const PE = require('pe-library')
const state = require('../shared/build-state.cjs')
const { openExecutable } = require('../shared/utils.cjs')
const ENGINE_ENTRIES = ['xetex.exe', 'xelatex.exe']
const MANIFEST_TYPE = 24
const MANIFEST_ID = 1
const MANIFEST_LANGUAGE = 0
const CERTIFICATE_DIRECTORY = 4
const FONT_DIRECTORIES = ['opentype', 'truetype', 'type1']
const UTF8_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="ScholarSeed.TeXLive" version="1.0.0.0"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
`

function read(filename) {
  const fd = openExecutable(filename, 'r', 'texlive.read')
  try { return fs.readFileSync(fd) } finally { fs.closeSync(fd) }
}

function utf8Engines(binDirectory) {
  state.noLinks(binDirectory)
  // Preflight all entries before writing. Never use the library's ignoreCert.
  const entries = ENGINE_ENTRIES.map(name => {
    const filename = path.join(binDirectory, name)
    state.regular(filename)
    const executable = PE.NtExecutable.from(read(filename))
    const certificate = executable.newHeader.optionalHeaderDataDirectory.get(CERTIFICATE_DIRECTORY)
    if (certificate.virtualAddress || certificate.size) throw new Error('signed TeX executable')
    const resources = PE.NtExecutableResource.from(executable)
    const manifests = resources.entries.filter(entry => entry.type === MANIFEST_TYPE)
    const ready = manifests.length === 1 && manifests[0].id === MANIFEST_ID &&
      manifests[0].lang === MANIFEST_LANGUAGE && Buffer.from(manifests[0].bin).toString('utf8') === UTF8_MANIFEST
    if (manifests.length && !ready) throw new Error('unexpected TeX process manifest; review the vendor input')
    return { filename, executable, resources, ready }
  })
  for (const {filename, executable, resources, ready} of entries) {
    if (!ready) {
      resources.replaceResourceEntryFromString(MANIFEST_TYPE, MANIFEST_ID, MANIFEST_LANGUAGE, UTF8_MANIFEST)
      resources.outputResource(executable)
      const bytes = Buffer.from(executable.generate())
      const fd = openExecutable(filename, 'r+', 'texlive.write')
      try { fs.writeFileSync(fd, bytes); fs.ftruncateSync(fd, bytes.length) } finally { fs.closeSync(fd) }
    }
    const readback = PE.NtExecutableResource.from(PE.NtExecutable.from(read(filename)))
    const manifests = readback.getResourceEntriesAsString(MANIFEST_TYPE, MANIFEST_ID)
    if (manifests.length !== 1 || manifests[0][0] !== MANIFEST_LANGUAGE || manifests[0][1] !== UTF8_MANIFEST)
      throw new Error('TeX UTF-8 process manifest readback failed')
  }
}

function normalizeTexliveTree(binDirectory, platform = process.platform) {
  if (platform === 'win32') utf8Engines(binDirectory)
  const tree = path.resolve(binDirectory, '..', '..')
  fs.rmSync(path.join(tree, 'texmf-var', 'fonts', 'cache'), { recursive: true, force: true })
  const directory = path.join(tree, 'texmf-var', 'fonts', 'conf')
  for (const name of ['fonts.conf', 'texlive-fontconfig.conf']) {
    const file = path.join(directory, name)
    if (fs.existsSync(file)) fs.writeFileSync(file,
      '<?xml version="1.0"?>\n<fontconfig>\n' + FONT_DIRECTORIES.map(font =>
        `<dir prefix="relative">../../../texmf-dist/fonts/${font}</dir>`).join('\n') +
      '\n<cachedir prefix="xdg">fontconfig</cachedir>\n</fontconfig>\n')
  }
}

module.exports = { normalizeTexliveTree }
