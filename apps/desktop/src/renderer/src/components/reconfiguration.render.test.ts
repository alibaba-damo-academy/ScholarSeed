import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

async function withFixture(operation: (page: Page, url: string) => Promise<void>): Promise<void> {
  const server = await createServer({
    configFile: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    plugins: [react()], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    await operation(page, new URL('/components/reconfiguration.render.fixture.html', server.resolvedUrls!.local[0]).href)
  } finally {
    await browser.close()
    await server.close()
  }
}

const SESSION = 'c'.repeat(32)
const IDENTITY = '12345678-1234-1234-1234-123456789abc'
const operation = (state = 'accepted', model = 'fixture-model') => ({
  session_id: SESSION, request_id: IDENTITY, model_id: model, state, error: '',
})

test('background status has no confirmation, survives remount and only reads', { timeout: 60000 }, async () => {
  await withFixture(async (page, url) => {
    let state = 'accepted'
    let polls = 0
    const methods: string[] = []
    await page.route('**/api/serve/sessions/*/runtime/reconfigure**', route => {
      methods.push(route.request().method())
      polls += 1
      return route.fulfill({ json: operation(state) })
    })
    await page.goto(url)
    await expect(page.getByTestId('runtime-reconfigure-status')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '确认切换' })).toHaveCount(0)
    await expect.poll(() => polls).toBeGreaterThanOrEqual(2)
    await page.getByRole('button', { name: 'Toggle fixture' }).click()
    state = 'applied'
    await page.getByRole('button', { name: 'Toggle fixture' }).click()
    await expect(page.getByTestId('runtime-reconfigure-status')).toContainText('运行环境已自动切换')
    assert.ok(methods.every(method => method === 'GET'))
  })
})

test('unknown query outcomes retry reads without issuing a switch or replay', { timeout: 60000 }, async () => {
  await withFixture(async (page, url) => {
    let available = false
    const methods: string[] = []
    await page.route('**/api/serve/sessions/*/runtime/reconfigure**', route => {
      methods.push(route.request().method())
      return route.fulfill(available ? { json: operation('applied') } : { status: 503 })
    })
    await page.goto(url)
    await expect(page.getByTestId('runtime-reconfigure-status')).toContainText('正在核对后台切换结果')
    available = true
    await expect(page.getByTestId('runtime-reconfigure-status')).toContainText('运行环境已自动切换')
    assert.ok(methods.length >= 2)
    assert.ok(methods.every(method => method === 'GET'))
  })
})

test('a completed historical switch cannot claim success for another selected model', { timeout: 60000 }, async () => {
  await withFixture(async (page, url) => {
    let queries = 0
    await page.route('**/api/serve/sessions/*/runtime/reconfigure**', route => {
      queries += 1
      return route.fulfill({ json: operation('applied') })
    })
    await page.goto(url)
    await expect(page.getByTestId('runtime-reconfigure-status')).toContainText('运行环境已自动切换')
    await page.getByRole('button', { name: 'Change model' }).click()
    await expect.poll(() => queries).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('runtime-reconfigure-status')).toHaveCount(0)
  })
})

test('late status from the previous session never paints the new session', { timeout: 60000 }, async () => {
  await withFixture(async (page, url) => {
    let release: (() => void) | undefined
    let started = false
    await page.route('**/api/serve/sessions/*/runtime/reconfigure**', async route => {
      if (route.request().url().includes(SESSION)) {
        started = true
        await new Promise<void>(resolve => { release = resolve })
        await route.fulfill({ json: operation('applied') })
      } else await route.fulfill({ status: 204 })
    })
    await page.goto(url)
    await expect.poll(() => started).toBe(true)
    await page.getByRole('button', { name: 'Change session' }).click()
    release?.()
    await expect(page.getByTestId('runtime-reconfigure-status')).toHaveCount(0)
  })
})

test('recovery state refresh observes an operation that began after the initial empty lookup', { timeout: 60000 }, async () => {
  await withFixture(async (page, url) => {
    let available = false
    let queries = 0
    const methods: string[] = []
    await page.route('**/api/serve/sessions/*/runtime/reconfigure**', route => {
      queries += 1
      methods.push(route.request().method())
      return route.fulfill(available ? { json: operation() } : { status: 204 })
    })
    await page.goto(url)
    await expect.poll(() => queries).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('runtime-reconfigure-status')).toHaveCount(0)
    available = true
    await page.getByRole('button', { name: 'Refresh status' }).click()
    await expect(page.getByTestId('runtime-reconfigure-status')).toContainText('正在后台等待任务和审批收尾')
    assert.ok(methods.every(method => method === 'GET'))
  })
})
