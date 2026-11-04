import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { RenderFailure, renderFixture } from '../../../test-helpers/render.ts'

const FIXTURE_URL = '/components/ui.render.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MOTION_OBSERVATION_MS = 350
const ISOLATION_KEYS = {
  storage: 'ui-render-case',
  global: 'uiRenderCase',
  cookie: 'ui-render-case',
}
let preparing: ReturnType<typeof renderFixture> | undefined

test('ScrollArea overlay keeps both axes outside layout and synchronizes keyboard and track clicks', async () => {
  await withFixture(async (page) => {
    const root = page.getByTestId('render-overlay-scroll')
    const viewport = page.getByTestId('render-overlay-viewport')
    await expect(root.getByRole('scrollbar')).toHaveCount(2)
    await expect(root).toHaveAttribute('data-fade-top', 'false')
    await expect(root).toHaveAttribute('data-fade-bottom', 'true')
    assert.deepEqual(
      await viewport.evaluate((element) => [element.clientWidth, element.clientHeight]),
      [160, 80]
    )
    for (const orientation of ['vertical', 'horizontal']) {
      const bar = root.locator(`[role="scrollbar"][aria-orientation="${orientation}"]`)
      await bar.focus()
      await page.keyboard.press('End')
      await expect(bar).toHaveAttribute('aria-valuenow', '160')
      if (orientation === 'vertical') {
        await expect(root).toHaveAttribute('data-fade-top', 'true')
        await expect(root).toHaveAttribute('data-fade-bottom', 'false')
      }
      await page.keyboard.press('Home')
      await expect(bar).toHaveAttribute('aria-valuenow', '0')
      const box = (await bar.boundingBox())!
      await page.mouse.click(
        box.x + (orientation === 'vertical' ? box.width / 2 : box.width - 12),
        box.y + (orientation === 'vertical' ? box.height - 12 : box.height / 2)
      )
      await expect
        .poll(async () => Number(await bar.getAttribute('aria-valuenow')))
        .toBeGreaterThan(0)
    }
  })
})

test('ResizableHandle supports independent pixel offsets and releases capture', async () => {
  await withFixture(async (page) => {
    const handle = page.getByTestId('render-resizable-standalone')
    await expect(handle.locator('span')).toHaveCount(0)
    await handle.scrollIntoViewIfNeeded()
    const bounds = await handle.boundingBox()
    assert.ok(bounds)
    assert.ok(bounds.width > 0 && bounds.height > 0, JSON.stringify(bounds))
    const start = bounds.x + bounds.width / 2
    const middle = bounds.y + bounds.height / 2
    await page.mouse.move(start, middle)
    await page.mouse.down()
    await expect(handle).toHaveAttribute('data-resizing', 'true')
    assert.equal(await handle.evaluate((element) => getComputedStyle(element).cursor), 'ew-resize')
    assert.equal(
      await handle.evaluate((element) => getComputedStyle(element, '::before').content),
      'none'
    )
    assert.equal(
      await handle.evaluate((element) => getComputedStyle(element, '::after').content),
      'none'
    )
    await page.mouse.move(start + 80, middle)
    await expect(page.getByTestId('render-resizable-offset')).toHaveText('80')
    await page.mouse.up()
    await expect(handle).not.toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(start + 100, middle)
    await expect(page.getByTestId('render-resizable-offset')).toHaveText('80')
    await handle.press('ArrowLeft')
    await expect(page.getByTestId('render-resizable-offset')).toHaveText('-5')
    await handle.press('ArrowRight')
    await expect(page.getByTestId('render-resizable-offset')).toHaveText('5')
  })
})

test('NavigationTabs activates the pressed tab and reorders in both directions with composed drag hooks', async () => {
  await withFixture(async (page) => {
    const bar = page.getByTestId('render-navigation-tabs-reorder')
    const first = bar.getByRole('tab', { name: 'First.md' })
    const third = bar.getByRole('tab', { name: 'Third.md' })
    await first.dragTo(third, {
      targetPosition: { x: (await third.boundingBox())!.width - 4, y: 16 },
    })
    await expect(bar.getByRole('tab')).toHaveText([
      '总览',
      'Second.md',
      'Third.md',
      'First.md',
      'Locked.md',
    ])
    await expect(bar.getByRole('tab', { selected: true })).toContainText('First.md')
    await third.dragTo(bar.getByRole('tab', { name: /Second.md/ }), {
      targetPosition: { x: 2, y: 16 },
    })
    await expect(bar.getByRole('tab')).toHaveText([
      '总览',
      'Third.md',
      'Second.md',
      'First.md',
      'Locked.md',
    ])
    await expect(bar.getByRole('tab', { selected: true })).toContainText('Third.md')
    await expect(page.getByTestId('render-navigation-reorders')).toHaveText('2')
    await expect(page.getByTestId('render-navigation-drag-events')).toHaveText('2')
    await expect(page.getByTestId('render-navigation-drop-events')).toHaveText('2')
    await expect(bar.getByRole('tab', { name: 'Locked.md' })).toHaveAttribute('draggable', 'false')
    await expect(bar.getByRole('tab', { name: '总览', exact: true })).not.toHaveAttribute(
      'draggable',
      'true'
    )
    await expect(bar.locator('[data-slot="navigation-tab-drop-indicator"]')).toHaveCount(0)
  })
})

test('NavigationTabs activates on press before a small movement can consume the click', async () => {
  await withFixture(async (page) => {
    const bar = page.getByTestId('render-navigation-tabs-reorder')
    const first = bar.getByRole('tab', { name: 'First.md' })
    const bounds = (await first.boundingBox())!
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await page.mouse.move(start.x + 5, start.y)
    await page.mouse.up()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('render-navigation-reorders')).toHaveText('0')
    const previousDrags = Number(
      await page.getByTestId('render-navigation-drag-events').textContent()
    )
    const third = bar.getByRole('tab', { name: 'Third.md' })
    const destination = (await third.boundingBox())!
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 5, start.y)
    await page.mouse.move(start.x + 10, start.y, { steps: 5 })
    await page.mouse.move(destination.x + destination.width - 4, start.y, { steps: 20 })
    await page.mouse.move(destination.x + destination.width - 4, start.y)
    await page.mouse.up()
    await expect(page.getByTestId('render-navigation-reorders')).toHaveText('1')
    await expect(page.getByTestId('render-navigation-drag-events')).toHaveText(
      String(previousDrags + 1)
    )
  })
})

test('NavigationTabs activates a mouse click once and preserves keyboard, auxiliary and close actions', async () => {
  await withFixture(async (page) => {
    const bar = page.getByTestId('render-navigation-tabs-reorder')
    const first = bar.getByRole('tab', { name: 'First.md' })
    const third = bar.getByRole('tab', { name: 'Third.md' })
    const activations = page.getByTestId('render-navigation-activations')
    await first.click()
    await expect(activations).toHaveText('1')
    await first.click({ button: 'right' })
    await first.click({ button: 'middle' })
    await expect(activations).toHaveText('1')
    await third.focus()
    await third.press('Enter')
    await expect(third).toHaveAttribute('aria-selected', 'true')
    await expect(activations).toHaveText('2')
    await third.dispatchEvent('click', { detail: 0 })
    await expect(activations).toHaveText('3')
    await first.getByRole('button', { name: '关闭 First.md' }).click()
    await expect(first).toHaveCount(0)
    await expect(third).toHaveAttribute('aria-selected', 'true')
    await expect(activations).toHaveText('3')
  })
})

test('NavigationTabs ignores external drops and clears a cancelled drag', async () => {
  await withFixture(async (page) => {
    const bar = page.getByTestId('render-navigation-tabs-reorder')
    const first = bar.getByRole('tab', { name: 'First.md' })
    const third = bar.getByRole('tab', { name: 'Third.md' })
    await third.dispatchEvent('drop', { clientX: 0 })
    await first.dispatchEvent('dragstart', {
      dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
    })
    await third.dispatchEvent('dragover', {
      dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
    })
    await expect(bar.locator('[data-slot="navigation-tab-drop-indicator"]')).toHaveCount(1)
    await first.dispatchEvent('dragend')
    await expect(bar.locator('[data-slot="navigation-tab-drop-indicator"]')).toHaveCount(0)
    await expect(page.getByTestId('render-navigation-reorders')).toHaveText('0')
  })
})

test('NavigationTabs ignores no-op and cross-instance drops even with matching IDs', async () => {
  await withFixture(async (page) => {
    const bar = page.getByTestId('render-navigation-tabs-reorder')
    const first = bar.getByRole('tab', { name: 'First.md' })
    await first.dragTo(bar.getByRole('tab', { name: /Second.md/ }), {
      targetPosition: { x: 2, y: 16 },
    })
    await first.dragTo(
      page
        .getByTestId('render-navigation-tabs-reorder-other')
        .getByRole('tab', { name: 'Third.md' })
    )
    await expect(page.getByTestId('render-navigation-reorders')).toHaveText('0')
    await expect(bar.getByRole('tab')).toHaveText([
      '总览',
      'First.md',
      'Second.md',
      'Third.md',
      'Locked.md',
    ])
    await expect(bar.locator('[data-slot="navigation-tab-drop-indicator"]')).toHaveCount(0)
  })
})

function sharedFixture() {
  preparing ??= renderFixture(path.dirname(ROOT_DIR), {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  return preparing
}

after(async () => {
  if (!preparing) return
  const [prepared] = await Promise.allSettled([preparing])
  if (prepared.status === 'fulfilled') await prepared.value.close()
})

test('split resizing follows screen direction for either sized panel and clamps both ends', async () => {
  await withFixture(async (page) => {
    for (const sizedPanel of ['left', 'right']) {
      for (const reversed of [false, true]) {
        const split = page.getByTestId(`render-split-${sizedPanel}-${reversed}`)
        const handle = split.getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
        await handle.scrollIntoViewIfNeeded()
        for (const delta of [50, -50]) {
          const before = (await handle.boundingBox())!
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
          await page.mouse.down()
          await page.mouse.move(before.x + before.width / 2 + delta, before.y + before.height / 2, {
            steps: 5,
          })
          await page.mouse.up()
          assert.ok(Math.abs((await handle.boundingBox())!.x - before.x - delta) < 2)
        }
        for (const delta of [-2000, 2000]) {
          const before = (await handle.boundingBox())!
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
          await page.mouse.down()
          await page.mouse.move(before.x + before.width / 2 + delta, before.y + before.height / 2)
          await page.mouse.up()
          const width = await split.evaluate(
            (element, side) =>
              Number.parseFloat(
                (element as HTMLElement).style.getPropertyValue(`--vds-resizable-${side}-width`)
              ),
            sizedPanel
          )
          const growsTowardPointer = delta > 0 !== reversed
          assert.equal(width, growsTowardPointer === (sizedPanel === 'left') ? 640 : 260)
        }
      }
    }
  })
})

test('disabled resizing preserves enabled panel actions', async () => {
  await withFixture(async (page) => {
    await expect(page.getByTestId('render-resizable-disabled-action')).toBeEnabled()
    await expect(page.getByTestId('render-resizable-disabled-handle')).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })
})

test('split navigation highlights only the hovered action and aligns its label left', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-navigation-split')
    const group = trigger.locator('..')
    const back = group.getByRole('button', { name: '返回项目中心', exact: true })
    const background = (locator: ReturnType<Page['locator']>) =>
      locator.evaluate((element) => getComputedStyle(element).backgroundColor)
    const clear = 'rgba(0, 0, 0, 0)'
    await back.hover()
    assert.equal(await background(group), clear)
    assert.notEqual(await background(back), clear)
    assert.equal(await background(trigger), clear)
    await trigger.hover()
    assert.equal(await background(group), clear)
    assert.equal(await background(back), clear)
    assert.notEqual(await background(trigger), clear)
    assert.equal(
      await trigger
        .locator('[data-slot="navigation-label"]')
        .evaluate((element) => getComputedStyle(element).textAlign),
      'left'
    )
  })
})

test('split navigation preserves exact design geometry and independent actions', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-navigation-split')
    const group = trigger.locator('..')
    const back = group.getByRole('button', { name: '返回项目中心', exact: true })
    const dimensions = await group.evaluate((element) => {
      const label = element.querySelector('[data-slot="navigation-label"]')!
      const icons = Array.from(element.querySelectorAll('.iconfont'))
      const box = element.getBoundingClientRect()
      const labelBox = label.getBoundingClientRect()
      const left = icons[0].getBoundingClientRect()
      const right = icons[1].getBoundingClientRect()
      return {
        width: box.width,
        height: box.height,
        label: labelBox.width,
        left: [left.width, left.height],
        right: [right.width, right.height],
        gaps: [labelBox.left - left.right, right.left - labelBox.right],
        padding: [left.left - box.left, box.right - right.right],
        truncated: label.scrollWidth > label.clientWidth,
      }
    })
    assert.deepEqual(dimensions, {
      width: 154,
      height: 32,
      label: 102,
      left: [14, 14],
      right: [14, 14],
      gaps: [6, 6],
      padding: [6, 6],
      truncated: true,
    })
    await back.click()
    await expect(page.getByTestId('render-button-clicks')).toHaveText('1')
    await trigger.focus()
    await trigger.press('Enter')
    await expect(page.getByTestId('render-button-clicks')).toHaveText('11')
  })
})

test('navigation button preserves its label, keyboard activation and disabled semantics', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-navigation-button')
    const typography = await trigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return { weight: style.fontWeight, size: style.fontSize, line: style.lineHeight }
    })
    assert.deepEqual(typography, { weight: '600', size: '14px', line: '20px' })
    await expect(trigger).toHaveAccessibleName('一个很长的项目名称用于验证省略与完整名称')
    await expect(trigger).toHaveAttribute('title', '一个很长的项目名称用于验证省略与完整名称')
    await expect(trigger.locator('.icon-a-line-switch-arrow-left-s')).toBeVisible()
    await expect(trigger.locator('.icon-a-line-switch-arrow-down-s')).toBeVisible()
    const geometry = await trigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        height: style.height,
        width: style.width,
        padding: style.padding,
        gap: style.gap,
        radius: style.borderRadius,
      }
    })
    assert.deepEqual(geometry, {
      height: '32px',
      width: '154px',
      padding: '6px',
      gap: '6px',
      radius: '8px',
    })
    assert.ok(
      await trigger
        .locator('[data-slot="navigation-label"]')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    )
    await trigger.focus()
    await trigger.press('Enter')
    await expect(page.getByTestId('render-button-clicks')).toHaveText('1')
    await expect(page.getByTestId('render-navigation-disabled')).toBeDisabled()
  })
})

test('animated splits interpolate both collapse directions and retain inactive content', async () => {
  await withFixture(async (page) => {
    const nav = page
      .getByTestId('render-animated-navigation')
      .locator(':scope > .vds-resizable-split__panel--left')
    const draft = page.getByTestId('render-navigation-draft')
    await draft.fill('Keep this draft')
    const sample = (testId: string, target: string) =>
      page.evaluate(
        async ({ testId, target }) => {
          const pane = document.querySelector<HTMLElement>(target)!
          const widths = [pane.getBoundingClientRect().width]
          const committed = new Promise<void>((resolve) => {
            const observer = new MutationObserver(() => {
              observer.disconnect()
              resolve()
            })
            observer.observe(pane, { attributes: true, attributeFilter: ['style'] })
          })
          document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
          await committed
          // Inspect the browser's real CSS timeline without relying on wall-clock frame delivery.
          const animation = pane
            .getAnimations()
            .find((item) => item instanceof CSSTransition && item.transitionProperty === 'width')
          if (!animation) throw new Error('Expected a width transition after the layout commit')
          animation.pause()
          const duration = Number(animation.effect!.getTiming().duration)
          for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
            animation.currentTime = duration * progress
            widths.push(pane.getBoundingClientRect().width)
          }
          animation.finish()
          return widths
        },
        { testId, target }
      )
    const navSelector =
      '[data-testid="render-animated-navigation"] > .vds-resizable-split__panel--left'
    const closing = await sample('render-navigation-toggle', navSelector)
    assert.equal(closing.at(-1), 0)
    assert.ok(closing.some((width) => width > 0 && width < closing[0]))
    assert.equal(await nav.getAttribute('inert'), '')
    assert.equal(await nav.getAttribute('aria-hidden'), 'true')
    assert.equal(await nav.getAttribute('hidden'), null)
    const opening = await sample('render-navigation-toggle', navSelector)
    assert.equal(opening.at(-1), 260)
    assert.ok(opening.some((width) => width > 0 && width < 260))
    await expect(draft).toHaveValue('Keep this draft')
    const conversation =
      '[data-testid="render-conversation-split"] > .vds-resizable-split__panel--left'
    const full = await sample('render-split-toggle', conversation)
    assert.equal(full.at(-1), 800)
    assert.ok(full.some((width) => width > 360 && width < 800))
    const split = await sample('render-split-toggle', conversation)
    assert.equal(split.at(-1), 360)
    assert.ok(split.some((width) => width > 360 && width < 800))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('render-navigation-toggle').click()
    assert.equal(await nav.evaluate((element) => element.getAnimations().length), 0)
    assert.equal(await nav.evaluate((element) => element.getBoundingClientRect().width), 0)
  })
})

test('surface morph preserves its live input, cancels on reversal and follows reduced motion', async () => {
  await withFixture(async (page) => {
    const draft = page.getByTestId('render-morph-draft')
    await draft.fill('Unsent conversation')
    const morph = () =>
      page.evaluate(async () => {
        const surface = document.querySelector<HTMLElement>('[data-testid="render-morph-surface"]')!
        const old = surface.getBoundingClientRect()
        const committed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect()
            resolve()
          })
          observer.observe(surface, { attributes: true, attributeFilter: ['style'] })
        })
        document.querySelector<HTMLButtonElement>('[data-testid="render-morph-toggle"]')!.click()
        await committed
        const animations = surface.getAnimations()
        const animation = animations[0]
        if (animation) {
          animation.pause()
          animation.currentTime = 0
        }
        const first = surface.getBoundingClientRect()
        const transform = new DOMMatrixReadOnly(getComputedStyle(surface).transform)
        return {
          count: animations.length,
          scale: { x: transform.a, y: transform.d },
          old: { left: old.left, width: old.width },
          first: { left: first.left, width: first.width },
        }
      })
    const first = await morph()
    assert.equal(first.count, 1)
    assert.deepEqual(first.scale, { x: 1, y: 1 })
    assert.ok(Math.abs(first.old.left - first.first.left) < 1)
    assert.ok(Math.abs(first.old.width - first.first.width) < 1)
    await page.getByTestId('render-morph-surface').evaluate((element) => {
      const animation = element.getAnimations()[0]
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    })
    const reversed = await morph()
    assert.equal(reversed.count, 1)
    await expect(draft).toHaveValue('Unsent conversation')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // MediaQueryList change is asynchronous; wait for cancellation, not just emulation setup.
    await expect
      .poll(() =>
        page
          .getByTestId('render-morph-surface')
          .evaluate((element) => element.getAnimations().length)
      )
      .toBe(0)
    assert.equal((await morph()).count, 0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByTestId('render-morph-drag').click()
    assert.equal(
      await page
        .getByTestId('render-morph-surface')
        .evaluate((element) => element.getAnimations().length),
      0
    )
  })
})

test('conversation entry fades at its final size without deforming its contents', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('render-morph-draft').fill('Keep minimized draft')
    for (const expectedWidth of [64, 300]) {
      const samples = await page.evaluate(async () => {
        const surface = document.querySelector<HTMLElement>('[data-testid="render-morph-surface"]')!
        const committed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect()
            resolve()
          })
          observer.observe(surface, { attributes: true, attributeFilter: ['style'] })
        })
        document.querySelector<HTMLButtonElement>('[data-testid="render-morph-entry"]')!.click()
        await committed
        const animation = surface.getAnimations()[0]
        animation.pause()
        const duration = Number(animation.effect!.getTiming().duration)
        return [0, 0.5, 1].map((progress) => {
          animation.currentTime = duration * progress
          return {
            width: surface.getBoundingClientRect().width,
            transform: getComputedStyle(surface).transform,
            opacity: Number(getComputedStyle(surface).opacity),
          }
        })
      })
      for (const sample of samples) {
        assert.equal(sample.width, expectedWidth)
        assert.equal(sample.transform, 'none')
      }
      assert.equal(samples[0].opacity, 0)
      assert.ok(samples[1].opacity > 0 && samples[1].opacity < 1)
      assert.equal(samples[2].opacity, 1)
      await expect(page.getByTestId('render-morph-draft')).toHaveValue('Keep minimized draft')
    }
  })
})

test('restored conversation keeps its fade when docking recalculates in either direction', async () => {
  await withFixture(async (page) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByTestId('render-morph-entry').click()
      const result = await page.evaluate(async () => {
        const surface = document.querySelector<HTMLElement>('[data-testid="render-morph-surface"]')!
        const change = async (testId: string) => {
          const committed = new Promise<void>((resolve) => {
            const observer = new MutationObserver(() => {
              observer.disconnect()
              resolve()
            })
            observer.observe(surface, { attributes: true, attributeFilter: ['style'] })
          })
          document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
          await committed
        }
        await change('render-morph-entry')
        const fade = surface.getAnimations()[0]
        fade.pause()
        fade.currentTime = Number(fade.effect!.getTiming().duration) / 2
        const before = surface.getBoundingClientRect().left
        await change('render-morph-position')
        return {
          sameAnimation: surface.getAnimations()[0] === fade,
          count: surface.getAnimations().length,
          transform: getComputedStyle(surface).transform,
          moved: surface.getBoundingClientRect().left !== before,
        }
      })
      assert.deepEqual(result, { sameAnimation: true, count: 1, transform: 'none', moved: true })
    }
  })
})

