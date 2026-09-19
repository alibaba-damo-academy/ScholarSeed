import { expect, test } from '@playwright/test'

import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const EXPECTED_ELECTRON_VERSION = '44.3.0'
const MINIMUM_EMBEDDED_NODE_MAJOR = 24

test('Electron 44 starts the real desktop stack with the expected runtimes', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const page = await desktop.launch()
    const versions = await desktop.app!.evaluate(() => ({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    }))
    const health = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/api/healthz`)
      return { status: response.status, body: await response.json() }
    }, await apiBase(page))

    expect(versions.electron).toBe(EXPECTED_ELECTRON_VERSION)
    expect(Number.parseInt(versions.node.split('.')[0], 10)).toBeGreaterThanOrEqual(MINIMUM_EMBEDDED_NODE_MAJOR)
    expect(versions.chromium).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(health).toMatchObject({
      status: 200,
      body: { ok: true, stack: 'codex-appserver', runtime_id: 'codex' }
    })
    await expect(page.getByTestId('workbench-shell')).toBeVisible()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('preload IPC remains available after a renderer reload', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const page = await desktop.launch()
    const initialApiBase = await apiBase(page)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('workbench-shell')).toBeVisible()

    expect(await apiBase(page)).toBe(initialApiBase)
    expect(await page.evaluate(() => typeof window.scholarseed.getApiBase)).toBe('function')
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('desktop can close and relaunch against the same isolated runtime', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const firstPage = await desktop.launch()
    const firstApiBase = await apiBase(firstPage)
    await desktop.close()

    const secondPage = await desktop.launch()
    const secondApiBase = await apiBase(secondPage)
    const health = await secondPage.evaluate(async (base) => {
      const response = await fetch(`${base}/api/healthz`)
      return response.ok
    }, secondApiBase)

    expect(firstApiBase).not.toBe('')
    expect(secondApiBase).not.toBe('')
    expect(health).toBe(true)
    await expect(secondPage.getByTestId('composer-send')).toBeVisible()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('Office clipboard acquisition reads real Electron image and text payloads', async ({}, testInfo) => {
  const desktop = new DesktopSession(createRuntime(testInfo), testInfo)
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(async ({ clipboard }) => {
      const state = globalThis as typeof globalThis & { savedClipboard?: Electron.ClipboardItem[] }
      state.savedClipboard = await clipboard.read()
      await clipboard.writeText('Office clipboard compatibility')
    })
    const text = await page.evaluate(() => window.scholarseed.acquireOfficeImage!('clipboard'))
    expect(text).toEqual({ status: 'text', text: 'Office clipboard compatibility' })
    const original = await desktop.app!.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
      const image = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
      const bytes = image.toPNG()
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      return Array.from(bytes)
    })
    const result = await page.evaluate(async () => {
      const image = await window.scholarseed.acquireOfficeImage!('clipboard')
      return image.status === 'image' ? { ...image, bytes: Array.from(image.bytes) } : image
    })
    expect(result).toEqual({ status: 'image', bytes: original })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.app) await desktop.app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const state = globalThis as typeof globalThis & { savedClipboard?: Electron.ClipboardItem[] }
      if (state.savedClipboard) {
        const copies = await Promise.all(state.savedClipboard.map(async item => {
          const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)] as const))
          return new ClipboardItem(Object.fromEntries(entries))
        }))
        await clipboard.write(copies)
      }
    })
    await desktop.attachArtifacts()
    await desktop.close()
  }
})
