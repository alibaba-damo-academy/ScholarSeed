import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

test(
  'native divider yields to overlapping renderer feedback and returns after dismissal',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL('/shell/floating.render.fixture.html?resize&native-resize&overlap', fixture.url)
          .href
      )
      const lastPlacement = () =>
        page.evaluate(() =>
          (window as unknown as { portalPlacements: unknown[] }).portalPlacements.at(-1)
        )
      await expect.poll(lastPlacement).toMatchObject({ height: 800 })
      const popup = page
        .context()
        .pages()
        .find((candidate) => candidate !== page)
      assert.ok(popup)
      const handle = popup
        .frameLocator('[data-native-conversation-frame]')
        .locator('[data-native-resize-surface] button')
      await handle.hover()
      await popup.mouse.down()
      try {
        await expect(handle).toHaveAttribute('data-resizing', 'true')
        await page.getByRole('button', { name: '显示复制提示' }).dispatchEvent('click')
        await expect(handle).not.toHaveCSS('mask-image', 'none')
        await expect.poll(lastPlacement).toMatchObject({ width: 1280, height: 800 })
      } finally {
        await popup.mouse.up()
      }
      await page.locator('.vds-toast').getByRole('button').click()
      await expect(handle).toHaveCSS('mask-image', 'none')
      await page.getByRole('button', { name: '显示复制提示' }).click()
      await expect.poll(lastPlacement, { timeout: 2000 }).toBeNull()
      const toast = page.locator('.vds-toast').filter({ hasText: '复制成功' })
      await expect(toast).toBeVisible()
      const artifacts = process.env.SCHOLARSEED_DIVIDER_SCREENSHOTS
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'copy-toast.png') })
      await toast.getByRole('button').click()
      await expect.poll(lastPlacement).toMatchObject({ height: 800 })
      await page.getByRole('button', { name: '查看更新' }).click()
      await expect(page.getByText('新版本已就绪', { exact: true })).toBeVisible()
      await expect.poll(lastPlacement).toBeNull()
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'update-ready.png') })
      await page.keyboard.press('Escape')
      await expect.poll(lastPlacement).toMatchObject({ height: 800 })
    } finally {
      await fixture.close()
    }
  }
)