test('releasing a drag still animates back to the same dock without a layout revision', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('render-morph-drag').click()
    const result = await page.evaluate(async () => {
      const surface = document.querySelector<HTMLElement>('[data-testid="render-morph-surface"]')!
      const committed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect()
          resolve()
        })
        observer.observe(surface, { attributes: true, attributeFilter: ['style'] })
      })
      document.querySelector<HTMLButtonElement>('[data-testid="render-morph-drop"]')!.click()
      await committed
      const animation = surface.getAnimations()[0]
      animation.pause()
      animation.currentTime = 0
      return {
        count: surface.getAnimations().length,
        transform: getComputedStyle(surface).transform,
      }
    })
    assert.equal(result.count, 1)
    assert.notEqual(result.transform, 'none')
  })
})

test('percentage split preserves half width with pixel minimum bounds', async () => {
  await withFixture(async (page) => {
    const split = page.getByTestId('render-resizable-mixed-units')
    const right = page.getByTestId('render-resizable-mixed-right').locator('..')
    assert.equal(
      await split.evaluate((element) =>
        element.style.getPropertyValue('--vds-resizable-right-width')
      ),
      '50%'
    )
    assert.equal(await right.evaluate((element) => getComputedStyle(element).width), '450px')
  })
})

test('pixel conversation width survives host growth and controlled project restoration', async () => {
  await withFixture(async (page) => {
    const split = page.getByTestId('render-conversation-split')
    const conversation = split.locator(':scope > .vds-resizable-split__panel--left')
    const documents = split.locator(':scope > .vds-resizable-split__panel--right')
    await expect(conversation).toHaveCSS('width', '360px')
    const before = await documents.boundingBox()
    await page.getByTestId('render-conversation-grow').click()
    await expect(conversation).toHaveCSS('width', '360px')
    const after = await documents.boundingBox()
    assert.equal(after!.width - before!.width, 300)
    await page.getByTestId('render-conversation-restore').click()
    await expect(conversation).toHaveCSS('width', '420px')
    await split
      .getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
      .scrollIntoViewIfNeeded()
    const handle = await split
      .getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
      .boundingBox()
    assert.ok(handle)
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2)
    await page.mouse.up()
    await expect(conversation).toHaveCSS('width', '460px')
  })
})

test('scroll viewport explicit height wins over inherited height in generated CSS', async () => {
  const VIEWPORT_HEIGHT = 40
  const ROOT_MAX_HEIGHT = 80
  await withFixture(async (page) => {
    const viewport = page.getByTestId('render-scroll-area-viewport')
    const dimensions = await viewport.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
      maximum: getComputedStyle(element).maxHeight,
      minimum: getComputedStyle(element).minHeight,
      rootMaximum: getComputedStyle(element.parentElement!).maxHeight,
    }))
    assert.equal(dimensions.maximum, `${VIEWPORT_HEIGHT}px`)
    assert.equal(dimensions.minimum, '0px')
    assert.equal(dimensions.rootMaximum, `${ROOT_MAX_HEIGHT}px`)
    assert.equal(dimensions.height, VIEWPORT_HEIGHT)
    assert.ok(dimensions.content > dimensions.height)
    await viewport.focus()
    await viewport.press('End')
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  })
})

async function withToastFixture(run: (page: Page) => Promise<void>): Promise<void> {
  await withFixture(async (page) => {
    await expect(page.getByRole('button', { name: '显示错误', exact: true })).toBeVisible()
    const now = new Date('2026-09-24T00:00:00Z')
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    await run(page)
  }, '/components/toast.render.fixture.html')
}

