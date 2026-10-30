const { resolve } = require('node:path')
const tailwind = require('@tailwindcss/postcss')

const SOURCES = Object.freeze({
  product: resolve(__dirname, '../../src/renderer'),
  pdfe: resolve(__dirname, '../..'),
})

function styles(mode) {
  if (!Object.hasOwn(SOURCES, mode)) throw new TypeError('Unknown stylesheet source mode: ' + mode)
  return { plugins: [tailwind({ base: SOURCES[mode] })] }
}

module.exports = { styles }
