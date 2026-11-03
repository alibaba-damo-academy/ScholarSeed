import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DESKTOP } from '../resources.mjs'

const ENGLISH_BRAND = 'ScholarSeed'
const LEGACY_ENGLISH_BRAND = new RegExp(`\\b${['Shu', 'shen'].join('')}\\b`)

const directory = mkdtempSync(join(tmpdir(), 'scholarseed-i18n-contract-'))
const output = join(directory, 'engine.mjs')
await build({ entryPoints: [join(DESKTOP, 'src/localization/engine.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm' })
const { createLocalization } = await import(pathToFileURL(output).href)
const mainOutput = join(directory, 'main.mjs')
await build({ entryPoints: [join(DESKTOP, 'src/main/localization.ts')], outfile: mainOutput, bundle: true, platform: 'node', format: 'esm' })
const main = await import(pathToFileURL(mainOutput).href)
rmSync(directory, { recursive: true })

test('independent instances initialize offline and diagnostics never expose interpolation values', async () => {
  const eventsA = [], eventsB = []
  const resources = {
    zh: { foundation: { greet: '你好 {{name}}', onlyChinese: '原文' } },
    en: { foundation: { greet: 'Hello {{name}}' } }
  }
  const a = createLocalization('en', resources, { report: (event) => eventsA.push(event) })
  const b = createLocalization('zh', resources, { report: (event) => eventsB.push(event) })
  assert.equal(a.isInitialized, true)
  assert.equal(a.t('greet', { name: '<private>' }), 'Hello &lt;private&gt;')
  a.t('onlyChinese')
  a.t('absent')
  assert.ok(eventsA.some((e) => e.kind === 'fallback'))
  assert.ok(eventsA.some((e) => e.kind === 'missing'))
  assert.ok(!eventsB.some((e) => e.kind === 'missing' || e.kind === 'fallback'))
  assert.ok(!JSON.stringify(eventsA).includes('private'))
  await a.changeLanguage('zh')
  assert.equal(b.language, 'zh')
})

test('React interpolation is configured before init; missing resources fail visibly without raw keys', () => {
  const events = []
  const engine = createLocalization('en', { zh: { foundation: { greet: '{{name}}' } }, en: { foundation: { greet: '{{name}}' } } }, { escapeValue: false })
  assert.equal(engine.t('greet', { name: '<A&B>' }), '<A&B>')
  const missing = createLocalization('en', {}, { report: (event) => events.push(event) })
  assert.notEqual(missing.t('no.such.key'), 'no.such.key')
  assert.ok(events.some((event) => event.kind === 'missing'))
})

test('startup failure reporting works before initialization and follows the confirmed main language', async () => {
  assert.throws(() => main.mainLocalization(), /has not initialized/)
  assert.equal(main.startupFailureTitle(), '书深启动失败')
  assert.ok(main.storageFailureMessage('/pointer.json').includes('无法读取数据位置配置'))
  assert.ok(main.storageFailureMessage('/pointer.json').endsWith('/pointer.json'))
  await main.applyMainLanguage('en')
  assert.ok(main.storageFailureMessage('/pointer.json').includes('data location configuration'))
  assert.equal(main.startupFailureTitle(), 'ScholarSeed failed to start')
  await main.applyMainLanguage('zh')
  assert.equal(main.startupFailureTitle(), '书深启动失败')
})

test('English product surfaces use the ScholarSeed brand', () => {
  const localeDirectory = join(DESKTOP, 'src/localization/locales/en')
  const englishResources = readdirSync(localeDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(join(localeDirectory, name), 'utf8'))
    .join('\n')
  assert.doesNotMatch(englishResources, LEGACY_ENGLISH_BRAND)

  const packageConfig = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
  assert.deepEqual(packageConfig.author, {
    name: 'Alibaba Damo (Hangzhou) Technology Co., Ltd.'
  })
  assert.equal(packageConfig.build.productName, ENGLISH_BRAND)
  assert.equal(packageConfig.build.protocols.name, ENGLISH_BRAND)

  const rendererDocument = readFileSync(join(DESKTOP, 'src/renderer/index.html'), 'utf8')
  assert.match(rendererDocument, /<title>ScholarSeed<\/title>/)

  const storageSource = readFileSync(join(DESKTOP, 'src/main/storage.ts'), 'utf8')
  assert.match(storageSource, /DEFAULT_HOME_WORKSPACE_DIRNAME = 'ScholarSeed'/)
  assert.match(storageSource, /SCHOLARSEED_HOME_DIRNAME = '\.scholarseed'/)

  const projectCards = readFileSync(join(DESKTOP, 'src/renderer/src/features/project/ProjectCards.tsx'), 'utf8')
  assert.match(projectCards, /project-card-path/)
  assert.match(projectCards, /project\.path/)
})

test('an explicitly requested editor language is not fallback, but missing editor messages still are', async () => {
  const events = []
  const instance = createLocalization('en', {
    zh: { foundation: { present: '已翻译', absentInEnglish: '仅中文' } },
    en: { foundation: { present: 'Translated' } }
  }, { report: event => events.push(event) })
  const editor = instance.getFixedT('en', 'foundation')
  await instance.changeLanguage('zh')
  assert.equal(editor('present'), 'Translated')
  assert.equal(events.filter(event => event.kind === 'fallback').length, 0)
  assert.equal(editor('absentInEnglish'), '仅中文')
  assert.equal(events.filter(event => event.kind === 'fallback').length, 1)
  assert.equal(events.find(event => event.kind === 'fallback').language, 'en')
})