test('toast lifecycle closes transient errors after six seconds and supports manual dismissal', async () => {
  await withToastFixture(async (page) => {
    await page.getByRole('button', { name: '显示错误', exact: true }).click()
    await page.clock.runFor(5999)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.clock.runFor(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '显示错误', exact: true }).click()
    await page.getByRole('alert').getByRole('button', { name: '关闭通知' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test('toast lifecycle pauses on hover and resumes only the remaining time', async () => {
  await withToastFixture(async (page) => {
    await page.getByRole('button', { name: '显示错误', exact: true }).click()
    await page.clock.runFor(2000)
    await page.getByRole('alert').hover()
    await page.clock.runFor(10000)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.mouse.move(0, 0)
    await page.clock.runFor(3999)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.clock.runFor(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test('toast lifecycle deduplicates repeated errors and restarts their countdown', async () => {
  await withToastFixture(async (page) => {
    const trigger = page.getByRole('button', { name: '显示错误', exact: true })
    await trigger.click()
    const originalId = await page.getByTestId('toast-returned-id').textContent()
    await page.clock.runFor(4000)
    await trigger.click()
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(page.getByTestId('toast-returned-id')).toHaveText(originalId!)
    await page.clock.runFor(5999)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.clock.runFor(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '连续重复' }).click()
    await expect(page.getByRole('alert')).toHaveCount(1)
    await page.getByRole('button', { name: '富文本错误' }).click()
    await page.getByRole('button', { name: '富文本错误' }).click()
    await expect(page.getByRole('alert')).toHaveCount(2)
  })
})

test('toast lifecycle does not restart other messages when the queue changes', async () => {
  await withToastFixture(async (page) => {
    await page.getByRole('button', { name: '显示错误', exact: true }).click()
    await page.clock.runFor(2000)
    await page.getByRole('button', { name: '其他错误' }).click()
    await page.clock.runFor(2000)
    await page.getByRole('button', { name: '无关更新' }).click()
    await page.clock.runFor(2000)
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveText('另一错误')
    await page.clock.runFor(2000)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test('toast lifecycle updates explicit ids in place and resets paused messages without losing focus', async () => {
  await withToastFixture(async (page) => {
    await page.getByRole('button', { name: '带操作的错误' }).click()
    await page.clock.runFor(2000)
    const action = page.getByRole('button', { name: '更新详情' })
    await action.hover()
    await action.click()
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(page.getByRole('alert')).toContainText('失败详情 2')
    await expect(action).toBeFocused()
    await page.clock.runFor(10000)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.mouse.move(0, 0)
    await page.getByRole('button', { name: '无关更新' }).focus()
    await page.clock.runFor(5999)
    await expect(page.getByRole('alert')).toBeVisible()
    await page.clock.runFor(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test('toast lifecycle keeps explicit action notifications until manual dismissal', async () => {
  await withToastFixture(async (page) => {
    await page.getByRole('button', { name: '常驻通知' }).click()
    await page.clock.runFor(12000)
    const notification = page.getByRole('region').getByRole('status')
    await expect(notification).toContainText('需要确认')
    await notification.getByRole('button', { name: '关闭通知' }).click()
    await expect(notification).toHaveCount(0)
  })
})

test('update application shell has no automatic announcement mount', async () => {
  const source = await readFile(path.join(ROOT_DIR, 'App.tsx'), 'utf8')
  assert.doesNotMatch(source, /<UpdateAnnouncement\b/)
})

test('update readiness never interrupts the focused settings control', async () => {
  await withFixture(async (page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const check = settings.getByRole('button', { name: 'Check for update' })
    await check.click()
    await page.evaluate(() => {
      ;(
        window as unknown as { updateFixture: { publish(next: Record<string, unknown>): void } }
      ).updateFixture.publish({ phase: 'ready' })
    })
    await expect(page.getByTestId('update-entry-ready')).toBeAttached()
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await expect(settings).toBeVisible()
    await expect(check).toBeFocused()
  }, '/components/update.render.fixture.html')
})

test('update available stays quiet and explicit entry reading acknowledges the unread candidate', async () => {
  await withFixture(async (page) => {
    const unread = page.getByTestId('update-entry-unread')
    const panel = page.getByTestId('update-panel')
    const entry = page.getByTestId('activity-update')
    await expect(unread).toBeVisible()
    await expect(panel).toHaveCount(0)
    await page.mouse.click(900, 200)
    await expect(panel).toHaveCount(0)
    await expect(unread).toBeVisible()
    await page.mouse.click(900, 200)
    await expect(unread).toBeVisible()
    await entry.click()
    await expect(panel).toBeInViewport({ ratio: 1 })
    await expect(panel).toHaveAttribute('data-presentation', 'popover')
    await expect(panel).toHaveCSS('width', '360px')
    await expect(panel.getByTestId('update-panel-title')).toHaveText('发现新版本')
    await expect(panel.getByTestId('update-panel-list').locator(':scope > span')).toHaveCount(3)
    await expect(panel.getByTestId('update-panel-list').locator(':scope > span').first()).toHaveCSS(
      'font-size',
      '14px'
    )
    await expect(page.getByRole('dialog', { name: '更新内容' })).toHaveCount(0)
    await expect(unread).toHaveCount(0)
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(panel).toHaveCount(0)
  }, '/components/update.render.fixture.html')
})

test('update ready entry opens only on request and Escape preserves installation', async () => {
  await withFixture(async (page) => {
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await page.getByRole('button', { name: 'Ready', exact: true }).click()
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await page.getByTestId('activity-update').click()
    await expect(page.getByTestId('update-panel')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await expect(page.getByTestId('update-entry-ready')).toBeVisible()
    await expect(page.getByTestId('update-actions')).toBeEmpty()
  }, '/components/update.render.fixture.html')
})

test('update entry renders unread, download, warning and restart indicators without opening panels', async () => {
  await withFixture(async (page) => {
    const entry = page.getByTestId('activity-update')
    await expect(entry).toBeVisible()
    await expect(page.getByTestId('update-entry-unread')).toBeVisible()
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await entry.click()
    await expect(page.getByTestId('update-entry-unread')).toHaveCount(0)
    await expect(entry).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Downloading', exact: true }).click()
    await expect(entry).toHaveAttribute('aria-label', /40/)
    await expect(entry.locator('[role="progressbar"]')).toBeVisible()
    await expect(entry.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '40')
    await expect(page.getByTestId('update-entry-unread')).toHaveCount(0)
    await page.getByRole('button', { name: 'Failure', exact: true }).click()
    const warning = page.getByTestId('update-entry-warning')
    await expect(warning.locator('.icon-fill-status-warning')).toBeVisible()
    await expect(warning).toHaveCSS('top', '2px')
    await expect(warning).toHaveCSS('right', '2px')
    await expect(warning).toHaveCSS('width', '14px')
    await expect(warning).toHaveCSS('height', '14px')
    await expect(warning.locator('.icon-fill-status-warning')).toHaveCSS('font-size', '14px')
    await expect(warning.locator('.icon-fill-status-warning')).toHaveCSS('line-height', '14px')
    await expect(page.getByTestId('update-entry-ready')).toHaveCount(0)
    await entry.click()
    await expect(page.getByTestId('update-entry-warning')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Ready', exact: true }).click()
    const ready = page.getByTestId('update-entry-ready').locator('.icon-chart-up-circle')
    await expect(ready).toBeVisible()
    await expect(page.getByTestId('update-entry-ready')).toHaveCSS('top', '2px')
    await expect(page.getByTestId('update-entry-ready')).toHaveCSS('right', '2px')
    await expect(page.getByTestId('update-entry-ready')).toHaveCSS('width', '14px')
    await expect(page.getByTestId('update-entry-ready')).toHaveCSS('height', '14px')
    await expect(ready).toHaveCSS('font-size', '14px')
    await expect(ready).toHaveCSS('line-height', '14px')
    expect(
      await ready.evaluate((element) => getComputedStyle(element, '::before').content)
    ).not.toBe('none')
    await page.getByRole('button', { name: 'New build', exact: true }).click()
    await expect(page.getByTestId('update-entry-unread')).toBeVisible()
    await expect(page.getByTestId('update-entry-unread')).toHaveCSS('top', '4px')
    await expect(page.getByTestId('update-entry-unread')).toHaveCSS('right', '4px')
    await expect(page.getByRole('dialog', { name: '更新内容' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Ready', exact: true }).click()
    await expect(page.getByTestId('update-panel')).toHaveCount(0)
    await entry.click()
    await expect(page.getByTestId('update-entry-unread')).toHaveCount(0)
  }, '/components/update.render.fixture.html')
})

test('update consecutive builds keep the workspace focused without acknowledging unseen candidates', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByRole('button', { name: 'New build', exact: true })
    await trigger.focus()
    for (const build of ['2', '3', '4']) {
      for (const phase of ['available', 'downloading', 'preparing', 'ready']) {
        await page.evaluate(
          ({ phase, build }) => {
            return window.scholarseed.getUpdateState().then((state) => {
              ;(
                window as unknown as {
                  updateFixture: { publish(next: Record<string, unknown>): void }
                }
              ).updateFixture.publish({
                phase,
                candidate: { ...state.candidate, build_number: build },
              })
            })
          },
          { phase, build }
        )
        await expect(page.getByTestId('activity-update')).toBeVisible()
        if (phase === 'ready') await expect(page.getByTestId('update-entry-ready')).toBeVisible()
        await expect(page.getByTestId('update-panel')).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
    }
    expect(
      await page.evaluate(async () => (await window.scholarseed.getUpdateState()).announcedKey)
    ).toBeUndefined()
    await expect(page.getByTestId('update-actions')).toBeEmpty()
    await page.getByTestId('activity-update').click()
    await expect(page.getByTestId('update-panel')).toBeVisible()
    expect(
      await page.evaluate(async () => (await window.scholarseed.getUpdateState()).announcedKey)
    ).toBe('0.2.1-4')
  }, '/components/update.render.fixture.html')
})

test('update manual entry preserves release notes, download, failure and confirmed restart actions', async () => {
  await withFixture(async (page) => {
    const dialog = page.getByRole('dialog', { name: '更新内容' })
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('activity-update').click()
    const panel = page.getByTestId('update-panel')
    await panel.getByTestId('update-panel-more').click()
    await expect(panel).toHaveAttribute('data-view', 'notes')
    await expect(panel).toHaveCSS('width', '480px')
    await expect(panel.getByTestId('update-panel-list').locator(':scope > span')).toHaveCount(4)
    await expect(panel.getByTestId('update-panel-list').locator(':scope > span').first()).toHaveCSS(
      'font-size',
      '14px'
    )
    await panel.getByTestId('update-panel-action').click()
    await expect(page.getByTestId('update-actions')).toHaveText('download:render-update')
    await expect(panel.getByTestId('update-panel-action')).toBeDisabled()
    await expect(panel.getByTestId('update-panel-progress')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New build', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'Ready', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('activity-update').click()
    await expect(page.getByTestId('update-panel-action')).toHaveText('重启客户端')
    await page.evaluate(() => {
      ;(
        window as unknown as {
          updateFixture: { publish: (next: { phase: string; errorFallback?: string }) => void }
        }
      ).updateFixture.publish({ phase: 'ready', errorFallback: 'install_failed' })
    })
    await expect(page.getByTestId('update-panel-error')).toBeVisible()
    await expect(page.getByTestId('update-panel-retry-hint')).toBeVisible()
    await page.getByTestId('update-panel-action').click()
    await expect(page.getByTestId('update-actions')).toHaveText('download:render-update')
    await expect(page.getByTestId('update-restart-confirmation')).toContainText('中断所有项目')
    await expect(page.getByTestId('update-restart-cancel')).toBeFocused()
    await page.getByTestId('update-restart-cancel').click()
    await expect(page.getByTestId('update-actions')).toHaveText('download:render-update')
    await page.getByTestId('update-panel-action').click()
    await page.getByTestId('update-restart-confirm').click()
    await expect(page.getByTestId('update-actions')).toHaveText('download:render-update,install')
    expect(
      await page.evaluate(async () => (await window.scholarseed.getUpdateState()).announcedKey)
    ).toBeDefined()
    await expect(page.getByTestId('update-overlay')).toBeVisible()
  }, '/components/update.render.fixture.html')
})

test('update background preparation stays quiet and the manual panel shows indeterminate work', async () => {
  await withFixture(async (page) => {
    const dialog = page.getByRole('dialog', { name: '更新内容' })
    const publish = async (phase: string) =>
      page.evaluate((phase) => {
        ;(
          window as unknown as { updateFixture: { publish: (next: { phase: string }) => void } }
        ).updateFixture.publish({ phase })
      }, phase)
    await publish('preparing')
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('activity-update').click()
    await expect(page.getByTestId('update-panel-hint')).toBeVisible()
    await expect(page.getByTestId('update-panel-progress')).not.toHaveAttribute('aria-valuenow')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New build', exact: true }).click()
    await publish('ready')
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('activity-update').click()
    for (const phase of ['preparing', 'verifying']) {
      await publish(phase)
      await expect(page.getByTestId('update-panel-progress')).not.toHaveAttribute('aria-valuenow')
      await expect(page.getByTestId('update-panel-action')).toBeDisabled()
    }
  }, '/components/update.render.fixture.html')
})

test('update popover restart confirmation survives real pointer clicks on portalled buttons', async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      ;(
        window as unknown as { updateFixture: { publish(next: Record<string, unknown>): void } }
      ).updateFixture.publish({ phase: 'ready', announcedKey: '0.2.1-1' })
    })
    await page.getByTestId('activity-update').click()
    const panel = page.getByTestId('update-panel')
    await panel.getByTestId('update-panel-action').click()
    await page.getByTestId('update-restart-cancel').click()
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('update-actions')).toHaveText('')
    await panel.getByTestId('update-panel-action').click()
    await page.getByTestId('update-restart-confirm').dblclick()
    await expect(page.getByTestId('update-actions')).toHaveText('install')
  }, '/components/update.render.fixture.html')
})

test('restart confirmation follows language, rejects stale releases and submits only once', async () => {
  await withFixture(async (page) => {
    const publish = async (next: Record<string, unknown>) =>
      page.evaluate((value) => {
        ;(
          window as unknown as { updateFixture: { publish(next: Record<string, unknown>): void } }
        ).updateFixture.publish(value)
      }, next)
    const action = page.getByTestId('update-panel-action')
    await publish({ phase: 'ready' })
    await page.getByTestId('activity-update').click()
    await action.click()
    const confirmation = page.getByTestId('update-restart-confirmation')
    await expect(confirmation).toContainText('重启后可点击「继续」或发送新消息接着处理')
    await expect(confirmation).not.toContainText('确认中断后发送新消息')
    await page.evaluate(() => {
      ;(
        window as unknown as { updateFixture: { language(language: string): void } }
      ).updateFixture.language('en')
    })
    await expect(confirmation).toContainText('click Continue or send a new message')
    await expect(confirmation).not.toContainText('acknowledge the interruption')
    await page.setViewportSize({ width: 480, height: 720 })
    await expect(page.getByTestId('update-restart-cancel')).toBeInViewport()
    await expect(page.getByTestId('update-restart-confirm')).toBeInViewport()
    await publish({ phase: 'available' })
    await expect(page.getByTestId('update-restart-confirm')).toBeDisabled()
    await expect(confirmation).toContainText('The update state has changed')
    await page.getByTestId('update-restart-cancel').click()
    await expect(page.getByTestId('update-actions')).toHaveText('')
    await publish({ phase: 'ready' })
    await page.getByTestId('activity-update').click()
    await action.click()
    await page.getByTestId('update-restart-confirm').evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(page.getByTestId('update-actions')).toHaveText('install')
  }, '/components/update.render.fixture.html')
})

test('toasts center on the application viewport outside transformed panels', async () => {
  await withFixture(async (page) => {
    const toaster = page.getByTestId('render-toaster-position')
    await expect(toaster).toHaveCSS('position', 'fixed')
    for (const width of [1280, 720]) {
      await page.setViewportSize({ width, height: 800 })
      expect(
        await toaster.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2)
        })
      ).toBeLessThan(1)
    }
  })
})

test('alert icons center with single-line descriptions and top-align with multiline content', async () => {
  await withFixture(async (page) => {
    for (const mode of ['single', 'multiple']) {
      const geometry = await page.getByTestId(`render-alert-align-${mode}`).evaluate((element) => {
        const icon = element.querySelector('.vds-alert__icon')!.getBoundingClientRect()
        const content = element.querySelector('.vds-alert__content')!.getBoundingClientRect()
        const text = element.querySelector('.vds-alert__description')!.getBoundingClientRect()
        return {
          iconTop: icon.top,
          contentTop: content.top,
          iconCenter: icon.top + icon.height / 2,
          textCenter: text.top + text.height / 2,
        }
      })
      expect(
        Math.abs(
          mode === 'single'
            ? geometry.iconCenter - geometry.textCenter
            : geometry.iconTop - geometry.contentTop
        )
      ).toBeLessThan(0.5)
    }
  })
})

test('catalog icons load the bundled font and render glyphs without legacy CSS', async () => {
  await withFixture(async (page) => {
    const glyphs = await page.locator('.iconfont').evaluateAll(async (elements) => {
      await document.fonts.ready
      return elements.map((element) => ({
        glyph: element.getAttribute('data-icon-glyph'),
        content: getComputedStyle(element, '::before').content,
        family: getComputedStyle(element).fontFamily,
        loaded: document.fonts.check(`${getComputedStyle(element).fontSize} iconfont`),
        hidden: element.getAttribute('aria-hidden'),
        text: element.textContent,
      }))
    })
    assert.ok(glyphs.length > 0)
    for (const glyph of glyphs) {
      assert.ok(glyph.glyph)
      assert.equal(glyph.content, JSON.stringify(glyph.glyph))
      assert.equal(glyph.family, 'iconfont')
      assert.equal(glyph.loaded, true)
      assert.equal(glyph.hidden, 'true')
      assert.equal(glyph.text, '')
    }
  })
})

test('compact empty state uses small centered geometry without changing the default variant', async () => {
  await withFixture(async (page) => {
    const compact = page.getByTestId('render-empty-compact')
    await expect(compact).toHaveCSS('row-gap', '16px')
    await expect(compact).toHaveCSS('justify-items', 'center')
    const icon = compact.locator('.vds-empty-state__icon')
    await expect(icon).toHaveCSS('width', '36px')
    await expect(icon).toHaveCSS('height', '36px')
    await expect(icon).toHaveCSS('border-radius', '8px')
    await expect(icon.locator('svg')).toHaveCSS('width', '16px')
    await expect(icon.locator('svg')).toHaveCSS('height', '16px')
    const glyph = page.getByTestId('render-empty-compact-font').locator('.iconfont')
    await expect(glyph).toHaveCSS('width', '16px')
    await expect(glyph).toHaveCSS('height', '16px')
    await expect(glyph).toHaveCSS('font-size', '16px')
    for (const selector of ['.vds-empty-state__title', '.vds-empty-state__description']) {
      const label = compact.locator(selector)
      await expect(label).toHaveCSS('font-size', '14px')
      await expect(label).toHaveCSS('font-weight', '400')
      expect(await label.evaluate((element) => getComputedStyle(element).color)).toBe(
        await icon.evaluate((element) => getComputedStyle(element).color)
      )
    }
    const standard = page.getByTestId('render-empty-state')
    await expect(standard.locator('.vds-empty-state__icon')).toHaveCSS('width', '48px')
    await expect(standard.locator('.vds-empty-state__title')).toHaveCSS('font-weight', '500')
    await page.setViewportSize({ width: 360, height: 720 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(icon).toHaveCSS('width', '36px')
    expect(
      await compact
        .locator('.vds-empty-state__title')
        .evaluate((element) => getComputedStyle(element).color)
    ).toBe(await icon.evaluate((element) => getComputedStyle(element).color))
  })
})

test('panel empty state uses a square icon and primary title without changing existing variants', async () => {
  await withFixture(async (page) => {
    const panel = page.getByTestId('render-empty-panel')
    const icon = panel.locator('.vds-empty-state__icon')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(icon).toHaveCSS('width', '36px')
      await expect(icon).toHaveCSS('height', '36px')
      await expect(icon).toHaveCSS('border-radius', '8px')
      await expect(icon.locator('svg')).toHaveCSS('width', '14px')
      await expect(panel).toHaveCSS('row-gap', '8px')
      await expect(panel.locator('.vds-empty-state__content')).toHaveCSS('row-gap', '8px')
      await expect(panel.locator('.vds-empty-state__title')).toHaveCSS('font-size', '14px')
      await expect(panel.locator('.vds-empty-state__title')).toHaveCSS('font-weight', '500')
      const colors = {
        primary: await page
          .getByTestId('render-empty-state')
          .locator('.vds-empty-state__title')
          .evaluate((element) => getComputedStyle(element).color),
        secondary: await icon.evaluate((element) => getComputedStyle(element).color),
      }
      await expect(panel.locator('.vds-empty-state__title')).toHaveCSS('color', colors.primary)
      await expect(panel.locator('.vds-empty-state__description')).toHaveCSS(
        'color',
        colors.secondary
      )
      await expect(
        page.getByTestId('render-empty-state').locator('.vds-empty-state__icon')
      ).toHaveCSS('width', '48px')
      await expect(page.getByTestId('render-empty-compact')).toHaveCSS('row-gap', '16px')
    }
  })
})

test('animated collapsible interpolates height, closes accessibly and reverses cleanly', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-motion-trigger')
    const content = page.getByTestId('render-motion-content')
    await trigger.scrollIntoViewIfNeeded()
    const sample = (opening: boolean) =>
      page.evaluate(
        async ({ opening, duration }) => {
          const content = document.querySelector<HTMLElement>(
            '[data-testid="render-motion-content"]'
          )!
          const trigger = document.querySelector<HTMLButtonElement>(
            '[data-testid="render-motion-trigger"]'
          )!
          const heights = [content.getBoundingClientRect().height]
          if ((trigger.getAttribute('aria-expanded') === 'true') !== opening) trigger.click()
          const started = performance.now()
          await new Promise<void>((resolve) => {
            const record = (): void => {
              heights.push(content.getBoundingClientRect().height)
              if (performance.now() - started < duration) requestAnimationFrame(record)
              else resolve()
            }
            requestAnimationFrame(record)
          })
          return heights
        },
        { opening, duration: MOTION_OBSERVATION_MS }
      )
    const opening = await sample(true)
    const fullHeight = opening.at(-1)!
    assert.ok(fullHeight > 0)
    assert.ok(opening.some((height) => height > 0 && height < fullHeight))
    await page.getByTestId('render-motion-action').focus()
    const closing = await sample(false)
    assert.equal(await content.getAttribute('inert'), '')
    assert.equal(await content.getAttribute('aria-hidden'), 'true')
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    assert.ok(closing.some((height) => height > 0 && height < fullHeight))
    assert.equal(closing.at(-1), 0)
    await trigger.click()
    await trigger.click()
    await trigger.click()
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLElement>('[data-testid="render-motion-content"]')!
          .getBoundingClientRect().height > 0
    )
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(await content.getAttribute('inert'), null)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(
      await content.evaluate((element) => getComputedStyle(element).transitionProperty),
      'none'
    )
    await trigger.press(' ')
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLElement>('[data-testid="render-motion-content"]')!
          .getBoundingClientRect().height === 0
    )
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  })
})

async function withFixture(
  run: (page: Page) => Promise<void>,
  fixtureUrl = FIXTURE_URL
): Promise<void> {
  const runtime = await sharedFixture()
  const context = await runtime.browser.newContext()
  let failed = false
  let failure: unknown

  try {
    const url = runtime.url
    assert.ok(url, 'Vite test server should expose a local URL')

    const page = await context.newPage()
    const startupErrors: string[] = []
    page.on('pageerror', (error) => startupErrors.push(`pageerror: ${error.message}`))
    page.on('requestfailed', (request) =>
      startupErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`)
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        startupErrors.push(`response: ${response.status()} ${response.url()}`)
    })
    try {
      await page.goto(new URL(`/src${fixtureUrl}`, url).toString())
      await run(page)
    } catch (error) {
      console.error('UI fixture failure evidence', {
        url: page.url(),
        startupErrors,
        body: (await page.locator('body').innerText()).slice(0, 2000),
      })
      throw error
    }
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await context.close()
    assert.equal(runtime.browser.contexts().includes(context), false)
  } catch (cleanup) {
    if (failed) throw new RenderFailure([failure, cleanup], 'UI case and context cleanup failed')
    throw cleanup
  }
  if (failed) throw failure
}

test('UI fixture isolates cookies, storage and globals and closes each context before exit', async (testContext) => {
  const runtime = await sharedFixture()
  const contexts: BrowserContext[] = []
  const diagnostic = await runtime.browser.newBrowserCDPSession()
  testContext.after(() => diagnostic.detach())
  const before = (await diagnostic.send('Target.getBrowserContexts')).browserContextIds
  for (const value of ['first', 'second']) {
    await withFixture(async (page) => {
      const context = page.context()
      contexts.push(context)
      const active = (await diagnostic.send('Target.getBrowserContexts')).browserContextIds
      assert.equal(active.filter((identity) => !before.includes(identity)).length, 1)
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), ISOLATION_KEYS.storage),
        null
      )
      assert.equal(
        await page.evaluate((key) => Reflect.has(window, key), ISOLATION_KEYS.global),
        false
      )
      assert.deepEqual(await context.cookies(), [])
      await page.evaluate(
        ({ keys, value }) => {
          localStorage.setItem(keys.storage, value)
          Reflect.set(window, keys.global, value)
        },
        { keys: ISOLATION_KEYS, value }
      )
      await context.addCookies([{ name: ISOLATION_KEYS.cookie, value, url: page.url() }])
    })
    assert.equal(runtime.browser.contexts().includes(contexts.at(-1)!), false)
    assert.deepEqual((await diagnostic.send('Target.getBrowserContexts')).browserContextIds, before)
  }
  assert.notEqual(contexts[0], contexts[1])
})

test('UI fixture preserves callback and initialization failures and reports context cleanup faults', async () => {
  const runtime = await sharedFixture()
  const primary = new Error('injected UI case failure')
  const cleanup = new Error('injected UI context cleanup failure')
  let callbackContext: BrowserContext | undefined
  await assert.rejects(
    withFixture(async (page) => {
      callbackContext = page.context()
      throw primary
    }),
    (error) => error === primary
  )
  assert.ok(callbackContext)
  assert.equal(runtime.browser.contexts().includes(callbackContext), false)

  const createContext = runtime.browser.newContext.bind(runtime.browser)
  for (const mode of ['normal', 'throw', 'noop']) {
    const failCleanup = mode !== 'normal'
    let context: BrowserContext | undefined
    let recover: (() => Promise<void>) | undefined
    runtime.browser.newContext = async () => {
      context = await createContext()
      recover = context.close.bind(context)
      context.newPage = async () => {
        throw primary
      }
      if (mode === 'throw')
        context.close = async () => {
          throw cleanup
        }
      if (mode === 'noop') context.close = async () => {}
      return context
    }
    try {
      await assert.rejects(
        withFixture(async () => assert.fail('page initialization should reject')),
        (error) => {
          if (!failCleanup) return error === primary
          assert.ok(error instanceof RenderFailure)
          assert.ok(error.errors.includes(primary))
          if (mode === 'throw') assert.ok(error.errors.includes(cleanup))
          else assert.ok(error.errors.some((item) => item instanceof assert.AssertionError))
          return true
        }
      )
      assert.ok(context)
      assert.equal(runtime.browser.contexts().includes(context), failCleanup)
    } finally {
      runtime.browser.newContext = createContext
      await recover?.()
    }
    assert.ok(context)
    assert.equal(runtime.browser.contexts().includes(context), false)
  }
})

test('annotation summary fits its content in a grid instead of stretching to the composer width', async () => {
  await withFixture(async (page) => {
    const workspace = page.getByTestId('render-annotation-workspace')
    const summary = page.getByTestId('answer-annotation-summary')
    await expect(summary).toBeVisible()
    const workspaceBox = await workspace.boundingBox()
    const summaryBox = await summary.boundingBox()
    assert.ok(workspaceBox && summaryBox)
    assert.ok(summaryBox.width < workspaceBox.width, 'annotation chip must not fill its grid track')
    await summary.getByRole('button', { name: '移除全部' }).click()
    await expect(summary).toHaveCount(0)
  })
})

test('sent and composer annotation chips keep the same opaque surface, border and radius', async () => {
  await withFixture(async (page) => {
    const composer = page.getByTestId('answer-annotation-summary')
    const sent = page.getByTestId('render-sent-annotation-summary')
    const workspace = page.getByTestId('render-annotation-workspace')
    const composerStyle = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.backgroundColor, style.backgroundImage, style.border, style.borderRadius]
    })
    const sentStyle = await sent.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.backgroundColor, style.backgroundImage, style.border, style.borderRadius]
    })
    assert.deepEqual(sentStyle, composerStyle)
    assert.equal(
      sentStyle[0],
      await workspace.evaluate((element) => getComputedStyle(element).backgroundColor)
    )
    assert.notEqual(sentStyle[1], 'none')
  })
})

test('annotation summary hover list supports editing and deleting individual annotations', async () => {
  await withFixture(async (page) => {
    const summary = page.getByTestId('answer-annotation-summary')
    await summary.getByRole('button', { name: '2 条注释' }).hover()
    const first = page.getByTestId('answer-annotation-details-first')
    const second = page.getByTestId('answer-annotation-details-second')
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await expect(second.getByRole('button', { name: '编辑注释 2' })).toBeVisible()
    await first.getByRole('button', { name: '编辑注释 1' }).click()
    await first.getByRole('textbox', { name: '编辑注释 1' }).fill('修改后的注释')
    await first.getByRole('button', { name: '保存', exact: true }).click()
    await expect(first).toContainText('修改后的注释')
    await first.getByRole('button', { name: '移除注释 1' }).click()
    await expect(first).toHaveCount(0)
    await expect(summary).toContainText('1 条注释')
    await summary.getByRole('button', { name: '1 条注释' }).hover()
    await expect(second).toBeVisible()
    await expect(second).toContainText('第二条注释')
    await second.getByRole('button', { name: '移除注释 1' }).click()
    await expect(summary).toHaveCount(0)
  })
})

test('icon-only copy buttons retain 24px targets, 14px glyphs and clipboard feedback', async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => window.localStorage.setItem('copied-text', text),
        },
      })
    })
    const button = page.getByTestId('render-copy-icon')
    const geometry = () =>
      button.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const iconBounds = element.querySelector('svg')!.getBoundingClientRect()
        return {
          width: bounds.width,
          height: bounds.height,
          padding: style.padding,
          iconWidth: iconBounds.width,
          iconHeight: iconBounds.height,
        }
      })
    const expectedGeometry = {
      width: 24,
      height: 24,
      padding: '0px',
      iconWidth: 14,
      iconHeight: 14,
    }
    assert.equal(await button.getAttribute('aria-label'), '复制')
    assert.deepEqual(await geometry(), expectedGeometry)
    await button.hover()
    assert.deepEqual(await geometry(), expectedGeometry)
    await button.focus()
    await page.keyboard.press('Enter')
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem('copied-text')),
      'icon-copy-value'
    )
    assert.equal(await button.getAttribute('data-copy-status'), 'success')
    await expect(button.locator('.lucide-check')).toBeVisible()
    assert.equal(await button.getAttribute('aria-label'), '已复制')
    assert.equal(await button.locator('[aria-live="polite"]').textContent(), '已复制')
    assert.deepEqual(await geometry(), expectedGeometry)
    await expect(button).toHaveAttribute('data-copy-status', 'idle')
    await expect(button.locator('.lucide-copy')).toBeVisible()
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('clipboard rejected')
          },
        },
      })
    })
    await button.click()
    assert.equal(await button.getAttribute('data-copy-status'), 'error')
    assert.equal(await button.getAttribute('aria-label'), '复制失败')
    assert.deepEqual(await geometry(), expectedGeometry)
  })
})

test('image spinners load their asset without rotating it or changing default spinners', async () => {
  await withFixture(async (page) => {
    const defaultSpinner = page.getByTestId('render-spinner-default')
    const imageSpinner = page.getByTestId('render-spinner-image')
    const image = imageSpinner.locator('img')
    await image.waitFor()
    await image.evaluate(async (element: HTMLImageElement) => element.decode())
    assert.equal(await image.evaluate((element: HTMLImageElement) => element.naturalWidth), 320)
    assert.equal(await image.getAttribute('alt'), '')
    assert.equal(await image.getAttribute('aria-hidden'), 'true')
    assert.equal(await imageSpinner.getAttribute('role'), 'status')
    assert.equal(
      await imageSpinner.getAttribute('aria-label'),
      await defaultSpinner.getAttribute('aria-label')
    )
    assert.equal(
      await imageSpinner.evaluate((element) => getComputedStyle(element).animationName),
      'none'
    )
    assert.equal(
      await imageSpinner.evaluate((element) => getComputedStyle(element).borderTopWidth),
      '0px'
    )
    assert.equal(await defaultSpinner.locator('img').count(), 0)
    assert.equal(
      await defaultSpinner.evaluate((element) => getComputedStyle(element).animationName),
      'vds-spin'
    )
    assert.equal(
      await imageSpinner.evaluate((element) => getComputedStyle(element).width),
      await defaultSpinner.evaluate((element) => getComputedStyle(element).width)
    )
    const imageButton = page.getByTestId('render-button-loading-image')
    const defaultButton = page.getByTestId('render-button-loading-default')
    assert.equal(await imageButton.isDisabled(), true)
    assert.equal(await imageButton.getAttribute('data-loading'), 'true')
    assert.equal(
      await imageButton.locator('img').getAttribute('src'),
      await image.getAttribute('src')
    )
    assert.equal(await defaultButton.isDisabled(), true)
    assert.equal(await defaultButton.locator('img').count(), 0)
  })
})

test('closed Sheet portals remove both content and overlay from the page', async () => {
  await withFixture(async (page) => {
    assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    assert.equal(await page.getByTestId('render-sheet-overlay').count(), 0)
    await page.getByTestId('render-sheet-open').click()
    const content = page.getByTestId('render-sheet-content')
    await expect(content).toBeVisible()
    await page.getByTestId('render-sheet-close').click()
    await expect(content).toHaveAttribute('data-state', 'closed')
    assert.equal(
      await content.evaluate((element) => getComputedStyle(element).animationName),
      'vds-sheet-out-right'
    )
    await content.waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    assert.equal(await page.getByTestId('render-sheet-overlay').count(), 0)
  })
})

test('Sheet trigger restores focus after a modal sheet closes', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-sheet-trigger')
    await trigger.click()
    const content = page.getByTestId('render-sheet-trigger-content')
    assert.equal(await content.evaluate((el) => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await content.waitFor({ state: 'detached' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
  })
})

test('Escape dismisses a child Sheet without closing its ancestor modal Sheet', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('render-sheet-trigger').click()
    await page.getByTestId('nested-sheet-trigger').click()
    await page.getByTestId('nested-sheet-close').focus()
    await page.keyboard.press('Escape')
    await page.getByTestId('nested-sheet-content').waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('render-sheet-trigger-content').isVisible(), true)
  })
})

test('DialogClose asChild preserves child classes and composes its click handler', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('render-dialog-open').click()
    const close = page.getByTestId('render-dialog-close-child')
    await assert.equal(
      await close.getAttribute('class').then((value) => value?.includes('absolute')),
      true
    )
    await assert.equal(
      await close.getAttribute('class').then((value) => value?.includes('right-3')),
      true
    )
    await close.click()
    await assert.equal(await page.getByTestId('render-dialog-content').count(), 0)
    await assert.equal(await page.getByTestId('render-dialog-child-clicks').textContent(), '1')
  })
})

test('assistant host constrains the transcript to its own scroll viewport', async () => {
  await withFixture(async (page) => {
    const source = await readFile(path.join(ROOT_DIR, 'features/assistant/AiPanel.tsx'), 'utf8')
    const hostClass = source.match(
      /className=\{\s*compact\s*\?\s*'hidden'\s*:\s*floatingContent\s*\?\s*'[^']+'\s*:\s*'([^']+)'\s*\}\s*id=\{contentId\}\s*data-testid="ai-stream"/
    )?.[1]
    assert.ok(hostClass)
    await page.locator('#root').evaluate((root, className) => {
      root.innerHTML = `<div style="height:300px;display:flex;flex-direction:column"><div class="${className}"><div class="conversation-stream" style="flex:1;min-height:0;overflow-y:auto"><div style="height:1200px">Long transcript</div></div></div></div>`
    }, hostClass)
    const dimensions = await page
      .locator('.conversation-stream')
      .evaluate((el) => ({ height: el.clientHeight, content: el.scrollHeight }))
    assert.ok(dimensions.height < 300, 'Stream must receive a bounded height from its flex host')
    assert.ok(dimensions.content > dimensions.height, 'Stream, not its host, owns scrolling')
    assert.equal(
      await page.locator('.vds-ai-stream').evaluate((el) => getComputedStyle(el).overflowY),
      'hidden'
    )
  })
})

test('nested activity disclosure follows its own state, not an expanded ancestor', async () => {
  const source = await readFile(path.join(ROOT_DIR, 'components/business/Execution.tsx'), 'utf8')
  const classes = Object.fromEntries(
    ['STEP', 'STEP_TRIGGER', 'STEP_CARET', 'STEP_CONTENT', 'CONTENT_INNER'].map((name) => {
      const value = source.match(new RegExp(`const TOOL_RUN_${name}_CLASS =\\s*'([^']+)'`))?.[1]
      assert.ok(value)
      return [name, value]
    })
  )
  await withFixture(async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('#root').evaluate((root, styles) => {
      root.innerHTML = `<div class="${styles.STEP} is-open"><div class="${styles.STEP}"><button class="${styles.STEP_TRIGGER}" aria-expanded="false"><span class="${styles.STEP_CARET}">›</span>Child</button><div data-testid="nested-content" class="${styles.STEP_CONTENT}" aria-hidden="true"><div class="${styles.CONTENT_INNER}">Input and output</div></div></div></div>`
    }, classes)
    const content = page.getByTestId('nested-content')
    const caret = page.getByRole('button', { name: 'Child' }).locator('span')
    await expect(content).toHaveCSS('opacity', '0')
    await expect(caret).toHaveCSS('rotate', 'none')
    assert.equal(await content.evaluate((element) => element.getBoundingClientRect().height), 0)
    await page.getByRole('button', { name: 'Child' }).evaluate((button) => {
      button.setAttribute('aria-expanded', 'true')
      button.nextElementSibling!.setAttribute('aria-hidden', 'false')
    })
    await expect(content).toHaveCSS('opacity', '1')
    await expect(caret).toHaveCSS('rotate', '90deg')
    assert.ok(await content.evaluate((element) => element.getBoundingClientRect().height > 0))
  })
})

test('subagent detail tokens preserve readable typography and wrap long commands in narrow panels', async () => {
  const source = await readFile(path.join(ROOT_DIR, 'components/business/Execution.tsx'), 'utf8')
  const stackClass = source.match(/const TOOL_RUN_IO_STACK_CLASS =\s*'([^']+)'/)?.[1]
  const labelClass = source.match(/const TOOL_RUN_IO_LABEL_CLASS =\s*'([^']+)'/)?.[1]
  assert.ok(stackClass && labelClass)
  const PANEL_WIDTH = 320
  const LONG_COMMAND = `/bin/zsh -lc 'cat /${'long-directory/'.repeat(40)}file.md'`
  await withFixture(async (page) => {
    await page.locator('#root').evaluate(
      (root, sample) => {
        root.innerHTML = `<div data-testid="detail-panel" style="width:${sample.width}px;font-size:20px"><div class="${sample.stackClass}" data-testid="detail-stack"><div class="${sample.labelClass}" data-testid="detail-label">执行命令</div><div class="font-[family-name:var(--vds-font-code)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-testid="detail-command"></div><div data-testid="detail-text">普通活动摘要</div></div></div>`
        root.querySelector('[data-testid="detail-command"]')!.textContent = sample.command
      },
      { stackClass, labelClass, width: PANEL_WIDTH, command: LONG_COMMAND }
    )
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((element, value) => {
        element.dataset.theme = value
      }, theme)
      const metrics = await page.getByTestId('detail-stack').evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          fontSize: style.fontSize,
          expectedSize: style.getPropertyValue('--vds-font-body-lv1').trim(),
          lineHeight: style.lineHeight,
          expectedHeight: style.getPropertyValue('--vds-lh-body-lv1').trim(),
          margin: parseFloat(style.marginLeft),
        }
      })
      assert.equal(metrics.fontSize, metrics.expectedSize)
      assert.equal(metrics.lineHeight, metrics.expectedHeight)
      assert.ok(metrics.margin > 0)
      await expect(page.getByTestId('detail-label')).toHaveCSS('font-size', metrics.fontSize)
      await expect(page.getByTestId('detail-text')).toHaveCSS('font-size', metrics.fontSize)
      await expect(page.getByTestId('detail-command')).toHaveCSS('font-size', metrics.fontSize)
      await expect(page.getByTestId('detail-command')).toHaveText(LONG_COMMAND)
      const font = await page
        .getByTestId('detail-command')
        .evaluate((element) => getComputedStyle(element).fontFamily)
      assert.match(font, /mono/i)
      const panel = await page.getByTestId('detail-panel').evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      assert.equal(panel.scrollWidth, panel.width)
    }
  })
})