test(
  'split resizing follows screen movement rather than moving portal coordinates',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(new URL('/shell/floating.render.fixture.html?resize', fixture.url).href)
      const handle = page.getByRole('button', { name: 'Resize panels' })
      const bounds = await handle.boundingBox()
      assert.ok(bounds)
      await handle.evaluate((element) =>
        element.addEventListener(
          'pointerdown',
          (event) => {
            element.setAttribute('data-test-screen-start', String((event as PointerEvent).screenX))
          },
          { once: true }
        )
      )
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      const screenStart = Number(await handle.getAttribute('data-test-screen-start'))
      const inheritedWidth = await page
        .getByTestId('resize-left')
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--vds-resizable-left-width')
        )
      try {
        for (const clientX of [700, 300, 900, 400]) {
          await handle.dispatchEvent('pointermove', {
            pointerId: 1,
            buttons: 1,
            clientX,
            screenX: screenStart + 40,
          })
          await expect
            .poll(() =>
              page
                .getByTestId('resize-left')
                .evaluate((element) => element.parentElement!.getBoundingClientRect().width)
            )
            .toBeCloseTo(540, 0)
          assert.equal(
            await page
              .getByTestId('resize-left')
              .evaluate((element) =>
                getComputedStyle(element).getPropertyValue('--vds-resizable-left-width')
              ),
            inheritedWidth
          )
        }
      } finally {
        await page.mouse.up()
      }
      await expect
        .poll(() =>
          page
            .getByTestId('resize-left')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue('--vds-resizable-left-width')
            )
        )
        .toBe('540px')
      await expect
        .poll(() =>
          page
            .getByTestId('resize-left')
            .evaluate((element) => element.parentElement!.getBoundingClientRect().width)
        )
        .toBeCloseTo(540, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'two native dividers remain independent and moving anchors never use a stale crop',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL('/shell/floating.render.fixture.html?resize&native-resize&nested', fixture.url).href
      )
      await expect(page.locator('[data-native-resize-anchor]')).toHaveCount(2)
      await expect.poll(() => page.context().pages().length).toBe(3)
      const currentPopups = async () => {
        const ready = []
        for (const candidate of page.context().pages()) {
          if (candidate === page) continue
          if (
            await candidate
              .frameLocator('iframe')
              .getByRole('button', { name: 'Resize panels' })
              .isVisible()
              .catch(() => false)
          )
            ready.push(candidate)
        }
        return ready
      }
      await expect.poll(async () => (await currentPopups()).length).toBe(2)
      const popups = await currentPopups()
      for (const popup of popups)
        await expect(
          popup.frameLocator('iframe').getByRole('button', { name: 'Resize panels' })
        ).toBeVisible()
      assert.notEqual(
        await popups[0].evaluate(() => window.name),
        await popups[1].evaluate(() => window.name)
      )
      const popup = popups[0]
      await popup.bringToFront()
      const handle = popup.frameLocator('iframe').getByRole('button', { name: 'Resize panels' })
      const initial = await handle.boundingBox()
      assert.ok(initial)
      const origin = await popup.evaluate(
        () => -parseFloat(document.querySelector('iframe')!.style.left)
      )
      const globalStart = origin + initial.x + initial.width / 2
      const vertical = initial.y + initial.height / 2
      await popup.evaluate(() => {
        const values: number[] = []
        Object.assign(window, { cropSamples: values })
        let remaining = 120
        const sample = () => {
          const frame = document.querySelector('iframe')!
          const button = frame.contentDocument!.querySelector('button')!
          if (button.dataset.resizing === 'true')
            values.push(frame.getBoundingClientRect().left + button.getBoundingClientRect().left)
          if (remaining-- > 0) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      await popup.mouse.move(initial.x + initial.width / 2, vertical)
      await popup.mouse.down()
      try {
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as { portalPlacements: { x: number; width: number }[] }
              ).portalPlacements.at(-1)
            )
          )
          .toMatchObject({ x: 0, width: 1280 })
        for (let step = 1; step <= 20; step++) {
          const offset = await popup.evaluate(
            () => -parseFloat(document.querySelector('iframe')!.style.left)
          )
          await popup.mouse.move(globalStart + step * 3 - offset, vertical)
          await popup.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          )
        }
      } finally {
        await popup.mouse.up()
      }
      const samples = await popup.evaluate(
        () => (window as unknown as { cropSamples: number[] }).cropSamples
      )
      assert.ok(samples.length > 5)
      assert.ok(
        samples.every((value) => value >= 0 && value < 1280),
        JSON.stringify(samples)
      )
      await expect
        .poll(() => popup.evaluate(() => -parseFloat(document.querySelector('iframe')!.style.left)))
        .toBeGreaterThan(0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'clamped split width starts dragging from the rendered edge without a dead zone',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(
        new URL('/shell/floating.render.fixture.html?resize&clamped', fixture.url).href
      )
      const initial = await page
        .getByTestId('resize-left')
        .evaluate((element) => element.parentElement!.getBoundingClientRect().width)
      const handle = await page.getByRole('button', { name: 'Resize panels' }).boundingBox()
      assert.ok(handle)
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 - 20, handle.y + handle.height / 2)
      await page.mouse.up()
      await expect
        .poll(() =>
          page
            .getByTestId('resize-left')
            .evaluate((element) => element.parentElement!.getBoundingClientRect().width)
        )
        .toBeCloseTo(initial - 20, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'native split handle straddles the unchanged pane boundary and preserves pointer resizing',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const baseline = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await baseline.goto(new URL('/shell/floating.render.fixture.html?resize', fixture.url).href)
      const originalHandle = await baseline
        .getByRole('button', { name: 'Resize panels' })
        .boundingBox()
      const originalWidth = await baseline
        .getByTestId('resize-left')
        .evaluate((e) => e.parentElement!.getBoundingClientRect().width)
      assert.ok(originalHandle)
      await baseline.close()
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      const opening = page.context().waitForEvent('page')
      await page.goto(
        new URL('/shell/floating.render.fixture.html?resize&native-resize', fixture.url).href
      )
      const popup = await opening
      const frame = popup.frameLocator('[data-native-conversation-frame]')
      const handle = frame.getByRole('button', { name: 'Resize panels' })
      await expect(handle).toBeVisible()
      const anchor = page.locator('[data-native-resize-anchor]')
      const bounds = await anchor.boundingBox()
      const left = await page
        .getByTestId('resize-left')
        .evaluate((e) => e.parentElement!.getBoundingClientRect().toJSON())
      assert.ok(bounds)
      assert.deepEqual(bounds, originalHandle)
      assert.equal(left.width, originalWidth)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { portalPlacements: { width: number }[] }).portalPlacements.at(
                -1
              )?.width
          )
        )
        .toBeCloseTo(bounds.width, 0)
      const rect = await handle.boundingBox()
      assert.ok(rect)
      await popup.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
      await popup.mouse.down()
      await popup.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2)
      await popup.mouse.up()
      await expect
        .poll(() =>
          page
            .getByTestId('resize-left')
            .evaluate((e) => e.parentElement!.getBoundingClientRect().width)
        )
        .toBeCloseTo(left.width + 80, 0)
      await handle.blur()
      await popup.keyboard.press('Tab')
      await handle.focus()
      await expect(handle).toBeFocused()
      await handle.evaluate(async (element) => {
        element.getBoundingClientRect()
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      const paint = await handle.evaluate((element) => {
        const shadow = getComputedStyle(element).boxShadow.replace(/rgba?\([^)]*\)/g, '')
        const spread = Number.parseFloat(shadow.match(/-?\d*\.?\d+px/g)?.at(-1) ?? '0')
        return { width: element.getBoundingClientRect().width, spread }
      })
      assert.ok(paint.spread > 0)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { portalPlacements: { width: number }[] }).portalPlacements.at(
                -1
              )?.width
          )
        )
        .toBeCloseTo(paint.width + paint.spread * 2, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'split handle presentation keeps resize geometry anchored to its original host',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(new URL('/shell/floating.render.fixture.html?resize', fixture.url).href)
      const handle = page.getByTestId('resize-presentation').getByRole('button')
      await expect(handle).toBeVisible()
      const initial = await page
        .getByTestId('resize-left')
        .evaluate((e) => e.parentElement!.getBoundingClientRect().width)
      const rect = await handle.boundingBox()
      assert.ok(rect)
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2)
      await page.mouse.up()
      await expect
        .poll(() =>
          page
            .getByTestId('resize-left')
            .evaluate((e) => e.parentElement!.getBoundingClientRect().width)
        )
        .toBeCloseTo(initial + 80, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'cancelled first hover completes the hidden native lease without reviving the popup',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage()
      await page.goto(
        new URL('/shell/floating.render.fixture.html?overlay&delay=500', fixture.url).href
      )
      const opening = page.context().waitForEvent('page')
      const citation = page.getByRole('button', { name: 'Citation', exact: true })
      await citation.hover()
      await page.getByRole('button', { name: 'Toggle browser', exact: true }).hover()
      const popup = await opening
      await page.waitForFunction(
        () => (window as unknown as { portalPaints: string[] }).portalPaints.length > 0
      )
      assert.equal(
        await page.evaluate(() =>
          (window as unknown as { portalPlacements: unknown[] }).portalPlacements.at(-1)
        ),
        null
      )
      const frame = popup.frameLocator('[data-native-conversation-frame]')
      await expect(frame.getByRole('region')).toHaveCount(0)
      await citation.hover()
      await expect(frame.getByRole('button', { name: 'Open source', exact: true })).toBeVisible()
    } finally {
      await fixture.close()
    }
  }
)

