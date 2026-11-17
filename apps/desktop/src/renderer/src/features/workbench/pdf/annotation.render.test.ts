import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect, type Locator } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'
import { createLocalization } from '../../../../../localization/engine.ts'
import pdfZh from '../../../../../localization/locales/zh/pdf.json' with { type: 'json' }

const DESKTOP = fileURLToPath(new URL('../../../../../../', import.meta.url))
const NAVIGATION_WIDTHS = [190, 280]
const translate = createLocalization(
  'zh',
  { zh: { pdf: pdfZh } },
  { report: () => undefined }
).getFixedT('zh', 'pdf')

test('annotation list edits and comments locally; point comments never offer source text as evidence', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import {createLocalization} from './src/localization/engine'
      import {resources} from './src/localization/resources'
      import {PdfAnnotations} from './src/renderer/src/features/workbench/pdf/Annotations'
      import {PdfAnnotation} from './src/renderer/src/features/workbench/pdf/Annotation'
      import {PdfCommentDraft} from './src/renderer/src/features/workbench/pdf/Annotation'
      window.changes = []; window.contexts = []; window.saves = []; window.cancelled = 0; window.focusedMarks = [];
      const initial = [
        {id:'text', style:'highlight', page:1, text:'Source line one\\nSource line two\\nSource line three\\nSource line four\\nSource line five\\nSource line six', quads:[[.1,.1,.2,.2]],color:'yellow',anchor_state:'anchored'},
        {id:'point',style:'comment',page:1,text:'',quads:[],point:[.5,.5],color:'green',anchor_state:'anchored'}
      ];
      function App() {
        const [marks,setMarks]=useState(initial); const [comments,setComments]=useState([{id:'p-comment',mark_id:'point',body:'user feedback'}]);
        const [saving,setSaving]=useState(false); window.setSaving=setSaving;
        const [results,setResults]=useState<Record<string,React.ComponentProps<typeof PdfAnnotation>['result']>>({});
        window.replaceSource = text => setMarks(current => current.map(mark => mark.id === 'text' ? {...mark, text} : mark));
        window.currentComments = comments;
        window.addSecondComment = () => setComments(current => [...current,{id:'second',mark_id:'text',body:'second comment'}]);
        return <><div style={{height:600}}><PdfAnnotations marks={marks} comments={comments} saving={false} onDelete={()=>{}} onFocus={mark=>window.focusedMarks.push(mark.id)}
          renderEditor={(mark,close,mode,inlineComment)=><PdfAnnotation initialMode={mode} inlineComment={inlineComment} mark={mark} comments={comments.filter(c=>c.mark_id===mark.id)} saving={saving} analyzing={false} canAnalyze={true}
            onColorChange={color=>{window.changes.push(color);setMarks(marks.map(m=>m.id===mark.id?{...m,color}:m))}}
            onStyleChange={style=>{window.changes.push(style);setMarks(marks.map(m=>m.id===mark.id?{...m,style}:m))}}
            onComment={async body=>{setComments([...comments,{id:'new',mark_id:mark.id,body}]);return true}} onClose={close}
            onUpdateComments={async drafts=>{if(window.failUpdate)return false;setComments(comments.map(comment=>({...comment,body:drafts.find(draft=>draft.id===comment.id)?.body??comment.body})));return true}}
            result={results[mark.id]}
            onOpenSettings={()=>{}} onExplain={()=>{}} onTranslate={()=>setResults(current=>({...current,[mark.id]:{kind:'selection_translation',panel:<div data-testid="fixture-translation">translated</div>}}))} onDelete={()=>{}} onAddToTask={async()=>{window.contexts.push(mark.id);return true}}/>}
        /></div><PdfCommentDraft page={1} point={[.5,.5]} saving={false} onCancel={()=>window.cancelled++} onSave={async body=>{window.saves.push(body);return window.allowSave??false}}/></>
      }
      const localization = createLocalization('zh', resources, {report:()=>undefined});
      createRoot(document.getElementById('root')).render(<I18nextProvider i18n={localization}><App/></I18nextProvider>);
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
        name: 'annotation-fixture',
        setup(builder) {
          builder.onResolve({ filter: /business\/PromptSettingsGuide$/ }, () => ({
            path: 'prompt',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents: 'export const PromptSettingsGuide=()=>null',
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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('http://localhost/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    )
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const filters = page.getByRole('tablist', { name: translate('pdfAnnotation.pdfRecords') })
    await expect(filters.locator(':scope > span[aria-hidden="true"]')).toHaveCSS('display', 'none')
    assert.deepEqual(await filters.getByRole('tab').allTextContents(), [
      `${translate('pdfAnnotation.filter.all')}2`,
      '1',
      '0',
      '0',
      '1',
    ])
    for (const width of NAVIGATION_WIDTHS) {
      await page.locator('#root').evaluate((root, width) => {
        root.style.width = `${width}px`
      }, width)
      assert.equal(
        await filters.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true
      )
      const layout = await filters.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          padding: Number.parseFloat(getComputedStyle(element).paddingLeft),
          gap: Number.parseFloat(getComputedStyle(element).columnGap),
          triggers: Array.from(element.querySelectorAll('[role="tab"]'), (trigger) => {
            const rect = trigger.getBoundingClientRect()
            return { left: rect.left, right: rect.right, width: rect.width }
          }),
        }
      })
      const expectedWidth =
        (layout.right -
          layout.left -
          layout.padding * 2 -
          layout.gap * (layout.triggers.length - 1)) /
        layout.triggers.length
      assert.ok(Math.abs(layout.triggers[0].left - layout.left - layout.padding) < 1)
      assert.ok(Math.abs(layout.triggers.at(-1)!.right - layout.right + layout.padding) < 1)
      for (const trigger of layout.triggers) {
        assert.ok(Math.abs(trigger.width - expectedWidth) < 1)
      }
      await expect(filters.getByRole('tab').first()).toContainText(
        translate('pdfAnnotation.filter.all')
      )
      for (const trigger of (await filters.getByRole('tab').all()).slice(1)) {
        assert.equal(
          await trigger.locator('svg').evaluate((icon) => icon.getBoundingClientRect().width),
          14
        )
        await expect(trigger).toHaveAttribute('aria-label', / \d+$/)
      }
    }
    const selectedFilter = filters.getByRole('tab', { selected: true })
    await expect(selectedFilter.locator('span').first()).toHaveCSS('font-weight', '500')
    const color = (token: string) =>
      page.evaluate((token) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${token})`
        document.body.append(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      }, token)
    await expect(selectedFilter).toHaveCSS('color', await color('--vds-text-primary'))
    await expect(selectedFilter).toHaveCSS(
      'background-color',
      await color('--vds-bg-white-default')
    )
    await selectedFilter.focus()
    const highlightIcon = filters
      .getByRole('tab', { name: `${translate('pdfAnnotation.filter.highlight')} 1` })
      .locator('svg')
    const inactiveStrokeWidth = await highlightIcon.evaluate(
      (icon) => getComputedStyle(icon).strokeWidth
    )
    await expect(highlightIcon).toHaveClass(/lucide-highlighter/)
    await highlightIcon.hover()
    await expect(page.getByRole('tooltip')).toHaveText(translate('pdfAnnotation.filter.highlight'))
    await page.mouse.move(0, 0)
    await page.keyboard.press('ArrowRight')
    await expect(
      filters.getByRole('tab', { name: `${translate('pdfAnnotation.filter.highlight')} 1` })
    ).toBeFocused()
    await expect(highlightIcon).toHaveCSS('stroke-width', inactiveStrokeWidth)
    await expect(page.getByTestId('pdf-annotation-list').locator('article')).toHaveCount(1)
    await page.keyboard.press('ArrowLeft')
    await expect(
      filters.getByRole('tab', { name: `${translate('pdfAnnotation.filter.all')} 2` })
    ).toBeFocused()
    await page.locator('html').evaluate((root) => root.setAttribute('data-theme', 'dark'))
    await expect(selectedFilter).toHaveCSS('color', await color('--vds-text-primary'))
    await expect(selectedFilter).toHaveCSS(
      'background-color',
      await color('--vds-bg-white-default')
    )
    await page.locator('html').evaluate((root) => root.removeAttribute('data-theme'))
    const cards = page.getByTestId('pdf-annotation-list').locator('article')
    const commentAction = cards.first().getByRole('button', {
      name: translate('pdfAnnotation.comment'),
      exact: true,
    })
    await commentAction.hover()
    await expect(
      page.getByRole('tooltip', { name: translate('pdfAnnotation.comment'), exact: true })
    ).toBeVisible()
    await expect(commentAction).toHaveClass(/vds-button--ghostIcon/u)
    await page.getByRole('tab', { name: `${translate('pdfAnnotation.filter.all')} 2` }).hover()
    const edit = async (card: Locator) => {
      await card.getByRole('button', { name: translate('pdfAnnotation.more'), exact: true }).click()
      await page
        .getByRole('menuitem', { name: translate('pdfAnnotation.edit'), exact: true })
        .click()
    }
    await expect(cards.first().locator('.vds-pdf-annotation-text').locator('..')).toHaveCSS(
      'border-left-width',
      '3px'
    )
    const source = cards.first().locator('.vds-pdf-annotation-text')
    await expect(
      cards
        .first()
        .getByRole('button', { name: translate('pdfAnnotation.viewSource'), exact: true })
    ).toHaveCount(0)
    await source.click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), ['text'])
    await expect(source).toHaveCSS('font-size', '12px')
    await expect(source).toHaveCSS('line-height', '18px')
    await expect(source).toHaveCSS('-webkit-line-clamp', '3')
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.expand'), exact: true })
      .click()
    await expect(source).toHaveCSS('-webkit-line-clamp', 'none')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), ['text'])
    await expect(
      cards
        .first()
        .getByTestId('pdf-annotation-card-actions')
        .getByRole('button', { name: translate('pdfAnnotation.more'), exact: true })
    ).toBeVisible()
    await expect(
      cards
        .nth(1)
        .getByTestId('pdf-annotation-comment-caption')
        .getByRole('button', { name: translate('pdfAnnotation.copyComment'), exact: true })
    ).toBeVisible()
    await expect(
      cards.nth(1).getByTestId('pdf-annotation-comment-caption').getByRole('button').locator('svg')
    ).toHaveCSS('color', await color('--vds-icon-outline-default'))
    assert.equal(
      await cards
        .nth(1)
        .locator('[data-testid="pdf-annotation-comment-content"]')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgba(0, 0, 0, 0)'
    )
    const pointCommentBody = cards.nth(1).getByText('user feedback', { exact: true })
    await pointCommentBody.click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), [
      'text',
      'point',
    ])
    const commentLocation = cards.nth(1).getByRole('button', { name: 'user feedback', exact: true })
    await commentLocation.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), [
      'text',
      'point',
      'point',
      'point',
    ])
    await expect(commentLocation).toHaveCSS('user-select', 'text')
    await cards
      .nth(1)
      .getByRole('button', { name: translate('pdfAnnotation.copyComment'), exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), [
      'text',
      'point',
      'point',
      'point',
    ])
    await edit(cards.first())
    const text = page.getByTestId('pdf-annotation-inspector-text')
    await expect(text).toBeVisible()
    const editMenu = await page.getByRole('menu').boundingBox()
    const editPanel = await text.boundingBox()
    assert.ok(editMenu && editPanel && editPanel.x >= editMenu.x + editMenu.width)
    const actions = text.getByTestId('pdf-annotation-actions')
    const actionRows = await actions
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top))
      )
    assert.equal(new Set(actionRows).size, 1)
    await expect(actions.locator('[data-pdf-annotation-tools]')).toBeVisible()
    await expect(actions.getByRole('button').last()).toHaveAttribute(
      'data-testid',
      'pdf-annotation-delete'
    )
    await expect(text.locator('header')).toHaveCount(0)
    for (const label of [
      'pdfAnnotation.copy',
      'pdfAnnotation.comment',
      'pdfAnnotation.delete',
    ] as const) {
      const geometry = await actions
        .getByRole('button', { name: translate(label), exact: true })
        .evaluate((button) => {
          const bounds = button.getBoundingClientRect()
          const icon = button.querySelector('svg')!.getBoundingClientRect()
          return {
            width: bounds.width,
            height: bounds.height,
            iconWidth: icon.width,
            iconHeight: icon.height,
            fontSize: getComputedStyle(button).fontSize,
            offsetX: icon.x + icon.width / 2 - bounds.x - bounds.width / 2,
            offsetY: icon.y + icon.height / 2 - bounds.y - bounds.height / 2,
          }
        })
      assert.equal(geometry.width, geometry.height)
      assert.equal(geometry.height, 28)
      assert.equal(geometry.fontSize, '12px')
      assert.equal(geometry.iconWidth, 14)
      assert.equal(geometry.iconHeight, 14)
      assert.ok(
        Math.abs(geometry.offsetX) < 1 && Math.abs(geometry.offsetY) < 1,
        JSON.stringify(geometry)
      )
    }
    await text.getByRole('button', { name: translate('addUnderline'), exact: true }).click()
    await page.evaluate(() => {
      Reflect.set(window, 'scholarseed', { writeClipboard: async () => ({ ok: true }) })
    })
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1_000))
    const copyAction = actions.locator('[data-copy-status]')
    await copyAction.click()
    await expect(copyAction).toHaveAttribute('data-copy-status', 'success')
    await expect(copyAction.locator('.lucide-check')).toBeVisible()
    await page.clock.runFor(2_999)
    await expect(copyAction).toHaveAttribute('data-copy-status', 'success')
    await page.clock.runFor(1)
    await expect(copyAction).toHaveAttribute('data-copy-status', 'idle')
    await expect(copyAction.locator('.lucide-copy')).toBeVisible()
    await page.clock.resume()
    const colorTrigger = text.getByRole('button', {
      name: translate('selectionColor'),
      exact: true,
    })
    const colorPadding = await colorTrigger.evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      const content = button.querySelector('[style*="--pdf-tool-color"]')!.getBoundingClientRect()
      const arrow = button.querySelector('svg')!.getBoundingClientRect()
      return { left: content.left - bounds.left, right: bounds.right - arrow.right }
    })
    assert.equal(colorPadding.left, 4)
    assert.equal(colorPadding.right, 4)
    await expect(colorTrigger.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-icon-outline-default')
    )
    await colorTrigger.click()
    await page
      .getByRole('button', {
        name: translate('markColor', { color: translate('palette.green') }),
        exact: true,
      })
      .click()
    await text
      .getByRole('button', { name: translate('selectionAddConversation'), exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'changes')), [
      'underline',
      'green',
    ])
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'contexts')), ['text'])
    await page.keyboard.press('Escape')
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
      .click()
    await expect(text.getByRole('textbox')).toBeFocused()
    await expect(text.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      translate('commentPlaceholder')
    )
    const editorBounds = await text.evaluate((inspector) => {
      const content = inspector.closest(
        '.vds-popover, [data-testid="pdf-annotation-inline-comment-editor"]'
      )
      if (!content) return null
      const outer = content.getBoundingClientRect()
      const inner = inspector.getBoundingClientRect()
      const input = inspector.querySelector('textarea')?.getBoundingClientRect()
      return {
        outer: { left: outer.left, right: outer.right },
        inner: { left: inner.left, right: inner.right },
        input: input ? { left: input.left, right: input.right } : null,
      }
    })
    assert.ok(
      editorBounds &&
        editorBounds.input &&
        editorBounds.inner.left >= editorBounds.outer.left &&
        editorBounds.inner.right <= editorBounds.outer.right &&
        editorBounds.input.left >= editorBounds.outer.left &&
        editorBounds.input.right <= editorBounds.outer.right,
      JSON.stringify(editorBounds)
    )
    await expect(text.getByRole('textbox')).toHaveCSS('min-height', '84px')
    await expect(text.getByRole('textbox')).toHaveAttribute('rows', '3')
    await expect(text.getByRole('textbox')).toHaveCSS('height', '84px')
    await expect(text.getByRole('textbox')).toHaveCSS('resize', 'vertical')
    const longComment = 'A long independent comment. '.repeat(12)
    await text.getByRole('textbox').fill(longComment)
    await text
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    await expect(text).toHaveCount(0)
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
      .click()
    await expect(text.getByRole('textbox')).toHaveValue(longComment.trim())
    await expect(text.locator('[data-pdf-annotation-tools]')).toHaveCount(0)
    await expect(text.getByTestId('pdf-annotation-actions')).toHaveCount(0)
    await expect(
      text.getByRole('button', { name: translate('pdfAnnotation.delete'), exact: true })
    ).toHaveCount(0)
    await text.getByRole('textbox').fill('cancelled draft')
    await text.getByRole('button', { name: translate('pdfAnnotation.cancel'), exact: true }).click()
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
      .click()
    await expect(text.getByRole('textbox')).toHaveValue(longComment.trim())
    await text.getByRole('textbox').fill('edited existing comment')
    await page.evaluate(() => Reflect.set(window, 'failUpdate', true))
    await text
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    await expect(text.getByRole('textbox')).toHaveValue('edited existing comment')
    await page.evaluate(() => Reflect.set(window, 'failUpdate', false))
    await text.getByRole('textbox').fill(longComment)
    await text
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    assert.deepEqual(
      (await page.evaluate(() => Reflect.get(window, 'currentComments'))).map(
        (comment: { id: string }) => comment.id
      ),
      ['p-comment', 'new']
    )
    await page.evaluate(() => Reflect.get(window, 'addSecondComment')())
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
      .click()
    await expect(text.getByRole('textbox')).toHaveCount(2)
    await expect(text.getByRole('textbox').nth(0)).toHaveValue(longComment.trim())
    await expect(text.getByRole('textbox').nth(1)).toHaveValue('second comment')
    await text.getByRole('textbox').nth(1).fill('second comment edited')
    await text
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    assert.deepEqual(
      (await page.evaluate(() => Reflect.get(window, 'currentComments'))).map(
        (comment: { id: string; body: string }) => [comment.id, comment.body]
      ),
      [
        ['p-comment', 'user feedback'],
        ['new', longComment.trim()],
        ['second', 'second comment edited'],
      ]
    )
    await edit(cards.first())
    await expect(text.locator('[data-pdf-annotation-tools]')).toBeVisible()
    const explainAction = text.getByRole('button', {
      name: translate('pdfAnnotation.explain'),
      exact: true,
    })
    const translateAction = text.getByRole('button', {
      name: translate('pdfAnnotation.translate'),
      exact: true,
    })
    const toolbarCommentAction = text.getByRole('button', {
      name: translate('pdfAnnotation.comment'),
      exact: true,
    })
    await expect(translateAction).toHaveCSS('color', await color('--vds-text-primary'))
    await expect(translateAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-icon-outline-default')
    )
    await expect(toolbarCommentAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-icon-outline-default')
    )
    await translateAction.click()
    await expect(text.getByTestId('fixture-translation')).toBeVisible()
    await expect(translateAction).toHaveAttribute('aria-pressed', 'true')
    await expect(translateAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-icon-outline-default')
    )
    await explainAction.click()
    await expect(text.getByTestId('fixture-translation')).toHaveCount(0)
    await expect(text.getByTestId('pdf-explanation-editor')).toBeVisible()
    await expect(text.getByPlaceholder(translate('reading.explanationPlaceholder'))).toBeVisible()
    await expect(
      text.getByRole('button', { name: translate('reading.selectionPromptSettings'), exact: true })
    ).toBeVisible()
    const explainSubmit = text.getByRole('button', {
      name: translate('reading.explainSelection'),
      exact: true,
    })
    await expect(explainSubmit).toBeVisible()
    await expect(explainSubmit.locator('img, svg')).toHaveCount(0)
    await expect(translateAction).toHaveAttribute('aria-pressed', 'false')
    await expect(explainAction).toHaveAttribute('aria-pressed', 'true')
    await text
      .getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
      .click()
    await expect(explainAction).toHaveAttribute('aria-pressed', 'false')
    await expect(
      text.getByRole('button', { name: translate('pdfAnnotation.comment'), exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbarCommentAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-text-primary')
    )
    await page.locator('html').evaluate((root) => root.setAttribute('data-theme', 'dark'))
    await expect(translateAction).toHaveCSS('color', await color('--vds-text-primary'))
    await expect(translateAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-icon-outline-default')
    )
    await expect(toolbarCommentAction.locator('svg')).toHaveCSS(
      'color',
      await color('--vds-text-primary')
    )
    await page.locator('html').evaluate((root) => root.removeAttribute('data-theme'))
    await expect(text.getByRole('textbox').nth(0)).toHaveValue(longComment.trim())
    await expect(text.getByRole('textbox').nth(1)).toHaveValue('second comment edited')
    await expect(text.getByTestId('pdf-annotation-actions')).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'setSaving')(true))
    await expect(text.getByRole('textbox').nth(0)).toBeDisabled()
    await expect(
      text.getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
    ).toBeDisabled()
    await expect(
      text.getByRole('button', { name: translate('pdfAnnotation.cancel'), exact: true })
    ).toBeDisabled()
    await page.evaluate(() => Reflect.get(window, 'setSaving')(false))
    await text.getByRole('button', { name: translate('pdfAnnotation.cancel'), exact: true }).click()
    await expect(text.getByRole('textbox')).toHaveCount(0)
    await expect(cards.first()).toContainText(longComment.trim())
    await page.keyboard.press('Escape')
    const collapseSource = cards.first().getByRole('button', {
      name: translate('pdfAnnotation.collapse'),
      expanded: true,
      exact: true,
    })
    await expect(collapseSource).toBeVisible()
    await expect(source).toHaveCount(1)
    await expect(source).toHaveCSS('-webkit-line-clamp', 'none')
    await expect(collapseSource).toHaveAttribute('aria-expanded', 'true')
    const comment = cards.first().getByTestId('pdf-annotation-comment-content').first()
    const commentBody = comment.locator('.vds-pdf-annotation-comment')
    await expect(commentBody).toHaveCSS('-webkit-line-clamp', '10')
    await cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.expandComment'), exact: true })
      .click()
    await collapseSource.click()
    await expect(source).toHaveCSS('-webkit-line-clamp', '3')
    await expect(commentBody).toHaveCSS('-webkit-line-clamp', 'none')
    const expandSource = cards
      .first()
      .getByRole('button', { name: translate('pdfAnnotation.expand'), exact: true })
    await expect(expandSource).toHaveAttribute('aria-expanded', 'false')
    await expandSource.focus()
    await page.keyboard.press('Enter')
    await expect(source).toHaveCSS('-webkit-line-clamp', 'none')
    await comment
      .getByRole('button', { name: translate('pdfAnnotation.collapseComment'), exact: true })
      .click()
    await expect(commentBody).toHaveCSS('-webkit-line-clamp', '10')
    await expect(source).toHaveCSS('-webkit-line-clamp', 'none')
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'focusedMarks')), [
      'text',
      'point',
      'point',
      'point',
    ])
    await page.evaluate(() => Reflect.get(window, 'replaceSource')('short source'))
    await expect(source).toHaveText('short source')
    await expect(expandSource).toHaveCount(0)
    await expect(collapseSource).toHaveCount(0)
    await expect(cards.nth(1).locator('.vds-pdf-annotation-text')).toHaveCount(0)
    await expect(
      cards.nth(1).getByRole('button', { name: translate('pdfAnnotation.expand'), exact: true })
    ).toHaveCount(0)
    await edit(cards.nth(1))
    const point = page.getByTestId('pdf-annotation-inspector-point')
    for (const tool of await point
      .locator('[data-pdf-annotation-tools]')
      .getByRole('button')
      .all()) {
      await expect(tool).toBeDisabled()
    }
    await expect(
      point.getByRole('button', { name: translate('pdfAnnotation.copy'), exact: true })
    ).toBeDisabled()
    await expect(
      point.getByRole('button', { name: translate('pdfAnnotation.explain'), exact: true })
    ).toBeDisabled()
    await expect(
      point.getByRole('button', { name: translate('pdfAnnotation.translate'), exact: true })
    ).toBeDisabled()
    await expect(
      point.getByRole('button', { name: translate('selectionAddConversation'), exact: true })
    ).toBeEnabled()
    await point
      .getByRole('button', { name: translate('selectionAddConversation'), exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'contexts')), ['text', 'point'])
    await expect(
      cards.nth(1).getByRole('button', { name: translate('pdfAnnotation.copySource'), exact: true })
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    const draft = page.getByTestId('pdf-point-comment-draft')
    await expect(draft.getByRole('textbox')).toHaveAttribute('rows', '3')
    await expect(draft.getByRole('textbox')).toHaveCSS('height', '84px')
    await expect(draft.getByRole('textbox')).toHaveCSS('resize', 'vertical')
    await expect(
      draft.getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
    ).toBeDisabled()
    await draft.getByRole('textbox').fill('unsaved point comment')
    await draft
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'cancelled')), 0)
    await expect(draft.getByRole('textbox')).toHaveValue('unsaved point comment')
    await page.evaluate(() => Reflect.set(window, 'allowSave', true))
    await draft
      .getByRole('button', { name: translate('pdfAnnotation.saveComment'), exact: true })
      .click()
    assert.equal(await page.evaluate(() => Reflect.get(window, 'cancelled')), 1)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