test('question options select radio or checkbox by question type', async () => {
  const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
  const options = await readFile(path.join(ROOT_DIR, 'components/business/Options.tsx'), 'utf8')
  assert.match(options, /const Control = multiSelect \? Checkbox : Radio/)
  assert.match(options, /<Control[\s\S]*?data-testid=\{testId\}/)
  assert.match(stream, /<QuestionOption[\s\S]*?testId={`hil-question-option-/)
  assert.match(stream, /<QuestionOption[\s\S]*?multiSelect=\{q\.multiSelect\}/)
  assert.doesNotMatch(stream, /QUESTION_OPTION_MARK_CLASS/)
})

test('checkbox renders option content and keeps selection interactive', async () => {
  await withFixture(async (page) => {
    const checkbox = page.getByTestId('render-checkbox-content')
    await expect(checkbox).toContainText('选项标题选项描述')
    await checkbox.click()
    await expect(checkbox).toHaveAttribute('aria-checked', 'true')
  })
})

test('multiline question options align radio and checkbox with first text line', async () => {
  await withFixture(async (page) => {
    const options = page.getByTestId('render-question-options')
    await expect(options).toBeVisible()
    const geometry = await options
      .locator('[data-testid^="render-question-option-"]')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const indicator = button.querySelector('.vds-radio__dot, .vds-checkbox__box')!
          const icon = indicator.getBoundingClientRect()
          const labelElement = button.querySelector('.vds-radio__label, .vds-checkbox__box + span')!
          const label = labelElement.getBoundingClientRect()
          return {
            variant: button.getAttribute('data-testid'),
            iconCenter: icon.top + icon.height / 2,
            firstLineCenter: label.top + parseFloat(getComputedStyle(labelElement).lineHeight) / 2,
            marginTop: getComputedStyle(indicator).marginTop,
          }
        })
      )
    for (const option of geometry) {
      assert.equal(option.marginTop, '3px')
      assert.ok(Math.abs(option.iconCenter - option.firstLineCenter) < 1)
    }
  })
})

test('permission dock uses the full-access icon and text-only actions', async () => {
  const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
  const permissionDock = stream.slice(
    stream.indexOf("if (presentation === 'dock' && !isQuestion && !done)"),
    stream.indexOf("const scrollableQuestion = presentation === 'dock' && isQuestion && !done")
  )
  assert.match(permissionDock, /<IconFont[\s\S]*?type="icon-wanquanfangwen"/)
  assert.match(
    permissionDock,
    /<Button\s+variant="outline"\s+size="sm"[\s\S]*?data-hil-decision="deny"/
  )
  assert.match(permissionDock, /<Button\s+variant="primary"\s+size="sm"/)
  assert.doesNotMatch(permissionDock, /<kbd>/)
})

test('floating composer fills its available width while normal conversation stays capped', async () => {
  const composer = await readFile(path.join(ROOT_DIR, 'components/business/Composer.tsx'), 'utf8')
  const expression = composer.match(
    /const readingColumnClass = ([\s\S]*?)\nconst popoverClass/
  )?.[1]
  assert.ok(expression)
  const columnClass = new Function(
    `return (${expression.replace(/: boolean/g, '').replace(/\): string =>/, ') =>')})`
  )() as (home: boolean, inline: boolean) => string
  await withFixture(async (page) => {
    for (const width of [480, 900, 1440]) {
      for (const inline of [false, true]) {
        await page.locator('#root').evaluate(
          (root, layout) => {
            root.innerHTML = `<div data-testid="composer-width-host" style="width:${layout.width}px;padding-inline:var(--vds-conversation-scrollbar-width)"><div data-testid="composer-width-column" class="${layout.className}">Composer</div></div>`
          },
          { width, className: columnClass(false, inline) }
        )
        const geometry = await page.getByTestId('composer-width-host').evaluate((host) => {
          const column = host.querySelector<HTMLElement>('[data-testid="composer-width-column"]')!
          const bounds = host.getBoundingClientRect()
          const content = column.getBoundingClientRect()
          const padding = Number.parseFloat(getComputedStyle(host).paddingLeft)
          return {
            available: host.clientWidth - padding * 2,
            width: content.width,
            left: content.left - bounds.left,
            right: bounds.right - content.right,
            padding,
          }
        })
        assert.equal(
          geometry.width,
          inline ? geometry.available : Math.min(760, geometry.available)
        )
        assert.equal(geometry.left, geometry.right)
        if (inline) assert.equal(geometry.left, geometry.padding)
      }
    }
  })
})

test('conversation and controls share a centered capped column at every panel width', async () => {
  const PANEL_WIDTHS = [480, 760, 900, 1440]
  const CONTENT_WIDTH = 760
  const VIEWPORT_HEIGHT = 300
  const TRANSCRIPT_HEIGHTS = [100, 1200]
  const PIXEL_TOLERANCE = 1
  await withFixture(async (page) => {
    const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
    const columnClass = stream.match(/const READING_COLUMN_CLASS =\s*'([^']+)'/)?.[1]
    const streamClass = stream.match(/className=\{cx\(\s*'(conversation-stream[^']*)'/)?.[1]
    const controlsClass = stream.match(/className=\{cx\(\s*'(vds-ai-composer-host[^']*)'/)?.[1]
    assert.ok(columnClass && streamClass && controlsClass)
    for (const width of PANEL_WIDTHS) {
      for (const height of TRANSCRIPT_HEIGHTS) {
        await page.locator('#root').evaluate(
          (root, layout) => {
            root.innerHTML = `<div data-layout="panel" style="width:${layout.width}px"><div class="${layout.streamClass}" style="height:${layout.viewportHeight}px;overflow-y:auto;padding-inline:var(--vds-conversation-inline-gutter)"><div data-layout="transcript" class="${layout.columnClass}" style="height:${layout.height}px">Transcript</div></div><div class="${layout.controlsClass}"><div style="padding-inline:var(--vds-conversation-inline-gutter)"><div data-layout="composer" class="${layout.columnClass}">Composer</div></div></div></div>`
          },
          {
            width,
            height,
            viewportHeight: VIEWPORT_HEIGHT,
            columnClass,
            streamClass,
            controlsClass,
          }
        )
        const panel = await page.locator('[data-layout="panel"]').boundingBox()
        const transcript = await page.locator('[data-layout="transcript"]').boundingBox()
        const composer = await page.locator('[data-layout="composer"]').boundingBox()
        assert.ok(panel && transcript && composer)
        assert.ok(Math.abs(transcript.width - composer.width) < PIXEL_TOLERANCE)
        assert.ok(Math.abs(transcript.x - composer.x) < PIXEL_TOLERANCE)
        assert.ok(
          Math.abs(transcript.x + transcript.width / 2 - panel.x - panel.width / 2) <
            PIXEL_TOLERANCE
        )
        assert.ok(transcript.width <= CONTENT_WIDTH)
        if (width > CONTENT_WIDTH) assert.equal(transcript.width, CONTENT_WIDTH)
      }
    }
  })
})

test('answer selection comment fits the toolbar width in a narrow assistant', async () => {
  const TOOLBAR_WIDTH = 260
  await withFixture(async (page) => {
    const source = await readFile(path.join(ROOT_DIR, 'features/assistant/Annotations.tsx'), 'utf8')
    const draft = source.slice(source.indexOf("{draft.mode === 'actions'"))
    const commentClass = draft.match(/\) : \(\s*<div className="([^"]+)"/)?.[1]
    assert.ok(commentClass)
    await page.locator('#root').evaluate(
      (root, layout) => {
        root.innerHTML = `<div data-layout="anchor" style="width:${layout.width}px"><div data-layout="comment" class="${layout.commentClass}"><input style="min-width:0;width:100%" /></div></div>`
      },
      { width: TOOLBAR_WIDTH, commentClass }
    )
    const anchor = await page.locator('[data-layout="anchor"]').boundingBox()
    const comment = await page.locator('[data-layout="comment"]').boundingBox()
    assert.ok(anchor && comment)
    assert.ok(comment.x >= anchor.x && comment.x + comment.width <= anchor.x + anchor.width)
  })
})

test('split handle remains transparent when a host view supplies a background', async () => {
  await withFixture(async (page) => {
    const handle = page
      .getByTestId('render-resizable-right-split')
      .getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
    await handle.evaluate((element) => {
      element.style.background = 'rgb(250, 248, 244)'
    })
    assert.match((await handle.getAttribute('class')) ?? '', /!bg-transparent/)
    assert.equal(
      await handle.evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgba(0, 0, 0, 0)'
    )
  })
})

test('alert descriptions can show full instructions without changing default clamping', async () => {
  await withFixture(async (page) => {
    assert.equal(
      await page
        .getByTestId('render-alert-full')
        .evaluate((el) => getComputedStyle(el).webkitLineClamp),
      'none'
    )
    assert.equal(
      await page
        .getByTestId('render-alert-default')
        .evaluate((el) => getComputedStyle(el).webkitLineClamp),
      '2'
    )
  })
})

test('NavigationTabs preserves allocated widths while active labels use four pixels tighter padding', async () => {
  await withFixture(async (page) => {
    for (const fixture of ['render-navigation-tabs', 'render-navigation-tabs-scroll']) {
      const navigation = page.getByTestId(fixture)
      const geometry = () =>
        navigation.evaluate((element) =>
          Array.from(element.lastElementChild!.querySelectorAll('[role="tab"]')).map((tab) => {
            const label = tab.querySelector('[data-slot="ellipsis-text"]')!.getBoundingClientRect()
            const slot = tab.parentElement!.getBoundingClientRect()
            return { left: label.left + element.scrollLeft, top: label.top, width: slot.width }
          })
        )
      await navigation.scrollIntoViewIfNeeded()
      const before = await geometry()
      await navigation.getByRole('tab').nth(1).click()
      const after = await geometry()
      after.forEach((position, index) => {
        assert.ok(
          Math.abs(position.left - before[index].left) <= 4,
          `${fixture}: label ${index} moved`
        )
        assert.ok(Math.abs(position.top - before[index].top) < 1)
        assert.ok(Math.abs(position.width - before[index].width) < 1)
      })
    }
  })
})

test('NavigationTabs joins active curved feet to the bottom seam without clipping', async () => {
  await withFixture(async (page) => {
    const navigation = page.getByTestId('render-navigation-tabs')
    for (const name of ['总览', 'Beta.md']) {
      await navigation.getByRole('tab', { name }).click()
      const edges = await navigation.evaluate((element) => {
        const active = element.lastElementChild!.querySelector('[aria-selected="true"]')!
        const surface = active.querySelector('[data-slot="navigation-tab-surface"]')!
        const outline = surface.children[1].getBoundingClientRect()
        return {
          seam: element.getBoundingClientRect().bottom,
          outlineBottom: outline.bottom,
          feet: ['left', 'right'].map((side) =>
            active
              .querySelector(`[data-slot="navigation-tab-${side}-foot"]`)!
              .getBoundingClientRect()
              .toJSON()
          ),
        }
      })
      for (const foot of edges.feet) {
        assert.equal(foot.bottom, edges.seam)
        assert.equal(foot.top, edges.outlineBottom)
      }
    }
  })
})

test('NavigationTabs hover backgrounds leave four pixels on both sides of each separator', async () => {
  await withFixture(async (page) => {
    const tabs = page.getByTestId('render-navigation-tabs')
    const beta = tabs.getByRole('tab', { name: 'Beta.md' })
    await beta.hover()
    const distances = await tabs.evaluate((element) => {
      const [, alpha, beta, gamma] = element.lastElementChild!.querySelectorAll('[role="tab"]')
      const leftLine = alpha
        .querySelector('[data-slot="navigation-tab-divider"]')!
        .getBoundingClientRect()
      const rightLine = beta
        .querySelector('[data-slot="navigation-tab-divider"]')!
        .getBoundingClientRect()
      return {
        leftOfLine: leftLine.left - alpha.getBoundingClientRect().right,
        rightOfLine: beta.getBoundingClientRect().left - leftLine.right,
        hoverLeft: beta.getBoundingClientRect().left - leftLine.right,
        hoverRight: rightLine.left - beta.getBoundingClientRect().right,
        nextHoverLeft: gamma.getBoundingClientRect().left - rightLine.right,
      }
    })
    assert.deepEqual(distances, {
      leftOfLine: 4,
      rightOfLine: 4,
      hoverLeft: 4,
      hoverRight: 4,
      nextHoverLeft: 4,
    })
  })
})

test('NavigationTabs aligns curved active sides with the visual separator spacing', async () => {
  await withFixture(async (page) => {
    const tabs = page.getByTestId('render-navigation-tabs')
    await tabs.getByRole('tab', { name: 'Beta.md' }).click()
    for (const label of ['Alpha.md', 'Gamma.md']) {
      await tabs.getByRole('tab', { name: label }).hover()
      const distances = await tabs.evaluate((element) => {
        const [, alpha, beta, gamma] = element.lastElementChild!.querySelectorAll('[role="tab"]')
        const active = beta
          .querySelector('[data-slot="navigation-tab-surface"]')!
          .getBoundingClientRect()
        return {
          left: active.left - alpha.getBoundingClientRect().right,
          right: gamma.getBoundingClientRect().left - active.right,
        }
      })
      assert.deepEqual(distances, { left: 4, right: 4 })
    }
  })
})

test('NavigationTabs overview fills its allocated width in active and inactive states', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    const overview = navigationTabs.getByRole('tab', { name: '总览', exact: true })
    const assertFilledWidth = async (): Promise<void> => {
      const dimensions = await overview.evaluate((element) => ({
        tab: element.getBoundingClientRect().width,
        slot: element.parentElement!.getBoundingClientRect().width,
      }))
      assert.ok(dimensions.slot > 0)
      assert.equal(dimensions.tab, dimensions.slot)
    }
    await assertFilledWidth()
    await navigationTabs.getByRole('tab', { name: 'Beta.md' }).click()
    assert.equal(await overview.getAttribute('aria-selected'), 'false')
    await assertFilledWidth()
  })
})

test('NavigationTabs opens supplied context menu for the targeted document tab', async () => {
  await withFixture(async (page) => {
    await page.getByRole('tab', { name: 'Beta.md' }).click({ button: 'right' })
    await assert.equal(
      await page.getByTestId('render-navigation-context-tab').textContent(),
      'beta'
    )
    await assert.equal(await page.getByTestId('render-navigation-context-menu').isVisible(), true)
    await assert.equal(
      await page.getByTestId('render-navigation-context-menu').textContent(),
      'Beta.md'
    )
    await assert.equal(
      await page.getByRole('tab', { name: 'Alpha.md' }).getAttribute('aria-expanded'),
      null
    )
  })
})

test('NavigationTabs makes the draggable blank area interactive while a context menu is open', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await page.getByRole('tab', { name: 'Beta.md' }).click({ button: 'right' })
    await assert.equal(
      await navigationTabs.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region')
      ),
      'no-drag'
    )
    const navigationTabsBox = await navigationTabs.boundingBox()
    assert.ok(navigationTabsBox)
    await navigationTabs.click({
      position: { x: navigationTabsBox.width - 2, y: navigationTabsBox.height / 2 },
    })
    await assert.equal(await page.getByTestId('render-navigation-context-menu').count(), 0)
  })
})

test('NavigationTabs can represent a split pane without duplicating the overview tab', async () => {
  await withFixture(async (page) => {
    const splitTabs = page.getByTestId('render-navigation-tabs-without-overview')
    await assert.equal(await splitTabs.getByRole('tab', { name: '总览' }).count(), 0)
    await assert.equal(await splitTabs.getByRole('tab', { name: '右侧文件.md' }).count(), 1)
  })
})

test('EllipsisText shows tooltip only when the text is truncated', async () => {
  await withFixture(async (page) => {
    const shortText = page.getByTestId('render-ellipsis-short')
    await shortText.hover()
    await assert.equal(await page.getByRole('tooltip', { name: '短标题' }).count(), 0)

    const longText = page.getByTestId('render-ellipsis-long')
    await longText.hover()
    await page
      .getByRole('tooltip', { name: '这是一段一定会超过容器宽度并被省略的长标题' })
      .waitFor({ state: 'visible' })
    await assert.equal(
      await page
        .getByRole('tooltip', { name: '这是一段一定会超过容器宽度并被省略的长标题' })
        .isVisible(),
      true
    )
  })
})

test('EllipsisText caps long tooltip content and keeps it scrollable', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-ellipsis-scrollable')
    await trigger.hover()
    await expect(trigger).toHaveAttribute('aria-describedby', /.+/)
    const contentId = await trigger.getAttribute('aria-describedby')
    assert.ok(contentId)
    const tooltip = page.locator(`[id="${contentId}"]`)
    await tooltip.waitFor({ state: 'visible' })
    const metrics = await tooltip.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        clientHeight: element.clientHeight,
        maxHeight: style.maxHeight,
        tokenHeight: getComputedStyle(document.documentElement)
          .getPropertyValue('--vds-tooltip-max-height')
          .trim(),
        overflowY: style.overflowY,
        pointerEvents: style.pointerEvents,
        scrollHeight: element.scrollHeight,
        viewportHeight: window.innerHeight,
      }
    })
    await assert.equal(metrics.maxHeight, metrics.tokenHeight)
    await assert.equal(metrics.overflowY, 'auto')
    await assert.equal(metrics.pointerEvents, 'auto')
    await assert.ok(metrics.clientHeight <= Number.parseFloat(metrics.tokenHeight))
    await assert.ok(metrics.clientHeight <= metrics.viewportHeight * 0.8)
    await assert.ok(metrics.scrollHeight > metrics.clientHeight)

    await tooltip.hover()
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(100)
    await assert.ok(await tooltip.evaluate((element) => element.scrollTop > 0))
    await assert.equal(await tooltip.isVisible(), true)
  })
})

test('NavigationTabs widens default tabs and progressively compresses to icons with an overflow menu', async () => {
  await withFixture(async (page) => {
    const tabs = page.getByTestId('render-navigation-tabs')
    await tabs.getByRole('tab', { name: '总览', exact: true }).click()
    const widths = () =>
      tabs
        .getByRole('tab')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
    const initial = await widths()
    const alpha = tabs.getByRole('tab', { name: 'Alpha.md' })
    const beta = tabs.getByRole('tab', { name: 'Beta.md' })
    await expect(alpha.getByRole('button')).toBeVisible()
    await expect(beta.getByRole('button')).toBeVisible()
    assert.equal((await alpha.boundingBox())!.width, 285)
    await expect(tabs.locator('..').getByTestId('navigation-tabs-overflow')).toHaveCount(0)
    await alpha.click()
    await expect(alpha.getByRole('button')).toBeVisible()
    assert.deepEqual(await widths(), initial)
    const label = await alpha.locator('[data-slot="ellipsis-text"]').boundingBox()
    const close = await alpha.getByRole('button').boundingBox()
    assert.ok(label!.x + label!.width > close!.x)
    const activeBounds = (await alpha.boundingBox())!
    assert.equal(activeBounds.x + activeBounds.width - close!.x - close!.width, 3)
    await expect(alpha.locator('[data-slot="ellipsis-text"]')).toHaveCSS('text-overflow', 'clip')
    assert.match(
      await alpha
        .locator('[data-slot="ellipsis-text"]')
        .evaluate((element) => getComputedStyle(element).maskImage),
      /linear-gradient/
    )
    await tabs.evaluate((element) => {
      element.style.width = '480px'
    })
    await expect(beta.getByRole('button')).toHaveCount(0)
    await expect(tabs.locator('..').getByTestId('navigation-tabs-overflow')).toHaveCount(0)
    await beta.hover()
    await expect(beta.getByRole('button')).toHaveCount(0)
    await beta.click()
    await expect(alpha.getByRole('button')).toHaveCount(0)
    await expect(beta.getByRole('button')).toBeVisible()
    assert.ok((await beta.boundingBox())!.width < 285)
    await tabs.evaluate((element) => {
      element.style.width = '230px'
    })
    await expect(alpha.locator('[data-slot="ellipsis-text"]')).toBeVisible()
    await expect(beta.locator('[data-slot="ellipsis-text"]')).toBeVisible()
    await expect(beta.getByRole('button')).toBeVisible()
    await tabs.evaluate((element) => {
      element.style.width = '150px'
    })
    await expect(alpha.locator('[data-slot="ellipsis-text"]')).toBeHidden()
    assert.ok((await alpha.boundingBox())!.width >= 34)
    const menu = tabs.locator('..').getByTestId('navigation-tabs-overflow')
    await expect(menu).toBeVisible()
    await menu.click()
    await expect(page.getByRole('menuitem')).toHaveCount(3)
    await page.getByRole('menuitem', { name: 'Gamma.md', exact: true }).click()
    await expect(tabs.getByRole('tab', { name: 'Gamma.md' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await beta.click()
    await beta.getByRole('button').focus()
    await beta.getByRole('button').press('Enter')
    await expect(page.getByTestId('render-navigation-context-tab')).toHaveText('beta')
  })
})

test('NavigationTabs caps each document tab and truncates long labels', async () => {
  await withFixture(async (page) => {
    const longLabel = 'Multimodal Fusion and Vision-Language Models for Robot Learning.md'
    const longTab = page.getByTestId('render-navigation-tabs-long-label').getByRole('tab')
    const label = longTab.locator('[data-slot="ellipsis-text"]')
    await assert.ok(
      await longTab.evaluate((element) => element.getBoundingClientRect().width <= 285)
    )
    await assert.equal(
      await label.evaluate((element) => getComputedStyle(element).textOverflow),
      'ellipsis'
    )
    await longTab.hover()
    const tooltip = page.getByRole('tooltip', { name: longLabel })
    await tooltip.waitFor({ state: 'visible' })
    await assert.equal(await tooltip.isVisible(), true)
    const positions = await Promise.all([
      label.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { bottom: rect.bottom, left: rect.left }
      }),
      tooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top }
      }),
    ])
    await assert.ok(Math.abs(positions[1].left - positions[0].left) <= 1)
    await assert.ok(Math.abs(positions[1].top - positions[0].bottom - 10) <= 1)
  })
})

test('NavigationTabs marks only tabs with unsaved edits', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await assert.equal(
      await navigationTabs.getByRole('tab').locator('i[aria-label="未保存"]').count(),
      1
    )
    await assert.equal(
      await page.getByRole('tab', { name: 'Beta.md' }).locator('i[aria-label="未保存"]').count(),
      1
    )
    await assert.equal(
      await page.getByRole('tab', { name: 'Alpha.md' }).locator('i[aria-label="未保存"]').count(),
      0
    )
  })
})

test('NavigationTabs scrolls with the mouse wheel across tabs and their gaps', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    await navigationTabs.scrollIntoViewIfNeeded()
    const first = await navigationTabs.getByRole('tab').nth(0).boundingBox()
    const second = await navigationTabs.getByRole('tab').nth(1).boundingBox()
    const root = await navigationTabs.boundingBox()
    assert.ok(first && second && root)
    for (const delta of [
      { x: 0, y: 80 },
      { x: 80, y: 0 },
    ]) {
      for (const point of [
        { x: (first.x + first.width + second.x) / 2, y: second.y + second.height / 2 },
        { x: second.x + second.width / 2, y: second.y + second.height / 2 },
        { x: root.x + root.width / 2, y: root.y + 1 },
      ]) {
        await navigationTabs.evaluate((element) => {
          element.scrollLeft = 0
        })
        await page.mouse.move(point.x, point.y)
        await page.mouse.wheel(delta.x, delta.y)
        await expect
          .poll(() => navigationTabs.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0)
      }
    }
    assert.equal(
      await navigationTabs.getByRole('tab', { selected: true }).textContent(),
      'Document 1.md'
    )
  })
})

test('NavigationTabs reserves overflow gaps for scrolling rather than native window dragging', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    await navigationTabs.scrollIntoViewIfNeeded()
    assert.equal(
      await navigationTabs.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region')
      ),
      'no-drag'
    )
    assert.equal(
      await page
        .getByTestId('render-navigation-tabs')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
      'drag'
    )
  })
})

test('NavigationTabs preserves manual horizontal scrolling across parent rerenders', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    const rightmostScroll = await navigationTabs.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      return element.scrollLeft
    })
    assert.ok(rightmostScroll > 0)

    await page.getByTestId('render-navigation-tabs-rerender').click()
    await page.waitForTimeout(600)

    assert.equal(await navigationTabs.evaluate((element) => element.scrollLeft), rightmostScroll)
  })
})

test('NavigationTabs reveals a newly activated tab', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    assert.equal(await navigationTabs.evaluate((element) => element.scrollLeft), 0)

    await page.getByTestId('render-navigation-tabs-activate-last').click()
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="render-navigation-tabs-scroll"]'
      )
      return Boolean(element && element.scrollLeft > 0)
    })

    assert.ok(await navigationTabs.evaluate((element) => element.scrollLeft > 0))
    await expect
      .poll(async () => {
        const viewport = (await navigationTabs.boundingBox())!
        const foot = (await navigationTabs
          .getByRole('tab', { selected: true })
          .locator('[data-slot="navigation-tab-right-foot"]')
          .boundingBox())!
        return foot.x + foot.width - viewport.x - viewport.width
      })
      .toBeLessThanOrEqual(0.5)
  })
})

test('ui primitives render accessible DOM and dispatch user events', async () => {
  await withFixture(async (page) => {
    const button = page.getByTestId('render-button')
    await assert.equal(await button.getAttribute('type'), 'button')
    await assert.equal(await button.isDisabled(), false)
    await button.click()
    await assert.equal(await button.isDisabled(), true)
    await assert.equal(await page.getByTestId('render-button-clicks').textContent(), '1')

    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await assert.equal(
      await navigationTabs.locator('[data-slot="navigation-tab-divider"]').count(),
      2
    )
    await assert.equal(
      await page
        .getByRole('tab', { name: 'Beta.md' })
        .locator('[data-slot="navigation-tab-divider"]')
        .count(),
      1
    )
    await assert.equal(
      await page
        .getByRole('tab', { name: 'Gamma.md' })
        .locator('[data-slot="navigation-tab-divider"]')
        .count(),
      0
    )
    const card = page.getByTestId('render-card')
    await assert.equal(await card.evaluate((element) => element.tagName), 'DIV')
    await assert.equal(await card.textContent(), '原子卡片')
    const structuredCard = page.getByTestId('render-card-structure')
    await assert.equal(
      await structuredCard
        .getByRole('heading', { name: '研究项目' })
        .evaluate((element) => element.tagName),
      'H3'
    )
    await assert.equal(
      await page
        .getByTestId('render-card-header')
        .getByText('用于验证 Card 子组件语义。')
        .textContent(),
      '用于验证 Card 子组件语义。'
    )
    await assert.equal(await page.getByTestId('render-card-content').textContent(), '核心内容')
    await assert.equal(
      await page
        .getByTestId('render-card-footer')
        .getByRole('button', { name: '查看' })
        .textContent(),
      '查看'
    )

    const divider = page.getByTestId('render-divider')
    await assert.equal(await divider.evaluate((element) => element.tagName), 'HR')
    await assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(
      await page.getByTestId('render-separator').evaluate((element) => element.tagName),
      'HR'
    )
    await assert.equal(
      await page.getByTestId('render-separator').getAttribute('aria-orientation'),
      'horizontal'
    )
    await assert.equal(
      await page.getByTestId('render-divider-vertical').getAttribute('aria-orientation'),
      'vertical'
    )

    const input = page.getByTestId('render-input')
    const messageId = await input.getAttribute('aria-describedby')
    assert.ok(messageId, 'Input error should be linked by aria-describedby')
    await assert.equal(await input.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${messageId}"]`).textContent(), '请输入有效名称')
    await assert.equal(
      await input.getAttribute('data-i18n-placeholder'),
      'examples:input.placeholder'
    )
    await assert.equal(
      await input.locator('..').getByText('名称', { exact: true }).getAttribute('data-i18n-text'),
      'examples:input.label'
    )
    await assert.equal(
      await input
        .locator('..')
        .getByText('名称', { exact: true })
        .evaluate((element) => getComputedStyle(element).fontSize),
      '14px'
    )
    await assert.equal(
      await page.locator(`[id="${messageId}"]`).getAttribute('data-i18n-text'),
      'examples:input.error'
    )
    const helperInput = page.getByTestId('render-input-helper')
    const helperInputMessageId = await helperInput.getAttribute('aria-describedby')
    assert.ok(helperInputMessageId, 'Input helperText should be linked by aria-describedby')
    await assert.equal(await helperInput.getAttribute('aria-invalid'), null)
    await assert.equal(
      await page.locator(`[id="${helperInputMessageId}"]`).textContent(),
      '请输入项目公开名称。'
    )
    const invalidHelperInput = page.getByTestId('render-input-invalid-helper')
    const invalidHelperInputMessageId = await invalidHelperInput.getAttribute('aria-describedby')
    assert.ok(
      invalidHelperInputMessageId,
      'Input invalid helperText should be linked by aria-describedby'
    )
    await assert.equal(await invalidHelperInput.getAttribute('aria-invalid'), 'true')
    await assert.equal(
      await page.locator(`[id="${invalidHelperInputMessageId}"]`).textContent(),
      '名称将展示给团队成员。'
    )
    const errorPriorityInput = page.getByTestId('render-input-error-priority')
    const errorPriorityInputMessageId = await errorPriorityInput.getAttribute('aria-describedby')
    assert.ok(
      errorPriorityInputMessageId,
      'Input error should keep aria-describedby when helperText also exists'
    )
    await assert.equal(
      await page.locator(`[id="${errorPriorityInputMessageId}"]`).textContent(),
      '错误文案优先。'
    )
    await assert.equal(await page.getByText('辅助文案不应展示。').count(), 0)

    const textarea = page.getByTestId('render-textarea')
    const textareaMessageId = await textarea.getAttribute('aria-describedby')
    assert.ok(textareaMessageId, 'Textarea error should be linked by aria-describedby')
    await assert.equal(await textarea.getAttribute('aria-invalid'), 'true')
    await assert.equal(
      await page.locator(`[id="${textareaMessageId}"]`).textContent(),
      '请输入至少 10 个字'
    )
    const helperTextarea = page.getByTestId('render-textarea-helper')
    const helperTextareaMessageId = await helperTextarea.getAttribute('aria-describedby')
    assert.ok(helperTextareaMessageId, 'Textarea helperText should be linked by aria-describedby')
    await assert.equal(await helperTextarea.getAttribute('aria-invalid'), null)
    await assert.equal(
      await page.locator(`[id="${helperTextareaMessageId}"]`).textContent(),
      '支持 Markdown 简述。'
    )
    const invalidHelperTextarea = page.getByTestId('render-textarea-invalid-helper')
    const invalidHelperTextareaMessageId =
      await invalidHelperTextarea.getAttribute('aria-describedby')
    assert.ok(
      invalidHelperTextareaMessageId,
      'Textarea invalid helperText should be linked by aria-describedby'
    )
    await assert.equal(await invalidHelperTextarea.getAttribute('aria-invalid'), 'true')
    await assert.equal(
      await page.locator(`[id="${invalidHelperTextareaMessageId}"]`).textContent(),
      '说明暂不可为空。'
    )
    const errorPriorityTextarea = page.getByTestId('render-textarea-error-priority')
    const errorPriorityTextareaMessageId =
      await errorPriorityTextarea.getAttribute('aria-describedby')
    assert.ok(
      errorPriorityTextareaMessageId,
      'Textarea error should keep aria-describedby when helperText also exists'
    )
    await assert.equal(
      await page.locator(`[id="${errorPriorityTextareaMessageId}"]`).textContent(),
      '错误说明优先。'
    )
    await assert.equal(await page.getByText('辅助说明不应展示。').count(), 0)

    const switchControl = page.getByTestId('render-switch')
    await assert.equal(await switchControl.getAttribute('role'), 'switch')
    await assert.equal(await switchControl.getAttribute('aria-checked'), 'false')
    await switchControl.click()
    await assert.equal(await switchControl.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-switch-value').textContent(), 'on')

    const checkbox = page.getByTestId('render-checkbox')
    await assert.equal(await checkbox.getAttribute('role'), 'checkbox')
    await assert.equal(await checkbox.getAttribute('aria-checked'), 'false')
    await checkbox.getByText('同意条款').click()
    await assert.equal(await checkbox.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-checkbox-value').textContent(), 'yes')
    await assert.equal(
      await page.getByTestId('render-checkbox-mixed').getAttribute('aria-checked'),
      'mixed'
    )

    const radio = page.getByTestId('render-radio')
    await assert.equal(await radio.getAttribute('role'), 'radio')
    await assert.equal(await radio.getAttribute('aria-checked'), 'false')
    await radio.getByText('自动模式').click()
    await assert.equal(await radio.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-radio-value').textContent(), 'auto')

    const radioGroup = page.getByTestId('render-radio-group')
    await assert.equal(await radioGroup.getAttribute('role'), 'radiogroup')
    await assert.equal(await radioGroup.getAttribute('aria-orientation'), 'vertical')
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('aria-checked'),
      'true'
    )
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'),
      '0'
    )
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('tabindex'),
      '-1'
    )
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '禁用模式' }).getAttribute('tabindex'),
      null
    )
    await radioGroup.getByRole('radio', { name: '自动模式' }).click()
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'auto')
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('aria-checked'),
      'true'
    )
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'),
      '-1'
    )
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('tabindex'),
      '0'
    )
    await radioGroup.getByRole('radio', { name: '自动模式' }).focus()
    await radioGroup.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'manual')
    await assert.equal(
      await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'),
      '0'
    )
    await assert.equal(
      await radioGroup
        .getByRole('radio', { name: '手动模式' })
        .evaluate((element) => document.activeElement === element),
      true
    )
    await radioGroup.press('ArrowUp')
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'auto')
    await assert.equal(
      await radioGroup
        .getByRole('radio', { name: '自动模式' })
        .evaluate((element) => document.activeElement === element),
      true
    )

    const disabledRadioGroup = page.getByTestId('render-radio-group-disabled')
    await assert.equal(await disabledRadioGroup.getAttribute('aria-disabled'), 'true')
    await assert.equal(
      await disabledRadioGroup.getByRole('radio', { name: '极速模式' }).isDisabled(),
      true
    )
    await disabledRadioGroup.getByRole('radio', { name: '极速模式' }).click({ force: true })
    await assert.equal(
      await page.getByTestId('render-radio-group-disabled-value').textContent(),
      'safe'
    )

    const select = page.getByTestId('render-select')
    const selectMessageId = await select.getAttribute('aria-describedby')
    assert.ok(selectMessageId, 'Select error should be linked by aria-describedby')
    await assert.equal(await select.getAttribute('aria-invalid'), 'true')
    await select.selectOption('all')
    await assert.equal(await select.getAttribute('aria-invalid'), null)
    await assert.equal(await page.getByTestId('render-select-value').textContent(), 'all')

    const alert = page.getByTestId('render-alert')
    await assert.equal(await alert.getAttribute('role'), 'alert')
    await assert.equal(await alert.getByText('保存失败').textContent(), '保存失败')
    await assert.equal(
      await alert.getByText('请检查填写内容后重试。').textContent(),
      '请检查填写内容后重试。'
    )
    await assert.equal(
      await alert.getByText('保存失败').getAttribute('data-i18n-text'),
      'examples:alert.title'
    )
    await assert.equal(
      await alert.getByText('请检查填写内容后重试。').getAttribute('data-i18n-text'),
      'examples:alert.description'
    )

    const progress = page.getByTestId('render-progress')
    const progressTrack = progress.getByRole('progressbar')
    await assert.equal(await progressTrack.getAttribute('aria-valuemin'), '0')
    await assert.equal(await progressTrack.getAttribute('aria-valuemax'), '100')
    await assert.equal(await progressTrack.getAttribute('aria-valuenow'), '60')
    assert.ok(
      (await progress.getAttribute('style'))?.includes('color: rgb(1, 2, 3);'),
      'ProgressBar should keep caller styles on its root element'
    )
    await assert.equal(await progress.getByText('上传进度').textContent(), '上传进度')
    await assert.equal(
      await page
        .getByTestId('render-progress-indeterminate')
        .getByRole('progressbar')
        .getAttribute('aria-valuenow'),
      null
    )

    const avatar = page.getByTestId('render-avatar')
    await assert.equal(await avatar.locator('img').count(), 1)
    await avatar.locator('img').dispatchEvent('error')
    await assert.equal(await avatar.locator('img').count(), 0)
    await assert.equal(await avatar.getByText('书').textContent(), '书')

    const formControl = page.getByTestId('render-form-control')
    const formField = page.getByTestId('render-form-field')
    const formLabel = formField.locator('label')
    const description = formField.getByText('用于展示在项目列表中。')
    const message = formField.getByText('项目名称不能为空。')
    const controlId = await formControl.getAttribute('id')
    assert.ok(controlId, 'FormControl should receive a stable id')
    await assert.equal(await formLabel.getAttribute('for'), controlId)
    await assert.equal(
      await formControl.getAttribute('aria-describedby'),
      `${await description.getAttribute('id')} ${await message.getAttribute('id')}`
    )
    await assert.equal(await formControl.getAttribute('aria-invalid'), 'true')

    await assert.equal(
      await page.getByTestId('render-form-control-without-help').getAttribute('aria-describedby'),
      null
    )

    const emptyState = page.getByTestId('render-empty-state')
    await assert.equal(await emptyState.getByText('暂无项目').textContent(), '暂无项目')
    await assert.equal(await emptyState.getByText('当前没有项目。').textContent(), '当前没有项目。')
    await assert.equal(
      await emptyState.getByText('暂无项目').getAttribute('data-i18n-text'),
      'examples:empty.title'
    )
    await assert.equal(
      await emptyState.getByText('当前没有项目。').getAttribute('data-i18n-text'),
      'examples:empty.description'
    )
    await assert.equal(
      await emptyState.locator('.vds-empty-state__image').getAttribute('src'),
      '/assets/empty-test.webp'
    )
    await assert.equal(
      await emptyState.getByRole('button', { name: '创建项目' }).textContent(),
      '创建项目'
    )

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            const mode = window.localStorage.getItem('copy-mode')
            window.localStorage.setItem(
              'copy-attempts',
              String(Number(window.localStorage.getItem('copy-attempts') ?? '0') + 1)
            )
            window.localStorage.setItem('copied-text', text)
            if (mode === 'reject') {
              return Promise.reject(new Error('clipboard rejected'))
            }
            return Promise.resolve()
          },
        },
      })
    })
    const copyButton = page.getByTestId('render-copy-button')
    await assert.equal(await copyButton.getAttribute('aria-label'), '复制')
    await copyButton.click()
    await assert.equal(
      await page.evaluate(() => window.localStorage.getItem('copied-text')),
      'copy-value'
    )
    await assert.equal(await copyButton.getAttribute('aria-label'), '已复制')
    await assert.equal(await copyButton.getAttribute('data-copy-status'), 'success')
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="render-copy-button"]')?.getAttribute('aria-label') ===
        '复制'
    )
    await assert.equal(await copyButton.getAttribute('data-copy-status'), 'idle')

    await page.evaluate(() => {
      window.localStorage.setItem('copy-mode', 'reject')
    })
    const rejectedCopyButton = page.getByTestId('render-copy-reject')
    await rejectedCopyButton.click()
    await assert.equal(await rejectedCopyButton.getAttribute('aria-label'), '复制失败')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      })
      window.localStorage.setItem('copy-mode', 'resolve')
    })
    const missingClipboardButton = page.getByTestId('render-copy-missing')
    await missingClipboardButton.click()
    await assert.equal(await missingClipboardButton.getAttribute('aria-label'), '复制失败')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            window.localStorage.setItem(
              'copy-attempts',
              String(Number(window.localStorage.getItem('copy-attempts') ?? '0') + 1)
            )
            window.localStorage.setItem('copied-text', text)
            return Promise.resolve()
          },
        },
      })
      window.localStorage.setItem('copy-attempts', '0')
      window.localStorage.removeItem('copied-text')
    })
    const disabledCopyButton = page.getByTestId('render-copy-disabled')
    await assert.equal(await disabledCopyButton.isDisabled(), true)
    await disabledCopyButton.click({ force: true })
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copy-attempts')), '0')
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), null)

    const preventedCopyButton = page.getByTestId('render-copy-prevented')
    await preventedCopyButton.click()
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copy-attempts')), '0')
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), null)

    const loadingOverlay = page.getByTestId('render-loading-overlay')
    await assert.equal(await loadingOverlay.getAttribute('role'), 'status')
    await assert.equal(await loadingOverlay.getAttribute('aria-busy'), 'true')
    await assert.equal(await loadingOverlay.getByText('同步中').textContent(), '同步中')
    await assert.equal(await page.getByTestId('render-loading-hidden').count(), 0)

    const table = page.getByTestId('render-table')
    await assert.equal(await table.evaluate((element) => element.tagName), 'TABLE')
    await assert.equal(await table.locator('caption').textContent(), '项目列表')
    await assert.equal(await table.locator('th').first().getAttribute('scope'), 'col')
    await assert.equal(await table.getByText('DeepRD').textContent(), 'DeepRD')

    const pagination = page.getByTestId('render-pagination')
    await assert.equal(await pagination.getAttribute('aria-label'), '分页')
    await assert.equal(
      await pagination.getByRole('button', { name: '第 4 页' }).getAttribute('aria-current'),
      'page'
    )
    await pagination.getByRole('button', { name: '下一页' }).click()
    await assert.equal(await page.getByTestId('render-pagination-value').textContent(), '5')
    await assert.equal(
      await pagination.getByRole('button', { name: '第 5 页' }).getAttribute('aria-current'),
      'page'
    )

    const disabledPagination = page.getByTestId('render-pagination-disabled')
    await assert.equal(
      await disabledPagination.getByRole('button', { name: '上一页' }).isDisabled(),
      true
    )
    await assert.equal(
      await disabledPagination.getByRole('button', { name: '第 3 页' }).isDisabled(),
      true
    )
    await disabledPagination.getByRole('button', { name: '第 3 页' }).click({ force: true })
    await assert.equal(
      await page.getByTestId('render-pagination-disabled-value').textContent(),
      '2'
    )

    await assert.equal(
      await page
        .getByTestId('render-pagination-first')
        .getByRole('button', { name: '上一页' })
        .isDisabled(),
      true
    )
    await assert.equal(
      await page
        .getByTestId('render-pagination-last')
        .getByRole('button', { name: '下一页' })
        .isDisabled(),
      true
    )
    await assert.equal(
      await page
        .getByTestId('render-pagination-overflow')
        .getByRole('button', { name: '第 3 页' })
        .getAttribute('aria-current'),
      'page'
    )
    await assert.equal(
      await page
        .getByTestId('render-pagination-overflow')
        .getByRole('button', { name: '下一页' })
        .isDisabled(),
      true
    )
    await assert.equal(
      await page
        .getByTestId('render-pagination-underflow')
        .getByRole('button', { name: '第 1 页' })
        .getAttribute('aria-current'),
      'page'
    )
    await assert.equal(
      await page
        .getByTestId('render-pagination-underflow')
        .getByRole('button', { name: '上一页' })
        .isDisabled(),
      true
    )

    const aspectRatio = page.getByTestId('render-aspect-ratio')
    await assert.equal(
      await aspectRatio.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--vds-aspect-ratio').trim()
      ),
      '1.3333333333333333'
    )
    assert.ok(
      (await aspectRatio.getAttribute('style'))?.includes('color: rgb(4, 5, 6);'),
      'AspectRatio should keep caller styles on its root element'
    )
    await assert.equal(await page.getByTestId('render-aspect-content').textContent(), '比例内容')

    const breadcrumb = page.getByTestId('render-breadcrumb')
    await assert.equal(await breadcrumb.evaluate((element) => element.tagName), 'NAV')
    await assert.equal(await breadcrumb.getAttribute('aria-label'), '项目路径')
    await assert.equal(await breadcrumb.getByText('DeepRD').getAttribute('aria-current'), 'page')
    await assert.equal(await breadcrumb.getByLabel('更多路径').textContent(), '...')
    await assert.equal(await breadcrumb.locator('ol').count(), 1)
    await assert.equal(
      await page
        .getByTestId('render-breadcrumb-custom-ellipsis')
        .getByLabel('展开隐藏路径')
        .textContent(),
      '...'
    )

    const collapsibleTrigger = page.getByTestId('render-collapsible-trigger')
    const collapsibleContent = page.getByTestId('render-collapsible-content')
    const collapsibleContentId = await collapsibleContent.getAttribute('id')
    assert.ok(collapsibleContentId, 'Collapsible content should receive a stable id')
    await assert.equal(await collapsibleTrigger.getAttribute('aria-controls'), collapsibleContentId)
    await assert.equal(await collapsibleTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(await collapsibleContent.getAttribute('hidden'), '')
    await collapsibleTrigger.click()
    await assert.equal(await collapsibleTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await collapsibleContent.getAttribute('hidden'), null)

    const keyboardCollapsibleTrigger = page.getByTestId('render-collapsible-keyboard')
    await keyboardCollapsibleTrigger.focus()
    await keyboardCollapsibleTrigger.press('Enter')
    await assert.equal(
      await page.getByTestId('render-collapsible-controlled-value').textContent(),
      'open'
    )
    await keyboardCollapsibleTrigger.press(' ')
    await assert.equal(
      await page.getByTestId('render-collapsible-controlled-value').textContent(),
      'closed'
    )

    const disabledCollapsibleTrigger = page.getByTestId('render-collapsible-disabled-trigger')
    await assert.equal(await disabledCollapsibleTrigger.isDisabled(), true)
    await disabledCollapsibleTrigger.click({ force: true })
    await assert.equal(
      await page.getByTestId('render-collapsible-disabled-content').getAttribute('hidden'),
      ''
    )

    const tabs = page.getByTestId('render-tabs')
    const overviewTab = tabs.getByRole('tab', { name: '概览' })
    const tasksTab = tabs.getByRole('tab', { name: '任务' })
    const disabledTab = tabs.getByRole('tab', { name: '禁用' })
    const settingsTab = tabs.getByRole('tab', { name: '设置' })
    await assert.equal(
      await tabs.getByRole('tablist').getAttribute('aria-orientation'),
      'horizontal'
    )
    await assert.equal(await overviewTab.getAttribute('aria-selected'), 'true')
    await assert.equal(await overviewTab.getAttribute('tabindex'), '0')
    await assert.equal(await tasksTab.getAttribute('tabindex'), '-1')
    await assert.equal(await disabledTab.isDisabled(), true)
    await tasksTab.click()
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'tasks')
    await assert.equal(await tasksTab.getAttribute('aria-selected'), 'true')
    await assert.equal(await tabs.getByRole('tabpanel', { name: '任务' }).textContent(), '任务面板')
    await tasksTab.focus()
    await tabs.getByRole('tablist').press('ArrowRight')
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'settings')
    await assert.equal(
      await settingsTab.evaluate((element) => document.activeElement === element),
      true
    )
    await tabs.getByRole('tablist').press('ArrowLeft')
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'tasks')
    await assert.equal(
      await tasksTab.evaluate((element) => document.activeElement === element),
      true
    )

    const defaultTabs = page.getByTestId('render-tabs-default')
    await assert.equal(
      await defaultTabs.getByRole('tab', { name: '甲' }).getAttribute('aria-selected'),
      'true'
    )
    await assert.equal(
      await defaultTabs.getByRole('tab', { name: '甲' }).getAttribute('tabindex'),
      '0'
    )
    await assert.equal(
      await defaultTabs.getByRole('tab', { name: '乙' }).getAttribute('aria-selected'),
      'false'
    )
    await assert.equal(
      await defaultTabs.getByRole('tabpanel', { name: '甲' }).textContent(),
      '甲面板'
    )

    const invalidTabs = page.getByTestId('render-tabs-invalid')
    await assert.equal(
      await invalidTabs.getByRole('tab', { name: '有效' }).getAttribute('aria-selected'),
      'true'
    )
    await assert.equal(
      await invalidTabs.getByRole('tab', { name: '有效' }).getAttribute('tabindex'),
      '0'
    )
    await assert.equal(
      await invalidTabs.getByRole('tab', { name: '其他' }).getAttribute('aria-selected'),
      'false'
    )
    await assert.equal(
      await invalidTabs.getByRole('tabpanel', { name: '有效' }).textContent(),
      '有效面板'
    )

    const allDisabledTabs = page.getByTestId('render-tabs-all-disabled')
    await assert.equal(
      await allDisabledTabs.getByRole('tab', { name: '禁用一' }).isDisabled(),
      true
    )
    await assert.equal(
      await allDisabledTabs.getByRole('tab', { name: '禁用二' }).isDisabled(),
      true
    )
    await assert.equal(
      await allDisabledTabs.getByRole('tab', { name: '禁用一' }).getAttribute('aria-selected'),
      'false'
    )
    await assert.equal(
      await allDisabledTabs.getByRole('tab', { name: '禁用二' }).getAttribute('aria-selected'),
      'false'
    )
    await assert.equal(await allDisabledTabs.getByText('禁用一面板').getAttribute('hidden'), '')
    await assert.equal(await allDisabledTabs.getByText('禁用二面板').getAttribute('hidden'), '')

    const accordion = page.getByTestId('render-accordion')
    const summaryTrigger = accordion.getByRole('button', { name: '摘要' })
    const detailTrigger = accordion.getByRole('button', { name: '详情' })
    const disabledAccordionTrigger = accordion.getByRole('button', { name: '禁用项' })
    await assert.equal(await summaryTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await accordion.getByText('摘要内容').getAttribute('hidden'), null)
    await detailTrigger.click()
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), 'detail')
    await assert.equal(await summaryTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(await detailTrigger.getAttribute('aria-expanded'), 'true')
    await detailTrigger.focus()
    await accordion.press('ArrowUp')
    await assert.equal(
      await summaryTrigger.evaluate((element) => document.activeElement === element),
      true
    )
    await accordion.press('End')
    await assert.equal(
      await detailTrigger.evaluate((element) => document.activeElement === element),
      true
    )
    await accordion.press('Home')
    await assert.equal(
      await summaryTrigger.evaluate((element) => document.activeElement === element),
      true
    )
    await summaryTrigger.press(' ')
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), 'summary')
    await summaryTrigger.press(' ')
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), '')
    await assert.equal(await disabledAccordionTrigger.isDisabled(), true)
    await disabledAccordionTrigger.click({ force: true })
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), '')

    const multipleAccordion = page.getByTestId('render-accordion-multiple')
    const firstAccordionTrigger = multipleAccordion.getByRole('button', { name: '第一项' })
    const secondAccordionTrigger = multipleAccordion.getByRole('button', { name: '第二项' })
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await secondAccordionTrigger.click()
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await secondAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(
      await page.getByTestId('render-accordion-multiple-value').textContent(),
      'first,second'
    )
    await firstAccordionTrigger.click()
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(
      await page.getByTestId('render-accordion-multiple-value').textContent(),
      'second'
    )

    const keydownAccordion = page.getByTestId('render-accordion-keydown')
    const keydownFirst = keydownAccordion.getByRole('button', { name: '键盘一' })
    const keydownSecond = keydownAccordion.getByRole('button', { name: '键盘二' })
    await keydownFirst.focus()
    await keydownAccordion.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-accordion-keydown-events').textContent(), '1')
    await assert.equal(
      await keydownSecond.evaluate((element) => document.activeElement === element),
      true
    )

    const blockedKeydownAccordion = page.getByTestId('render-accordion-keydown-prevented')
    const blockedKeydownFirst = blockedKeydownAccordion.getByRole('button', { name: '阻止一' })
    const blockedKeydownSecond = blockedKeydownAccordion.getByRole('button', { name: '阻止二' })
    await blockedKeydownFirst.focus()
    await blockedKeydownAccordion.press('ArrowDown')
    await assert.equal(
      await page.getByTestId('render-accordion-keydown-prevented-events').textContent(),
      '1'
    )
    await assert.equal(
      await blockedKeydownFirst.evaluate((element) => document.activeElement === element),
      true
    )
    await assert.equal(
      await blockedKeydownSecond.evaluate((element) => document.activeElement === element),
      false
    )

    const scrollArea = page.getByTestId('render-scroll-area')
    await assert.equal(await scrollArea.getAttribute('data-orientation'), 'both')
    const scrollViewport = page.getByTestId('render-scroll-area-viewport')
    await assert.equal(await scrollViewport.getAttribute('role'), 'region')
    await assert.equal(await scrollViewport.getAttribute('aria-label'), '滚动视口')
    await assert.equal(await scrollViewport.getAttribute('tabindex'), '0')
    await scrollViewport.focus()
    await assert.equal(
      await scrollViewport.evaluate((element) => document.activeElement === element),
      true
    )
    await assert.equal(
      await scrollViewport.evaluate((element) => getComputedStyle(element).overflowX),
      'auto'
    )
    await assert.equal(
      await scrollViewport.evaluate((element) => getComputedStyle(element).overflowY),
      'auto'
    )

    const slider = page.getByTestId('render-slider')
    await assert.equal(await slider.getAttribute('role'), null)
    await assert.equal(await slider.getAttribute('aria-valuemin'), '0')
    await assert.equal(await slider.getAttribute('aria-valuemax'), '100')
    await assert.equal(await slider.getAttribute('aria-valuenow'), '20')
    await slider.focus()
    await slider.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '25')
    await slider.press('PageUp')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '75')
    await slider.press('End')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '100')
    await slider.press('Home')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '0')
    const uncontrolledSlider = page.getByTestId('render-slider-uncontrolled')
    await assert.equal(await uncontrolledSlider.inputValue(), '10')
    await uncontrolledSlider.press('ArrowRight')
    await assert.equal(await uncontrolledSlider.inputValue(), '15')
    await assert.equal(
      await page.getByTestId('render-slider-uncontrolled-changes').textContent(),
      '1'
    )
    const verticalSlider = page.getByTestId('render-slider-vertical')
    await assert.equal(await verticalSlider.getAttribute('aria-orientation'), 'vertical')
    await verticalSlider.focus()
    await verticalSlider.press('ArrowUp')
    await assert.equal(await verticalSlider.inputValue(), '60')
    await verticalSlider.press('ArrowLeft')
    await assert.equal(await verticalSlider.inputValue(), '70')
    const disabledSlider = page.getByTestId('render-slider-disabled')
    await assert.equal(await disabledSlider.isDisabled(), true)
    await disabledSlider.press('End')
    await assert.equal(await page.getByTestId('render-slider-disabled-value').textContent(), '30')

    const otp = page.getByTestId('render-input-otp')
    const otpGroup = otp.getByRole('group', { name: '验证码' })
    const otpFirst = otp.getByLabel('验证码 1')
    const otpSecond = otp.getByLabel('验证码 2')
    await assert.equal(await otpGroup.count(), 1)
    const otpDescriptionId = await otpFirst.getAttribute('aria-describedby')
    assert.ok(otpDescriptionId, 'InputOTP description should be linked by aria-describedby')
    await assert.equal(
      await page.locator(`[id="${otpDescriptionId}"]`).textContent(),
      '输入收到的 6 位验证码。'
    )
    await otpFirst.fill('1')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '1')
    await assert.equal(
      await otpSecond.evaluate((element) => document.activeElement === element),
      true
    )
    await otpSecond.fill('2')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '12')
    await otpSecond.press('Backspace')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '1')
    await assert.equal(
      await otpSecond.evaluate((element) => document.activeElement === element),
      true
    )
    await otpSecond.press('Backspace')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '')
    await assert.equal(
      await otpFirst.evaluate((element) => document.activeElement === element),
      true
    )
    await otpFirst.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', '987654')
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
    })
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '987654')
    await assert.equal(await page.getByTestId('render-input-otp-complete').textContent(), '987654')
    await assert.equal(
      await otp.getByLabel('验证码 6').evaluate((element) => document.activeElement === element),
      true
    )

    const textOtp = page.getByTestId('render-input-otp-text')
    await assert.equal(await textOtp.getByLabel('文本代码 1').inputValue(), 'A')
    await assert.equal(await textOtp.getByLabel('文本代码 2').inputValue(), 'Z')
    await textOtp.getByLabel('文本代码 3').fill('x')
    await assert.equal(await page.getByTestId('render-input-otp-text-value').textContent(), 'AZx')
    await assert.equal(await textOtp.locator('.vds-input-otp__separator').textContent(), '-')

    const compositionOtp = page.getByTestId('render-input-otp-composition')
    const compositionFirst = compositionOtp.getByLabel('组合输入 1')
    const compositionSecond = compositionOtp.getByLabel('组合输入 2')
    await compositionFirst.focus()
    await compositionFirst.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'n' }))
      ;(element as HTMLInputElement).value = 'n'
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'n' }))
    })
    await assert.equal(
      await page.getByTestId('render-input-otp-composition-value').textContent(),
      ''
    )
    await assert.equal(
      await page.getByTestId('render-input-otp-composition-changes').textContent(),
      '0'
    )
    await assert.equal(
      await compositionFirst.evaluate((element) => document.activeElement === element),
      true
    )
    await compositionFirst.evaluate((element) => {
      ;(element as HTMLInputElement).value = '你'
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }))
    })
    await assert.equal(
      await page.getByTestId('render-input-otp-composition-value').textContent(),
      '你'
    )
    await assert.equal(
      await page.getByTestId('render-input-otp-composition-changes').textContent(),
      '1'
    )
    await assert.equal(
      await compositionSecond.evaluate((element) => document.activeElement === element),
      true
    )

    const stableOtp = page.getByTestId('render-input-otp-stable')
    const stableFirst = stableOtp.getByLabel('稳定槽位 1')
    const stableSecond = stableOtp.getByLabel('稳定槽位 2')
    const stableThird = stableOtp.getByLabel('稳定槽位 3')
    const stableFourth = stableOtp.getByLabel('稳定槽位 4')
    await assert.equal(await stableFirst.inputValue(), '1')
    await assert.equal(await stableSecond.inputValue(), '2')
    await assert.equal(await stableThird.inputValue(), '3')
    await assert.equal(await stableFourth.inputValue(), '4')
    await stableSecond.press('Backspace')
    await assert.equal(await stableFirst.inputValue(), '1')
    await assert.equal(await stableSecond.inputValue(), '')
    await assert.equal(await stableThird.inputValue(), '3')
    await assert.equal(await stableFourth.inputValue(), '4')
    await assert.equal(await page.getByTestId('render-input-otp-stable-value').textContent(), '134')

    const controlledSlotsOtp = page.getByTestId('render-input-otp-controlled-slots')
    const controlledSlotsFirst = controlledSlotsOtp.getByLabel('受控槽位 1')
    const controlledSlotsSecond = controlledSlotsOtp.getByLabel('受控槽位 2')
    const controlledSlotsThird = controlledSlotsOtp.getByLabel('受控槽位 3')
    const controlledSlotsFourth = controlledSlotsOtp.getByLabel('受控槽位 4')
    await controlledSlotsSecond.press('Backspace')
    await assert.equal(await controlledSlotsFirst.inputValue(), '1')
    await assert.equal(await controlledSlotsSecond.inputValue(), '')
    await assert.equal(await controlledSlotsThird.inputValue(), '3')
    await assert.equal(await controlledSlotsFourth.inputValue(), '4')
    await assert.equal(
      await page.getByTestId('render-input-otp-controlled-slots-value').textContent(),
      '1_34'
    )

    const customSlot = page.getByTestId('render-input-otp-slot-class').getByLabel('自定义槽位 1')
    const customSlotClass = await customSlot.getAttribute('class')
    assert.ok(
      customSlotClass?.includes('vds-input-otp__slot'),
      'InputOTP should keep its base slot class'
    )
    assert.ok(
      customSlotClass?.includes('custom-otp-slot'),
      'InputOTP should merge slotProps.className'
    )

    const invalidOtp = page.getByTestId('render-input-otp-invalid')
    const invalidOtpFirst = invalidOtp.getByLabel('错误验证码 1')
    const invalidDescription = await invalidOtpFirst.getAttribute('aria-describedby')
    assert.ok(invalidDescription, 'InputOTP error should be linked by aria-describedby')
    await assert.equal(await invalidOtpFirst.getAttribute('aria-invalid'), 'true')
    await assert.equal(
      await page.locator(`[id="${invalidDescription}"]`).textContent(),
      '验证码错误。'
    )

    const disabledOtp = page.getByTestId('render-input-otp-disabled')
    const disabledOtpFirst = disabledOtp.getByLabel('禁用验证码 1')
    await assert.equal(await disabledOtp.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledOtpFirst.isDisabled(), true)
    await disabledOtpFirst.fill('9', { force: true })
    await assert.equal(
      await page.getByTestId('render-input-otp-disabled-value').textContent(),
      '12'
    )

    const command = page.getByTestId('render-command')
    const commandInput = page.getByTestId('render-command-input')
    const commandList = page.getByTestId('render-command-list')
    const openCommand = command.getByRole('option', { includeHidden: true, name: '打开项目' })
    const newCommand = command.getByRole('option', { name: '新建项目' })
    const listCommand = command.getByRole('option', { name: '切换列表' })
    const archiveCommand = command.getByRole('option', { name: '归档视图' })
    await assert.equal(await command.getAttribute('aria-disabled'), null)
    await assert.equal(await commandList.getAttribute('role'), 'listbox')
    await assert.equal(await openCommand.getAttribute('aria-selected'), 'true')
    await assert.equal(await archiveCommand.isDisabled(), true)
    await commandInput.fill('create')
    await assert.equal(await page.getByTestId('render-command-search').textContent(), 'create')
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="render-command"] [value="open"]')
        ?.hasAttribute('hidden')
    )
    await assert.equal(
      await openCommand.evaluate((element) => (element as HTMLButtonElement).hidden),
      true
    )
    await assert.equal(
      await newCommand.evaluate((element) => (element as HTMLButtonElement).hidden),
      false
    )
    await newCommand.click()
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'new')
    await assert.equal(await page.getByTestId('render-command-selects').textContent(), 'new')
    await commandInput.fill('zzz')
    await assert.equal(await command.getByText('没有匹配命令').textContent(), '没有匹配命令')
    await commandInput.fill('')
    await newCommand.focus()
    await commandList.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'list')
    await assert.equal(
      await listCommand.evaluate((element) => document.activeElement === element),
      true
    )
    await commandList.press('Home')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'open')
    await assert.equal(
      await openCommand.evaluate((element) => document.activeElement === element),
      true
    )
    await commandList.press('End')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'list')

    const defaultCommand = page.getByTestId('render-command-default')
    await assert.equal(
      await defaultCommand
        .getByRole('option', { name: '新建项目' })
        .evaluate((element) => (element as HTMLButtonElement).hidden),
      false
    )
    await assert.equal(
      await defaultCommand
        .getByRole('option', { includeHidden: true, name: '打开项目' })
        .evaluate((element) => (element as HTMLButtonElement).hidden),
      true
    )
    await assert.equal(
      await page.getByTestId('render-command-default-input').inputValue(),
      'create'
    )

    const disabledCommand = page.getByTestId('render-command-disabled')
    const disabledCommandInput = page.getByTestId('render-command-disabled-input')
    await assert.equal(await disabledCommand.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledCommandInput.isDisabled(), true)
    await disabledCommand.getByRole('option', { name: '其他' }).click({ force: true })
    await assert.equal(
      await page.getByTestId('render-command-disabled-value').textContent(),
      'locked'
    )

    const resizable = page.getByTestId('render-resizable')
    const resizableHandle = page.getByTestId('render-resizable-handle')
    await assert.equal(await resizable.getAttribute('data-direction'), 'horizontal')
    await assert.equal(await resizableHandle.getAttribute('role'), 'separator')
    await assert.equal(await resizableHandle.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await resizableHandle.getAttribute('aria-valuemin'), '20')
    await assert.equal(await resizableHandle.getAttribute('aria-valuemax'), '80')
    await assert.equal(Math.round(Number(await resizableHandle.getAttribute('aria-valuenow'))), 30)
    await resizableHandle.focus()
    await resizableHandle.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-resizable-sizes').textContent(), '35,65')
    await assert.equal(Math.round(Number(await resizableHandle.getAttribute('aria-valuenow'))), 35)
    await resizableHandle.press('Home')
    await assert.equal(await page.getByTestId('render-resizable-sizes').textContent(), '20,80')
    const handleBox = await resizableHandle.boundingBox()
    assert.ok(handleBox, 'Resizable handle should have a visible box')
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      handleBox.x + handleBox.width / 2 + 80,
      handleBox.y + handleBox.height / 2
    )
    await page.mouse.up()
    const draggedSizes = (await page.getByTestId('render-resizable-sizes').textContent()) ?? ''
    assert.notEqual(draggedSizes, '20,80')

    const defaultResizable = page.getByTestId('render-resizable-default')
    await assert.equal(
      await defaultResizable.getByLabel('默认左侧').getAttribute('data-panel-size'),
      '25'
    )
    await page.getByTestId('render-resizable-default-handle').press('ArrowRight')
    await assert.equal(
      await defaultResizable.getByLabel('默认左侧').getAttribute('data-panel-size'),
      '30'
    )

    const panelDefaultResizable = page.getByTestId('render-resizable-panel-default')
    await assert.equal(
      await panelDefaultResizable.getByLabel('面板默认左侧').getAttribute('data-panel-size'),
      '35'
    )
    await assert.equal(
      await panelDefaultResizable.getByLabel('面板默认右侧').getAttribute('data-panel-size'),
      '65'
    )

    const defaultClampedResizable = page.getByTestId('render-resizable-default-clamped')
    await assert.equal(
      Math.round(
        Number(
          await defaultClampedResizable.getByLabel('约束默认左侧').getAttribute('data-panel-size')
        )
      ),
      20
    )
    await assert.equal(
      Math.round(
        Number(
          await defaultClampedResizable.getByLabel('约束默认右侧').getAttribute('data-panel-size')
        )
      ),
      80
    )

    const controlledClampedResizable = page.getByTestId('render-resizable-controlled-clamped')
    const controlledClampedHandle = page.getByTestId('render-resizable-controlled-clamped-handle')
    await assert.equal(
      Math.round(
        Number(
          await controlledClampedResizable
            .getByLabel('受控约束左侧')
            .getAttribute('data-panel-size')
        )
      ),
      20
    )
    await assert.equal(
      Math.round(
        Number(
          await controlledClampedResizable
            .getByLabel('受控约束右侧')
            .getAttribute('data-panel-size')
        )
      ),
      80
    )
    await controlledClampedHandle.press('End')
    await assert.equal(
      await page.getByTestId('render-resizable-controlled-clamped-sizes').textContent(),
      '70,30'
    )
    await assert.equal(
      Math.round(Number(await controlledClampedHandle.getAttribute('aria-valuenow'))),
      70
    )

    const verticalResizable = page.getByTestId('render-resizable-vertical')
    const verticalHandle = page.getByTestId('render-resizable-vertical-handle')
    await assert.equal(await verticalResizable.getAttribute('data-direction'), 'vertical')
    await assert.equal(await verticalHandle.getAttribute('aria-orientation'), 'vertical')
    await verticalHandle.press('ArrowUp')
    await assert.equal(
      Math.round(
        Number(await verticalResizable.getByLabel('上方面板').getAttribute('data-panel-size'))
      ),
      55
    )

    const disabledResizable = page.getByTestId('render-resizable-disabled')
    const disabledResizableHandle = page.getByTestId('render-resizable-disabled-handle')
    await assert.equal(await disabledResizable.getAttribute('aria-disabled'), null)
    await assert.equal(await disabledResizableHandle.getAttribute('tabindex'), null)
    await disabledResizableHandle.press('ArrowRight')
    await assert.equal(
      await page.getByTestId('render-resizable-disabled-sizes').textContent(),
      '45,55'
    )

    const rightSplit = page.getByTestId('render-resizable-right-split')
    const rightSplitHandle = rightSplit.getByRole('button', {
      name: /^(Resize panels|调整面板大小)$/,
    })
    const rightSplitPanel = page.getByTestId('render-resizable-right-split-right').locator('..')
    await assert.equal(
      await rightSplitPanel.evaluate((element) => getComputedStyle(element).width),
      '403px'
    )
    await rightSplitHandle.scrollIntoViewIfNeeded()
    const rightSplitHandleBox = await rightSplitHandle.boundingBox()
    assert.ok(rightSplitHandleBox, 'Right split handle should have a visible box')
    await page.mouse.move(
      rightSplitHandleBox.x + rightSplitHandleBox.width / 2,
      rightSplitHandleBox.y + rightSplitHandleBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      rightSplitHandleBox.x + rightSplitHandleBox.width / 2 - 100,
      rightSplitHandleBox.y + rightSplitHandleBox.height / 2
    )
    await page.mouse.up()
    await assert.equal(
      await page.getByTestId('render-resizable-right-width').textContent(),
      '503px'
    )
    const expandedRightSplitHandleBox = await rightSplitHandle.boundingBox()
    assert.ok(expandedRightSplitHandleBox, 'Expanded right split handle should have a visible box')
    await page.mouse.move(
      expandedRightSplitHandleBox.x + expandedRightSplitHandleBox.width / 2,
      expandedRightSplitHandleBox.y + expandedRightSplitHandleBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      expandedRightSplitHandleBox.x + expandedRightSplitHandleBox.width / 2 - 500,
      expandedRightSplitHandleBox.y + expandedRightSplitHandleBox.height / 2
    )
    await page.mouse.up()
    await assert.equal(
      await page.getByTestId('render-resizable-right-width').textContent(),
      '600px'
    )

    const toggle = page.getByTestId('render-toggle')
    await assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    await toggle.click()
    await assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    await assert.equal(await page.getByTestId('render-toggle-value').textContent(), 'on')
    const uncontrolledToggle = page.getByTestId('render-toggle-uncontrolled')
    await assert.equal(await uncontrolledToggle.getAttribute('aria-pressed'), 'true')
    await uncontrolledToggle.click()
    await assert.equal(await uncontrolledToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(
      await page.getByTestId('render-toggle-uncontrolled-changes').textContent(),
      '1'
    )
    const preventedToggle = page.getByTestId('render-toggle-prevented')
    await assert.equal(await preventedToggle.getAttribute('aria-pressed'), 'false')
    await preventedToggle.click()
    await assert.equal(await preventedToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(
      await page.getByTestId('render-toggle-uncontrolled-changes').textContent(),
      '1'
    )
    const disabledToggle = page.getByTestId('render-toggle-disabled')
    await assert.equal(await disabledToggle.isDisabled(), true)
    await assert.equal(await disabledToggle.getAttribute('aria-pressed'), 'true')
    const disabledCallbackToggle = page.getByTestId('render-toggle-disabled-callback')
    await disabledCallbackToggle.click({ force: true })
    await assert.equal(await disabledCallbackToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(await page.getByTestId('render-toggle-disabled-changes').textContent(), '0')

    const toggleGroup = page.getByTestId('render-toggle-group')
    const listToggle = toggleGroup.getByRole('button', { name: '列表' })
    const gridToggle = toggleGroup.getByRole('button', { name: '网格' })
    const disabledToggleItem = toggleGroup.getByRole('button', { name: '禁用视图' })
    const chartToggle = toggleGroup.getByRole('button', { name: '图表' })
    await assert.equal(await toggleGroup.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await listToggle.getAttribute('aria-pressed'), 'true')
    await assert.equal(await listToggle.getAttribute('tabindex'), '0')
    await assert.equal(await gridToggle.getAttribute('tabindex'), '-1')
    await assert.equal(await disabledToggleItem.isDisabled(), true)
    await gridToggle.click()
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'grid')
    await assert.equal(await gridToggle.getAttribute('aria-pressed'), 'true')
    await gridToggle.focus()
    await toggleGroup.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'chart')
    await assert.equal(
      await chartToggle.evaluate((element) => document.activeElement === element),
      true
    )
    await toggleGroup.press('ArrowLeft')
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'grid')
    await assert.equal(
      await gridToggle.evaluate((element) => document.activeElement === element),
      true
    )

    const multipleToggleGroup = page.getByTestId('render-toggle-group-multiple')
    await assert.equal(
      await multipleToggleGroup.getByRole('button', { name: '标签' }).getAttribute('aria-pressed'),
      'true'
    )
    await multipleToggleGroup.getByRole('button', { name: '负责人' }).click()
    await assert.equal(
      await page.getByTestId('render-toggle-group-multiple-value').textContent(),
      'tag,owner'
    )
    await multipleToggleGroup.getByRole('button', { name: '标签' }).click()
    await assert.equal(
      await page.getByTestId('render-toggle-group-multiple-value').textContent(),
      'owner'
    )

    const segmentedControl = page.getByTestId('render-segmented-control')
    await assert.equal(
      await segmentedControl.getByRole('button', { name: '日' }).getAttribute('aria-pressed'),
      'true'
    )
    await segmentedControl.getByRole('button', { name: '日' }).click()
    await assert.equal(
      await page.getByTestId('render-segmented-control-value').textContent(),
      'day'
    )
    await assert.equal(
      await segmentedControl.getByRole('button', { name: '日' }).getAttribute('aria-pressed'),
      'true'
    )
    await segmentedControl.getByRole('button', { name: '周' }).click()
    await assert.equal(
      await page.getByTestId('render-segmented-control-value').textContent(),
      'week'
    )

    const defaultToggleGroup = page.getByTestId('render-toggle-group-default')
    const defaultAlpha = defaultToggleGroup.getByRole('button', { name: '甲视图' })
    const defaultBeta = defaultToggleGroup.getByRole('button', { name: '乙视图' })
    await assert.equal(await defaultAlpha.getAttribute('tabindex'), '0')
    await assert.equal(await defaultBeta.getAttribute('tabindex'), '-1')
    await defaultAlpha.click()
    await assert.equal(
      await page.getByTestId('render-toggle-group-default-value').textContent(),
      'alpha'
    )
    await defaultAlpha.click()
    await assert.equal(
      await page.getByTestId('render-toggle-group-default-value').textContent(),
      ''
    )

    const invalidToggleGroup = page.getByTestId('render-toggle-group-invalid')
    const validToggle = invalidToggleGroup.getByRole('button', { name: '有效视图' })
    const otherToggle = invalidToggleGroup.getByRole('button', { name: '其他视图' })
    await assert.equal(await validToggle.getAttribute('tabindex'), '0')
    await assert.equal(await otherToggle.getAttribute('tabindex'), '-1')
    await validToggle.focus()
    await invalidToggleGroup.press('ArrowRight')
    await assert.equal(
      await page.getByTestId('render-toggle-group-invalid-value').textContent(),
      'other'
    )
    await assert.equal(
      await otherToggle.evaluate((element) => document.activeElement === element),
      true
    )

    const allDisabledToggleGroup = page.getByTestId('render-toggle-group-all-disabled')
    await assert.equal(
      await allDisabledToggleGroup.getByRole('button', { name: '禁用甲' }).isDisabled(),
      true
    )
    await assert.equal(
      await allDisabledToggleGroup.getByRole('button', { name: '禁用乙' }).isDisabled(),
      true
    )
    await allDisabledToggleGroup.press('ArrowRight')
    await assert.equal(
      await page.getByTestId('render-toggle-group-all-disabled-value').textContent(),
      ''
    )

    const verticalToggleGroup = page.getByTestId('render-toggle-group-vertical')
    const topToggle = verticalToggleGroup.getByRole('button', { name: '上方' })
    const middleToggle = verticalToggleGroup.getByRole('button', { name: '中间' })
    await assert.equal(await verticalToggleGroup.getAttribute('aria-orientation'), 'vertical')
    await topToggle.focus()
    await verticalToggleGroup.press('ArrowDown')
    await assert.equal(
      await page.getByTestId('render-toggle-group-vertical-value').textContent(),
      'middle'
    )
    await assert.equal(
      await middleToggle.evaluate((element) => document.activeElement === element),
      true
    )
    await verticalToggleGroup.press('ArrowUp')
    await assert.equal(
      await page.getByTestId('render-toggle-group-vertical-value').textContent(),
      'top'
    )
    await assert.equal(
      await topToggle.evaluate((element) => document.activeElement === element),
      true
    )

    const controlledToaster = page.getByTestId('render-toaster-controlled')
    await assert.equal(await controlledToaster.getAttribute('role'), 'region')
    await assert.equal(await controlledToaster.getAttribute('aria-live'), 'polite')
    await assert.equal(
      await controlledToaster.getByRole('status').getByText('已保存').textContent(),
      '已保存'
    )
    await assert.equal(
      await controlledToaster.getByRole('button', { name: '撤销' }).textContent(),
      '撤销'
    )
    await assert.equal(
      await page
        .getByTestId('render-toaster-position')
        .evaluate((element) => window.getComputedStyle(element).top),
      '50px'
    )
    await assert.equal(
      await page.getByTestId('render-toaster-position').evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2) < 1
      }),
      true
    )
    await assert.equal(
      await page.getByTestId('render-toaster-position').evaluate((element) => {
        const styles = window.getComputedStyle(element)
        const rootStyles = window.getComputedStyle(document.documentElement)
        return Number(styles.zIndex) > Number(rootStyles.getPropertyValue('--vds-z-modal').trim())
      }),
      true
    )
    const errorToast = controlledToaster.getByRole('alert')
    await assert.equal(await errorToast.getByText('同步失败').textContent(), '同步失败')
    await assert.equal(
      await errorToast.evaluate((element) => window.getComputedStyle(element).alignItems),
      'flex-start'
    )
    await controlledToaster.getByRole('button', { name: '关闭通知' }).first().click()
    await assert.equal(await page.getByTestId('render-toaster-controlled-count').textContent(), '1')

    const autoToaster = page.getByTestId('render-toaster-auto')
    await page.getByTestId('render-toast-auto-add').click()
    await assert.equal(await autoToaster.getByText('自动关闭').count(), 1)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="render-toaster-auto-count"]')?.textContent === '0'
    )
    await assert.equal(await autoToaster.getByText('自动关闭').count(), 0)

    await page.getByTestId('render-toast-add').click()
    const queueToaster = page.getByTestId('render-toaster-queue')
    await assert.equal(
      await queueToaster.getByRole('status').getByText('队列通知').textContent(),
      '队列通知'
    )
    await assert.equal(
      await queueToaster.getByRole('button', { name: '查看' }).textContent(),
      '查看'
    )
    await queueToaster.getByRole('button', { name: '关闭队列通知' }).click()
    await assert.equal(await queueToaster.getByText('队列通知').count(), 0)

    const nestedProviderToaster = page.getByTestId('render-toaster-nested-provider')
    const nestedControlledToaster = page.getByTestId('render-toaster-nested-controlled')
    await assert.equal(await nestedProviderToaster.getByText('Provider 同 id').count(), 1)
    await assert.equal(await nestedControlledToaster.getByText('受控同 id').count(), 1)
    await nestedControlledToaster.getByRole('button', { name: '关闭通知' }).click()
    await assert.equal(
      await page.getByTestId('render-toaster-nested-controlled-count').textContent(),
      '0'
    )
    await assert.equal(await nestedControlledToaster.getByText('受控同 id').count(), 0)
    await assert.equal(await nestedProviderToaster.getByText('Provider 同 id').count(), 1)

    const readonlyToaster = page.getByTestId('render-toaster-controlled-readonly')
    await assert.equal(await readonlyToaster.getByText('只读通知').count(), 1)
    await assert.equal(await readonlyToaster.getByRole('button', { name: '关闭通知' }).count(), 0)
    await page.waitForTimeout(80)
    await assert.equal(await readonlyToaster.getByText('只读通知').count(), 1)

    await assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    await page.getByTestId('render-sheet-open').click()
    const sheet = page.getByTestId('render-sheet-content')
    const sheetOverlay = page.getByTestId('render-sheet-overlay')
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'open')
    await assert.equal(await sheet.getAttribute('role'), 'dialog')
    await assert.equal(await sheet.getAttribute('aria-modal'), null)
    await assert.equal(await sheet.getAttribute('data-side'), 'right')
    await assert.equal((await sheet.getAttribute('class'))?.includes('vds-sheet--right'), true)
    const sheetTitleId = await sheet.getAttribute('aria-labelledby')
    const sheetDescriptionId = await sheet.getAttribute('aria-describedby')
    assert.ok(sheetTitleId, 'Sheet title should be linked by aria-labelledby')
    assert.ok(sheetDescriptionId, 'Sheet description should be linked by aria-describedby')
    await assert.equal(await page.locator(`[id="${sheetTitleId}"]`).textContent(), '项目详情')
    await assert.equal(
      await page.locator(`[id="${sheetDescriptionId}"]`).textContent(),
      '展示右侧详情 UI 壳层。'
    )
    await sheet.focus()
    await assert.equal(await sheet.evaluate((element) => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-sheet-open-changes').textContent(), '1')
    await sheet.waitFor({ state: 'detached' })
    await assert.equal(await sheet.count(), 0)

    await page.getByTestId('render-sheet-modal-open').click()
    const modalSheet = page.getByTestId('render-sheet-modal-content')
    await assert.equal(await modalSheet.getAttribute('aria-modal'), 'true')
    await assert.equal(await modalSheet.getAttribute('data-side'), 'left')
    await page.getByTestId('render-sheet-modal-close').click()
    await modalSheet.waitFor({ state: 'detached' })
    await assert.equal(await modalSheet.count(), 0)

    await page.getByTestId('render-sheet-open').click()
    await page.getByTestId('render-sheet-overlay').click()
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await sheetOverlay.waitFor({ state: 'detached' })
    await assert.equal(await sheetOverlay.count(), 0)

    await page.getByTestId('render-sheet-open').click()
    await page.getByTestId('render-sheet-close').click()
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-sheet-close-count').textContent(), '1')

    await assert.equal(await page.getByTestId('render-drawer-content').count(), 0)
    await page.getByTestId('render-drawer-open').click()
    const drawer = page.getByTestId('render-drawer-content')
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'open')
    await assert.equal(await drawer.getAttribute('role'), 'dialog')
    await assert.equal(await drawer.getAttribute('aria-modal'), null)
    await assert.equal(await drawer.getAttribute('data-side'), 'bottom')
    await assert.equal((await drawer.getAttribute('class'))?.includes('vds-drawer--bottom'), true)
    const drawerTitleId = await drawer.getAttribute('aria-labelledby')
    const drawerDescriptionId = await drawer.getAttribute('aria-describedby')
    assert.ok(drawerTitleId, 'Drawer title should be linked by aria-labelledby')
    assert.ok(drawerDescriptionId, 'Drawer description should be linked by aria-describedby')
    await assert.equal(await page.locator(`[id="${drawerTitleId}"]`).textContent(), '移动抽屉')
    await assert.equal(
      await page.locator(`[id="${drawerDescriptionId}"]`).textContent(),
      '底部抽屉 UI 壳层。'
    )
    await page.keyboard.press('Escape')
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')

    await page.getByTestId('render-drawer-open').click()
    await page.getByTestId('render-drawer-overlay').click()
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')

    await page.getByTestId('render-drawer-open').click()
    await page.getByTestId('render-drawer-close').click()
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-drawer-close-count').textContent(), '1')

    const tooltip = page.getByTestId('render-tooltip')
    const tooltipTrigger = tooltip.getByRole('button', { name: '保存配置' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '保存当前配置', exact: true }).count(),
      0
    )
    await tooltipTrigger.hover()
    const tooltipContent = page.getByRole('tooltip', { name: '保存当前配置', exact: true })
    await tooltipContent.waitFor({ state: 'visible' })
    await assert.equal(await tooltipContent.textContent(), '保存当前配置')
    await assert.equal(
      await tooltipContent.getAttribute('data-i18n-text'),
      'examples:tooltip.content'
    )
    await assert.equal(await tooltipContent.getAttribute('data-side'), 'top')
    await assert.equal(
      (await tooltipContent.getAttribute('class'))?.includes('vds-tooltip--top'),
      true
    )
    const tooltipContentId = await tooltipContent.getAttribute('id')
    assert.ok(tooltipContentId, 'Tooltip content should receive a stable id')
    await assert.equal(await tooltipTrigger.getAttribute('aria-describedby'), tooltipContentId)
    await page.mouse.move(0, 0)
    await page
      .getByRole('tooltip', { name: '保存当前配置', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '保存当前配置', exact: true }).count(),
      0
    )
    await assert.equal(await tooltipTrigger.getAttribute('aria-describedby'), null)

    const focusTooltip = page.getByTestId('render-tooltip-focus')
    const focusTooltipTrigger = focusTooltip.getByRole('button', { name: '聚焦说明' })
    await focusTooltipTrigger.focus()
    await page
      .getByRole('tooltip', { name: '聚焦时显示提示', exact: true })
      .waitFor({ state: 'visible' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '聚焦时显示提示', exact: true }).textContent(),
      '聚焦时显示提示'
    )
    await assert.equal(
      await page
        .getByRole('tooltip', { name: '聚焦时显示提示', exact: true })
        .getAttribute('data-side'),
      'right'
    )
    await focusTooltipTrigger.blur()
    await page
      .getByRole('tooltip', { name: '聚焦时显示提示', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '聚焦时显示提示', exact: true }).count(),
      0
    )

    const controlledTooltip = page.getByTestId('render-tooltip-controlled')
    const controlledTooltipTrigger = controlledTooltip.getByRole('button', { name: '受控说明' })
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-value').textContent(),
      'closed'
    )
    await controlledTooltipTrigger.hover()
    await page
      .getByRole('tooltip', { name: '受控提示内容', exact: true })
      .waitFor({ state: 'visible' })
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-value').textContent(),
      'open'
    )
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-changes').textContent(),
      '1'
    )
    await controlledTooltipTrigger.focus()
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-changes').textContent(),
      '1'
    )
    await assert.equal(
      await page.getByRole('tooltip', { name: '受控提示内容', exact: true }).textContent(),
      '受控提示内容'
    )
    await page.mouse.move(0, 0)
    await page
      .getByRole('tooltip', { name: '受控提示内容', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-value').textContent(),
      'closed'
    )
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-changes').textContent(),
      '2'
    )
    await controlledTooltipTrigger.blur()
    await assert.equal(
      await page.getByTestId('render-tooltip-controlled-changes').textContent(),
      '2'
    )
    await assert.equal(
      await page.getByRole('tooltip', { name: '受控提示内容', exact: true }).count(),
      0
    )

    const customIdTooltip = page.getByTestId('render-tooltip-custom-id')
    const customIdTrigger = customIdTooltip.getByRole('button', { name: '自定义 ID 说明' })
    await assert.equal(
      await customIdTrigger.getAttribute('aria-describedby'),
      'tooltip-existing-help'
    )
    await customIdTrigger.hover()
    const customIdContent = page.getByRole('tooltip', { name: '自定义 ID 提示', exact: true })
    await customIdContent.waitFor({ state: 'visible' })
    await assert.equal(await customIdContent.getAttribute('id'), 'tooltip-custom-content')
    await assert.equal(
      await customIdTrigger.getAttribute('aria-describedby'),
      'tooltip-existing-help tooltip-custom-content'
    )
    await page.mouse.move(0, 0)
    await page
      .getByRole('tooltip', { name: '自定义 ID 提示', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '自定义 ID 提示', exact: true }).count(),
      0
    )
    await assert.equal(
      await customIdTrigger.getAttribute('aria-describedby'),
      'tooltip-existing-help'
    )

    const wrapperDescriptionTooltip = page.getByTestId('render-tooltip-trigger-wrapper-description')
    const wrapperDescriptionTrigger = wrapperDescriptionTooltip.getByRole('button', {
      name: '外层描述说明',
    })
    await assert.equal(
      await wrapperDescriptionTrigger.getAttribute('aria-describedby'),
      'tooltip-trigger-wrapper-help'
    )
    await wrapperDescriptionTrigger.hover()
    await page
      .getByRole('tooltip', { name: '外层描述提示', exact: true })
      .waitFor({ state: 'visible' })
    const wrapperDescriptionContentId = await page
      .getByRole('tooltip', { name: '外层描述提示', exact: true })
      .getAttribute('id')
    assert.ok(wrapperDescriptionContentId, 'Tooltip content should receive an id')
    await assert.equal(
      await wrapperDescriptionTrigger.getAttribute('aria-describedby'),
      `tooltip-trigger-wrapper-help ${wrapperDescriptionContentId}`
    )
    await page.mouse.move(0, 0)
    await page
      .getByRole('tooltip', { name: '外层描述提示', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByRole('tooltip', { name: '外层描述提示', exact: true }).count(),
      0
    )
    await assert.equal(
      await wrapperDescriptionTrigger.getAttribute('aria-describedby'),
      'tooltip-trigger-wrapper-help'
    )

    await assert.equal(
      await page.getByRole('tooltip', { name: '默认提示内容', exact: true }).textContent(),
      '默认提示内容'
    )
    await assert.equal(
      await page
        .getByRole('tooltip', { name: '默认提示内容', exact: true })
        .getAttribute('data-side'),
      'left'
    )

    const defaultOpenCustomIdTooltip = page.getByTestId('render-tooltip-default-open-custom-id')
    const defaultOpenCustomIdTrigger = defaultOpenCustomIdTooltip.getByRole('button', {
      name: '默认自定义 ID',
    })
    await assert.equal(
      await page
        .getByRole('tooltip', { name: '默认自定义 ID 提示', exact: true })
        .getAttribute('id'),
      'tooltip-default-open-custom-content'
    )
    await assert.equal(
      await defaultOpenCustomIdTrigger.getAttribute('aria-describedby'),
      'tooltip-default-open-custom-content'
    )

    const uncontrolledEventsTooltip = page.getByTestId('render-tooltip-uncontrolled-events')
    const uncontrolledEventsTrigger = uncontrolledEventsTooltip.getByRole('button', {
      name: '非受控事件说明',
    })
    await uncontrolledEventsTrigger.hover()
    await uncontrolledEventsTrigger.focus()
    await page
      .getByRole('tooltip', { name: '非受控事件提示', exact: true })
      .waitFor({ state: 'visible' })
    await assert.equal(
      await page.getByTestId('render-tooltip-uncontrolled-changes').textContent(),
      '1'
    )
    await page.mouse.move(0, 0)
    await uncontrolledEventsTrigger.blur()
    await page
      .getByRole('tooltip', { name: '非受控事件提示', exact: true })
      .waitFor({ state: 'detached' })
    await assert.equal(
      await page.getByTestId('render-tooltip-uncontrolled-changes').textContent(),
      '2'
    )

    const disabledTooltip = page.getByTestId('render-tooltip-disabled')
    const disabledTooltipTrigger = disabledTooltip.getByRole('button', { name: '禁用说明' })
    await disabledTooltipTrigger.hover()
    await assert.equal(
      await page.getByRole('tooltip', { name: '禁用提示', exact: true }).count(),
      0
    )
    await assert.equal(await disabledTooltipTrigger.getAttribute('aria-describedby'), null)
  })
})

