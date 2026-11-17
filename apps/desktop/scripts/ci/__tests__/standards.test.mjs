import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import postcss from 'postcss'
import './visual.test.mjs'
import './git.test.mjs'

import { cssInventory, cssDebtErrors, validateCssExceptions } from '../css.mjs'

import { foundationCssErrors, unresolvedTokens, checkStandards, classifyStyleSource, compareRatchet, generatedDocuments, moduleSpecifiers, scanArchitecture, scanStyles, validateEnglishRegistry } from '../standards.mjs'

const DESKTOP_ROOT = new URL('../../../', import.meta.url)
const REPOSITORY_ROOT = new URL('../../../../../', import.meta.url)
const DESKTOP_PACKAGE = JSON.parse(readFileSync(new URL('package.json', DESKTOP_ROOT), 'utf8'))
const DESKTOP_LOCK = JSON.parse(readFileSync(new URL('package-lock.json', DESKTOP_ROOT), 'utf8'))
const ROOT_PACKAGE = JSON.parse(readFileSync(new URL('package.json', REPOSITORY_ROOT), 'utf8'))
const ROOT_LOCK = JSON.parse(readFileSync(new URL('package-lock.json', REPOSITORY_ROOT), 'utf8'))

test('Tailwind entry directives are not handwritten style rules', () => {
  assert.deepEqual(cssDebtErrors([['frame.css', "@import 'tailwindcss' source(none); @source './frame.ts';"]], {}), [])
})

test('Tailwind directives do not exempt owned rules, arbitrary imports or apply', () => {
  const check = source => cssDebtErrors([['frame.css', source]], {})
  assert.equal(check("@import 'tailwindcss'; .card { color: red; }").length, 1)
  assert.equal(check("@import './private.css';").length, 1)
  assert.equal(check("@source './frame.ts';").length, 1)
  assert.ok(check("@import 'tailwindcss'; .card { @apply bg-red-500; }").some(error => error.includes('bypasses')))
  assert.ok(check("@import 'tailwindcss'; @source './frame.ts' { color: red; }").length)
})

test('Desktop quality dependencies stay synchronized with the committed lock file', () => {
  assert.deepEqual(DESKTOP_LOCK.packages[''].devDependencies, DESKTOP_PACKAGE.devDependencies)
})

test('Desktop lint keeps the existing warning debt behind a non-increasing budget', () => {
  assert.equal(DESKTOP_PACKAGE.scripts.lint, 'eslint src/ --max-warnings 305')
})

test('root Husky lifecycle dependency stays synchronized with the committed lock file', () => {
  assert.equal(ROOT_PACKAGE.scripts.prepare, 'husky')
  assert.equal(ROOT_LOCK.packages[''].devDependencies.husky, ROOT_PACKAGE.devDependencies.husky)
})

test('coverage thresholds are enforced instead of report-only metadata', () => {
  const coverage = JSON.parse(readFileSync(new URL('.c8rc.json', DESKTOP_ROOT), 'utf8'))
  assert.equal(coverage['check-coverage'], true)
})

test('resource tree depth uses custom properties without relaxing visual inline checks', () => {
  const source = readFileSync(new URL('src/renderer/src/features/resources/Listing.tsx', DESKTOP_ROOT), 'utf8')
  assert.equal(classifyStyleSource(source, 'Listing.tsx').visualInlineStyle, 0)
  assert.equal(classifyStyleSource(`
    const row = <div style={{ '--vds-library-tree-depth': depth }} />
  `, 'fixture.tsx').visualInlineStyle, 0)
  for (const source of [
    `const row = <div style={{ paddingLeft: '12px' }} />`,
    `const row = <div style={{ paddingLeft: offset }} />`,
    `const row = <div style={{ color: 'var(--vds-text-primary)' }} />`,
  ]) {
    assert.equal(classifyStyleSource(source, 'fixture.tsx').visualInlineStyle, 1)
  }
})

