import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_URL = '/components/update.render.fixture.html'

async function withFixture(run: (page: Page) => Promise<void>): Promise<void> {
  const server = await createServer({
    configFile: false,
    cacheDir: path.join(ROOT_DIR, 'node_modules/.vite-tests', `installation-${process.pid}`),
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(new URL(FIXTURE_URL, url).toString())
      await run(page)
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}

test('update installation shows source and staged steps, elapsed time, cancellation and restart in both languages', async () => {
  await withFixture(async (page) => {
    const now = new Date('2026-09-28T03:56:20Z')
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    const publish = async (next: Record<string, unknown>) =>
      page.evaluate((value) => {
        ;(
          window as unknown as {
            updateFixture: { publish: (next: Record<string, unknown>) => void }
          }
        ).updateFixture.publish(value)
      }, next)
    const installation = {
      step: 'gatekeeper',
      startedAt: now.getTime() - 120_000,
      stepStartedAt: now.getTime() - 60_000,
      timeoutMs: 180_000,
      application: 'source',
      cancelling: false,
    }
    await publish({ phase: 'installing', installStage: 'preparing', installation })
    await expect(page.getByTestId('update-overlay-description')).toContainText('应用尚未退出')
    await expect(page.getByTestId('update-overlay-step')).toContainText('macOS 安全检查')
    await page.clock.runFor(1_000)
    await expect(page.getByTestId('update-overlay-elapsed')).toHaveText(
      '本步骤已用 1:01 · 总计已用 2:01'
    )
    await expect(page.getByTestId('update-overlay-limit')).toContainText('3:00')
    await expect(
      page.getByTestId('update-overlay-progress').getByRole('progressbar')
    ).not.toHaveAttribute('aria-valuenow')
    await publish({
      installation: {
        ...installation,
        step: 'signature',
        application: 'staged',
        stepStartedAt: now.getTime() + 1_000,
      },
    })
    await page.clock.runFor(1_000)
    await expect(page.getByTestId('update-overlay-step')).toHaveText(
      '复验已复制的应用：正在校验应用签名…'
    )
    await expect(page.getByTestId('update-overlay-elapsed')).toHaveText(
      '本步骤已用 0:01 · 总计已用 2:02'
    )
    await page.getByTestId('update-overlay-cancel').click()
    await expect(page.getByTestId('update-overlay-cancel')).toBeDisabled()
    await expect(page.getByTestId('update-overlay-description')).toContainText('当前应用不会退出')
    await publish({
      installation: { ...installation, step: 'cleanup', cancelling: true, application: undefined },
    })
    await expect(page.getByTestId('update-overlay-step')).toHaveText('正在卸载安装镜像…')
    await expect(page.getByTestId('update-overlay-cancel')).toHaveCount(0)
    await publish({ phase: 'ready', installation: undefined })
    await expect(page.getByTestId('update-overlay')).toHaveCount(0)
    await page.evaluate(() =>
      (
        window as unknown as { updateFixture: { language: (language: string) => Promise<unknown> } }
      ).updateFixture.language('en')
    )
    await publish({ phase: 'installing', installation })
    await expect(page.getByTestId('update-overlay-description')).toContainText(
      'The app is still open'
    )
    await expect(page.getByTestId('update-overlay-step')).toContainText('macOS security assessment')
    await expect(page.getByTestId('update-overlay-limit')).toContainText('not the time remaining')
    await page.setViewportSize({ width: 480, height: 600 })
    await expect(page.getByTestId('update-overlay-cancel')).toBeInViewport({ ratio: 1 })
    await publish({
      phase: 'restarting',
      installStage: 'restarting',
      installation: { ...installation, step: 'restarting' },
    })
    await expect(page.getByTestId('update-overlay-description')).toContainText(
      'finish updating in the background'
    )
    await expect(page.getByTestId('update-overlay-cancel')).toHaveCount(0)
  })
})
