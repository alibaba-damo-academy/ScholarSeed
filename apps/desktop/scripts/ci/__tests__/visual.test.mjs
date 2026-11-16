import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { isFixedVisualClass, layerTokenFindings, newVisualFindings, unknownLayerTokenFindings, visualFindings } from '../visual.mjs'

// The gate must recognize alternate syntaxes, not just the examples in the guide.
test('visual utilities reject fixed values across variants and arbitrary properties', () => {
  for (const token of ['gap-4', 'hover:!px-[18px]', '-mt-2', '[&_span]:text-sm', 'md:rounded-lg', 'shadow', 'z-0', 'z-[97]', '[z-index:97]', 'text-[length:14px]', 'w-[calc(100%_-_24px)]', 'font-[650]', 'leading-[1.5]', 'p-[var(--vds-missing,24px)]']) {
    assert.ok(isFixedVisualClass(token), token)
  }
  for (const token of ['grid', 'min-w-0', 'h-full', 'mx-auto', 'w-1/2', 'w-[100%]', 'shadow-none', 'rounded-full', 'z-auto', 'gap-[var(--vds-layout-section-gap)]', 'font-[var(--vds-fw-medium)]', 'text-[var(--vds-text-primary)]', '[&:focus]:z-[var(--vds-z-modal)]']) {
    assert.equal(isFixedVisualClass(token), false, token)
  }
})

test('identity ignores formatting, rejects replacements, owner movement and extra copies', () => {
  const before = visualFindings('const OLD_CLASS = "gap-4"')
  assert.deepEqual(newVisualFindings(visualFindings('\nconst OLD_CLASS =   "gap-4"'), before), [])
  assert.equal(newVisualFindings(visualFindings('const OLD_CLASS = "gap-8"'), before).length, 1)
  assert.equal(newVisualFindings(visualFindings('const NEW_CLASS = "gap-4"'), before).length, 1)
  assert.equal(newVisualFindings(visualFindings('const OLD_CLASS = "gap-4 gap-4"'), before).length, 1)
  assert.equal(newVisualFindings(visualFindings('const OLD_CLASS = "hover:gap-4"'), before).length, 1)
})

test('AST scans aliases, computed style properties, negative numbers; ignores comments and runtime geometry', () => {
  const hits = visualFindings(`
    // z-[97] gap-4
    const runtime = { width: measuredWidth, height: bounds.height, zIndex: 'var(--vds-z-modal)' }
    const structure = { width: '100%', height: 'auto', padding: 0 }
    const bad = { ['zIndex']: -4, padding: '16px', borderRadius: 8 }
    function View() { return <div style={{...bad, zIndex: 0}} className={cx('gap-4', enabled && 'focus:z-50')} /> }
  `)
  assert.deepEqual(hits.map(({ kind, value }) => [kind, value]), [
    ['zIndex', '-4'], ['padding', '16px'], ['borderRadius', '8'], ['zIndex', '0'], ['class', 'gap-4'], ['class', 'focus:z-50']
  ])
})

test('resource listing permits token-based dynamic indentation but rejects fixed geometry', () => {
  const dynamicGeometry = visualFindings(`
    function Listing() {
      return <div
        className="pl-[calc(var(--vds-library-tree-depth)*var(--vds-library-tree-indent))]"
        style={{ '--vds-library-tree-depth': depth }}
      />
    }
  `)
  assert.deepEqual(dynamicGeometry, [])

  const fixedGeometry = visualFindings(
    'function Listing() { return <div className="pl-[12px]" /> }'
  )
  assert.deepEqual(
    fixedGeometry.map(({ kind, value }) => [kind, value]),
    [['class', 'pl-[12px]']]
  )
})

test('CSS identities retain selector and media context and accept token references', () => {
  const source = '@media (width > 700px) { .x { gap: 16px; width: 100%; border-radius: var(--vds-radius-4); } }'
  assert.equal(visualFindings(source, 'test.css').length, 1)
  assert.equal(newVisualFindings(visualFindings(source.replace('.x', '.y'), 'test.css'), visualFindings(source, 'test.css')).length, 1)
})

test('core UI layer gate allows only semantic z-index tokens', () => {
  const source = 'const view=<><div className="z-[var(--vds-z-dialog)]"/><div className="focus:z-10"/><div style={{zIndex: 71}}/></>'
  assert.deepEqual(layerTokenFindings(source).map((hit) => [hit.kind, hit.value]), [
    ['class', 'focus:z-10'], ['zIndex', '71']
  ])
  assert.deepEqual(layerTokenFindings('.dialog { z-index: var(--vds-z-dialog); }', 'fixture.css'), [])
})

test('layer references must resolve to tokens owned by zindex.css', () => {
  assert.deepEqual(unknownLayerTokenFindings('const view=<div className="z-[var(--vds-z-dialog)]"/>').map((hit) => hit.value), [])
  assert.deepEqual(unknownLayerTokenFindings('const view=<div className="z-[var(--vds-z-does-not-exist)]"/>').map((hit) => hit.value), ['--vds-z-does-not-exist'])
})

test('workbench dividers stay below nonmodal floating panels', () => {
  const layers = new Map()
  const zindex = postcss.parse(readFileSync(new URL('../../../src/renderer/src/design/zindex.css', import.meta.url), 'utf8'))
  zindex.walkDecls((declaration) => layers.set(declaration.prop, Number(declaration.value)))
  assert.ok(layers.get('--vds-z-resize-handle') < layers.get('--vds-z-floating-panel'))

  const workbench = postcss.parse(readFileSync(new URL('../../../src/renderer/src/shell/workbench.css', import.meta.url), 'utf8'))
  workbench.walkDecls('--vds-resizable-handle-z-index', (declaration) => {
    assert.fail(`workbench divider overrides the floating-panel layer: ${declaration.parent.selector}`)
  })
})

test('ordinary text and IDs are not classes; referenced class/style constants are checked', () => {
  assert.deepEqual(visualFindings('const serverMessage="font-normal"; const data={width: 128}; const view=<div data-testid="gap-4" title="z-99">text-sm</div>'), [])
  const hits = visualFindings('const spacing=4; const look={padding:spacing*4,borderTopLeftRadius:8,zIndex:Number(900)}; const tokens="gap-4"; const view=<div className={tokens} style={look}/>')
  assert.deepEqual(hits.map(hit => hit.value), ['gap-4','16','8','900'])
})

test('binding resolution respects lexical shadows and style shorthand', () => {
  const source = `const gap='gap-4'; function View(){if(enabled){const gap='gap-[var(--vds-space-4)]';}return <div className={gap}/>}`
  assert.deepEqual(visualFindings(source).map(hit=>hit.value), ['gap-4'])
  assert.deepEqual(visualFindings(`const gap='gap-4'; function View(gap){return <div className={gap}/>} `), [])
  assert.deepEqual(visualFindings(`const zIndex=900; const width=24; function View(){return <div style={{zIndex,width}}/>}`).map(hit=>hit.value), ['900','24'])
  assert.deepEqual(visualFindings(`const zIndex=900; function View({zIndex}){return <div style={{zIndex}}/>}`), [])
})