test(
  'citation overlays leave the conversation mounted and follow cross-document input',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(new URL('/shell/floating.render.fixture.html?overlay', fixture.url).href)
      const draft = page.getByRole('textbox', { name: 'Local draft', exact: true })
      await draft.fill('unsent local draft')
      await page.getByRole('button', { name: 'Unrelated options', exact: true }).click()
      await expect(
        page.getByRole('textbox', { name: 'Ordinary option', exact: true })
      ).toBeVisible()
      await page.keyboard.press('Escape')
      const opening = page.context().waitForEvent('page')
      const sources = page.getByRole('button', { name: 'Sources', exact: true })
      await sources.click()
      const popup = await opening
      const frame = popup.frameLocator('[data-native-conversation-frame]')
      const filter = frame.getByRole('textbox', { name: 'Source filter', exact: true })
      await expect(filter).toBeFocused()
      await popup.keyboard.press('Escape')
      await expect(filter).toHaveCount(0)
      await expect(sources).toBeFocused()
      const citation = page.getByRole('button', { name: 'Citation', exact: true })
      await citation.hover()
      await expect(frame.getByRole('button', { name: 'Open source', exact: true })).toBeVisible()
      await expect(page.getByRole('region')).toHaveCount(0)
      await expect(draft).toHaveValue('unsent local draft')
      await popup.waitForFunction(() => !document.body.inert)
      await frame.getByRole('button', { name: 'Open source', exact: true }).focus()
      await popup.keyboard.press('Escape')
      await expect(frame.getByRole('region')).toHaveCount(0)
      await sources.click()
      await expect(filter).toBeFocused()
      await popup.keyboard.press('Escape')
      await expect(filter).toHaveCount(0)
      await expect(sources).toBeFocused()
      await sources.click()
      await expect(filter).toBeVisible()
      await draft.click()
      await expect(filter).toHaveCount(0)
      await citation.focus()
      await expect(frame.getByRole('button', { name: 'Open source', exact: true })).toBeVisible()
      await page.getByTestId('conversation-scroll').hover()
      await page.mouse.wheel(0, 600)
      await expect(frame.getByRole('region')).toHaveCount(0)
      await page.getByRole('button', { name: 'Toggle browser', exact: true }).click()
      await expect(draft).toHaveValue('unsent local draft')
      await page.getByRole('button', { name: 'Toggle browser', exact: true }).click()
      await expect(draft).toHaveValue('unsent local draft')
    } finally {
      await fixture.close()
    }
  }
)

