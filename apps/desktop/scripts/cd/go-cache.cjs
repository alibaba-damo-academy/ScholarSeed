const path = require('node:path')
const cache = require('./cache.cjs')
const state = require('../shared/build-state.cjs')

function goObjects(environment, archiveSha256) {
  return state.ensurePrivateDirectory(path.join(cache.root(environment), 'go', archiveSha256))
}

module.exports = { goObjects }