test('Desktop E2E CI installs the Electron runtime before launching smoke tests', () => {
  const pipeline = readFileSync(new URL('.gitlab-ci.yml', REPOSITORY_ROOT), 'utf8')
  const job = pipeline.match(/desktop-e2e-smoke:\n([\s\S]*?)(?=\n[^\s#][^\n]*:\n|$)/)?.[1] ?? ''
  assert.ok(job.includes('npm ci --no-audit --no-fund'))
  assert.ok(!job.includes('npm ci --ignore-scripts'))
})

test('extracted API modules do not depend on the legacy API barrel', () => {
  const apiRoot = new URL('src/renderer/src/app/api/', DESKTOP_ROOT)
  for (const file of readdirSync(apiRoot).filter((entry) => entry.endsWith('.ts'))) {
    const source = readFileSync(new URL(`src/renderer/src/app/api/${file}`, DESKTOP_ROOT), 'utf8')
    assert.ok(!moduleSpecifiers(source).some((specifier) => specifier.endsWith('/api')))
  }
})

test('Desktop local standards and generated inventories stay synchronized', () => {
  assert.deepEqual(checkStandards(), [])
})

test('generated inventories use English while retaining component coverage', () => {
  const documents = generatedDocuments()
  for (const [path, source] of documents) {
    const withoutLegacyAnchors = source.replace(/<a id="[^"]+"><\/a>/g, '')
    assert.equal(/[\u4e00-\u9fff]/u.test(withoutLegacyAnchors), false, `${path} contains untranslated text`)
  }
  const components = documents.get('_generated/components.md')
  assert.match(components, /\| Accordion \|/)
  assert.match(components, /\| Button \|/)
  assert.match(components, /<a id="ui-组件族"><\/a>/)
})

test('English component descriptions reject missing, incomplete, untranslated, and stale entries', () => {
  const registry = { Button: { intents: ['按钮'], use: '用途', avoid: '避免' } }
  const valid = { Button: { intents: ['button'], use: 'Use for actions.', avoid: 'Use IconButton for icon-only actions.', sourceHash: 'be9fda2c16927f98cb0a7f169d9c2a837bdece5a2a4991d47a4fb6ec3c1f1ddd' } }
  assert.doesNotThrow(() => validateEnglishRegistry(registry, valid))
  assert.throws(() => validateEnglishRegistry(registry, {}), /cover exactly/)
  assert.throws(() => validateEnglishRegistry(registry, { Button: { ...valid.Button, use: '' } }), /Missing English/)
  assert.throws(() => validateEnglishRegistry(registry, { Button: { ...valid.Button, avoid: '按钮' } }), /Untranslated/)
  assert.throws(() => validateEnglishRegistry({ Button: { ...registry.Button, use: '已更改' } }, valid), /needs review/)
})

test('UI consumers use the barrel and UI has no business reverse dependency', () => {
  assert.deepEqual(scanArchitecture(), { deepImports: [], reverseDependencies: [] })
})

test('style scan exposes categorized per-file debt for the ratchet', () => {
  const result = scanStyles()
  for (const counts of Object.values(result.counts)) {
    assert.deepEqual(Object.keys(counts), ['rawColor', 'fixedTailwindColor', 'visualInlineStyle'])
  }
})

test('module parser covers imports, type imports, re-exports and dynamic imports', () => {
  const source = `
    import { Button } from '../../components/ui/Button'
    import type { DialogProps } from '../../components/ui/Dialog'
    export { Select } from '../../components/ui/Select'
    const module = import('../../components/ui/Popover')
  `
  assert.deepEqual(moduleSpecifiers(source), [
    '../../components/ui/Button',
    '../../components/ui/Dialog',
    '../../components/ui/Select',
    '../../components/ui/Popover'
  ])
})

test('style ratchet rejects growth and requires baseline tightening after decrease', () => {
  const baseline = { 'feature.tsx': { rawColor: 1, fixedTailwindColor: 0, visualInlineStyle: 1 } }
  assert.deepEqual(compareRatchet(baseline, baseline), [])
  assert.match(compareRatchet({ 'feature.tsx': { rawColor: 2, fixedTailwindColor: 0, visualInlineStyle: 1 } }, baseline).join('\n'), /increased/)
  assert.match(compareRatchet({ 'feature.tsx': { rawColor: 0, fixedTailwindColor: 0, visualInlineStyle: 1 } }, baseline).join('\n'), /decreased/)
  assert.match(compareRatchet({ 'new.tsx': { rawColor: 1, fixedTailwindColor: 0, visualInlineStyle: 0 } }, {}).join('\n'), /new\.tsx.*1 > 0/)
})

test('style classifier ignores comments, permits geometry and detects visual literals', () => {
  assert.deepEqual(classifyStyleSource(`
    // #fff and text-red-500 are examples in a comment
    const geometry = <div style={{ width, left }} />
    const visual = <div className="text-red-500" style={{ color: '#fff' }} />
  `, 'fixture.tsx'), { rawColor: 1, fixedTailwindColor: 1, visualInlineStyle: 1 })
  assert.deepEqual(classifyStyleSource('/* #fff */ .x { color: #000; background: var(--vds-bg); }', 'fixture.css'), { rawColor: 1, fixedTailwindColor: 0, visualInlineStyle: 0 })
})

// WCAG relative luminance. Token evidence supplements real browser acceptance.
const NORMAL_TEXT_CONTRAST = 4.5
function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((channel) => {
    const value = parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('brand text contrast covers light, explicit dark and system dark states', () => {
  const css = postcss.parse(readFileSync(new URL('../../../src/renderer/src/design/tokens.css', import.meta.url), 'utf8'))
  const contexts = []
  css.walkRules((rule) => {
    const values = new Map()
    rule.each((node) => { if (node.type === 'decl') values.set(node.prop, node.value) })
    if (values.has('--vds-brand-bg-default')) contexts.push(values)
  })
  assert.equal(contexts.length, 3, 'light plus both dark branches')
  function resolve(values, name, seen = new Set()) {
    assert.ok(!seen.has(name), `cyclic token ${name}`)
    seen.add(name)
    const value = values.get(name)
    assert.ok(value, `missing token ${name}`)
    const alias = /^var\((--[\w-]+)\)$/.exec(value)
    return alias ? resolve(values, alias[1], seen) : value
  }
  for (const [index, overrides] of contexts.entries()) {
    const values = new Map([...contexts[0], ...overrides])
    for (const [background, foreground] of [
      ['--vds-brand-bg-default', '--vds-text-on-brand'],
      ['--vds-brand-bg-hover', '--vds-text-on-brand-hover'],
      ['--vds-brand-bg-active', '--vds-text-on-brand-active']
    ]) {
      const a = luminance(resolve(values, background))
      const b = luminance(resolve(values, foreground))
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      assert.ok(contrast >= NORMAL_TEXT_CONTRAST, `theme ${index} ${background}: ${contrast.toFixed(2)}`)
    }
  }
})


test('carousel indicator colors belong to the design owner without changing their aliases', () => {
  const theme = postcss.parse(readFileSync(new URL('../../../src/renderer/src/design/theme.css', import.meta.url), 'utf8'))
  const styles = postcss.parse(readFileSync(new URL('../../../src/renderer/src/styles.css', import.meta.url), 'utf8'))
  for (const [name, value] of [
    ['--vds-carousel-indicator-track', 'var(--vds-fill-5)'],
    ['--vds-carousel-indicator-value', 'var(--vds-brand-bg-default)']
  ]) {
    const definitions = []
    theme.walkDecls(name, declaration => definitions.push(declaration))
    assert.equal(definitions.length, 1, name)
    assert.equal(definitions[0].value, value)
    assert.ok(definitions[0].parent.selector.includes(':root'))
    styles.walkDecls(name, () => assert.fail(`${name} must not be duplicated outside design`))
  }
})

test('token closure rejects missing names while permitting local properties and explicit fallbacks', () => {
  assert.deepEqual(unresolvedTokens([
    ['tokens.css', ':root { --vds-surface: var(--vds-missing); }'],
    ['Control.tsx', "'[--vds-local:var(--vds-surface)] bg-[var(--vds-local)] text-[var(--vds-optional,inherit)]'"]
  ]), [{ path: 'tokens.css', token: '--vds-missing' }])
})


test('foundation CSS permits tokens and keyframes but rejects owned selectors and apply', () => {
  assert.deepEqual(foundationCssErrors(":root { --vds-size: 4px; color-scheme: light; } @keyframes spin { to { transform: rotate(360deg); } }", 'design.css'), [])
  assert.deepEqual(foundationCssErrors('@media (prefers-color-scheme: dark) { :root:not([data-theme]):not(.light) { --vds-color: black; } }', 'design.css'), [])
  assert.ok(foundationCssErrors(':root .panel { --vds-color: black; }', 'design.css').some((error) => error.includes('owned selector')))
  assert.ok(foundationCssErrors('.panel { display: flex; }', 'design.css').some((error) => error.includes('owned selector')))
  assert.ok(foundationCssErrors(':root { padding: 4px; }', 'design.css').some((error) => error.includes('non-foundation')))
  assert.ok(foundationCssErrors('.panel { @apply flex; }', 'design.css').some((error) => error.includes('@apply')))
})

test('CSS identities allow old rules and deletions, reject replacement and new files', () => {
  const source = '.legacy { display: flex; color: var(--vds-text-primary); }'
  const baseline = { 'old.css': cssInventory(source) }
  assert.deepEqual(cssDebtErrors([['old.css', `/* comment */ ${source}`]], baseline), [])
  assert.deepEqual(cssDebtErrors([['old.css', '']], baseline), [])
  assert.match(cssDebtErrors([['old.css', '.new { display: flex; }']], baseline).join('\n'), /new or changed/)
  assert.match(cssDebtErrors([['old.css', source.replace('flex', 'grid')]], baseline).join('\n'), /new or changed/)
  assert.match(cssDebtErrors([['new.css', source]], baseline).join('\n'), /new\.css/)
  assert.match(cssDebtErrors([['old.css', `${source}${source}`]], baseline).join('\n'), /new or changed/)
  assert.match(cssDebtErrors([['old.css', `@media (max-width: 600px) { ${source} }`]], baseline).join('\n'), /@media/)
})

test('CSS vendor exception requires metadata and exact container-scoped selector', () => {
  const exception = {path:'editor.css',scope:'.integration',selector:'.integration .vendor-text',library:'vendor',reason:'generated DOM has no className API',verification:'open editor and check text selection'}
  assert.deepEqual(cssDebtErrors([['editor.css', '.integration .vendor-text { color: var(--vds-text-primary); }']], {}, [exception]), [])
  assert.match(cssDebtErrors([['editor.css', '.integration .toolbar { display: flex; }']], {}, [exception]).join('\n'), /Tailwind/)
  assert.match(validateCssExceptions([{...exception, selector:'.integration .vendor-text, body'}]).join('\n'), /scope/)
  assert.match(validateCssExceptions([{...exception, reason:''}]).join('\n'), /reason/)
  assert.match(cssDebtErrors([['editor.css', '.integration .vendor-text { @apply flex; }']], {}, [exception]).join('\n'), /@apply/)
  assert.match(cssDebtErrors([['editor.css', '.integration .vendor-text { .toolbar { display: flex; } }']], {}, [exception]).join('\n'), /Tailwind/)
})