test(
  'bounded conversation uses a full coordinate iframe, shared state and scoped nested controls',
  { timeout: 60000 },
  async () => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'), {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    try {
      const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(new URL('/shell/floating.render.fixture.html', fixture.url).href)
      const opening = page.context().waitForEvent('page')
      await page.getByRole('button', { name: 'Toggle native', exact: true }).click()
      const popup = await opening
      const frame = popup.frameLocator('[data-native-conversation-frame]')
      await expect(frame.getByRole('textbox', { name: 'Draft', exact: true })).toBeEnabled()
      await popup.waitForFunction(() => !document.body.inert)
      await frame.getByRole('textbox', { name: 'Draft', exact: true }).fill('retained draft')
      await frame.getByRole('button', { name: 'Increment', exact: true }).click()
      await expect(page.getByTestId('shared-count')).toHaveText('1')
      const metrics = await popup
        .frames()
        .find((candidate) => candidate.parentFrame())!
        .evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          bridge: typeof window.scholarseed,
          panel: document
            .querySelector('[data-testid=floating-fixture-panel]')!
            .getBoundingClientRect()
            .toJSON(),
        }))
      assert.equal(metrics.width, 1280)
      assert.equal(metrics.height, 800)
      assert.equal(metrics.bridge, 'undefined')
      assert.ok(metrics.panel.x > 800)
      await frame.getByRole('button', { name: 'Options', exact: true }).click()
      await expect(frame.getByRole('textbox', { name: 'Nested option', exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Nested option', exact: true })).toHaveCount(0)
      await popup.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Open product modal', exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as unknown as { portalPlacements: unknown[] }).portalPlacements.at(-1) === null
      )
      await page.getByRole('button', { name: 'Close modal', exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as unknown as { portalPlacements: unknown[] }).portalPlacements.at(-1) !== null
      )
      await expect(frame.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'retained draft'
      )
      await page.getByRole('button', { name: 'Toggle native', exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'retained draft'
      )
      const pages = page.context().pages().length
      assert.equal(await popup.evaluate(() => document.body.inert), true)
      await page.waitForFunction(
        () =>
          (window as unknown as { portalPlacements: unknown[] }).portalPlacements.at(-1) === null
      )
      await page.getByRole('button', { name: 'Toggle native', exact: true }).click()
      await expect(frame.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'retained draft'
      )
      assert.equal(page.context().pages().length, pages)
    } finally {
      await fixture.close()
    }
  }
)
