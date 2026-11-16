import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import ts from 'typescript'

const DESKTOP = fileURLToPath(new URL('../../../../../../', import.meta.url))

test('PDF navigation keeps nested outline collapsed and annotations inline with working filters', async () => {
  const sourceAttributes = (
    source: string,
    filename: string,
    tag: string,
    matches: (attributes: readonly ts.JsxAttribute[]) => boolean,
    properties: readonly string[]
  ): string => {
    const tree = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const targets: ts.JsxAttribute[][] = []
    const inspect = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === tag) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
        if (matches(attributes)) targets.push(attributes)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(tree)
    assert.equal(targets.length, 1)
    return properties
      .map((property) => {
        const attribute = targets[0].find((candidate) => candidate.name.getText(tree) === property)
        assert.ok(attribute?.initializer)
        return attribute.getText(tree)
      })
      .join(' ')
  }
  const documentSource = readFileSync(
    join(DESKTOP, 'src/renderer/src/features/workbench/PdfDocument.tsx'),
    'utf8'
  )
  const navigationStart = documentSource.indexOf('<TabsList className=')
  const copyActionsClass = sourceAttributes(
    documentSource.slice(
      documentSource.indexOf('const copyContribution ='),
      documentSource.indexOf('useSelectionActionContribution(tabId, selectionContribution)')
    ),
    'PdfDocument.tsx',
    'div',
    (attributes) => attributes.some((attribute) => attribute.name.getText() === 'className'),
    ['className']
  )
  const navigationMarkup = documentSource.slice(
    navigationStart,
    documentSource.indexOf('</TabsList>', navigationStart) + '</TabsList>'.length
  )
  const railClassName = sourceAttributes(
    documentSource,
    'PdfDocument.tsx',
    'nav',
    (attributes) =>
      attributes.some(
        (attribute) =>
          attribute.name.getText() === 'data-ob' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'pdf-tools'
      ),
    ['className']
  )
  const readingSource = readFileSync(
    join(DESKTOP, 'src/renderer/src/features/workbench/pdf/Reading.tsx'),
    'utf8'
  )
  const figureStart = readingSource.indexOf('<HoverCardTrigger')
  const translationClasses = sourceAttributes(
    readingSource,
    'Reading.tsx',
    'ScrollArea',
    (attributes) =>
      attributes.some(
        (attribute) =>
          attribute.name.getText() === 'viewportProps' &&
          attribute.initializer?.getText().includes('pdf-selection-')
      ),
    ['className', 'viewportClassName']
  )
  const figureMarkup = readingSource.slice(
    figureStart,
    readingSource.indexOf('</HoverCardTrigger>', figureStart) + '</HoverCardTrigger>'.length
  )
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { PdfOutline } from './src/renderer/src/features/workbench/pdf/Outline'
        import { PdfAnnotations } from './src/renderer/src/features/workbench/pdf/Annotations'
        import { PdfCommentEditor } from './src/renderer/src/features/workbench/pdf/Comment'
        import { Button, HoverCard, HoverCardTrigger, IconButton, ScrollArea, Tabs, TabsList, TabsTrigger, Tooltip } from './src/renderer/src/components/ui'
        import { BookOpen, NotebookPen, SquareChartGantt } from 'lucide-react'
        import { Icon } from './src/renderer/src/icons'
        const isLiterature = false
        const analysis = { expandedSelectionResult: false }
        const selectionResultFillsReader = false
        const labels = {
          zh: { outlineTab: '大纲', pagesTab: '缩略图', 'pdfAnnotation.records': '标注', searchTab: '查找' },
          en: { outlineTab: 'Outline', pagesTab: 'Thumbnails', 'pdfAnnotation.records': 'Annotations', searchTab: 'Search' }
        }
        let language = 'zh'
        const t = key => key === 'reading.figure' ? '图表解释' : labels[language][key]
        let figure = false
        const exitFigureSelection = () => { window.figureExited = true; figure = false }
        const onExclusiveSurfaceOpen = () => window.figureExclusive = true
        const setFigure = value => { figure = value; window.figureSelected = value }
        const setFigureGuideOpen = value => window.figureGuide = value
        const selectPanel = value => window.figurePanel = value
        const marks = [
          { id: 'highlight', page: 1, style: 'highlight', color: 'yellow', text: 'source one' },
          { id: 'underline', page: 2, style: 'underline', color: 'blue', text: 'source two' }
        ]
        window.focused = []
        window.deleted = []
        const root = createRoot(document.getElementById('root'))
        function render() { root.render(<>
          <div data-testid="selection-actions" className="flex items-center" style={{width:1058}}>
            <span>Selection actions</span>
            <div ${copyActionsClass}><span>Copy</span><span>Comment</span></div>
          </div>
          <div data-testid="translation-sizing" data-resized="false" className="group/pdf-selection flex flex-col" style={{height:400}}>
            <ScrollArea shadow="auto" ${translationClasses} viewportProps={{'data-testid':'translation-viewport'}}>
              {Array.from({length:40},(_,index)=><div key={index}>Translation line {index}</div>)}
            </ScrollArea>
          </div>
          <HoverCard>${figureMarkup}</HoverCard>
          <div data-testid="navigation-width" style={{ width: 190, padding: 8, boxSizing: 'border-box' }}><Tabs defaultValue="outline">${navigationMarkup}</Tabs></div>
          <nav data-testid="reader-rail" ${railClassName}><Tooltip content="信息"><IconButton label="信息" icon={<Icon name="doc" />} variant="ghost" onClick={() => window.railActivated = true} /></Tooltip></nav>
          <PdfOutline items={[{ title: 'Chapter', page: 1, children: [{ title: 'Section', page: 2, children: [{ title: 'Detail', page: 3, children: [] }] }] }]} onNavigate={page => window.focused.push(page)} />
          <PdfAnnotations comments={[{ id: 'comment', mark_id: 'underline', body: 'comment two' }]} marks={marks} saving={false} onDelete={id => window.deleted.push(id)} onFocus={mark => window.focused.push(mark.page)} renderEditor={(mark,close,mode,inline) => <div data-testid="annotation-editor">Editor{inline && <PdfCommentEditor inline comments={[{id:'comment',body:'comment two'}]} saving={false} onCancel={close} onSubmit={async drafts => {window.savedComments=drafts;return true}} />}</div>} />
        </>) }
        window.setNavigationLanguage = value => { language = value; render() }
        render()
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'navigation-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /primitive\/clipboard$/ }, () => ({
            path: 'clipboard',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'i18n'
                ? 'export const useTranslation = () => ({ t: (key, values) => values?.page ? key + " " + values.page : key, i18n: { resolvedLanguage: "en" } })'
                : 'export const writeClipboard = async text => { window.copied = text }',
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await expect(page.getByTestId('pdf-annotations-tab')).toBeVisible()
    await expect(page.getByTestId('pdf-outline-row-0')).toBeVisible()
    await expect(page.getByTestId('pdf-outline-row-0-0')).not.toBeVisible()
    await page.getByTestId('pdf-outline-toggle-0').click()
    await expect(page.getByTestId('pdf-outline-row-0-0')).toBeVisible()
    await expect(page.getByTestId('pdf-outline-row-0-0-0')).not.toBeVisible()
    await page.getByTestId('pdf-outline-toggle-0-0').focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('pdf-outline-row-0-0-0').click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focused')), [3])
    await expect(page.getByTestId('pdf-annotations').locator('header')).toHaveCount(0)
    await page.getByTestId('pdf-annotation-page-1').click()
    await expect(page.getByTestId('pdf-annotation-page-1')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(
      page.getByTestId('pdf-annotation-list').getByText('source one', { exact: true })
    ).not.toBeVisible()
    await page.getByTestId('pdf-annotation-page-1').click()
    await expect(
      page.getByTestId('pdf-annotation-list').getByText('source one', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'reading.expandPanel' })).toHaveCount(0)
    await page.getByRole('tab', { name: 'pdfAnnotation.filter.comment 1', exact: true }).click()
    await expect(
      page.getByTestId('pdf-annotation-list').getByText('source one', { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByTestId('pdf-annotation-list').getByText('source two', { exact: true })
    ).toBeVisible()
    await page.getByTestId('pdf-annotation-list').getByText('source two', { exact: true }).click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focused')), [3, 2])
    await page.getByRole('button', { name: 'pdfAnnotation.copyComment', exact: true }).click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'copied')), 'comment two')
    const copyComment = page.getByTestId('pdf-annotation-comment-caption').getByRole('button')
    await expect(copyComment.locator('svg.lucide-check')).toHaveCount(1)
    await expect(copyComment.locator('svg.lucide-check')).toHaveCount(0, { timeout: 4000 })
    const commentToggle = page.getByRole('button', { name: 'pdfAnnotation.comment', exact: true })
    await commentToggle.click()
    await expect(commentToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('pdf-annotation-inline-comment-editor')).toContainText('Editor')
    await expect(page.locator('.vds-popover')).toHaveCount(0)
    await expect(page.getByTestId('annotation-editor').locator('header')).toHaveCount(0)
    await page.getByRole('textbox').fill('discard this draft')
    await commentToggle.click()
    await expect(commentToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('annotation-editor')).toHaveCount(0)
    await expect(page.getByText('comment two', { exact: true })).toBeVisible()
    await commentToggle.click()
    await expect(page.getByRole('textbox')).toHaveValue('comment two')
    await page.getByRole('textbox').fill('saved comment')
    await page.getByRole('button', { name: 'pdfAnnotation.saveComment', exact: true }).click()
    await expect(page.getByTestId('annotation-editor')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'savedComments')), [
      { id: 'comment', body: 'saved comment' },
    ])
    await page.getByRole('button', { name: 'pdfAnnotation.more', exact: true }).click()
    await expect(page.getByTestId('annotation-editor')).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'pdfAnnotation.edit', exact: true }).click()
    await expect(page.getByTestId('annotation-editor')).toBeVisible()
    await page.getByRole('button', { name: 'pdfAnnotation.more', exact: true }).click()
    await page.getByRole('button', { name: 'pdfAnnotation.more', exact: true }).click()
    await expect(page.getByTestId('annotation-editor')).toHaveCount(0)
    await page
      .getByRole('menuitem', { name: 'pdfAnnotation.deletePageKind 2', exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'deleted')), ['underline'])
    const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
    const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.addStyleTag({ content: compiled.css })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      for (const path of ['0', '0-0', '0-0-0']) {
        const row = page.getByTestId(`pdf-outline-row-${path}`)
        await expect(row).toHaveCSS('height', '28px')
        await row.hover()
        await expect(row).toHaveCSS('height', '28px')
        const text = row.locator('[data-slot="ellipsis-text"]')
        const rowBounds = await row.boundingBox()
        const textBounds = await text.boundingBox()
        assert.ok(rowBounds && textBounds)
        assert.ok(textBounds.y >= rowBounds.y)
        assert.ok(textBounds.y + textBounds.height <= rowBounds.y + rowBounds.height)
        await page.mouse.down()
        await expect(row).toHaveCSS('height', '28px')
        await page.mouse.up()
      }
      for (const path of ['0', '0-0']) {
        const toggle = page.getByTestId(`pdf-outline-toggle-${path}`)
        await expect(toggle).toHaveCSS('width', '28px')
        await expect(toggle).toHaveCSS('height', '28px')
        await toggle.hover()
        await expect(toggle).toHaveCSS('height', '28px')
        await expect(toggle.locator('svg')).toHaveCSS('width', '14px')
        await expect(toggle.locator('svg')).toHaveCSS('height', '14px')
      }
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    const selectionActions = page.getByTestId('selection-actions')
    for (const width of [1058, 458]) {
      await selectionActions.evaluate((element, value) => {
        element.style.width = `${value}px`
      }, width)
      const bounds = await selectionActions.boundingBox()
      const trailing = await selectionActions.getByText('Comment', { exact: true }).boundingBox()
      assert.ok(bounds && trailing)
      assert.ok(Math.abs(bounds.x + bounds.width - trailing.x - trailing.width) < 1)
    }
    await page
      .getByRole('tab', { name: 'pdfAnnotation.filter.strikethrough 0', exact: true })
      .click()
    const emptyTitle = page.getByTestId('pdf-annotations').locator('.vds-empty-state__title')
    await expect(emptyTitle).toHaveText('pdfAnnotation.filterEmpty')
    await expect(emptyTitle).toHaveCSS('font-size', '12px')
    await expect(emptyTitle).toHaveCSS('font-weight', '400')
    await expect(emptyTitle.locator('../..')).toHaveCSS('text-align', 'center')
    const figureButton = page.getByTestId('pdf-figure-explanation')
    await expect(figureButton).toHaveAccessibleName('图表解释')
    await expect(figureButton.locator('svg')).toHaveAttribute('width', '16')
    await expect(figureButton.locator('svg')).toHaveAttribute('height', '16')
    const figureBounds = await figureButton.boundingBox()
    assert.ok(figureBounds)
    assert.equal(figureBounds.width, figureBounds.height)
    await figureButton.click()
    assert.deepEqual(
      await page.evaluate(() =>
        ['figureExclusive', 'figureSelected', 'figureGuide', 'figurePanel'].map((key) =>
          Reflect.get(window, key)
        )
      ),
      [true, true, false, null]
    )
    await figureButton.click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'figureExited')), true)
    const navigation = page.getByTestId('navigation-width')
    await expect(navigation.locator('.vds-tabs__indicator')).toHaveCSS('display', 'none')
    const rail = page.getByTestId('reader-rail')
    await expect(rail).toHaveCSS('width', '64px')
    assert.deepEqual(
      await rail.getByRole('button').evaluate((element) => {
        const label = getComputedStyle(element, '::after')
        return { content: label.content }
      }),
      { content: 'none' }
    )
    await rail.getByRole('button', { name: '信息', exact: true }).click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'railActivated')), true)
    await expect(navigation.getByRole('tab')).toHaveText(['大纲', '缩略图', '标注', '查找'])
    await expect(navigation.getByRole('tab').locator('svg')).toHaveCount(4)
    await expect(navigation.getByRole('tab').locator('.sr-only')).toHaveCount(4)
    for (const trigger of await navigation.getByRole('tab').all()) {
      await expect(trigger).toHaveCSS('white-space', 'nowrap')
      assert.ok((await trigger.boundingBox())!.height <= 32)
    }
    assert.equal(
      await navigation
        .getByRole('tablist')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true
    )
    assert.equal(
      await navigation
        .getByRole('tablist')
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
      true
    )
    await navigation.getByRole('tab', { name: '大纲', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(navigation.getByRole('tab', { name: '查找', exact: true })).toBeFocused()
    await page.evaluate(() => Reflect.get(window, 'setNavigationLanguage')('en'))
    await expect(navigation.getByRole('tab')).toHaveText([
      'Outline',
      'Thumbnails',
      'Annotations',
      'Search',
    ])
    assert.equal(
      await navigation
        .getByRole('tablist')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true
    )
    assert.equal(
      await navigation
        .getByRole('tablist')
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
      true
    )
    await navigation.getByRole('tab', { name: 'Outline', exact: true }).click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(navigation.getByRole('tab', { name: 'Search', exact: true })).toBeFocused()
    const translationViewport = page.getByTestId('translation-viewport')
    await expect(translationViewport.locator('..')).toHaveCSS('border-radius', '0px')
    await expect(translationViewport).toHaveCSS('font-size', '14px')
    await expect(translationViewport).toHaveCSS('height', '220px')
    await page
      .getByTestId('translation-sizing')
      .evaluate((element) => element.setAttribute('data-resized', 'true'))
    await expect(translationViewport).toHaveCSS('height', '400px')
    await translationViewport.scrollIntoViewIfNeeded()
    await translationViewport.hover()
    await page.mouse.wheel(0, 500)
    await expect
      .poll(() => translationViewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)
    await expect(translationViewport.locator('..')).toHaveAttribute('data-fade-top', 'true')
  } finally {
    await browser.close()
  }
})
