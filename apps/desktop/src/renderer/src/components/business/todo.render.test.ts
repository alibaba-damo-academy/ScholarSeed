import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE_URL = '/components/business/todo.fixture.html'
const CASE_TIMEOUT_MS = 90_000
const GEOMETRY_TOLERANCE = 1
const NARROW_WIDTH = 228

test(
  'the composer waits for plan steps even when the running skill has an estimate',
  { timeout: CASE_TIMEOUT_MS },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const query = new URLSearchParams({
      recovered: 'true',
      estimate: '',
      subplan: '',
      duration: '1000',
      width: '640',
    })
    const panel = page.getByTestId('todo-panel')
    const estimate = page.getByTestId('todo-estimate')
    const summaryEstimate = page.getByTestId('todo-summary-estimate')
    const elapsed = page.getByTestId('todo-elapsed')
    const toggle = page.getByTestId('todo-toggle')

    await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
    await expect(panel).toBeVisible()
    await expect(summaryEstimate).toHaveText('预估 30～45 分钟')
    await expect(elapsed).toHaveCount(0)
    await expect(estimate).toHaveCount(0)
    const summaryMark = toggle.getByTestId('todo-mark-running')
    const summaryImage = summaryMark.locator('img')
    await expect(summaryImage).toHaveAttribute('src', /^data:image\/gif;base64,/)
    await expect(summaryImage).toHaveJSProperty('naturalWidth', 320)
    await toggle.click()
    const bubble = page.getByTestId('todo-body')
    await expect(estimate).toHaveCount(0)
    await expect(bubble).not.toContainText('预估')
    await expect(bubble.getByText('执行计划', { exact: true })).toHaveCSS('font-size', '12px')
    const runningStep = bubble.getByText('Step 8', { exact: true })
    await expect(runningStep).toHaveCount(1)
    await expect(runningStep).toHaveCSS('font-weight', '500')
    await expect(bubble.getByText('Step 9', { exact: true })).toHaveCSS('font-weight', '400')
    await expect(bubble).not.toContainText('Sub-agent detail')
    await expect(bubble.getByTestId('todo-step')).toHaveCount(9)
    const runningMark = bubble.getByTestId('todo-mark-running')
    const runningImage = runningMark.locator('img')
    await expect(runningImage).toHaveAttribute('src', /^data:image\/gif;base64,/)
    await expect(runningImage).toHaveJSProperty('naturalWidth', 320)
    const detailElapsed = bubble.getByTestId('todo-detail-elapsed')
    await expect(detailElapsed).toHaveCSS('font-size', '12px')
    await expect(detailElapsed).toHaveCSS('font-weight', '400')

    query.set('duration', '120000')
    await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
    await expect(summaryEstimate).toHaveText('预估 28～43 分钟')
    await expect(elapsed).toHaveCount(0)

    for (const issue of ['failed', 'blocked']) {
      query.set('issue', issue)
      await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
      const mark = toggle.getByTestId(`todo-mark-${issue}`)
      await expect(
        mark.locator(issue === 'failed' ? 'svg.lucide-circle-alert' : '.iconfont')
      ).toBeVisible()
      await expect(toggle.getByTestId('todo-mark-running')).toHaveCount(0)
    }
    query.delete('issue')

    query.set('duration', '2701000')
    await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
    await expect(summaryEstimate).toHaveCount(0)
    await expect(elapsed).toBeVisible()

    query.set('noPlan', '')
    await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
    await expect(page.locator('#root > div')).toBeAttached()
    await expect(panel).toHaveCount(0)

    query.delete('recovered')
    query.set('duration', '120000')
    await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
    await expect(summaryEstimate).toBeVisible()
  }
)

