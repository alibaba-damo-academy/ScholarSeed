import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const DESKTOP = fileURLToPath(new URL('../../../../', import.meta.url))

test('floating selection surfaces preserve user geometry and collapse across result updates', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { FloatingWindow } from './src/renderer/src/components/primitive/FloatingWindow'
        import { FloatingToolbar, Button } from './src/renderer/src/components/ui'
        function Fixture() {
          const [revision, setRevision] = useState(0)
          const [position, setPosition] = useState({ left: 40, top: 40, width: 320, height: 80 })
          return <>
            <Button onClick={() => setRevision(value => value + 1)}>Regenerate</Button>
            <FloatingToolbar label="Selection" data-testid="toolbar" className="fixed" style={position} actions={<Button>Copy</Button>}
              onMove={delta => setPosition(box => ({ ...box, left: box.left + delta.x, top: box.top + delta.y }))}
              resizeHandle="edges"
              onResize={(delta, edge) => setPosition(box => ({ ...box, left: box.left + (edge?.x === -1 ? delta.x : 0), top: box.top + (edge?.y === -1 ? delta.y : 0), width: box.width + delta.x * (edge?.x ?? 1), height: box.height + delta.y * (edge?.y ?? 1) }))} />
            <FloatingToolbar label="Surface selection" data-testid="surface" className="fixed" style={{ left: position.left, top: position.top + 100, width: 500 }} actions={<Button>Surface action</Button>} moveHandle="surface"
              onMove={delta => setPosition(box => ({ ...box, left: box.left + delta.x, top: box.top + delta.y }))} />
            <FloatingWindow title="Selection result" initialPosition={{ left: 100, top: 180 }} initialSize={{ width: 480, height: 300 }} collapsible onClose={() => {}}>
              <p data-testid="result">Generated result {revision}</p>
            </FloatingWindow>
            <FloatingWindow title="Existing consumer" initialPosition={{ left: 700, top: 180 }} initialSize={{ width: 400, height: 300 }} onClose={() => {}}>Existing content</FloatingWindow>
          </>
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
        name: 'floating-translations',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'export const useTranslation = () => ({ t: (key, values) => values?.title ? key + " " + values.title : key })',
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const toolbar = page.getByTestId('toolbar')
    const surface = page.getByTestId('surface')
    const surfaceToolbar = surface.getByRole('toolbar')
    await expect(surface.getByRole('button', { name: /floatingWindow.move/ })).toHaveCount(0)
    await surfaceToolbar.focus()
    const beforeKeyboard = await surface.boundingBox()
    await page.keyboard.press('ArrowRight')
    assert.equal((await surface.boundingBox())!.x, beforeKeyboard!.x + 16)
    const surfaceAction = surface.getByRole('button', { name: 'Surface action', exact: true })
    await surfaceAction.focus()
    const beforeChild = await surface.boundingBox()
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await surface.boundingBox(), beforeChild)
    const actionBox = (await surfaceAction.boundingBox())!
    await page.mouse.move(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      actionBox.x + actionBox.width / 2 + 20,
      actionBox.y + actionBox.height / 2
    )
    await page.mouse.up()
    assert.deepEqual(await surface.boundingBox(), beforeChild)
    const surfaceBox = (await surfaceToolbar.boundingBox())!
    await page.mouse.move(surfaceBox.x + 4, surfaceBox.y + 4)
    await page.mouse.down()
    await page.mouse.move(surfaceBox.x + 24, surfaceBox.y + 14)
    await page.mouse.up()
    assert.equal((await surface.boundingBox())!.x, beforeChild!.x + 20)
    assert.equal((await surface.boundingBox())!.y, beforeChild!.y + 10)
    const originalToolbar = await toolbar.boundingBox()
    await toolbar
      .getByRole('button', { name: 'floatingWindow.move Selection', exact: true })
      .focus()
    await page.keyboard.press('ArrowRight')
    assert.equal((await toolbar.boundingBox())!.x, originalToolbar!.x + 16)
    await expect(toolbar.getByRole('button', { name: 'floatingWindow.resize' })).toHaveCount(0)
    await toolbar.locator('[data-resize-edge="right"]').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal((await toolbar.boundingBox())!.width, originalToolbar!.width + 16)
    const beforeLeft = (await toolbar.boundingBox())!
    const leftEdge = toolbar.locator('[data-resize-edge="left"]')
    const edgeBox = (await leftEdge.boundingBox())!
    await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(edgeBox.x + edgeBox.width / 2 - 20, edgeBox.y + edgeBox.height / 2)
    await page.mouse.up()
    assert.equal((await toolbar.boundingBox())!.x, beforeLeft.x - 20)
    assert.equal((await toolbar.boundingBox())!.width, beforeLeft.width + 20)
    const handle = toolbar.getByRole('button', {
      name: 'floatingWindow.move Selection',
      exact: true,
    })
    for (const boundary of ['pointercancel', 'lostpointercapture']) {
      const bounds = (await handle.boundingBox())!
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await handle.dispatchEvent(boundary, { pointerId: 1 })
      const stopped = await toolbar.boundingBox()
      await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 25)
      await page.mouse.up()
      assert.deepEqual(await toolbar.boundingBox(), stopped)
    }
    const result = page.getByRole('dialog', { name: 'Selection result', exact: true })
    const initial = await result.boundingBox()
    await result.locator('header').focus()
    await page.keyboard.press('ArrowRight')
    await result.getByRole('separator').focus()
    await page.keyboard.press('ArrowRight')
    const resized = await result.boundingBox()
    assert.equal(resized!.x, initial!.x + 16)
    assert.equal(resized!.width, initial!.width + 16)
    await result.getByRole('button', { name: 'floatingWindow.collapse' }).click()
    await expect(page.getByTestId('result')).not.toBeVisible()
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click()
    await expect(result.getByRole('button', { name: 'floatingWindow.expand' })).toBeVisible()
    await result.getByRole('button', { name: 'floatingWindow.expand' }).click()
    await expect(page.getByTestId('result')).toHaveText('Generated result 1')
    assert.deepEqual(await result.boundingBox(), resized)
    await expect(
      page
        .getByRole('dialog', { name: 'Existing consumer' })
        .getByRole('button', { name: 'floatingWindow.collapse' })
    ).toHaveCount(0)
  } finally {
    await browser.close()
  }
})
