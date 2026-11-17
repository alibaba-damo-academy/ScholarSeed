import path from 'node:path'
import test, { after } from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

let preparing: ReturnType<typeof renderFixture> | undefined
after(async () => (await preparing)?.close())

for (const source of ['resource', 'literature']) {
  test(`${source} reference shortcuts select rows but preserve native search selection`, async (context) => {
    preparing ??= renderFixture(path.resolve(import.meta.dirname, '..'))
    const fixture = await preparing
    const page = await fixture.page(context)
    await page.goto(`${fixture.url}business/references.render.fixture.html?source=${source}`)
    const all = page.getByTestId('reference-picker-select-all')
    const kind = source === 'resource' ? 'file' : source
    const alpha = page.getByTestId(`ai-context-select-${kind}-Alpha`)
    const beta = page.getByTestId(`ai-context-select-${kind}-Beta`)
    const unavailable = page.getByTestId(`ai-context-select-${kind}-Unavailable`)
    for (const modifier of ['Meta', 'Control']) {
      await alpha.focus()
      await alpha.press(`${modifier}+a`)
      await expect(all).toHaveAttribute('aria-checked', 'true')
      await expect(alpha).toHaveAttribute('aria-checked', 'true')
      await expect(beta).toHaveAttribute('aria-checked', 'true')
      await expect(unavailable).toHaveAttribute('aria-checked', 'false')
      await alpha.click()
      await expect(all).toHaveAttribute('aria-checked', 'mixed')
      await alpha.press(`${modifier}+a`)
      await expect(all).toHaveAttribute('aria-checked', 'true')
      await all.click()
      await expect(all).toHaveAttribute('aria-checked', 'false')
    }
    const search = page.getByRole('searchbox')
    await search.fill('Alpha')
    await search.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await expect(all).toHaveAttribute('aria-checked', 'false')
    await expect(search).toHaveValue('Alpha')
    expect(
      await search.evaluate((element: HTMLInputElement) => [
        element.selectionStart,
        element.selectionEnd,
      ])
    ).toEqual([0, 5])
    await alpha.press('Control+a')
    await search.fill('')
    await expect(alpha).toHaveAttribute('aria-checked', 'true')
    await expect(beta).toHaveAttribute('aria-checked', 'false')
  })
  test(`${source} reference select-all preserves filtered selections and skips unavailable rows`, async (context) => {
    preparing ??= renderFixture(path.resolve(import.meta.dirname, '..'))
    const fixture = await preparing
    const page = await fixture.page(context)
    await page.goto(`${fixture.url}business/references.render.fixture.html?source=${source}`)
    const all = page.getByTestId('reference-picker-select-all')
    const kind = source === 'resource' ? 'file' : source
    const alpha = page.getByTestId(`ai-context-select-${kind}-Alpha`)
    const beta = page.getByTestId(`ai-context-select-${kind}-Beta`)
    const unavailable = page.getByTestId(`ai-context-select-${kind}-Unavailable`)
    await expect(all).toHaveAttribute('aria-checked', 'false')
    await all.click()
    await expect(alpha).toHaveAttribute('aria-checked', 'true')
    await expect(beta).toHaveAttribute('aria-checked', 'true')
    await expect(unavailable).toHaveAttribute('aria-checked', 'false')
    await expect(unavailable).toBeDisabled()
    await alpha.click()
    await expect(all).toHaveAttribute('aria-checked', 'mixed')
    await all.press('Space')
    await expect(all).toHaveAttribute('aria-checked', 'true')
    const search = page.getByRole('searchbox')
    await search.fill('Alpha')
    await all.click()
    await search.fill('')
    await expect(alpha).toHaveAttribute('aria-checked', 'false')
    await expect(beta).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('reference-picker-confirm').click()
    await expect(page.getByTestId('confirmed')).toHaveText('Beta')
    await all.click()
    await all.click()
    await expect(page.getByTestId('reference-picker-confirm')).toBeDisabled()
  })
}
