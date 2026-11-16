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

test('PDF evidence navigation floats below the header and preserves region navigation', async () => {
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
  let navigation: ts.JsxExpression | undefined
  let viewportStyle: ts.Expression | undefined
  let navigationMeasure: ts.CallExpression | undefined
  const inspect = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      if (
        attributes.some(
          (attribute) =>
            attribute.name.getText(tree) === 'data-ob' &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text === 'pdf-viewport'
        )
      ) {
        const style = attributes.find(
          (attribute) => attribute.name.getText(tree) === 'style'
        )?.initializer
        if (style && ts.isJsxExpression(style)) viewportStyle = style.expression
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useLayoutEffect' &&
      node.arguments[1]?.getText(tree) === '[citationTargets.length]'
    )
      navigationMeasure = node
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const condition = node.expression.left
      if (
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
        ts.isPropertyAccessExpression(condition.left) &&
        ts.isIdentifier(condition.left.expression) &&
        condition.left.expression.text === 'citationTargets' &&
        condition.left.name.text === 'length' &&
        ts.isNumericLiteral(condition.right) &&
        condition.right.text === '1'
      )
        navigation = node
    }
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
  assert.ok(navigation)
  assert.ok(viewportStyle)
  for (
    let ancestor: ts.Node | undefined = navigation.parent;
    ancestor;
    ancestor = ancestor.parent
  ) {
    if (!ts.isJsxElement(ancestor)) continue
    const attributes = ancestor.openingElement.attributes.getText(tree)
    assert.ok(
      !attributes.includes('vds-pdf-tools'),
      'evidence navigation must leave the top toolbar'
    )
    assert.ok(
      !attributes.includes('vds-pdf-pages'),
      'evidence navigation must not scroll with PDF pages'
    )
  }
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, {useLayoutEffect, useRef, useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {I18nextProvider, useTranslation} from 'react-i18next'
        import {ArrowUp, ArrowDown} from 'lucide-react'
        import {Button, EllipsisText, FloatingToolbar} from './src/renderer/src/components/ui'
        import {createLocalization, applyLocalizationLanguage} from './src/localization/engine'
        import zh from './src/localization/locales/zh/pdf.json'
        import en from './src/localization/locales/en/pdf.json'
        const localization = createLocalization('zh', {zh:{pdf:zh},en:{pdf:en}}, {report:()=>{}})
        window.setLanguage = language => applyLocalizationLanguage(localization, language)
        window.focused = []
        function Fixture() {
          const {t} = useTranslation('pdf')
          const [citationTargetIndex, setIndex] = useState(-1)
          const [count, setCount] = useState(3)
          const [sidebar, setSidebar] = useState(false)
          const navigationWidth = 260
          const citationTargets = [{page:1,region:0},{page:1,region:1},{page:3,region:0}].slice(0,count)
          const citationNavigationRef = useRef(null)
          const [citationNavigationHeight, setCitationNavigationHeight] = useState(0)
          ${navigationMeasure?.getText(tree) ?? ''}
          window.setEvidenceCount = value => {setCount(value);setIndex(-1)}
          window.setSidebar = setSidebar
          const requestFocus = target => {
            window.focused.push(target)
            setIndex(citationTargets.findIndex(candidate => candidate.page === target.page && candidate.region === target.region))
          }
          return <>
            <header data-testid="header" style={{height:48}}>PDF tools</header>
            <main data-testid="reader" className="relative" style={{height:360}}>
              <div data-testid="scroll" style={{height:'100%',overflow:'auto',...${viewportStyle.getText(tree)}}}><div data-testid="first-page" style={{height:1200}}>PDF content</div></div>
              ${navigation.getText(tree)}
            </main>
          </>
        }
        createRoot(document.getElementById('root')).render(<I18nextProvider i18n={localization}><Fixture/></I18nextProvider>)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  })
  const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
  const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const toolbar = page.getByRole('toolbar', { name: '引用区域导航' })
    const previous = page.getByRole('button', { name: '上一处依据', exact: true })
    const next = page.getByRole('button', { name: '下一处依据', exact: true })
    await expect(toolbar).toBeVisible()
    assert.ok(
      (await page.getByTestId('first-page').boundingBox())!.y >
        (await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height
    )
    assert.equal(
      await page.getByTestId('pdf-citation-navigation').evaluate((element) => {
        const style = getComputedStyle(element)
        return Number(style.zIndex) > Number(style.getPropertyValue('--vds-z-local-control'))
      }),
      true
    )
    await expect(toolbar).toContainText('共 3 处')
    await expect(previous).toBeDisabled()
    await expect(previous.locator('svg')).toHaveCount(1)
    await expect(next.locator('svg')).toHaveCount(1)
    await next.focus()
    await page.keyboard.press('Enter')
    await expect(toolbar).toContainText('1 / 3')
    await expect(previous).toBeDisabled()
    await next.click()
    await expect(toolbar).toContainText('2 / 3')
    await next.click()
    await expect(next).toBeDisabled()
    await previous.click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focused')), [
      { kind: 'citation', page: 1, region: 0 },
      { kind: 'citation', page: 1, region: 1 },
      { kind: 'citation', page: 3, region: 0 },
      { kind: 'citation', page: 1, region: 1 },
    ])
    const beforeScroll = await toolbar.boundingBox()
    await page.getByTestId('scroll').evaluate((element) => {
      element.scrollTop = 300
    })
    assert.deepEqual(await toolbar.boundingBox(), beforeScroll)
    for (const language of ['zh', 'en']) {
      await page.evaluate((value) => Reflect.get(window, 'setLanguage')(value), language)
      for (const width of [800, 360, 240]) {
        await page.setViewportSize({ width, height: 600 })
        const bounds = await page.getByRole('toolbar').boundingBox()
        const header = await page.getByTestId('header').boundingBox()
        assert.ok(bounds && header)
        assert.ok(bounds.y > header.y + header.height)
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
        assert.equal(
          await page
            .getByRole('toolbar')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
          true
        )
      }
    }
    await page.setViewportSize({ width: 800, height: 600 })
    await page.evaluate(() => Reflect.get(window, 'setSidebar')(true))
    assert.ok((await page.getByRole('toolbar').boundingBox())!.x > 260)
    await page.setViewportSize({ width: 366, height: 600 })
    for (const language of ['zh', 'en']) {
      await page.evaluate((value) => Reflect.get(window, 'setLanguage')(value), language)
      await page.evaluate(() => Reflect.get(window, 'setEvidenceCount')(3))
      const narrowToolbar = page.getByRole('toolbar')
      const bounds = await narrowToolbar.boundingBox()
      assert.ok(bounds)
      await expect
        .poll(async () => {
          const firstPage = await page.getByTestId('first-page').boundingBox()
          const bar = await narrowToolbar.boundingBox()
          const scrollTop = await page
            .getByTestId('scroll')
            .evaluate((element) => element.scrollTop)
          return Boolean(firstPage && bar && firstPage.y + scrollTop > bar.y + bar.height)
        })
        .toBe(true)
      assert.equal(
        await narrowToolbar.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true
      )
      for (const button of await narrowToolbar.getByRole('button').all()) {
        const buttonBounds = await button.boundingBox()
        const iconBounds = await button.locator('svg').boundingBox()
        assert.ok(buttonBounds && iconBounds)
        assert.ok(
          buttonBounds.x >= bounds.x &&
            buttonBounds.x + buttonBounds.width <= bounds.x + bounds.width
        )
        assert.ok(
          iconBounds.x >= bounds.x && iconBounds.x + iconBounds.width <= bounds.x + bounds.width
        )
      }
      const nextEvidence = narrowToolbar.getByRole('button').last()
      await nextEvidence.focus()
      await page.keyboard.press('Enter')
      await expect(narrowToolbar).toContainText('1 / 3')
    }
    await page.setViewportSize({ width: 800, height: 600 })
    const surface = page.locator('.vds-floating-toolbar')
    const light = await surface.evaluate((element) => getComputedStyle(element).backgroundColor)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    assert.notEqual(
      await surface.evaluate((element) => getComputedStyle(element).backgroundColor),
      light
    )
    for (const count of [1, 0]) {
      await page.evaluate((value) => Reflect.get(window, 'setEvidenceCount')(value), count)
      await expect(page.getByRole('toolbar')).toHaveCount(0)
    }
  } finally {
    await browser.close()
  }
})
