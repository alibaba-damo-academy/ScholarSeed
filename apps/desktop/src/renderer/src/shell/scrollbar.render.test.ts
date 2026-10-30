import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import tailwindcss from '@tailwindcss/postcss'
import { chromium } from '@playwright/test'
import postcss from 'postcss'

test('native scrollbar utilities preserve global and Markdown thumb geometry', async () => {
  const stylesheet = new URL('../styles.css', import.meta.url)
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const markdown = readFileSync(
    new URL('../features/workbench/MarkdownDocument.tsx', import.meta.url),
    'utf8'
  )
  const rootClasses = html.match(/<body[^>]*class="([^"]+)"/)?.[1]
  const markdownClasses = markdown.match(/vds-markdown-crepe h-full[^`]+/)?.[0].split('${')[0]
  assert.ok(rootClasses)
  assert.ok(markdownClasses)
  const compiled = await postcss([
    tailwindcss({ base: fileURLToPath(new URL('../../', import.meta.url)) }),
  ]).process(readFileSync(stylesheet, 'utf8'), { from: fileURLToPath(stylesheet) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(
      `<html><body class="${rootClasses}"><div id="ordinary"></div><div class="${markdownClasses}"><div class="milkdown"></div></div></body></html>`
    )
    await page.addStyleTag({ content: compiled.css })
    for (const theme of ['light', 'dark']) {
      const styles = await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
        return ['#ordinary', '.milkdown'].map((selector) => {
          const style = getComputedStyle(
            document.querySelector(selector)!,
            '::-webkit-scrollbar-thumb'
          )
          return {
            border: style.borderTopWidth,
            radius: style.borderTopLeftRadius,
            clip: style.backgroundClip,
            color: style.backgroundColor,
            minimum: style.minHeight,
          }
        })
      }, theme)
      assert.deepEqual(
        styles.map(({ border, radius, clip }) => ({ border, radius, clip })),
        [
          { border: '2px', radius: '6px', clip: 'content-box' },
          { border: '3px', radius: '8px', clip: 'padding-box' },
        ]
      )
      assert.equal(styles[1].minimum, '32px')
      assert.equal(styles[0].color, styles[1].color)
      assert.notEqual(styles[0].color, 'rgba(0, 0, 0, 0)')
    }
  } finally {
    await browser.close()
  }
})
