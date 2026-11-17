import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import tailwindcss from '@tailwindcss/postcss'
import { chromium } from '@playwright/test'
import postcss from 'postcss'

test('workbench controls own their full hit area without the legacy app drag strip', async () => {
  const stylesheet = new URL('../styles.css', import.meta.url)
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const rootClasses = appSource.match(/className=\{`(vds-app-shell[^$]+)\$/)?.[1]
  assert.ok(rootClasses)
  const compiled = await postcss([
    tailwindcss({ base: fileURLToPath(new URL('../../', import.meta.url)) }),
  ]).process(readFileSync(stylesheet, 'utf8'), { from: fileURLToPath(stylesheet) })
  const workbenchStyles = readFileSync(new URL('./workbench.css', import.meta.url), 'utf8')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    for (const width of [1040, 1496]) {
      await page.setViewportSize({ width, height: 840 })
      for (const theme of ['light', 'dark']) {
        await page.setContent(
          `<html data-theme="${theme}"><body><div class="${rootClasses}"><div class="vds-workbench"><header class="vds-top-bar"><div class="vds-project-switch" style="margin-left:78px"><button style="width:154px;height:32px" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Choose project</button></div></header></div></div></body></html>`
        )
        await page.addStyleTag({ content: `${compiled.css}\n${workbenchStyles}` })
        const button = page.getByRole('button', { name: 'Choose project' })
        const bounds = await button.boundingBox()
        assert.ok(bounds)
        for (const offset of [4, bounds.height / 2, bounds.height - 4]) {
          await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + offset)
        }
        assert.equal(await button.getAttribute('data-clicks'), '3', `${theme} ${width}px`)
        const regions = await page.evaluate(() => ({
          strip: getComputedStyle(document.querySelector('.vds-app-shell')!, '::before').display,
          header: getComputedStyle(document.querySelector('header')!).getPropertyValue(
            '-webkit-app-region'
          ),
          button: getComputedStyle(document.querySelector('button')!).getPropertyValue(
            '-webkit-app-region'
          ),
        }))
        assert.deepEqual(regions, { strip: 'none', header: 'drag', button: 'no-drag' })
        await page
          .locator('.vds-workbench')
          .evaluate((element) => element.classList.remove('vds-workbench'))
        assert.notEqual(
          await page
            .locator('.vds-app-shell')
            .evaluate((element) => getComputedStyle(element, '::before').display),
          'none'
        )
      }
    }
  } finally {
    await browser.close()
  }
})