test('floating toolbar renders an opaque accessible action surface', async () => {
  await withFixture(async (page) => {
    const floatingToolbar = page.getByTestId('render-floating-toolbar')
    await assert.equal(await floatingToolbar.getByRole('toolbar', { name: '选区操作' }).count(), 1)
    const background = await floatingToolbar.evaluate(
      (element) => window.getComputedStyle(element).backgroundColor
    )
    await assert.match(background, /^rgb\(/)
    await assert.notEqual(background, 'rgba(0, 0, 0, 0)')
  })
})

test('alert dialog close button is opt-in and cancels with keyboard focus restored', async () => {
  await withFixture(async (page) => {
    const confirmation = page.getByRole('alertdialog', { name: '确认操作' })
    await page.getByTestId('render-alert-open-false').click()
    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toHaveClass(
      /vds-button--outline/
    )
    await expect(confirmation.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0)
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    const trigger = page.getByTestId('render-alert-open-true')
    await trigger.click()
    const close = confirmation.getByRole('button', { name: '关闭', exact: true })
    await expect(close).toBeVisible()
    await close.focus()
    await page.keyboard.press('Enter')
    await expect(confirmation).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
})

test('modal dialog contains keyboard focus, dismisses only the nested layer and restores focus', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-dialog-open')
    const outer = page.getByTestId('render-dialog-content')
    await trigger.click()
    await expect(outer.getByTestId('render-dialog-cancel')).toHaveClass(/vds-button--outline/)
    await outer.getByTestId('render-dialog-cancel').click()
    await trigger.click()
    assert.equal(await outer.evaluate((el) => el.contains(document.activeElement)), true)
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await outer.evaluate((el) => el.contains(document.activeElement)), true)
    }
    await page.getByTestId('nested-dialog-open').click()
    const inner = page.getByTestId('nested-dialog-content')
    assert.equal(await inner.evaluate((el) => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await inner.waitFor({ state: 'hidden' })
    assert.equal(await outer.isVisible(), true)
    assert.equal(
      await page.getByTestId('nested-dialog-open').evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('Escape')
    await outer.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
  })
})

test('modal dialog recovers focus when its focused action becomes disabled and remains dismissible', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-dialog-open')
    const dialog = page.getByTestId('render-dialog-content')
    await trigger.click()
    const action = page.getByTestId('dialog-disable-focused-action')
    await action.click()
    await expect(action).toBeDisabled()
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
})

