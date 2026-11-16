const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs/promises')
const { build } = require('esbuild')
const { closedOpenUI } = require('../openui.mjs')

test('only OpenUI development bootstrap is compiled as closed production code', async context => {
  const parent = path.resolve(__dirname, '../../../node_modules/.cache/openui')
  await fs.mkdir(parent, { recursive: true })
  const directory = await fs.mkdtemp(path.join(parent, 'bootstrap-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  for (const packageName of ['@openuidev/react-lang', '@example/ordinary']) {
    const filename = path.join(directory, 'node_modules', packageName, 'dist/index.mjs')
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, 'export const mode = process.env.NODE_ENV; if (process.env.NODE_ENV === "development") globalThis.inspector = "https://example.invalid/developer-script";')
    const result = await build({ entryPoints: [filename], bundle: true, write: false, minify: true,
      plugins: [closedOpenUI()], define: { 'process.env.NODE_ENV': '"development"' } })
    const output = result.outputFiles[0].text
    if (packageName === '@openuidev/react-lang') {
      assert.match(output, /production/)
      assert.doesNotMatch(output, /developer-script/)
    } else {
      assert.match(output, /development/)
      assert.match(output, /developer-script/)
    }
  }
})
