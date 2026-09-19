// electron-builder `mac.sign` entry: run @electron/osx-sign's own nested signing
// pass but restrict it to the paths macOS actually requires a signature on.
const { signAsync } = require('@electron/osx-sign')
const { signableIgnore } = require('./macho.cjs')

async function sign(options) {
  await signAsync({ ...options, ignore: signableIgnore(options.ignore) })
}

module.exports = sign
module.exports.sign = sign