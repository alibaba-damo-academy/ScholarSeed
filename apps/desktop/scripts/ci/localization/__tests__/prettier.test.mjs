import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { format, getFileInfo, resolveConfig } from 'prettier'
import { DESKTOP } from '../resources.mjs'

test('Desktop format configuration is explicit and idempotent across platforms', async () => {
  const filepath = resolve(DESKTOP, 'src/renderer/src/features/workbench/links.ts')
  const config = await resolveConfig(filepath)
  assert.equal(config.endOfLine, 'lf')
  assert.equal(config.semi, false)
  assert.equal(config.singleQuote, true)
  const output = await format('export const target = "https://example.org";\r\n', { ...config, filepath })
  assert.equal(output.includes('\r'), false)
  assert.equal(await format(output, { ...config, filepath }), output)
})

test('generated localization artifacts keep the generator as their formatting owner', async () => {
  const ignorePath = resolve(DESKTOP, '.prettierignore')
  for (const filename of ['types.d.ts', 'resources.ts']) {
    const info = await getFileInfo(resolve(DESKTOP, 'src/localization', filename), { ignorePath })
    assert.equal(info.ignored, true)
  }
  const source = await getFileInfo(resolve(DESKTOP, 'src/renderer/src/features/workbench/links.ts'), { ignorePath })
  assert.equal(source.ignored, false)
})
