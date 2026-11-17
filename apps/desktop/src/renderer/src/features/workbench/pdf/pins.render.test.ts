import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import ts from 'typescript'

const DESKTOP = fileURLToPath(new URL('../../../../../../', import.meta.url))

test('PDF geometry restoration preserves explicit focus instead of returning to a citation', async () => {
  const source = readFileSync(
    join(DESKTOP, 'src/renderer/src/features/workbench/PdfDocument.tsx'),
    'utf8'
  )
  const tree = ts.createSourceFile(
    'PdfDocument.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let restoration: ts.CallExpression | undefined
  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useLayoutEffect'
    ) {
      const dependencies = node.arguments[1]
      if (dependencies && ts.isArrayLiteralExpression(dependencies)) {
        const names = dependencies.elements.map((element) => element.getText(tree))
        if (
          names.length === 4 &&
          ['pageCount', 'scale', 'sidebar', 'translationLayoutOpen'].every((name) =>
            names.includes(name)
          )
        )
          restoration = node
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
  assert.ok(restoration)
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, {useCallback, useLayoutEffect, useRef, useState} from 'react'
        import {createRoot} from 'react-dom/client'
        function Fixture() {
          const [focus, setFocus] = useState()
          const sequence = useRef(0)
          const requestFocus = useCallback(target => setFocus({...target, sequence:++sequence.current}), [])
          const [scale, setScale] = useState(1)
          const [sidebar, setSidebar] = useState(false)
          const [translationLayoutOpen, setTranslationLayoutOpen] = useState(false)
          const translationResize = useRef(false)
          const navigationAnchorRef = useRef()
          const zoomAnchorRef = useRef()
          const viewportRef = useRef(null)
          const citationPages = [{page:2}]
          const pageCount = 3
          const currentPage = focus?.page ?? 1
          window.requestTarget = requestFocus
          ${restoration.getText(tree)}
          return <>
            <output data-testid="focus">{JSON.stringify(focus)}</output>
            <button onClick={() => setScale(value => value + 1)}>Resize</button>
            <button onClick={() => setSidebar(value => !value)}>Sidebar</button>
            <button onClick={() => setTranslationLayoutOpen(value => !value)}>Translation</button>
          </>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = page.getByTestId('focus')
    await expect(result).toContainText('"kind":"citation"')
    for (const target of [
      { kind: 'annotation', page: 1, id: 'point' },
      { kind: 'search', page: 1, ordinal: 0 },
      { kind: 'reading', page: 1, text: 'selected text' },
      { kind: 'link', page: 1, left: 0, top: 0 },
      { kind: 'citation', page: 2, region: 1 },
    ]) {
      await page.evaluate((value) => Reflect.get(window, 'requestTarget')(value), target)
      for (const action of ['Resize', 'Sidebar', 'Translation']) {
        const before = JSON.parse((await result.textContent())!)
        await page.getByRole('button', { name: action, exact: true }).click()
        const after = JSON.parse((await result.textContent())!)
        const { sequence, ...actual } = after
        assert.deepEqual(actual, target)
        assert.ok(sequence > before.sequence)
      }
    }
  } finally {
    await browser.close()
  }
})

test('page point comments use real click coordinates, avoid text, and preserve selection drags', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {PdfPage} from './src/renderer/src/features/workbench/pdf/Page';
      import {PdfCommentEditor} from './src/renderer/src/features/workbench/pdf/Comment';
      import {PdfCommentDraft} from './src/renderer/src/features/workbench/pdf/Annotation';
      const page={pageNumber:1,userUnit:1,getViewport:({scale})=>({width:200*scale,height:300*scale,scale,transform:[scale,0,0,-scale,0,300*scale]}),render:()=>({promise:Promise.resolve(),cancel(){}}),getOperatorList:async()=>({fnArray:[],argsArray:[]}),getAnnotations:async()=>[],cleanup(){}};
      const fonts={prepare:async()=>({lang:'en',items:[]}),textPage:page=>page};
      window.points=[];
      function Fixture(){
        const [scenario,setScenario]=React.useState({scale:1,translated:true,crowded:false});
        const [railWidth,setRailWidth]=React.useState(0);
        window.setPinScenario=setScenario;
        const textMarks=Array.from({length:scenario.crowded?8:1},(_,index)=>({id:index?'text-'+index:'text',style:'highlight',page:1,text:'selectable source',quads:[scenario.crowded?[.02*index,.9,.02*index+.01,.92]:[.4,.33,.7,.44]],color:'yellow',anchor_state:'anchored',created_at:index+1}));
        return <div style={{width:400,height:350,overflow:'auto'}} data-testid="scroll">
        <div style={{display:'grid',gridTemplateColumns:scenario.translated?(200*scenario.scale+railWidth)+'px 120px':'max-content',width:'max-content'}} data-testid="pair">
        <PdfPage page={page} fonts={fonts} scale={scenario.scale} keepRendered pointCommentEnabled focus={{kind:'annotation',page:1,id:'point',sequence:1}}
          hideCommentPins={scenario.hidePins}
          annotations={[{id:'point',style:'comment',page:1,point:[.5,.4],text:'',quads:[],color:'green',anchor_state:'anchored'}, ...textMarks]}
          onCommentRail={React.useCallback((_page,width)=>setRailWidth(width),[])} comments={[{mark_id:'point',body:'Point comment preview'},...textMarks.map(mark=>({mark_id:mark.id,body:'Text comment preview'}))]} renderAnnotation={(mark,close,mode='edit')=><section style={{width:'var(--vds-pdf-comment-width)',maxWidth:'100%'}}><span>inspector {mark.id} {mode}</span>{mode==='comment'&&<PdfCommentEditor comments={[{id:'comment',body:'Existing comment'}]} saving={false} onCancel={close} onSubmit={async()=>true}/>}</section>}
          renderPointComment={(point,close)=><PdfCommentDraft page={1} point={point} saving={false} onCancel={close} onSave={async body=>{window.points.push({point,body});return true}}/>}
        />
        {scenario.translated&&<div data-testid="translation" style={{width:120,height:300}}>Adjacent translation must remain clear.</div>}
        </div>
      </div>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'page-pin-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /pdfjs-dist\/legacy\/web\/pdf_viewer.mjs$/ }, () => ({
            path: 'text',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'i18n'
                ? 'export const useTranslation=()=>({t:key=>key==="pdfAnnotation.cancel"?"Cancel":key==="pdfAnnotation.saveComment"?"Save":key})'
                : `
        export class TextLayerBuilder {
          constructor(options){this.options=options;this.div=document.createElement('div');this.div.className='textLayer';this.div.style.cssText='position:absolute;inset:0';}
          async render(){const span=document.createElement('span');span.textContent='selectable source';span.dataset.testid='source-text';span.style.cssText='position:absolute;left:80px;top:100px;width:60px;height:30px';this.div.append(span);this.options.onAppend(this.div)}
          cancel(){}
        }
      `,
          }))
        },
      },
    ],
  })
  const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
  const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.route('http://localhost/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    )
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: compiled.css })
    await page.addStyleTag({
      content: '[data-testid="pair"] > [data-pdf-page-frame] { margin: 0; }',
    })
    await page.addStyleTag({
      content: readFileSync(
        join(DESKTOP, 'src/renderer/src/features/workbench/pdf/pdf.css'),
        'utf8'
      ),
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const pdf = page.getByTestId('pdf-page-1')
    await expect(pdf).toHaveAttribute('data-text-rendered', 'true')
    await expect(page.getByTestId('pdf-point-comment-point')).toHaveAttribute(
      'data-annotation-focused',
      'true'
    )
    const pin = await page.getByTestId('pdf-point-comment-point').boundingBox()
    const railPin = page.getByTestId('pdf-comment-pin-text')
    for (const property of ['background-color', 'color', 'border-top-width']) {
      const expected = await railPin.evaluate(
        (element, property) => getComputedStyle(element).getPropertyValue(property),
        property
      )
      await expect(page.getByTestId('pdf-point-comment-point')).toHaveCSS(property, expected)
    }
    await expect(page.getByTestId('pdf-point-comment-point').locator('svg')).toHaveClass(
      /lucide-message-square-text/
    )
    await expect(page.getByTestId('pdf-comment-pin-text').locator('svg')).toHaveClass(
      /lucide-message-square-text/
    )
    const source = await page.getByTestId('source-text').boundingBox()
    assert.ok(pin && source)
    assert.ok(
      pin.x + pin.width <= source.x ||
        pin.x >= source.x + source.width ||
        pin.y + pin.height <= source.y ||
        pin.y >= source.y + source.height
    )
    const rail = page.getByTestId('pdf-comment-pin-text')
    await rail.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Text comment preview')
    await page.getByTestId('pdf-point-comment-point').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Point comment preview')
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(rail).toHaveCSS('border-top-width', '0px')
    const pinColors = await rail.evaluate((element) => {
      const probe = document.createElement('span')
      element.append(probe)
      probe.style.color = 'var(--vds-icon-outline-default)'
      const icon = getComputedStyle(probe).color
      probe.style.backgroundColor = 'var(--vds-other-overlay-2)'
      const background = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { icon, background }
    })
    await expect(rail.locator('svg')).toHaveCSS('color', pinColors.icon)
    await expect(rail).toHaveCSS('background-color', pinColors.background)
    const railBounds = await rail.boundingBox()
    const translationBounds = await page.getByTestId('translation').boundingBox()
    assert.ok(railBounds && translationBounds)
    assert.ok(
      railBounds.x + railBounds.width <= translationBounds.x,
      'comment rail overlaps translation'
    )
    await rail.click()
    await expect(page.getByText('inspector text comment', { exact: true })).toBeVisible()
    const editorBounds = await page
      .getByRole('textbox')
      .first()
      .evaluate((input) => {
        const popup = input.closest('.vds-popover')!
        const bounds = popup.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: window.innerWidth,
          contents: Array.from(popup.querySelectorAll('textarea, button'), (element) => {
            const rectangle = element.getBoundingClientRect()
            return { left: rectangle.left, right: rectangle.right }
          }),
        }
      })
    assert.ok(editorBounds.left >= 0 && editorBounds.right <= editorBounds.viewport)
    for (const content of editorBounds.contents) {
      assert.ok(content.left >= editorBounds.left && content.right <= editorBounds.right)
    }
    await expect(page.getByTestId('pdf-mark-text')).toHaveAttribute(
      'data-annotation-focused',
      'true'
    )
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pdf-mark-text')).toHaveAttribute(
      'data-annotation-focused',
      'false'
    )
    await page
      .getByTestId('pdf-mark-text')
      .evaluate((element) => (element as HTMLButtonElement).click())
    await expect(page.getByText('inspector text edit', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('pdf-point-comment-point').click()
    await expect(page.getByText('inspector point comment', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('scroll').evaluate((element) => {
      element.scrollLeft = 0
    })
    const bounds = await pdf.boundingBox()
    assert.ok(bounds)
    await page.mouse.click(bounds.x + 20, bounds.y + 200)
    const draft = page.getByTestId('pdf-point-comment-draft')
    await expect(draft.getByTestId('pdf-annotation-actions')).toBeVisible()
    await expect(draft.getByRole('textbox')).toBeFocused()
    await expect(draft.getByRole('textbox')).toHaveAttribute('placeholder', 'commentPlaceholder')
    await draft.getByRole('textbox').fill('local point')
    await draft.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(draft).toHaveCount(0)
    const saved = await page.evaluate(() => Reflect.get(window, 'points'))
    assert.deepEqual(saved, [{ point: [0.1, 2 / 3], body: 'local point' }])
    await page.mouse.move(bounds.x + 10, bounds.y + 150)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 50, bounds.y + 150, { steps: 5 })
    await page.mouse.up()
    await expect(draft).toHaveCount(0)
    await page.mouse.click(bounds.x + 20, bounds.y + 250)
    await expect(draft).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(draft).toHaveCount(0)
    assert.equal((await page.evaluate(() => Reflect.get(window, 'points'))).length, 1)
    for (const scenario of [
      { scale: 0.5, translated: true, crowded: true },
      { scale: 1.5, translated: false, crowded: true },
      { scale: 1.5, translated: true, crowded: true },
      { scale: 1, translated: true, crowded: false },
    ]) {
      await page.evaluate((value) => Reflect.get(window, 'setPinScenario')(value), scenario)
      const pins = page.locator('[data-testid^="pdf-comment-pin-"]')
      await expect(pins).toHaveCount(scenario.crowded ? 8 : 1)
      const layout = await page.evaluate(() => {
        const bounds = (
          element: Element
        ): { left: number; right: number; top: number; bottom: number } => {
          const rectangle = element.getBoundingClientRect()
          return {
            left: rectangle.left,
            right: rectangle.right,
            top: rectangle.top,
            bottom: rectangle.bottom,
          }
        }
        const source = document.querySelector('[data-testid="pdf-page-1"]')!
        const translation = document.querySelector('[data-testid="translation"]')
        return {
          source: bounds(source),
          pair: bounds(document.querySelector('[data-testid="pair"]')!),
          translation: translation ? bounds(translation) : null,
          pins: Array.from(document.querySelectorAll('[data-testid^="pdf-comment-pin-"]'), bounds),
          frame: bounds(source.closest('[data-pdf-page-frame]')!),
        }
      })
      assert.equal(layout.frame.right, layout.source.right)
      assert.equal(layout.frame.left, layout.source.left)
      for (const pin of layout.pins) {
        assert.ok(pin.left >= layout.source.right)
        if (layout.translation) assert.ok(pin.right <= layout.translation.left)
        for (const other of layout.pins) {
          if (other === pin) continue
          assert.ok(
            pin.right <= other.left ||
              other.right <= pin.left ||
              pin.bottom <= other.top ||
              other.bottom <= pin.top
          )
        }
      }
      if (!layout.translation) assert.equal(layout.frame.right, layout.pair.right)
      await page.getByTestId(`pdf-comment-pin-${scenario.crowded ? 'text-7' : 'text'}`).click()
      await expect(
        page.getByText(`inspector ${scenario.crowded ? 'text-7' : 'text'} comment`, { exact: true })
      ).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.evaluate(() =>
      Reflect.get(
        window,
        'setPinScenario'
      )({ scale: 1, translated: true, crowded: true, hidePins: true })
    )
    await expect(page.locator('[data-pdf-comment-pins]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="pdf-comment-pin-"]')).toHaveCount(0)
  } finally {
    await browser.close()
  }
})
