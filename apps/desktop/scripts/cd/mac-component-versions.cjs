const electron = require('../../package.json').devDependencies.electron
const browserNode = require('./browser.json').version
const codex = require('../../../../scripts/vendor/codex/manifest.json').version
const python = require('../../../../scripts/vendor/python-build-standalone/manifest.json').python
const texlive = require('../../../../scripts/vendor/texlive/manifest.json').texlive

function macComponentVersions() {
  // Bump a runtime's revision if its shipped bytes change at the same upstream version.
  const versions = {
    browser: `${browserNode}-r1`,
    codex: `${codex}-r1`,
    electron: `${electron}-r1`,
    python: `${python}-r1`,
    texlive: `${texlive}-r1`,
  }
  for (const [kind, version] of Object.entries(versions)) {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}-r[1-9][0-9]*$/.test(version)) {
      throw new Error(`Invalid macOS component version for ${kind}: ${version}`)
    }
  }
  return versions
}

module.exports = { macComponentVersions }
