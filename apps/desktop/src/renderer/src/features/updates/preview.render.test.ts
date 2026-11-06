import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = '/features/updates/preview.render.fixture.html'

test(
  'preview scope, explicit cross-line confirmation and cancellation; release has no controls or policy calls',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      cacheKey: 'preview',
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1040, height: 660 } })
      const visit = async (query = '') =>
        page.goto(new URL(`${FIXTURE}${query}`, server.resolvedUrls!.local[0]).href)
      await visit('?channel=release')
      await expect(page.getByTestId('preview-update-controls')).toHaveCount(0)
      await expect(page.locator('#calls')).toHaveText('')

      await visit()
      await expect(page.getByTestId('preview-update-scope')).toHaveValue('current-line')
      await page.getByTestId('preview-update-scope').selectOption('current-version')
      await expect(page.locator('#calls')).toHaveText('get,scope:current-version')
      await page.getByTestId('preview-update-lines').click()
      await expect(page.getByTestId('preview-update-confirm')).toBeDisabled()
      await page.getByTestId('preview-update-target').selectOption('preview-three')
      await expect(page.getByTestId('preview-update-confirm')).toHaveText(
        '下载并升级至 0.3.0-202610201400'
      )
      await expect(page.locator('#calls')).toHaveText('get,scope:current-version,list')
      await expect(page.getByTestId('preview-update-dialog')).toContainText('版本线更新说明')
      await page.getByTestId('preview-update-confirm').click()
      await expect(page.getByTestId('preview-update-dialog')).toHaveCount(0)
      await expect(page.getByTestId('preview-update-scope')).toBeDisabled()
      await page.getByTestId('preview-update-cancel').click()
      await expect(page.getByTestId('preview-update-scope')).toHaveValue('current-version')
      await expect(page.getByTestId('preview-update-scope')).toBeEnabled()
      await expect(page.locator('#calls')).toHaveText(
        'get,scope:current-version,list,select:preview-three,cancel'
      )

      await visit('?fail')
      await page.getByTestId('preview-update-scope').selectOption('current-version')
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByTestId('preview-update-scope')).toHaveValue('current-line')

      await visit('?empty&language=en')
      await page.getByTestId('preview-update-lines').click()
      await expect(page.getByTestId('preview-update-dialog')).toContainText(
        'No release lines are available'
      )
      await expect(page.getByTestId('preview-update-confirm')).toBeDisabled()
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.getByTestId('preview-update-dialog')).toHaveCount(0)

      await visit('?installing')
      await expect(page.getByTestId('preview-update-lines')).toBeDisabled()
      await expect(page.getByTestId('preview-update-scope')).toBeDisabled()
      assert.equal(await page.locator('#calls').textContent(), 'get')

      await visit('?bilingual')
      await page.getByTestId('preview-update-lines').click()
      await page.getByTestId('preview-update-target').selectOption('preview-three')
      const dialog = page.getByTestId('preview-update-dialog')
      await expect(dialog).toContainText('版本线更新说明')
      await page.evaluate(async () => Reflect.get(window, 'previewFixture').language('en'))
      await expect(dialog).toContainText('Release line notes')
      await expect(dialog).not.toContainText('版本线更新说明')
      await page.evaluate(async () => Reflect.get(window, 'previewFixture').language('zh'))
      await expect(dialog).toContainText('版本线更新说明')
      await expect(page.locator('#calls')).toHaveText('get,list')

      for (const query of ['?language=en', '?language=en&blank-english', '?language=en&no-notes']) {
        await visit(query)
        await page.getByTestId('preview-update-lines').click()
        await page.getByTestId('preview-update-target').selectOption('preview-three')
        await expect(page.getByTestId('preview-update-dialog')).toContainText(
          query.includes('no-notes')
            ? 'No release notes are available for this version.'
            : '版本线更新说明'
        )
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
