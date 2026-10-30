import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DESKTOP } from '../resources.mjs'

const directory = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-format-'))
const output = join(directory, 'format.mjs')
await build({ entryPoints: [join(DESKTOP, 'src/localization/format.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm' })
const { createFormatters } = await import(pathToFileURL(output).href)
rmSync(directory, { recursive: true })

test('file sizes use B, K and M without trailing fractional zeros in both languages', () => {
  const cases = [
    [0, '0 B'],
    [999, '999 B'],
    [1023, '1023 B'],
    [1024, '1 K'],
    [1536, '1.5 K'],
    [1260, '1.23 K'],
    [1048575, '1024 K'],
    [1048576, '1 M'],
    [1572864, '1.5 M'],
    [2105000, '2.01 M'],
    [1073741824, '1024 M']
  ]
  for (const language of ['zh', 'en']) {
    for (const [bytes, expected] of cases) {
      assert.equal(createFormatters(language).bytes(bytes), expected)
    }
  }
})

test('language changes retain caller currency, precision, and grouping policy', () => {
  const amount = { style: 'currency', currency: 'CNY', currencyDisplay: 'code', minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false }
  for (const language of ['zh', 'en']) {
    const result = createFormatters(language).number(1234.5, amount)
    assert.match(result, /CNY/)
    assert.match(result, /1234\.500/)
    assert.doesNotMatch(result, /USD|1,234/)
  }
})

test('date time-zone remains explicit while relative text follows language', () => {
  const format = createFormatters('en')
  const instant = Date.UTC(2026, 8, 10, 1)
  const date = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }
  assert.equal(format.date(instant, date), '09/10/2026')
  assert.equal(format.date(instant, { ...date, timeZone: 'America/Los_Angeles' }), '09/09/2026')
  assert.equal(format.relative(-1, 'day', { numeric: 'auto' }), 'yesterday')
  assert.equal(createFormatters('zh').relative(-1, 'day', { numeric: 'auto' }), '昨天')
})
