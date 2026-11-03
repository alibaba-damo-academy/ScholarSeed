import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_URL = '/components/update.render.fixture.html'
const SCREENSHOT_DIRECTORY = process.env.UPDATE_MESSAGE_SCREENSHOTS

async function withFixture(run: (page: Page) => Promise<void>, query = ''): Promise<void> {
  const server = await servers.create({
    configFile: false,
    cacheKey: 'installation',
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(new URL(`${FIXTURE_URL}${query}`, url).toString())
      await run(page)
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}

test('candidate version includes its build stamp throughout the About update states', async () => {
  await withFixture(async (page) => {
    for (const language of ['zh', 'en']) {
      await page.evaluate(async (language) => {
        await Reflect.get(window, 'updateFixture').language(language)
      }, language)
      for (const phase of ['available', 'downloading', 'ready']) {
        await page.evaluate((phase) => {
          Reflect.get(window, 'updateFixture').publish({
            phase,
            candidate: {
              id: 'version-regression',
              version: '0.3.1',
              build_number: '202611031118',
              product_id: 'scholarseed',
              bundle_id: 'com.scholarseed.desktop',
              arch_type: 'darwin-arm64',
              channel: 'release',
              file_size: 100,
              sha512: 'a'.repeat(128),
            },
          })
        }, phase)
        const version = page.getByTestId(phase === 'available' ? 'version-chip' : 'version-status')
        await expect(version).toContainText('0.3.1-202611031118')
        await expect(page.getByText(/0\.2\.0-202610301118/)).toBeVisible()
        if (phase === 'downloading') {
          await expect(
            page.getByTestId('version-progress').locator('[aria-label]')
          ).toHaveAttribute('aria-label', /0\.3\.1-202611031118/)
        }
      }
    }
  }, '?about')
})

test('candidate version includes its build stamp in update metadata, notes and installation', async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      Reflect.get(window, 'updateFixture').publish({
        candidate: {
          id: 'version-regression',
          version: '0.3.1',
          build_number: '202611031118',
          product_id: 'scholarseed',
          bundle_id: 'com.scholarseed.desktop',
          arch_type: 'darwin-arm64',
          channel: 'release',
          file_size: 100,
          sha512: 'a'.repeat(128),
          version_built_at: '2026-11-03T03:18:00Z',
          release_notes: 'One\nTwo\nThree\nFour',
        },
      })
    })
    await page.getByTestId('activity-update').click()
    for (const language of ['zh', 'en']) {
      await page.evaluate(async (language) => {
        await Reflect.get(window, 'updateFixture').language(language)
      }, language)
      await expect(page.getByTestId('update-panel-version')).toContainText('0.3.1-202611031118')
      await expect(page.getByTestId('update-panel-version').locator('time')).toHaveAttribute(
        'datetime',
        '2026-11-03T03:18:00Z'
      )
    }
    await page.getByTestId('update-panel-more').click()
    await expect(page.getByTestId('update-panel-version')).toContainText('0.3.1-202611031118')
    await page.evaluate(() => Reflect.get(window, 'updateFixture').publish({ phase: 'installing' }))
    await expect(page.getByTestId('update-overlay-version')).toContainText('0.3.1-202611031118')
  })
})

test('storage exhaustion stays concise, localized and retryable in the update panel', async () => {
  await withFixture(async (page) => {
    await page.setViewportSize({ width: 900, height: 600 })
    await page.evaluate(() => {
      Reflect.get(window, 'updateFixture').publish({
        phase: 'failed',
        errorOrigin: 'preparation',
        error:
          'Error: archive mounted application failed: ditto: /cache/application.zip:/Contents/file: No space left on device\nditto: /cache/application.zip:/Contents/another: No space left on device',
      })
    })
    await page.getByTestId('activity-update').click()
    const panel = page.getByTestId('update-panel')
    for (const language of ['zh', 'en']) {
      await page.evaluate(async (language) => {
        await Reflect.get(window, 'updateFixture').language(language)
      }, language)
      const message =
        language === 'zh'
          ? '磁盘可用空间不足，无法继续更新。请释放空间后重试；关闭此提示可返回应用。'
          : 'There is not enough free disk space to continue the update. Free up disk space and try again. You can close this message to return to the app.'
      await expect(panel.getByText(message, { exact: true })).toBeVisible()
      await expect(panel).not.toContainText('/cache/application.zip')
      await expect(panel).not.toContainText('ditto:')
      await expect(
        panel.getByRole('button', {
          name: language === 'zh' ? '重试准备' : 'Retry preparation',
          exact: true,
        })
      ).toBeEnabled()
      await expect(panel).toBeInViewport({ ratio: 1 })
      if (SCREENSHOT_DIRECTORY) {
        await panel.screenshot({
          path: path.join(SCREENSHOT_DIRECTORY, `component-${language}.png`),
        })
      }
    }
    await panel.getByRole('button', { name: 'Retry preparation', exact: true }).click()
    await expect(page.getByTestId('update-actions')).toHaveText('download:render-update')
  })
})

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
    await publish({ phase: 'downloading', restartPending: true, installStage: undefined })
    await expect(page.getByTestId('update-overlay-description')).toContainText('正在准备最新版本')
    await expect(page.getByTestId('update-overlay-cancel')).toBeEnabled()
    await publish({ restartPending: false })
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
