import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { skipQuarantined } from './fixtures/quarantine'

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const FIXTURE_CONFIG = resolve('e2e/fixtures/editor.config.mjs')
const FIXTURE_OUTPUT = resolve('../../tmp/editor-fixture/editor.js')
const UPDATE_COUNT = 50
const MAX_HEIGHT = 132
let script = ''

test.beforeAll(async () => {
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', FIXTURE_CONFIG], { stdio: 'pipe' })
  script = readFileSync(FIXTURE_OUTPUT, 'utf8')
})

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: script })
})

test('composer editor skips unrelated parent commits and keeps its input node', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('中文草稿')
  await input.press('ArrowLeft')
  await input.press('Shift+ArrowLeft')
  const selection = await input.evaluate((element: HTMLTextAreaElement) => ({ start: element.selectionStart, end: element.selectionEnd }))
  const node = await input.elementHandle()
  await input.evaluate(element => {
    const key = Object.keys(element).find(key => key.startsWith('__reactProps$'))!
    Object.assign(window, { previousEditorProps: (element as unknown as Record<string, unknown>)[key] })
  })
  for (let index = 0; index < UPDATE_COUNT; index += 1) {
    await page.getByRole('button', { name: 'unrelated update' }).evaluate((element: HTMLButtonElement) => element.click())
  }
  expect(await input.evaluate(element => {
    const key = Object.keys(element).find(key => key.startsWith('__reactProps$'))!
    return (element as unknown as Record<string, unknown>)[key] ===
      (window as unknown as { previousEditorProps: unknown }).previousEditorProps
  })).toBe(true)
  expect(await node!.evaluate(element => element.isConnected)).toBe(true)
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLTextAreaElement) => ({ start: element.selectionStart, end: element.selectionEnd }))).toEqual(selection)
  await expect(input).toHaveValue('中文草稿')
  await expect(page.getByTestId('updates')).toHaveText(String(UPDATE_COUNT))
})

test('composer editor updates drafts, restores, clears and follows meaningful props', async ({ page }) => {
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
})

test('composer editor protects composition Enter and delegates normal keyboard events', async ({ page }) => {
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
})

test('composer editor grows for multiline drafts and shrinks after clearing', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  const initial = await input.evaluate(element => element.getBoundingClientRect().height)
  await input.fill('多行草稿\n'.repeat(30))
  const expanded = await input.evaluate(element => ({ height: element.getBoundingClientRect().height, overflow: element.style.overflowY }))
  expect(expanded.height).toBeGreaterThan(initial)
  expect(expanded.height).toBeLessThanOrEqual(MAX_HEIGHT)
  expect(expanded.overflow).toBe('auto')
  await page.getByRole('button', { name: 'clear draft' }).click()
  await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height)).toBe(initial)
})

test('composer editor recalculates wrapped draft height when its width changes', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('A draft that wraps when the conversation panel becomes narrow')
  const originalHeight = await input.evaluate(element => element.getBoundingClientRect().height)
  await page.getByRole('button', { name: 'toggle width' }).click()
  await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(originalHeight)
  await page.getByRole('button', { name: 'toggle width' }).click()
  await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height)).toBe(originalHeight)
})
