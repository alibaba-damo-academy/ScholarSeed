import path from 'node:path'
import { readFileSync } from 'node:fs'
import { expressions, jsxWithAttributes } from '../../../../test-helpers/syntax.ts'
import test, { after, type TestContext } from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'
import { isResourceFinalizing } from '../../runtime.ts'

const UPDATE_COUNT = 50
const MAX_HEIGHT = 132
const RENDER_TIMEOUT_MS = 60_000
let preparing: ReturnType<typeof renderFixture> | undefined

test('resource finalization requires pending settlement without a recovery block', () => {
  const thread = {
    sessionId: 'session',
    running: false,
    recoveryPending: true,
    resourceFinalizing: true,
    recoveryBlocked: false,
  }
  expect(isResourceFinalizing(thread)).toBe(true)
  expect(isResourceFinalizing({ ...thread, running: true })).toBe(false)
  expect(isResourceFinalizing({ ...thread, recoveryBlocked: true })).toBe(false)
  expect(isResourceFinalizing({ ...thread, recoveryPending: false })).toBe(false)
})

test('floating attachments stay hidden until the editor is clicked, without hover activation', () => {
  const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  const tray = jsxWithAttributes(source, { 'data-testid': 'composer-reference-region' })
  expressions(tray)('inline && !inlineReferencesExpanded', { attribute: 'hidden' })
  const input = jsxWithAttributes(source, { 'data-testid': 'composer-input' })
  expressions(input)('inline ? () => setInlineReferencesExpanded(true) : undefined', {
    attribute: 'onClick',
  })
})

after(async () => {
  await (await preparing)?.close()
})

async function editor(context: TestContext) {
  preparing ??= renderFixture(path.resolve(import.meta.dirname, '..'), {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  const fixture = await preparing
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}business/composer.render.fixture.html`)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  return page
}

test(
  'composer editor skips unrelated parent commits and keeps its input node',
  { timeout: RENDER_TIMEOUT_MS },
  async (context) => {
    const page = await editor(context)
    const input = page.getByTestId('composer-input')
    await input.fill('中文草稿')
    await input.press('ArrowLeft')
    await input.press('Shift+ArrowLeft')
    const selection = await input.evaluate((element: HTMLTextAreaElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
    }))
    const node = await input.elementHandle()
    await input.evaluate((element) => {
      const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!
      Object.assign(window, {
        previousEditorProps: (element as unknown as Record<string, unknown>)[key],
      })
    })
    for (let index = 0; index < UPDATE_COUNT; index += 1) {
      await page
        .getByRole('button', { name: 'unrelated update' })
        .evaluate((element: HTMLButtonElement) => element.click())
    }
    expect(
      await input.evaluate((element) => {
        const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!
        return (
          (element as unknown as Record<string, unknown>)[key] ===
          (window as unknown as { previousEditorProps: unknown }).previousEditorProps
        )
      })
    ).toBe(true)
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(input).toBeFocused()
    expect(
      await input.evaluate((element: HTMLTextAreaElement) => ({
        start: element.selectionStart,
        end: element.selectionEnd,
      }))
    ).toEqual(selection)
    await expect(input).toHaveValue('中文草稿')
    await expect(page.getByTestId('updates')).toHaveText(String(UPDATE_COUNT))
  }
)

test(
  'composer editor updates drafts, restores, clears and follows meaningful props',
  { timeout: RENDER_TIMEOUT_MS },
  async (context) => {
    const page = await editor(context)
    const input = page.getByTestId('composer-input')
    await expect(input).toBeFocused()
    await input.fill('输入内容')
    await expect(page.getByTestId('changes')).toHaveText('1')
    await page.getByRole('button', { name: 'restore draft' }).click()
    await expect(input).toHaveValue('restored draft')
    await page.getByRole('button', { name: 'clear draft' }).click()
    await expect(input).toHaveValue('')
    await page.getByRole('button', { name: 'change placeholder' }).click()
    await expect(input).toHaveAttribute('placeholder', 'running')
    await page.getByRole('button', { name: 'toggle disabled' }).click()
    await expect(input).toBeDisabled()
    await page.getByRole('button', { name: 'toggle disabled' }).click()
    await expect(input).toBeEnabled()
  }
)

test(
  'composer editor protects composition Enter and delegates normal keyboard events',
  { timeout: RENDER_TIMEOUT_MS },
  async (context) => {
    const page = await editor(context)
    const input = page.getByTestId('composer-input')
    await input.dispatchEvent('compositionstart')
    await input.press('Enter')
    await expect(page.getByTestId('keys')).toHaveText('')
    await input.dispatchEvent('compositionend')
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
    await expect(page.getByTestId('keys')).toHaveText('')
    await input.press('Enter')
    await input.press('ArrowDown')
    await input.press('Escape')
    await expect(page.getByTestId('keys')).toHaveText('Enter,ArrowDown,Escape')
    await input.fill('第一行')
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('第一行\n')
  }
)

test(
  'composer editor grows for multiline drafts and shrinks after clearing',
  { timeout: RENDER_TIMEOUT_MS },
  async (context) => {
    const page = await editor(context)
    const input = page.getByTestId('composer-input')
    const initial = await input.evaluate((element) => element.getBoundingClientRect().height)
    await input.fill('多行草稿\n'.repeat(30))
    const expanded = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      overflow: element.style.overflowY,
    }))
    expect(expanded.height).toBeGreaterThan(initial)
    expect(expanded.height).toBeLessThanOrEqual(MAX_HEIGHT)
    expect(expanded.overflow).toBe('auto')
    await page.getByRole('button', { name: 'clear draft' }).click()
    await expect
      .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(initial)
  }
)

test(
  'composer editor recalculates wrapped draft height when its width changes',
  { timeout: RENDER_TIMEOUT_MS },
  async (context) => {
    const page = await editor(context)
    const input = page.getByTestId('composer-input')
    await input.fill('A draft that wraps when the conversation panel becomes narrow')
    const originalHeight = await input.evaluate((element) => element.getBoundingClientRect().height)
    await page.getByRole('button', { name: 'toggle width' }).click()
    await expect
      .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(originalHeight)
    await page.getByRole('button', { name: 'toggle width' }).click()
    await expect
      .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(originalHeight)
  }
)
