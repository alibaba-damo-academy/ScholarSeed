import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { createCfHtmlFixture, parseCfHtml } from './fixtures/cf-html'
import { apiBase, DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'

const EXPECTED_ELECTRON_VERSION = '44.3.0'
const MINIMUM_EMBEDDED_NODE_MAJOR = 24
const CLIPBOARD_SHORTCUT = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
const CLIPBOARD_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlBueQAAAAASUVORK5CYII='
const WINDOWS_HTML_CLIPBOARD_FORMAT = 'HTML Format'

function readWindowsCfHtml(): string {
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$value = [Windows.Forms.Clipboard]::GetDataObject().GetData('${WINDOWS_HTML_CLIPBOARD_FORMAT}')`,
    'if ($null -eq $value) { exit 3 }',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value))'
  ].join('; ')
  const encoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8'
  }).trim()
  return Buffer.from(encoded, 'base64').toString('utf8')
}

test('CF_HTML parser validates UTF-8 byte offsets, line endings, and image counts', () => {
  for (const lineEnding of ['\n', '\r\n']) {
    for (const imageCount of [0, 1, 2]) {
      const images = Array.from({ length: imageCount }, (_, index) => `<img src="data:image/png;base64,image-${index}" alt="截图 ${index + 1}">`).join('')
      const fragment = `<section><h1>反馈报告 😀</h1><p>中文正文</p>${images}</section>`
      const raw = createCfHtmlFixture(fragment, lineEnding)
      const parsed = parseCfHtml(raw)

      expect(parsed.fragment).toBe(fragment)
      expect(parsed.fragmentByteLength).toBe(Buffer.byteLength(fragment, 'utf8'))
      expect(parsed.fragmentImageCount).toBe(imageCount)
      expect(parsed.headerLineEnding).toBe(lineEnding)
    }
  }

  const unicodePayload = createCfHtmlFixture('<p>😀</p>', '\r\n')
  const unicodeOffsets = parseCfHtml(unicodePayload).offsets
  const splitEmojiOffset = unicodeOffsets.StartFragment + Buffer.byteLength('<p>', 'utf8') + 1
  const malformedPayload = unicodePayload.replace(
    `EndFragment:${unicodeOffsets.EndFragment.toString().padStart(10, '0')}`,
    `EndFragment:${splitEmojiOffset.toString().padStart(10, '0')}`
  )
  expect(() => parseCfHtml(malformedPayload)).toThrow('CF_HTML fragment offsets split a UTF-8 character')
})

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

test('rich feedback clipboard exposes HTML and a readable plain fallback to Chromium', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const text = '# 反馈报告 😀\n\n正文\n\n- 截图说明 1：设置页面'
  const html = `<div><h1>反馈报告 😀</h1><p>正文</p><figure><img src="${CLIPBOARD_IMAGE_DATA_URL}" alt="截图说明 1"><figcaption>截图说明 1：设置页面</figcaption></figure></div>`
  try {
    const page = await desktop.launch()
    await desktop.app!.evaluate(async ({ clipboard }) => {
      const state = globalThis as typeof globalThis & { savedClipboard?: Electron.ClipboardItem[] }
      state.savedClipboard = await clipboard.read()
    })

    expect(await page.evaluate((payload) => window.scholarseed.writeClipboardContent(payload), { text, html })).toEqual({ ok: true })
    const nativeClipboard = await desktop.app!.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      return {
        types: items.flatMap(item => item.types),
        text: await clipboard.readText(),
        html: await Promise.all(items.map(async item => item.types.includes('text/html')
          ? (await item.getType('text/html')).text()
          : ''))
      }
    })
    expect(nativeClipboard.types).toContain('text/plain')
    expect(nativeClipboard.types).toContain('text/html')
    expect(nativeClipboard.text).toBe(text)
    expect(nativeClipboard.html.some(value => value.includes(html))).toBe(true)
    if (process.platform === 'win32') {
      const rawCfHtml = readWindowsCfHtml()
      const parsedCfHtml = parseCfHtml(rawCfHtml)
      writeFileSync(join(runtime.artifacts, 'windows-cf-html.txt'), rawCfHtml)
      writeFileSync(join(runtime.artifacts, 'windows-cf-html.json'), JSON.stringify(parsedCfHtml, null, 2))
      expect(parsedCfHtml.html).toContain('反馈报告 😀')
      expect(parsedCfHtml.fragmentImageCount).toBe(1)
      expect(parsedCfHtml.fragment).toContain(CLIPBOARD_IMAGE_DATA_URL)
    }

    await page.evaluate(() => {
      const target = document.createElement('div')
      target.contentEditable = 'true'
      target.dataset.testid = 'clipboard-event-target'
      target.textContent = 'paste target'
      target.addEventListener('paste', (event) => {
        event.preventDefault()
        const data = event.clipboardData
        target.dataset.result = JSON.stringify({
          types: Array.from(data?.types ?? []),
          items: Array.from(data?.items ?? []).map(item => ({ kind: item.kind, type: item.type })),
          files: Array.from(data?.files ?? []).map(file => ({ name: file.name, type: file.type, size: file.size })),
          html: data?.getData('text/html') ?? '',
          text: data?.getData('text/plain') ?? ''
        })
      }, { once: true })
      document.body.append(target)
    })
    const target = page.getByTestId('clipboard-event-target')
    await page.bringToFront()
    await target.click()
    await page.keyboard.press(CLIPBOARD_SHORTCUT)
    await expect.poll(() => target.getAttribute('data-result')).not.toBeNull()
    const event = JSON.parse((await target.getAttribute('data-result'))!) as {
      types: string[]
      items: Array<{ kind: string; type: string }>
      files: Array<{ name: string; type: string; size: number }>
      html: string
      text: string
    }
    writeFileSync(join(runtime.artifacts, 'rich-clipboard-event.json'), JSON.stringify(event, null, 2))
    expect(event.types).toEqual(expect.arrayContaining(['text/plain', 'text/html']))
    expect(event.items).toEqual(expect.arrayContaining([
      { kind: 'string', type: 'text/plain' },
      { kind: 'string', type: 'text/html' }
    ]))
    expect(event.files).toEqual([])
    expect(event.html).toContain('<img')
    expect(event.html).toContain(CLIPBOARD_IMAGE_DATA_URL)
    expect(event.text).toBe(text)
    expect(event.text).not.toContain('data:image/')
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