test('modal dialog recovers focus when its focused action is removed', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-dialog-open')
    const dialog = page.getByTestId('render-dialog-content')
    await trigger.click()
    const action = page.getByTestId('dialog-remove-focused-action')
    await action.click()
    await expect(action).toHaveCount(0)
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
})

test('nonmodal dialog permits Tab to leave and ignores implicit dismissal without a blocking backdrop', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('nonmodal-dialog-open').click()
    const content = page.getByTestId('nonmodal-dialog-content')
    assert.equal(await content.getAttribute('aria-modal'), null)
    await page.getByTestId('nonmodal-dialog-action').focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await page.getByTestId('nonmodal-after').evaluate((el) => el === document.activeElement),
      true
    )
    await page.getByTestId('nonmodal-after').click()
    assert.equal(await content.isVisible(), true)
    await page.keyboard.press('Escape')
    assert.equal(await content.isVisible(), true)
    assert.equal(await page.locator('.vds-dialog-overlay').count(), 0)
  })
})

test('popover focuses content after positioning, restores on Escape and permits focus outside', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('focus-popover-trigger')
    const content = page.getByTestId('focus-popover-content')
    const checkbox = page.getByTestId('focus-popover-checkbox')
    const outside = page.getByTestId('focus-popover-outside')
    await trigger.click()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'focus-popover-checkbox'
    )
    await page.keyboard.press('Space')
    assert.equal(await checkbox.isChecked(), true)
    await page.keyboard.press('Escape')
    await content.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    await trigger.click()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'focus-popover-checkbox'
    )
    await page.getByTestId('focus-popover-last').focus()
    await page.keyboard.press('Tab')
    assert.equal(await content.evaluate((el) => el.contains(document.activeElement)), false)
    await outside.click()
    await content.waitFor({ state: 'hidden' })
    assert.equal(await outside.evaluate((el) => el === document.activeElement), true)
  })
})

