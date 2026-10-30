import { test as base, expect } from '@playwright/test'
import type { FrameLocator, Page, Request } from '@playwright/test'
import { PREVIEW_INSTANCE_PARAMETER, PREVIEW_SCENE_PARAMETER, DEFAULT_PREVIEW_SCENE, previewStatePath } from './bridge.ts'
import { PREVIEW_INSTANCE_PATTERN, PREVIEW_ORIGIN } from './constants.ts'
import { PREVIEW_VIEWPORT } from './viewport.ts'
import { PREVIEW_CATALOG } from './catalog.ts'
import zh from './locales/zh.json' with { type: 'json' }
import { pdfeNavigationGroup } from './hierarchy.ts'

const PREVIEW_CLEANUP_TIMEOUT_MS = 5_000

export { expect }
export type { Frame, Page, Request, Response, TestInfo } from '@playwright/test'

export function previewSurface(page: Page): FrameLocator {
  return page.frameLocator(`#${PREVIEW_VIEWPORT.frameId}`)
}

export async function openPreviewTools(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: /^(外观与诊断|Appearance and diagnostics)$/ })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}

export async function openPreviewScenario(page: Page, pageId: string, sceneId: string, verifyGuide = false): Promise<void> {
  const entry = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)
  const scene = entry?.scenarios.find(candidate => candidate.id === sceneId)
  if (!entry || !scene) throw new Error('Unknown preview scenario: ' + pageId + '/' + sceneId)
  const group = page.getByTestId('preview-group-' + pdfeNavigationGroup(entry).id)
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  const target = page.getByTestId('preview-page-' + entry.id)
  if (await target.count() && await target.getAttribute('aria-expanded') !== 'true') await target.click()
  if (scene.section) {
    const area = page.getByTestId('preview-section-' + entry.id + '-' + scene.section)
    if (await area.getAttribute('aria-expanded') !== 'true') await area.click()
  }
  const loaded = page.waitForEvent('domcontentloaded')
  await page.getByTestId('preview-scene-' + pageId + '-' + sceneId).click()
  await loaded
  await expect(page).toHaveURL(url => url.searchParams.get('page') === pageId && url.searchParams.get('scene') === sceneId)
  await expect(page.getByRole('heading', { name: zh.title, exact: true })).toBeVisible()
  if (verifyGuide) {
    await page.getByRole('button', { name: zh.guide, exact: true }).click()
    const guide = page.getByRole('dialog', { name: zh.guide, exact: true })
    for (const text of [...entry.entryInstructions ?? [], ...scene.limitations]) await expect(guide.getByText(text, { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(guide).not.toBeVisible()
  }
}

export function previewRequestInstance(input: string, origin = PREVIEW_ORIGIN): string | null {
  let url: URL
  try { url = new URL(input) } catch { return null }
  if (url.origin !== origin) return null
  const instance = url.searchParams.get(PREVIEW_INSTANCE_PARAMETER)
  return instance && PREVIEW_INSTANCE_PATTERN.test(instance) ? instance : null
}

export const test = base.extend<{ previewLifetime: void }>({
  previewLifetime: [async ({ context, request, baseURL }, use, testInfo) => {
    const origin = new URL(baseURL ?? PREVIEW_ORIGIN).origin
    const instances = new Set<string>()
    const collect = (request: Request): void => {
      const instance = previewRequestInstance(request.url(), origin)
      if (instance) instances.add(instance)
    }
    context.on('request', collect)
    await use()
    context.off('request', collect)
    const pages = context.pages().filter(page => !page.isClosed())
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [index, page] of pages.entries()) {
        const path = testInfo.outputPath(`preview-before-cleanup-${index}.png`)
        await page.screenshot({ path, timeout: PREVIEW_CLEANUP_TIMEOUT_MS })
        await testInfo.attach(`preview-before-cleanup-${index}`, { path, contentType: 'image/png' })
      }
    }
    await Promise.all(pages.map(page => page.goto('about:blank', {
      waitUntil: 'commit', timeout: PREVIEW_CLEANUP_TIMEOUT_MS,
    })))
    for (const instance of instances) {
      const url = new URL(previewStatePath(instance, DEFAULT_PREVIEW_SCENE), origin)
      url.searchParams.delete(PREVIEW_SCENE_PARAMETER)
      const response = await request.delete(url.href)
      if (response.status() !== 200 && response.status() !== 404) throw new Error(`Preview instance disposal failed: ${response.status()}`)
    }
  }, { auto: true }],
})
