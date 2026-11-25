const electron = require('../../package.json').devDependencies.electron
const browserNode = require('./browser.json').version
const codex = require('../../../../scripts/vendor/codex/manifest.json').version
const python = require('../../../../scripts/vendor/python-build-standalone/manifest.json').python
const texlive = require('../../../../scripts/vendor/texlive/manifest.json').texlive

function macComponentVersions(release) {
  if (!/^\d+\.\d+\.\d+$/.test(release?.version) ||
      !['preview', 'release'].includes(release.channel) ||
      !/^[1-9]\d{11}$/.test(release.build_number)) {
    throw new Error('Invalid release identity for macOS component versions')
  }
  const build = `${release.version}-${release.channel}-r${release.build_number}`
  // Bump a runtime's revision if its shipped bytes change at the same upstream version.
  // Frameworks in this group ship with Electron. The browser group contains its Node runtime.
  const versions = {
    app: build,
    browser: `${browserNode}-r1`,
    codex: `${codex}-r1`,
    electron: `${electron}-r1`,
    frameworks: `${electron}-r1`,
    python: `${python}-r1`,
    texlive: `${texlive}-r1`,
    layout: build,
  }
  for (const [kind, version] of Object.entries(versions)) {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}-r[1-9][0-9]*$/.test(version)) {
      throw new Error(`Invalid macOS component version for ${kind}: ${version}`)
    }
  }
  return versions
}

module.exports = { macComponentVersions }
