import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession, liveStatus } from './fixtures/electron'
import { createRuntime, seedSkillHost } from './fixtures/runtime'
import { seedProject } from './fixtures/workbench'

const PASTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
const RUNTIME_READY_TIMEOUT_MS = 45_000
const ATTACHMENT_TIMEOUT_MS = 30_000
const DRAFT = '请分析粘贴的截图。'
const PASTED_TEXT = '保留普通文本粘贴\n第二行'
const RENDERER_PREFERENCES_FILE = 'renderer-preferences.json'
const FIND_PASTEBOARD_FORMAT = 'electron application/findtext'

test('composer pastes clipboard images through attachments without replacing its text draft', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  seedSkillHost(runtime)
  writeFileSync(join(runtime.userData, RENDERER_PREFERENCES_FILE), JSON.stringify({
    language: 'zh',
    onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map(group => [group, true])) }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    let turnSubmissions = 0
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === 'POST' && pathname.startsWith('/api/serve/sessions/') && pathname.endsWith('/turns')) {
        turnSubmissions += 1
      }
    })
    await seedProject(page, runtime)
    await expect.poll(async () => (await liveStatus(page))?.runtimeReady, {
      timeout: RUNTIME_READY_TIMEOUT_MS
    }).toBe(true)
    const input = page.getByTestId('composer-input')
    const attachmentTray = page.getByTestId('composer-drop-zone').getByTestId('attachment-images')
    const attachments = attachmentTray.getByRole('button', { name: /^查看图片 / })
    await input.fill(DRAFT)
    const source = await page.screenshot({ path: join(runtime.artifacts, 'clipboard-source.png') })
    await desktop.app!.evaluate(async ({ clipboard, ClipboardItem }, { bytes, findPasteboardFormat }) => {
      const state = globalThis as typeof globalThis & { composerClipboard?: Electron.ClipboardItem[] }
      const copies = []
      for (const item of await clipboard.read()) {
        const types = item.types.filter(type => type !== findPasteboardFormat)
        if (types.length === 0) continue
        const entries = await Promise.all(types.map(async type => [type, await item.getType(type)] as const))
        copies.push(new ClipboardItem(Object.fromEntries(entries)))
      }
      state.composerClipboard = copies
      await clipboard.write([new ClipboardItem({
        'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        'text/plain': new Blob(['image fallback must not replace the draft'], { type: 'text/plain' })
      })])
    }, { bytes: Array.from(source), findPasteboardFormat: FIND_PASTEBOARD_FORMAT })
    const paste = async (): Promise<void> => {
      await input.focus()
      await expect(input).toBeFocused()
      await input.press(PASTE_SHORTCUT)
    }
    const [previewResult] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'GET' && url.pathname.startsWith('/api/serve/sessions/') &&
          url.pathname.endsWith('/files/raw') && url.searchParams.has('path')
      }),
      paste()
    ])
    await expect(attachments).toHaveCount(1, { timeout: ATTACHMENT_TIMEOUT_MS })
    await expect(input).toHaveValue(DRAFT)
    const sessionId = (await liveStatus(page))?.activeSession
    expect(sessionId).toBeTruthy()
    await page.screenshot({ path: join(runtime.artifacts, 'composer-pasted-image.png') })
    expect(new URL(previewResult.url()).pathname).toBe(`/api/serve/sessions/${sessionId}/files/raw`)
    expect(previewResult.ok(), previewResult.ok() ? previewResult.url() : await previewResult.text()).toBe(true)
    await attachments.click()
    const viewer = page.getByTestId('attachment-image-viewer')
    const preview = viewer.locator('img')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: join(runtime.artifacts, 'composer-image-preview.png') })
    await page.keyboard.press('Escape')
    await expect(viewer).not.toBeVisible()
    await attachmentTray.getByRole('button', { name: /^移除图片 / }).click()
    await expect(attachments).toHaveCount(0)
    await expect(input).toHaveValue(DRAFT)

    await desktop.app!.evaluate(async ({ clipboard, ClipboardItem }, bytes) => {
      await clipboard.write([new ClipboardItem({
        'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      })])
    }, Array.from(source))
    const upload = page.waitForResponse(response => (
      response.url().endsWith(`/api/serve/sessions/${sessionId}/attachments`)
      && response.request().method() === 'POST'
    ))
    await paste()
    const uploaded = await upload
    expect(uploaded.ok(), await uploaded.text()).toBe(true)
    const body = await uploaded.json()
    expect(body.media_type).toBe('image/png')
    expect(await desktop.app!.evaluate(({ nativeImage }, data) => {
      const original = nativeImage.createFromBuffer(Buffer.from(data.bytes))
      const persisted = nativeImage.createFromPath(data.path)
      return original.toBitmap().equals(persisted.toBitmap())
    }, { bytes: Array.from(source), path: body.absolute_path })).toBe(true)
    await expect(attachments).toHaveCount(1)
    expect((await liveStatus(page))?.activeSession).toBe(sessionId)
    await expect(input).toHaveValue(DRAFT)

    await desktop.app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), PASTED_TEXT)
    await input.fill('')
    await paste()
    await expect(input).toHaveValue(PASTED_TEXT)
    await expect(attachments).toHaveCount(1)
    await page.screenshot({ path: join(runtime.artifacts, 'composer-image-and-text.png') })
    expect(turnSubmissions).toBe(0)
    desktop.assertNoPageErrors()
  } finally {
    try {
      if (desktop.app) await desktop.app.evaluate(async ({ clipboard }) => {
        const state = globalThis as typeof globalThis & { composerClipboard?: Electron.ClipboardItem[] }
        if (!state.composerClipboard) return
        if (state.composerClipboard.length === 0) clipboard.clear()
        else await clipboard.write(state.composerClipboard)
      })
    } finally {
      await desktop.attachArtifacts()
    }
  }
})
