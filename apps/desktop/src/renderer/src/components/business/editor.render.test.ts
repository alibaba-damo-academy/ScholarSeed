import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('composer editor caps at ten rows, reports scroll edges and avoids wrapping layout oscillation', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 388, height: 720 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(new URL('/components/business/editor.render.fixture.html', fixture.url).href)
  const input = page.getByTestId('editor')
  const layout = page.getByTestId('layout')
  const height = () => input.evaluate((element) => element.getBoundingClientRect().height)
  await input.fill('短输入')
  const single = await height()
  await expect(layout).toHaveText(JSON.stringify({ multiline: false, above: false, below: false }))
  await input.fill(Array.from({ length: 10 }, (_, index) => `第${index + 1}行`).join('\n'))
  await expect.poll(height).toBeGreaterThan(single)
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const style = getComputedStyle(element)
        return (
          (element.clientHeight -
            Number.parseFloat(style.paddingTop) -
            Number.parseFloat(style.paddingBottom)) /
          Number.parseFloat(style.lineHeight)
        )
      })
    )
    .toBe(10)
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: false, below: false }))
  await input.fill(Array.from({ length: 30 }, (_, index) => `第${index + 1}行`).join('\n'))
  await input.press('Control+Home')
  await input.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: false, below: true }))
  await input.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: true, below: true }))
  await input.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: true, below: false }))
  await input.fill('内容宽度变化后不应反复切换工具栏位置。'.repeat(2))
  await expect(layout).toContainText('"multiline":true')
  await page.setViewportSize({ width: 520, height: 720 })
  await expect(input).toHaveValue('内容宽度变化后不应反复切换工具栏位置。'.repeat(2))
  await input.fill('')
  await expect.poll(height).toBe(single)
  await expect(layout).toHaveText(JSON.stringify({ multiline: false, above: false, below: false }))
  assert.deepEqual(errors, [])
})
