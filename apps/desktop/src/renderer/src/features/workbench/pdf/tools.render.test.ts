import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'
import ts from 'typescript'

const DESKTOP = fileURLToPath(new URL('../../../../../../', import.meta.url))

test('selection tools retain a pending color and top toolbar shares one color across mark styles', async () => {
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
  const effects: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.getText(tree).includes('const onEscape =')
    )
      effects.push(node.getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(effects.length, 1)
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState, useEffect } from 'react'
        import { createRoot } from 'react-dom/client'
        import { PdfTools, PdfSelectionMenu } from './src/renderer/src/features/workbench/pdf/Tools'
        import { Button, Input } from './src/renderer/src/components/ui'
        function Fixture() {
          const [colors, setColors] = useState({ highlight: 'yellow', underline: 'blue', strikethrough: 'red' })
          const [applied, setApplied] = useState([])
          const [selectionColor, setSelectionColor] = useState('yellow')
          const [enabled, setEnabled] = useState(true)
          const [disabled, setDisabled] = useState(false)
          const [selection, setSelection] = useState(0)
          const [activeTool, setActiveTool] = useState(null)
          const [activeMark, setActiveMark] = useState(null)
          const [selections, setSelections] = useState([])
          const [selectionDragSpan, setSelectionDragSpan] = useState(null)
          const [escaping, setEscaping] = useState(false)
          const active = true
          const tabId = 'pdf'
          const controller = { getSnapshot: () => ({ focusedTabId: tabId }) }
          const analysis = { figure: false }
          const exitFigureSelection = () => {}
          const clearSelection = () => { setSelections([]); setActiveMark(null) }
          ${effects[0]}
          const props = { colors, disabled: false, hasSelection: true, commentOpen: false, onComment: () => {}, onApply: (style, color) => setApplied(items => [...items, { style, color }]), onColor: (style, color) => setColors(value => ({ ...value, [style]: color })) }
          return <>{(!escaping || selections.length > 0) && <div data-testid="selection"><PdfTools key={selection} {...props} selectionColor={selectionColor} onSelectionColor={setSelectionColor} /></div>}<div data-testid="top"><PdfTools {...props} activeTool={activeTool} onToggle={setActiveTool} /></div>{enabled && <PdfSelectionMenu enabled={enabled} disabled={disabled} onEnabledChange={setEnabled} />}<Button onClick={() => setEnabled(true)}>Restore toolbar</Button><Button onClick={() => setDisabled(value => !value)}>Toggle saving</Button><Button onClick={() => setSelection(value => value + 1)}>New selection</Button><Button onClick={() => { setEscaping(true); setSelections([{}]) }}>Select PDF text</Button><Input aria-label="Comment draft" /><div tabIndex={0} data-testid="pdf-source">PDF text</div><output>{JSON.stringify({ colors, applied })}</output></>
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
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
        name: 'tools-translations',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'export const useTranslation = () => ({ t: (key, values) => values?.color ? key + " " + values.color : values?.style ? key + " " + values.style : key })',
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
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const selection = page.getByTestId('selection')
    const top = page.getByTestId('top')
    await expect(
      selection.getByRole('button', { name: 'selectionColor', exact: true })
    ).toHaveCount(1)
    await expect(selection.getByRole('button', { name: /^markColors/ })).toHaveCount(0)
    await expect(top.getByRole('button', { name: 'selectionColor', exact: true })).toHaveCount(1)
    await expect(top.getByRole('button', { name: /^markColors/ })).toHaveCount(0)
    await expect(selection.getByRole('separator')).toHaveCount(2)
    for (const separator of await selection.getByRole('separator').all()) {
      await expect(separator).toHaveCSS('align-self', 'center')
    }
    for (const group of await top.locator('[data-pdf-tool]').all()) {
      await expect(group).toHaveCSS('border-top-width', '0px')
    }
    for (const theme of ['light', 'dark']) {
      await page
        .locator('html')
        .evaluate((root, value) => root.setAttribute('data-theme', value), theme)
      for (const toolbar of [selection, top]) {
        const trigger = toolbar.getByRole('button', { name: 'selectionColor', exact: true })
        await trigger.hover()
        const padding = await trigger.evaluate((button) => {
          const bounds = button.getBoundingClientRect()
          const swatch = button
            .querySelector('[style*="--pdf-tool-color"]')!
            .getBoundingClientRect()
          const arrow = button.querySelector('svg')!.getBoundingClientRect()
          return { left: swatch.left - bounds.left, right: bounds.right - arrow.right }
        })
        assert.deepEqual(padding, { left: 4, right: 4 }, theme)
      }
    }
    await page.locator('html').evaluate((root) => root.removeAttribute('data-theme'))
    await selection.getByRole('button', { name: 'selectionColor', exact: true }).click()
    for (const swatch of await page.getByRole('button', { name: /^markColor palette\./ }).all()) {
      const bounds = await swatch.locator('[style*="--pdf-tool-color"]').boundingBox()
      assert.ok(bounds && bounds.width > 0)
      assert.equal(bounds.width, bounds.height)
    }
    await page.getByRole('button', { name: 'markColor palette.green', exact: true }).click()
    assert.deepEqual(JSON.parse(await page.locator('output').innerText()), {
      colors: { highlight: 'yellow', underline: 'blue', strikethrough: 'red' },
      applied: [],
    })
    await page.getByRole('button', { name: 'New selection', exact: true }).click()
    await selection.getByRole('button', { name: 'selectionColor', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'markColor palette.green', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    for (const label of ['addHighlight', 'addUnderline', 'pdfAnnotation.addStrikethrough']) {
      await selection.getByRole('button', { name: label, exact: true }).click()
    }
    assert.deepEqual(JSON.parse(await page.locator('output').innerText()), {
      colors: { highlight: 'green', underline: 'green', strikethrough: 'green' },
      applied: ['highlight', 'underline', 'strikethrough'].map((style) => ({
        style,
        color: 'green',
      })),
    })
    await top.getByRole('button', { name: 'selectionColor', exact: true }).click()
    await page.getByRole('button', { name: 'markColor palette.purple', exact: true }).click()
    const final = JSON.parse(await page.locator('output').innerText())
    assert.deepEqual(final.colors, {
      highlight: 'purple',
      underline: 'purple',
      strikethrough: 'purple',
    })
    assert.equal(final.applied.length, 3)
    await page.getByRole('button', { name: 'Toggle saving', exact: true }).click()
    await page.getByRole('button', { name: 'selectionMore', exact: true }).click()
    await expect(
      page.getByRole('switch', { name: 'selectionAutomatic', exact: true })
    ).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Toggle saving', exact: true }).click()
    await page.getByRole('button', { name: 'selectionMore', exact: true }).click()
    const automatic = page.getByRole('switch', { name: 'selectionAutomatic', exact: true })
    await expect(automatic).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'selectionMore', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'selectionMore', exact: true }).click()
    await automatic.click()
    await expect(page.getByRole('button', { name: 'selectionMore', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Restore toolbar', exact: true }).click()
    await page.getByRole('button', { name: 'selectionMore', exact: true }).click()
    await expect(automatic).toBeChecked()
    await page.keyboard.press('Escape')
    for (const label of ['addHighlight', 'addUnderline']) {
      const tool = top.getByRole('button', { name: label, exact: true })
      for (const activation of ['pointer', 'keyboard']) {
        await tool.focus()
        if (activation === 'pointer') {
          await tool.click()
        } else {
          await page.keyboard.press('Enter')
        }
        await expect(tool).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByRole('tooltip', { name: label, exact: true })).toBeVisible()
        await expect(tool).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(tool).toHaveAttribute('aria-pressed', 'false')
        await expect(page.getByRole('tooltip', { name: label, exact: true })).toHaveCount(0)
        if (activation === 'keyboard') await expect(tool).toBeFocused()
        await page.getByTestId('pdf-source').click()
      }
      await tool.click()
      await expect(tool).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('pdf-source').click()
      await page.keyboard.press('Escape')
      await expect(tool).toHaveAttribute('aria-pressed', 'false')
      await page.getByRole('button', { name: 'Select PDF text', exact: true }).click()
      await selection.getByRole('button', { name: label, exact: true }).click()
      const saved = await page.locator('output').innerText()
      await page.getByTestId('pdf-source').click()
      await page.keyboard.press('Escape')
      await expect(selection).toHaveCount(0)
      assert.equal(await page.locator('output').innerText(), saved)
    }
    const continuous = top.getByRole('button', { name: 'addHighlight', exact: true })
    await continuous.click()
    await top.getByRole('button', { name: 'selectionColor', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: /^markColor palette\./ })).toHaveCount(0)
    await expect(continuous).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Select PDF text', exact: true }).click()
    await page.getByRole('textbox', { name: 'Comment draft' }).fill('Keep this draft')
    await page.keyboard.press('Escape')
    await expect(selection).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Comment draft' })).toHaveValue(
      'Keep this draft'
    )
    await expect(continuous).toHaveAttribute('aria-pressed', 'true')
    await selection.getByRole('button', { name: 'selectionColor', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(selection).toBeVisible()
    await expect(page.getByRole('button', { name: /^markColor palette\./ })).toHaveCount(0)
    await page.getByTestId('pdf-source').click()
    await page.keyboard.press('Escape')
    await expect(selection).toHaveCount(0)
    await expect(continuous).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await browser.close()
  }
})
