const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve, relative, isAbsolute, sep } = require('node:path')
const test = require('node:test')
const postcss = require('postcss')
const configuration = require('../../../postcss.config.cjs')
const { styles } = require('../styles.cjs')

const ROOT = resolve(__dirname, '../../..')
const STYLES = resolve(ROOT, 'src/renderer/src/styles.css')
const RENDERER = resolve(ROOT, 'src/renderer')

function within(directory, file) {
  const path = relative(directory, file)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

async function compile(config = configuration) {
  return postcss(config.plugins).process(readFileSync(STYLES, 'utf8'), { from: STYLES })
}

test('normal shared stylesheet does not scan private PDFE development sources', async () => {
  const result = await compile()
  const dependencies = result.messages.filter(message => message.type === 'dependency').map(message => message.file)
  const privateSources = dependencies.filter(file => within(resolve(ROOT, 'preview'), file))
  assert.deepEqual(privateSources, [])
  assert.ok(dependencies.some(file => within(RENDERER, file)))
  assert.match(result.css, /\.grid\s*\{/)
})

test('alternating PDFE and product compilation keeps their source scans independent', async () => {
  for (const mode of ['product', 'pdfe', 'product']) {
    const result = await compile(styles(mode))
    const dependencies = result.messages.filter(message => message.type === 'dependency').map(message => message.file)
    for (const file of ['Navigation.tsx', 'Console.tsx']) {
      assert.equal(dependencies.includes(resolve(ROOT, 'preview', file)), mode === 'pdfe', mode + ': ' + file)
    }
    assert.match(result.css, /\.grid\s*\{/)
  }
})

test('stylesheet source mode rejects unknown and inherited names', () => {
  for (const mode of [undefined, '', 'preview', 'constructor', '__proto__']) {
    assert.throws(() => styles(mode), TypeError)
  }
})