test('Escape on a nested hover trigger closes only its own detail', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('focus-popover-trigger').click()
    await page.getByTestId('nested-hover-trigger').focus()
    await page.getByTestId('nested-hover-content').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByTestId('nested-hover-content').waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('focus-popover-content').isVisible(), true)
  })
})

test('side hover cards stay outside their whole boundary at wide and narrow widths', async () => {
  await withFixture(async (page) => {
    for (const width of [1280, 640]) {
      await page.setViewportSize({ width, height: 800 })
      const trigger = page.getByTestId('side-hover-trigger')
      await trigger.hover()
      const content = page.getByTestId('side-hover-content')
      await content.waitFor({ state: 'visible' })
      await expect(async () => {
        const boundary = (await page.getByTestId('side-hover-boundary').boundingBox())!
        const detail = (await content.boundingBox())!
        assert.ok(detail.x + detail.width <= boundary.x, JSON.stringify({ boundary, detail }))
        assert.ok(detail.x >= 8)
      }).toPass()
      await page.getByTestId('side-hover-action').hover()
      assert.equal(await content.isVisible(), true)
      await trigger.focus()
      await page.keyboard.press('Escape')
      await content.waitFor({ state: 'hidden' })
    }
  })
})

test('tall floating content stays inside the viewport and exposes its trailing action', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('focus-popover-outside').scrollIntoViewIfNeeded()
    await page.getByTestId('viewport-hover-card-trigger').hover()
    const content = page.getByTestId('viewport-hover-card-content')
    await content.waitFor({ state: 'visible' })
    await page.waitForTimeout(250)

    const bounds = await content.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        top: rect.top,
        viewportHeight: window.innerHeight,
      }
    })
    assert.ok(bounds.top >= 8, JSON.stringify(bounds))
    assert.ok(bounds.bottom <= bounds.viewportHeight - 8, JSON.stringify(bounds))
    assert.ok(bounds.scrollHeight > bounds.clientHeight, JSON.stringify(bounds))

    await content.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    const action = page.getByTestId('viewport-hover-card-action')
    await assert.equal(await action.isVisible(), true)
    await assert.ok(
      await action.evaluate((element) => {
        const actionRect = element.getBoundingClientRect()
        const contentRect = element
          .closest('[data-testid="viewport-hover-card-content"]')!
          .getBoundingClientRect()
        return actionRect.bottom <= contentRect.bottom
      })
    )
  })
})

