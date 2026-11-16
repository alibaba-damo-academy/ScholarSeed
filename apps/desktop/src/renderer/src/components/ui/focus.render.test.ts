import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('focus scope survives owner-document navigation before React unmount', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  try {
    const page = await fixture.browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(new URL('/components/ui/focus.render.fixture.html', fixture.url).href)
    await page.getByRole('button', { name: 'Open scope', exact: true }).click()
    const frame = page.frameLocator('iframe')
    await expect(frame.getByRole('button', { name: 'Scoped action' })).toBeFocused()
    await page.getByRole('button', { name: 'Inspect scope' }).click()
    await expect(page.getByTestId('probe')).toHaveText('[true,false,false]')
    await page.getByRole('button', { name: 'Navigate owner' }).click()
    await expect(page.getByTestId('retired')).toHaveText('true')
    await expect(page.getByTestId('owner-window')).toHaveText('null')
    await page.getByRole('button', { name: 'Unmount scope' }).click()
    assert.deepEqual(errors, [])
    await expect(page.getByTestId('mounted')).toHaveText('closed')
    await page.getByRole('button', { name: 'Open scope', exact: true }).click()
    await expect(
      page.frameLocator('iframe').last().getByRole('button', { name: 'Scoped action' })
    ).toBeFocused()
    await page.getByRole('button', { name: 'Unmount scope' }).click()
    assert.deepEqual(errors, [])
  } finally {
    await fixture.close()
  }
})

test('focus membership rejects a retired document without using the parent realm', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  try {
    const page = await fixture.browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(new URL('/components/ui/focus.render.fixture.html', fixture.url).href)
    await page.getByRole('button', { name: 'Open scope', exact: true }).click()
    await page.getByRole('button', { name: 'Navigate owner' }).click()
    await expect(page.getByTestId('retired')).toHaveText('true')
    await expect(page.getByTestId('owner-window')).toHaveText('null')
    await page.getByRole('button', { name: 'Inspect scope' }).click()
    await expect(page.getByTestId('probe')).toHaveText('[false,false,false]')
    await page.getByRole('button', { name: 'Unmount scope' }).click()
    assert.deepEqual(errors, [])
  } finally {
    await fixture.close()
  }
})