test(
  'recovery plans stay visible while running or completed and can continue after interruption',
  { timeout: CASE_TIMEOUT_MS },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const outcome of ['running', 'completed', 'interrupted']) {
      const query = new URLSearchParams({
        recovered: 'true',
        completed: String(outcome === 'completed'),
        interrupted: String(outcome === 'interrupted'),
        holdContinue: String(outcome === 'interrupted'),
        width: '640',
      })
      await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
      await expect(page.getByTestId('todo-panel')).toBeVisible()
      const continuation = page.getByTestId('todo-continue')
      if (outcome === 'interrupted') {
        await expect(continuation).toHaveCount(0)
        await expect(page.getByTestId('todo-elapsed')).toBeVisible()
        const toggle = page.getByTestId('todo-toggle')
        const background = await toggle.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        )
        await toggle.hover()
        await expect(toggle).not.toHaveCSS('box-shadow', 'none')
        await expect(toggle).toHaveCSS('background-color', background)
        await toggle.click()
        await expect(page.getByTestId('todo-incomplete')).toHaveCount(0)
        await expect(page.getByTestId('todo-step').first()).toHaveCSS('font-weight', '400')
        await expect(continuation).toBeEnabled()
        await continuation.click()
        await expect(continuation).toBeDisabled()
        await expect(page.getByTestId('todo-toggle')).toHaveAttribute('aria-expanded', 'true')
        await expect(page.locator('html')).toHaveAttribute('data-continue-requests', '1')
        await page.evaluate(() => {
          const release = (window as Window & { releaseTodoContinuation?: () => void })
            .releaseTodoContinuation
          if (!release) throw new Error('Continuation callback was not registered')
          release()
        })
        await expect(page.locator('html')).toHaveAttribute('data-continued', 'true')
        await expect(continuation).toBeEnabled()
        query.set('continueDisabled', 'true')
        await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
        await toggle.click()
        await expect(continuation).toBeDisabled()
        assert.equal(await page.locator('html').getAttribute('data-continue-requests'), null)
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
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const language of ['zh', 'en']) {
      for (const width of [NARROW_WIDTH, 640]) {
        for (const completed of [false, true]) {
          const query = new URLSearchParams({
            language,
            width: String(width),
            completed: String(completed),
            theme: completed ? 'dark' : 'light',
          })
          if (width === NARROW_WIDTH) query.set('longStep', '')
          await page.goto(new URL(`${FIXTURE_URL}?${query}`, fixture.url).href)
          const panel = page.getByTestId('todo-panel')
          const toggle = page.getByTestId('todo-toggle')
          const elapsed = page.getByTestId('todo-elapsed')
          await expect(toggle).toHaveCSS('height', '32px')
          await expect(toggle).toHaveCSS('border-top-left-radius', '8px')
          await expect(elapsed).toContainText(language === 'zh' ? '174 分 48 秒' : '174m 48s')
          await expect(elapsed).toHaveCSS('font-weight', '400')
          const typography = await elapsed.evaluate((element) => {
            const probe = document.createElement('span')
            probe.style.fontSize = 'var(--vds-font-body-lv1)'
            probe.style.color = 'var(--vds-text-tertiary)'
            element.append(probe)
            const expected = getComputedStyle(probe)
            const actual = getComputedStyle(element)
            const result = {
              actual: {
                family: actual.fontFamily,
                numbers: actual.fontVariantNumeric,
                size: actual.fontSize,
                color: actual.color,
              },
              expected: {
                family: getComputedStyle(document.body).fontFamily,
                numbers: 'normal',
                size: expected.fontSize,
                color: expected.color,
              },
            }
            probe.remove()
            return result
          })
          assert.deepEqual(typography.actual, typography.expected)
          const progress = page.getByTestId('todo-progress')
          const controls = [toggle, elapsed]
          if (completed) {
            await expect(progress).toHaveCount(0)
            const mark = toggle.getByTestId('todo-mark-done')
            const successColor = await toggle.evaluate((element) => {
              const probe = document.createElement('span')
              probe.style.color = 'var(--vds-success-text-primary)'
              element.append(probe)
              const color = getComputedStyle(probe).color
              probe.remove()
              return color
            })
            await expect(mark).toHaveCSS('color', successColor)
          } else {
            controls.push(progress)
            await expect(progress).toHaveCSS('font-family', typography.expected.family)
            await expect(progress).toHaveCSS('font-variant-numeric', 'normal')
            await expect(progress).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          }
          await expect(page.getByTestId('todo-estimate')).toHaveCount(0)
          await expect
            .poll(async () =>
              panel.evaluate((element) => element.scrollWidth - element.clientWidth)
            )
            .toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
          const bounds = (await panel.boundingBox())!
          for (const control of controls) {
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
          await expect(toggle).toContainText(language === 'zh' ? '执行步骤' : 'Steps')
          await expect(page.getByTestId('todo-body')).toHaveCount(0)
          await toggle.focus()
          await page.keyboard.press('Enter')
          await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          assert.equal((await panel.boundingBox())?.height, bounds.height)
          const bubble = (await page.getByTestId('todo-body').boundingBox())!
          assert.ok(bubble.y + bubble.height <= bounds.y)
          assert.ok(Math.abs(bubble.x - bounds.x) <= GEOMETRY_TOLERANCE)
          if (width === NARROW_WIDTH) {
            assert.ok(Math.abs(bubble.width - bounds.width) <= GEOMETRY_TOLERANCE)
          } else {
            assert.ok(bubble.width < bounds.width)
          }
          await expect(elapsed.locator('svg')).toHaveCSS('width', '12px')
          await expect(page.getByTestId('todo-detail-elapsed').locator('svg')).toHaveCSS(
            'width',
            '12px'
          )
          const scrollbar = page.getByRole('scrollbar')
          await expect(scrollbar).toBeVisible()
          const track = (await scrollbar.boundingBox())!
          assert.ok(Math.abs(bubble.x + bubble.width - track.x - track.width) <= GEOMETRY_TOLERANCE)
          const viewport = page.locator('.vds-scroll-area__viewport')
          assert.equal(
            await viewport.evaluate(
              (element) =>
                element instanceof HTMLElement && element.scrollWidth === element.offsetWidth
            ),
            true
          )
          await expect(page.getByTestId('todo-step')).toHaveCount(9)
          await expect(page.getByTestId('todo-step-elapsed')).toHaveCount(0)
          await expect(page.getByTestId('todo-step').first()).toHaveCSS('font-weight', '400')
          const mark = page.getByTestId('todo-step').first().locator('.iconfont')
          await expect(mark).toHaveCSS('font-size', '12px')
          if (!completed) {
            const pending = page.getByTestId('todo-step').last().locator('svg')
            await expect(pending).toBeVisible()
            const icon = await pending.boundingBox()
            const line = await pending.locator('xpath=..').boundingBox()
            assert.ok(icon && line)
            const glyphSize = await mark.evaluate((element) =>
              Number.parseFloat(getComputedStyle(element).fontSize)
            )
            assert.equal(icon.width, glyphSize)
            assert.equal(icon.height, glyphSize)
            assert.ok(
              Math.abs(icon.y + icon.height / 2 - line.y - line.height / 2) <= GEOMETRY_TOLERANCE
            )
          }
          await page.keyboard.press('Escape')
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          await expect(toggle).toBeFocused()
          await toggle.click()
          await page.mouse.click(1, 1)
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
          if (width === 640) {
            if (!completed) {
              const count = (await progress.boundingBox())!
              const title = (await progress
                .locator('xpath=preceding-sibling::span[1]')
                .boundingBox())!
              assert.ok(Math.abs(count.x - title.x - title.width - 8) < GEOMETRY_TOLERANCE)
              assert.ok(
                Math.abs(count.y + count.height / 2 - title.y - title.height / 2) <
                  GEOMETRY_TOLERANCE
              )
            }
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
