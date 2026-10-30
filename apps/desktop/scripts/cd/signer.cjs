// electron-builder `mac.sign` entry: run @electron/osx-sign's own nested signing
// pass but restrict it to the paths macOS actually requires a signature on.
const { signAsync } = require('@electron/osx-sign')
const { signableIgnore } = require('./macho.cjs')
const { nativeSignatureGuard } = require('./seal.cjs')
const { frozenContext } = require('./sign.cjs')

async function sign(options) {
  const native = nativeSignatureGuard(options.app, frozenContext().native)
  const baseIgnore = signableIgnore(options.ignore)
  await signAsync({ ...options, ignore: filename => native.ignore(filename) || baseIgnore(filename) })
  native.verify()
}

module.exports = sign
module.exports.sign = sign
