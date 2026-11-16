// The pinned osx-sign walker reads resources before applying ignore rules.
// Read headers sequentially to preserve binary detection with bounded open files.
const { createRequire } = require('node:module')
const signingRequire = createRequire(require.resolve('@electron/osx-sign'))
const binary = signingRequire('isbinaryfile')
binary.isBinaryFile = async (...args) => binary.isBinaryFileSync(...args)

module.exports = {
  ...require('@electron/osx-sign'),
  ...require('@electron/osx-sign/dist/cjs/util'),
}
