import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('document read errors distinguish permission denial in both languages', async () => {
  const server = await servers.create({
    configFile: false,
    cacheKey: 'html-read-errors',
    root: ROOT,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    for (const language of ['zh', 'en']) {
      await page.goto(
        new URL(
          `/features/workbench/html.render.fixture.html?lang=${language}`,
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByTestId('permission-failure')).toHaveText(
        language === 'zh'
          ? '没有权限读取此文件，请恢复文件读取权限后重试。'
          : 'You do not have permission to read this file. Restore read access, then retry.'
      )
      await expect(page.getByTestId('generic-read-failure')).toHaveText(
        language === 'zh'
          ? '无法读取此文件，请检查文件是否可访问后重试。'
          : 'The file could not be read. Check that it is accessible, then retry.'
      )
    }
  } finally {
    await browser.close()
  }
})

test(
  'static HTML blocks scripts and external resources, preserves source and refreshes through the document owner',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      cacheKey: 'html-static-preview',
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const requests: string[] = []
      await page.route('https://blocked.invalid/**', (route) => {
        requests.push(route.request().url())
        return route.abort()
      })
      await page.goto(
        new URL('/features/workbench/html.render.fixture.html', server.resolvedUrls!.local[0]).href
      )
      const frame = page.frameLocator('[data-testid="html-preview"]')
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await expect(page.getByTestId('html-open-external')).toBeVisible()
      await expect(page.getByRole('textbox', { name: '文件路径' })).toHaveValue(
        '/authorized/report.html'
      )
      await page.getByRole('button', { name: '更多浏览器功能' }).click()
      await page.getByRole('menuitem', { name: '复制文件路径' }).click()
      await expect(page.getByText('文件路径已复制')).toBeVisible()
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        '/authorized/report.html'
      )
      await expect(frame.getByRole('heading', { name: 'Static report' })).toBeVisible()
      await expect(frame.getByText('Revision 1')).toBeVisible()
      await expect(
        frame.locator('script, iframe, meta[http-equiv="refresh"], a[href], img[src]')
      ).toHaveCount(0)
      assert.equal(await page.locator('body').getAttribute('data-compromised'), null)
      assert.deepEqual(requests, [])
      await page.getByRole('button', { name: '更多浏览器功能' }).click()
      await page.getByRole('menuitem', { name: '查看源码' }).click()
      await expect(page.getByTestId('html-source')).toContainText('<script>')
      await page.getByRole('button', { name: '更多浏览器功能' }).click()
      await page.getByRole('menuitem', { name: '返回网页' }).click()
      await page.getByRole('button', { name: '刷新' }).click()
      await expect(frame.getByText('Revision 2')).toBeVisible()
      await page.evaluate(() => (window as unknown as { failHtmlRead(): void }).failHtmlRead())
      await page.getByRole('button', { name: '刷新' }).click()
      await expect(page.getByRole('alert')).toContainText('authorization revoked')
      await expect(frame.getByText('Revision 2')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
