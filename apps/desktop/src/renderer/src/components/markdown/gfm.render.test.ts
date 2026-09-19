import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const FIXTURE_URL = '/components/markdown.render.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Unable to reserve a local test port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

test('Markdown renders single-tilde ranges and double-tilde deletion', async () => {
  const port = await reservePort()
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true }
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(new URL(FIXTURE_URL, url).toString())

    for (const testId of ['tilde-markdown', 'tilde-markdown-math']) {
      const tildeMarkdown = page.getByTestId(testId)
      const renderedText = await tildeMarkdown.textContent()
      assert.ok(renderedText?.includes('24~33℃；次日 23~31℃'), `${testId} preserves numeric ranges`)
      assert.ok(renderedText?.includes('代码：24~33℃'), `${testId} preserves inline code ranges`)
      assert.equal(await tildeMarkdown.locator('del').count(), 1)
      assert.equal(await tildeMarkdown.locator('del').textContent(), '已取消')
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
