import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'copied formulas paste as editable mathematics through the native Crepe clipboard',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      cacheKey: 'math-paste',
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const mode of ['formula', 'source', 'plain']) {
        const page = await browser.newPage()
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto(
          new URL(
            '/features/workbench/mathematics.render.fixture.html',
            server.resolvedUrls!.local[0]
          ).href
        )
        const editor = page.locator('.ProseMirror')
        await expect(editor).toBeVisible()
        if (mode === 'formula') {
          const safety = await page.evaluate(() => {
            const transform = (
              window as unknown as {
                mathClipboardHtml: (html: string, document: Document) => string
              }
            ).mathClipboardHtml
            const ordinary = '<p><strong>Keep formatting</strong></p>'
            const noAnnotation =
              '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>'
            const source = '<img src=x onerror="window.__mathUnsafe=true">'
            const encoded =
              '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">&lt;img src=x onerror="window.__mathUnsafe=true"&gt;</annotation></semantics></math>'
            const html = transform(encoded, document)
            const template = document.createElement('template')
            template.innerHTML = html
            return {
              ordinary: transform(ordinary, document) === ordinary,
              noAnnotation: transform(noAnnotation, document) === noAnnotation,
              noImages: template.content.querySelectorAll('img').length === 0,
              literalSource:
                template.content
                  .querySelector('[data-type="math_inline"]')
                  ?.getAttribute('data-value') === source,
            }
          })
          assert.deepEqual(safety, {
            ordinary: true,
            noAnnotation: true,
            noImages: true,
            literalSource: true,
          })
        }
        await page.getByTestId('conversation-formula').hover()
        if (mode === 'source') await page.getByRole('tab', { name: 'LaTeX', exact: true }).click()
        await page.getByRole('button', { name: '复制', exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(mode === 'source' ? '\\frac{F}{k}=x' : '\\[\\frac{F}{k}=x\\]')
        if (mode === 'plain')
          await page.evaluate(() => navigator.clipboard.writeText('\\[\\frac{F}{k}=x\\]'))
        await editor.click()
        await page.keyboard.press('ControlOrMeta+V')
        await expect(editor.locator('.milkdown-code-block')).toHaveCount(1)
        await expect(page.getByTestId('serialized-math')).toContainText('\\frac{F}{k}=x')
        assert.doesNotMatch(await page.getByTestId('serialized-math').innerText(), /Fk=x/)
        const code = editor.locator('.cm-content')
        await code.click()
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.insertText('+1')
        await expect(page.getByTestId('serialized-math')).toContainText('\\frac{F}{k}=x+1')
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
