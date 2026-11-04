import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE_URL = '/components/business/todo.fixture.html'
const CASE_TIMEOUT_MS = 90_000
const GEOMETRY_TOLERANCE = 1

test(
  'recovery plans stay visible while running or completed and can continue after interruption',
  { timeout: CASE_TIMEOUT_MS },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const outcome of ['running', 'completed', 'interrupted']) {
      const query = new URLSearchParams({
        recovered: 'true',
        completed: String(outcome === 'completed'),
        interrupted: String(outcome === 'interrupted'),
        width: '640',
      })
      await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
      await expect(page.getByTestId('todo-panel')).toBeVisible()
      const continuation = page.getByTestId('todo-continue')
      if (outcome === 'interrupted') {
        await expect(continuation).toBeEnabled()
        await continuation.click()
        await expect(page.locator('html')).toHaveAttribute('data-continued', 'true')
      } else {
        await expect(continuation).toHaveCount(0)
      }
    }
  }
)

test(
  'plan header contains its full duration and controls at narrow and normal widths',
  { timeout: CASE_TIMEOUT_MS },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const language of ['zh', 'en']) {
      for (const width of [228, 640]) {
        for (const completed of [false, true]) {
          const query = new URLSearchParams({
            language,
            width: String(width),
            completed: String(completed),
            theme: completed ? 'dark' : 'light',
          })
          await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
          const panel = page.getByTestId('todo-panel')
          const toggle = page.getByTestId('todo-toggle')
          const elapsed = page.getByTestId('todo-elapsed')
          await expect(elapsed).toContainText('2h 54m')
          await expect(page.getByTestId('todo-estimate')).toHaveCount(0)
          await expect
            .poll(async () =>
              panel.evaluate((element) => element.scrollWidth - element.clientWidth)
            )
            .toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
          const bounds = (await panel.boundingBox())!
          for (const control of [toggle, elapsed, page.getByTestId('todo-progress')]) {
            const rectangle = (await control.boundingBox())!
            assert.ok(
              rectangle.x >= bounds.x &&
                rectangle.x + rectangle.width <= bounds.x + bounds.width + GEOMETRY_TOLERANCE &&
                rectangle.y >= bounds.y &&
                rectangle.y + rectangle.height <= bounds.y + bounds.height + GEOMETRY_TOLERANCE,
              `${language}/${width}/${completed}: control escaped card`
            )
          }
          assert.equal(
            await elapsed.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true
          )
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          await toggle.focus()
          await page.keyboard.press('Enter')
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          await expect(page.getByTestId('todo-step')).toHaveCount(9)
          await page.keyboard.press('Space')
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          if (width === 640) {
            const header = (await toggle.boundingBox())!
            const timer = (await elapsed.boundingBox())!
            assert.ok(
              timer.y < header.y + header.height / 2,
              'normal width should retain a single header row'
            )
          }
        }
      }
    }
  }
)
