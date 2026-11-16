import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const HOVER_OBSERVATION_MS = 1_000

test('annotation recall keeps hover/edit isolation, exact geometry, five lines and cancel/save behavior', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}features/assistant/notes.render.fixture.html`)
  const open = page.getByRole('button', { name: '编辑注释', exact: true })
  const tooltip = page.getByRole('tooltip')
  await open.hover()
  await expect(tooltip).toHaveText('原有注释')
  await open.click()
  const textarea = page.getByRole('textbox')
  await expect(textarea).toHaveValue('原有注释')
  await page.clock.install()
  await textarea.hover()
  await open.hover()
  await page.clock.runFor(HOVER_OBSERVATION_MS)
  await expect(tooltip).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '删除注释', exact: true }).locator('svg.lucide-trash-2')
  ).toHaveCount(1)
  const surface = page.getByRole('region').filter({ has: textarea })
  await expect
    .poll(async () => {
      const box = await surface.boundingBox()
      return [box?.width, box?.height]
    })
    .toEqual([388, 104])
  const shadow = await surface.evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.boxShadow = 'var(--vds-shadow-aidialog-2)'
    element.append(probe)
    const value = getComputedStyle(probe).boxShadow
    probe.remove()
    return value
  })
  assert.notEqual(shadow, 'none')
  assert.equal(
    await surface.evaluate(
      (element, value) => getComputedStyle(element).boxShadow.endsWith(value),
      shadow
    ),
    true
  )
  await textarea.focus()
  assert.deepEqual(
    await textarea.evaluate((element) => {
      const styles = getComputedStyle(element)
      return [
        styles.fontSize,
        styles.lineHeight,
        styles.fontWeight,
        styles.borderWidth,
        styles.color,
      ]
    }),
    ['14px', '22px', '400', '0px', 'rgb(12, 12, 12)']
  )
  const longComment = Array.from({ length: 8 }, (_, index) => `第${index + 1}行注释`).join('\n')
  await textarea.fill(longComment)
  await textarea.evaluate((element) => element.scrollTo(0, 0))
  await expect(page.getByTestId('annotation-editor-fade')).toBeVisible()
  await expect.poll(async () => (await surface.boundingBox())?.height).toBe(180)
  assert.equal(
    await textarea.evaluate((element) =>
      Math.floor(element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight))
    ),
    5
  )
  await expect(textarea).toHaveValue(longComment)
  await expect(tooltip).toHaveCount(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByTestId('saved-comment')).toHaveText('原有注释')
  await open.hover()
  await expect(tooltip).toHaveText('原有注释')
  await open.click()
  await expect(textarea).toHaveValue('原有注释')
  await textarea.fill(longComment)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(textarea).toHaveCount(0)
  await expect(page.getByTestId('saved-comment')).toHaveText(longComment)
  await open.hover()
  await expect(tooltip).toHaveText(longComment)
})
