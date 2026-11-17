import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('message height transitions in both directions and respects reduced motion', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const source = Array.from({ length: 12 }, (_, index) => `Line ${index}`).join('\n')
  await page.goto(
    `${fixture.url}components/business/Message.render.fixture.html?text=${encodeURIComponent(source)}`
  )
  const text = page.getByTestId('user-message-text')
  await expect(text).toHaveCSS('transition-property', 'height')
  await text.evaluate((element) => {
    const observations: string[][] = []
    ;(window as unknown as { messageTransitions: string[][] }).messageTransitions = observations
    element.addEventListener('transitionrun', (event) => {
      if ((event as TransitionEvent).propertyName !== 'height') return
      const transition = element
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === 'height'
        )
      const effect = transition?.effect
      observations.push(
        effect instanceof KeyframeEffect
          ? effect.getKeyframes().map((frame) => String(frame.height))
          : []
      )
    })
  })
  await page.getByRole('button', { name: '展开更多', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { messageTransitions: string[][] }).messageTransitions.length
      )
    )
    .toBe(1)
  await expect.poll(() => text.evaluate((element) => element.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: '收起', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { messageTransitions: string[][] }).messageTransitions.length
      )
    )
    .toBe(2)
  await expect.poll(() => text.evaluate((element) => element.getAnimations().length)).toBe(0)
  const transitions = await page.evaluate(
    () => (window as unknown as { messageTransitions: string[][] }).messageTransitions
  )
  assert.ok(parseFloat(transitions[0][0]) < parseFloat(transitions[0].at(-1)!))
  assert.ok(parseFloat(transitions[1][0]) > parseFloat(transitions[1].at(-1)!))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text).toHaveCSS('transition-property', 'none')
  await page.getByRole('button', { name: '展开更多', exact: true }).click()
  assert.equal(await text.evaluate((element) => element.getAnimations().length), 0)
  await expect(text).toHaveText(source)
})

test('user messages fold only beyond six visual lines and always copy the literal complete text', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const open = (text: string) =>
    page.goto(
      `${fixture.url}components/business/Message.render.fixture.html?text=${encodeURIComponent(text)}`
    )
  const six = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 行 *β* \`code\``).join('\n')
  await open(six)
  await expect(page.getByRole('button', { name: '展开更多' })).toHaveCount(0)
  const long = six + '\n# 原始标题，不渲染 Markdown'
  await open(long)
  const text = page.getByTestId('user-message-text')
  await expect(text).toHaveAttribute('data-collapsed', 'true')
  const geometry = await text.evaluate((element) => ({
    height: element.clientHeight,
    line: parseFloat(getComputedStyle(element).lineHeight),
  }))
  assert.ok(Math.abs(geometry.height - geometry.line * 6) < 1)
  await expect(text).toHaveText(long)
  await expect(text.locator('strong, code, h1')).toHaveCount(0)
  for (const label of ['展开更多', '收起', '展开更多']) {
    const toggle = page.getByRole('button', { name: label, exact: true })
    await expect(
      toggle.locator(label === '收起' ? 'svg.lucide-chevron-up' : 'svg.lucide-chevron-down')
    ).toHaveCount(1)
    await expect(toggle.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await page.getByTestId('copy-first').focus()
    await page.getByTestId('copy-first').click()
    await expect(page.getByTestId('copied')).toHaveText(long)
    await page.getByRole('button', { name: label, exact: true }).click()
  }
  await expect(text).toHaveAttribute('data-collapsed', 'false')
})

test('user links keep the exact URL, wrap in a narrow container and use shared web navigation', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const href = 'https://example.com/a_(b)?q=' + 'x'.repeat(250) + '&v=%20#fragment'
  await page.goto(
    `${fixture.url}components/business/Message.render.fixture.html?text=${encodeURIComponent('原文：' + href + '。')}`
  )
  const link = page.getByRole('link')
  await expect(link).toHaveAttribute('href', href)
  await expect(link.locator('svg')).toHaveCount(1)
  await expect(link).toHaveText(href)
  await link.focus()
  await link.press('Enter')
  await expect(page.getByTestId('opened')).toHaveText(href)
  assert.equal(
    await page
      .getByTestId('user-message-text')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true
  )
})

test('copied bold messages keep emphasis through folding without changing copied source', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const labels = Array.from({ length: 9 }, (_, index) => `加粗条目 ${index + 1}`)
  const source = labels.map((label) => `- **${label}** — 普通说明`).join('\n')
  const url = `${fixture.url}components/business/Message.render.fixture.html?text=${encodeURIComponent(source)}`
  await page.goto(url)
  const text = page.getByTestId('user-message-text')
  await expect(text.locator('strong')).toHaveText(labels)
  await expect(text.locator('strong').first()).toHaveCSS('font-weight', '600')
  await expect(text).toHaveAttribute('data-collapsed', 'true')
  for (const label of ['展开更多', '收起']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(text.locator('strong')).toHaveText(labels)
    await page.getByTestId('copy-first').click()
    await expect(page.getByTestId('copied')).toHaveText(source)
  }
  await page.reload()
  await expect(text.locator('strong')).toHaveText(labels)
  assert.equal(await text.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
})

test('only the latest reply actions stay visible while historical actions follow hover and keyboard focus', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}components/business/Message.render.fixture.html?text=first`)
  await page.getByTestId('outside').hover()
  const historical = page.getByTestId('historical')
  const actions = historical.getByTestId('message-actions')
  const latest = page.getByTestId('latest').getByTestId('message-actions')
  await expect(actions).toHaveCSS('opacity', '0')
  await expect(latest).toHaveCSS('opacity', '1')
  await historical.hover()
  await expect(actions).toHaveCSS('opacity', '1')
  await page.getByTestId('outside').hover()
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByTestId('outside').focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(historical.getByRole('button')).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
  await historical.getByRole('button').click()
  await expect(page.getByTestId('copied')).toHaveText('first')
  await page.getByTestId('outside').focus()
  await page.getByTestId('outside').hover()
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByTestId('latest').getByRole('button').click()
  await expect(page.getByTestId('copied')).toHaveText('Second reply')
})
