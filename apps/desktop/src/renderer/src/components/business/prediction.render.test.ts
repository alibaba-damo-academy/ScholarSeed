import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('ghost text accepts on Right or Tab, never sends, and typing replaces it', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}components/business/prediction.render.fixture.html`)
  const editor = page.getByTestId('editor')
  const suggestion = '比较这些方法，并列出下一步实验。'
  await expect(editor).toHaveValue('')
  await expect(editor).toHaveAttribute('placeholder', suggestion)
  await editor.press('ArrowRight')
  await expect(editor).toHaveValue(suggestion)
  await expect(page.getByTestId('sends')).toHaveText('0')
  await page.getByTestId('reset').click()
  await editor.press('Tab')
  await expect(editor).toHaveValue(suggestion)
  await expect(page.getByTestId('sends')).toHaveText('0')
  await page.getByTestId('reset').click()
  await editor.fill('自己的问题')
  await expect(editor).toHaveValue('自己的问题')
  await expect(editor).toHaveAttribute('data-prediction', 'false')
  await editor.fill('')
  await expect(editor).toHaveAttribute('placeholder', 'Write a message')
  await page.getByTestId('reset').click()
  await editor.press('Escape')
  await expect(editor).toHaveAttribute('data-prediction', 'false')
  await expect(page.getByTestId('sends')).toHaveText('0')
})

test('inline references indent only the first line without narrowing the text area', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}components/business/prediction.render.fixture.html`)
  await page.getByTestId('references').click()
  const editor = page.getByTestId('editor')
  await expect(page.getByTestId('inline-reference')).toBeVisible()
  const referenceGeometry = await editor.evaluate((element) => ({
    width: element.clientWidth,
    prefix: element.parentElement!.firstElementChild!.getBoundingClientRect().width,
    indent: getComputedStyle(element).textIndent,
    gap: getComputedStyle(element).getPropertyValue('--vds-space-2'),
  }))
  assert.ok(parseFloat(referenceGeometry.indent) > 0, JSON.stringify(referenceGeometry))
  const geometry = await editor.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    parentWidth: element.parentElement!.getBoundingClientRect().width,
  }))
  assert.equal(geometry.width, geometry.parentWidth)
  await editor.fill('第一行正文。'.repeat(40))
  await expect(editor).toHaveValue('第一行正文。'.repeat(40))
  await page.getByTestId('references').click()
  await expect(editor).toHaveCSS('text-indent', '0px')
})