test('menu keyboard skips disabled items, wraps and dismisses only the focused submenu', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('focus-menu-trigger')
    const menu = page.getByTestId('focus-menu')
    const first = page.getByTestId('focus-menu-first')
    const last = page.getByTestId('focus-menu-last')
    const subtrigger = page.getByTestId('focus-menu-subtrigger')
    await trigger.click()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'focus-menu-first'
    )
    await page.keyboard.press('ArrowDown')
    assert.equal(await subtrigger.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press('End')
    assert.equal(await last.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press('ArrowDown')
    assert.equal(await first.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press('ArrowUp')
    assert.equal(await last.evaluate((el) => el === document.activeElement), true)
    await subtrigger.click()
    const sub = page.getByTestId('focus-menu-sub')
    await sub.getByRole('menuitem').waitFor({ state: 'visible' })
    assert.equal(await sub.evaluate((el) => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await sub.waitFor({ state: 'hidden' })
    assert.equal(await menu.isVisible(), true)
    assert.equal(await subtrigger.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
  })
})

test('menu trapFocus opt-in wraps Tab while ordinary menus remain nonmodal', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('trapped-menu-trigger')
    await trigger.click()
    await expect(page.getByTestId('trapped-menu-first')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('trapped-menu-last')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('trapped-menu-first')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await page.getByTestId('focus-menu-trigger').click()
    await page.getByTestId('focus-menu-last').focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByTestId('focus-menu')
        .evaluate((element) => element.contains(document.activeElement)),
      false
    )
  })
})

test('icon buttons keep square geometry without text-button padding and loading replaces the icon', async () => {
  await withFixture(async (page) => {
    for (const [size, edge, iconEdge] of [
      ['sm', 28, 14],
      ['md', 32, 16],
      ['lg', 40, 16],
    ] as const) {
      const button = page.getByTestId(`square-icon-${size}`)
      const geometry = await button.evaluate((el) => {
        const bounds = el.getBoundingClientRect()
        const icon = el.querySelector('.vds-icon-button__content')!.getBoundingClientRect()
        return {
          width: bounds.width,
          height: bounds.height,
          iconWidth: icon.width,
          iconHeight: icon.height,
          offsetX: Math.abs((icon.left + icon.right) / 2 - (bounds.left + bounds.right) / 2),
          offsetY: Math.abs((icon.top + icon.bottom) / 2 - (bounds.top + bounds.bottom) / 2),
        }
      })
      assert.equal(geometry.width, edge)
      assert.equal(geometry.height, edge)
      assert.equal(geometry.iconWidth, iconEdge)
      assert.equal(geometry.iconHeight, iconEdge)
      assert.ok(geometry.offsetX < 1 && geometry.offsetY < 1)
    }
    const loading = page.getByTestId('square-icon-loading')
    assert.equal(await loading.isDisabled(), true)
    assert.equal(await loading.locator('.vds-icon-button__content').count(), 0)
    assert.equal(await loading.getByRole('status').count(), 1)
  })
})

test('default tooltips stay inside all viewport edges and escape clipped panels', async () => {
  await withFixture(async (page) => {
    const root = page.getByTestId('render-tooltip')
    const trigger = root.getByRole('button')
    const content = page.getByRole('tooltip', { name: '保存当前配置', exact: true })
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await page.mouse.move(0, 0)
      await trigger.blur()
      await root.evaluate((element, corner) => {
        Object.assign(element.style, {
          position: 'fixed',
          left: corner.endsWith('left') ? '0' : 'auto',
          right: corner.endsWith('right') ? '0' : 'auto',
          top: corner.startsWith('top') ? '0' : 'auto',
          bottom: corner.startsWith('bottom') ? '0' : 'auto',
          overflow: 'hidden',
        })
      }, corner)
      await trigger.focus()
      await content.waitFor({ state: 'visible' })
      await expect
        .poll(async () =>
          content.evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return (
              bounds.left >= 0 &&
              bounds.top >= 0 &&
              bounds.right <= window.innerWidth &&
              bounds.bottom <= window.innerHeight &&
              element.parentElement === document.body
            )
          })
        )
        .toBe(true)
      await page.keyboard.press('Escape')
      await content.waitFor({ state: 'hidden' })
    }
  })
})

test('disabled tooltip forgets previous hover before being enabled again', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByRole('button', { name: '点击禁用提示', exact: true })
    const content = page.getByRole('tooltip').filter({ hasText: '动态禁用提示' })
    await trigger.hover()
    await content.waitFor({ state: 'visible' })
    await trigger.click()
    await content.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '重新启用提示', exact: true }).click()
    assert.equal(await content.count(), 0)
    await trigger.hover()
    await content.waitFor({ state: 'visible' })
  })
})

test('visible tooltip dismisses on Escape without moving focused trigger', async () => {
  await withFixture(async (page) => {
    const root = page.getByTestId('render-tooltip')
    const trigger = root.getByRole('button')
    await trigger.focus()
    await page
      .getByRole('tooltip', { name: '保存当前配置', exact: true })
      .waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page
      .getByRole('tooltip', { name: '保存当前配置', exact: true })
      .waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    assert.equal(await trigger.getAttribute('aria-describedby'), null)
    await page.mouse.move(0, 0)
    await trigger.hover()
    await page
      .getByRole('tooltip', { name: '保存当前配置', exact: true })
      .waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page
      .getByRole('tooltip', { name: '保存当前配置', exact: true })
      .waitFor({ state: 'hidden' })
  })
})

test('composed select opens from keyboard, skips disabled options, selects and restores focus', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('keyboard-select')
    const list = page.getByTestId('keyboard-options')
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await list.waitFor({ state: 'visible' })
    await expect(list.getByRole('option', { name: '第一项', exact: true })).toHaveClass(
      /vds-select__item--selected/
    )
    const selectedBackground = await list
      .getByRole('option', { name: '第一项', exact: true })
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return style.backgroundColor
      })
    assert.equal(selectedBackground, 'rgb(233, 238, 235)')
    assert.equal(
      await list
        .getByRole('option', { name: '第一项', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('ArrowDown')
    assert.equal(
      await list
        .getByRole('option', { name: '最后项', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('Enter')
    await list.waitFor({ state: 'hidden' })
    assert.match(await trigger.innerText(), /最后项/)
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    await trigger.click()
    assert.equal(
      await list
        .getByRole('option', { name: '最后项', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('Home')
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'hidden' })
    assert.match(await trigger.innerText(), /最后项/)
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
  })
})

test('end-aligned select keeps its minimum-width menu inside the viewport', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('keyboard-select')
    const list = page.getByTestId('keyboard-options')
    for (const viewportWidth of [1000, 480]) {
      await page.setViewportSize({ width: viewportWidth, height: 720 })
      await trigger.evaluate((element) => {
        Object.assign(element.style, {
          position: 'fixed',
          right: '16px',
          top: '16px',
          width: '100px',
          minWidth: '0',
        })
      })
      await trigger.click()
      await list.waitFor({ state: 'visible' })
      const triggerBounds = (await trigger.boundingBox())!
      const listBounds = (await list.boundingBox())!
      assert.equal(listBounds.x + listBounds.width, triggerBounds.x + triggerBounds.width)
      assert.ok(listBounds.width >= 128)
      assert.ok(listBounds.x >= 0 && listBounds.x + listBounds.width <= viewportWidth)
      await page.keyboard.press('Escape')
    }
  })
})
