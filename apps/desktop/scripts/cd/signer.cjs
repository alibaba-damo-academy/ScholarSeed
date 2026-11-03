// electron-builder `mac.sign` entry: run @electron/osx-sign's own nested signing
// pass but restrict it to the paths macOS actually requires a signature on.
const { signAsync } = require('@electron/osx-sign')
const { setTimeout: delay } = require('node:timers/promises')
const { signableIgnore } = require('./macho.cjs')
const { nativeSignatureGuard } = require('./seal.cjs')
const { frozenContext } = require('./sign.cjs')

const TIMESTAMP_RETRY_DELAYS_MS = Object.freeze([2000, 5000])
const TIMESTAMP_UNAVAILABLE = 'The timestamp service is not available.'

async function sign(options) {
  const native = nativeSignatureGuard(options.app, frozenContext().native)
  const baseIgnore = signableIgnore(options.ignore)
  const signing = { ...options, ignore: filename => native.ignore(filename) || baseIgnore(filename) }
  for (let attempt = 0; ; attempt++) {
    try {
      await signAsync(signing)
      break
    } catch (error) {
      const message = String(error?.message || error)
      if (!message.includes(TIMESTAMP_UNAVAILABLE) || attempt >= TIMESTAMP_RETRY_DELAYS_MS.length)
        throw error
      // A failed pass can already have signed some entries. Preserve the frozen
      // native inputs before repeating the same signing policy and exclusions.
      native.verify()
      const waitMs = TIMESTAMP_RETRY_DELAYS_MS[attempt]
      console.warn(`[sign] timestamp unavailable; retry ${attempt + 1}/${TIMESTAMP_RETRY_DELAYS_MS.length} in ${waitMs}ms`)
      await delay(waitMs)
    }
  }
  native.verify()
}

module.exports = sign
module.exports.sign = sign
