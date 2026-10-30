import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { openPreviewScenario, previewSurface, expect, test, type Page } from './testing'
import type { HistoryResult } from '../src/renderer/src/api'
import { PREVIEW_CATALOG } from './catalog'
import { PREVIEW_CONVERSATION } from './conversation'
import { PREVIEW_ORIGIN } from './constants'
import { PREVIEW_ARTIFACTS } from './publications'
import { previewConsumption } from './coverage'
import { capturePreview } from './capture'
import previewZh from './locales/zh.json'
import layoutZh from '../src/localization/locales/zh/layout.json'

const DELIVERY_TIMEOUT_MS = PREVIEW_CONVERSATION.interruptibleChunks.length * PREVIEW_CONVERSATION.interruptibleIntervalMs + 5_000

async function history(page: Page, session: string): Promise<HistoryResult> {
  const instance = new URL(page.url()).searchParams.get('previewInstance')!
  const response = await page.request.get(`/api/serve/history/${encodeURIComponent(session)}?previewInstance=${instance}`)
  expect(response.status()).toBe(200)
  return await response.json() as HistoryResult
}

async function submit(page: Page, text: string): Promise<string> {
  const accepted = page.waitForResponse(response => /\/api\/serve\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await previewSurface(page).getByTestId('composer-input').fill(text)
  await previewSurface(page).getByTestId('composer-send').click()
  const response = await accepted
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ accepted: true })
  return decodeURIComponent(new URL(response.url()).pathname.split('/').at(-2)!)
}

async function expandConversation(page: Page): Promise<void> {
  const conversation = previewSurface(page).getByTestId('workspace-conversation')
  if (await conversation.getAttribute('data-content-collapsed') === 'true') {
    const expand = previewSurface(page).getByTestId('workspace-expand-messages')
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expand.click()
    await expect(expand).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(conversation).toHaveAttribute('data-content-collapsed', 'false')
}

test('a real composer cancel produces no publication and a later completed turn reuses the same output history after reentry', {
  annotation: previewConsumption('viewer-outputs', 'outputs-delivery', ['empty', 'submitting', 'published', 'reentered']),
}, async ({ page }, testInfo) => {
  const failures: { path: string; status: number }[] = []
  const externalOrigins: string[] = []
  const pageErrors: string[] = []
  const requestFailures: { path: string; error: string | null }[] = []
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if ((path.startsWith('/api/') || path.startsWith('/__preview/')) && response.status() >= 400) failures.push({ path, status: response.status() })
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== PREVIEW_ORIGIN) externalOrigins.push(url.origin)
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('requestfailed', request => requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null }))
  try {
    const entry = PREVIEW_CATALOG.find(candidate => candidate.id === 'viewer-outputs')!
    const scene = entry.scenarios.find(candidate => candidate.id === 'outputs-delivery')!
    await page.goto(`/?previewInstance=${randomUUID()}&scene=page-home`)
    await page.keyboard.press('F8')
    await openPreviewScenario(page, entry.id, scene.id)
    await previewSurface(page).getByTestId('project-library').click()
    await previewSurface(page).getByTestId('project-library-content').getByRole('tab', { name: '任务产物', exact: true }).click()
    const outputs = previewSurface(page).getByTestId('project-outputs')
    await expect(outputs.getByText(layoutZh.emptyOutputs, { exact: true })).toBeVisible()
    await capturePreview(page, testInfo.outputPath('delivery-empty.png'))
    const session = await submit(page, '取消本次模拟文件交付')
    await expect(previewSurface(page).getByTestId('composer-stop')).toBeEnabled()
    await capturePreview(page, testInfo.outputPath('delivery-submitting.png'))
    await previewSurface(page).getByTestId('composer-stop').click()
    await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible()
    expect((await history(page, session)).artifacts).toEqual([])
    expect(await submit(page, '完成当前模拟文件交付')).toBe(session)
    await expect(previewSurface(page).getByTestId('composer-stop')).toBeVisible()
    await expect(previewSurface(page).getByTestId('composer-stop')).not.toBeVisible({ timeout: DELIVERY_TIMEOUT_MS })
    const completed = await history(page, session)
    expect(completed.artifacts).toHaveLength(PREVIEW_ARTIFACTS.sample.length)
    const published = completed.activity_events.filter(event => event.type === 'artifact_changed')
    expect(published.map(event => event.data.artifact)).toEqual(completed.artifacts)
    const final = completed.artifacts.find(artifact => artifact.role === 'final')!
    await expandConversation(page)
    await expect(previewSurface(page).getByTestId(`turn-artifact-${final.artifact_id}`)).toBeVisible()
    await previewSurface(page).getByTestId('project-library').click()
    await previewSurface(page).getByTestId('project-library-content').getByRole('tab', { name: '任务产物', exact: true }).click()
    await previewSurface(page).getByTestId('project-library-content').getByRole('button', { name: layoutZh.refreshLibrary, exact: true }).click()
    for (const artifact of completed.artifacts) await expect(outputs.getByTestId(`output-${artifact.artifact_id}`)).toBeVisible()
    await capturePreview(page, testInfo.outputPath('delivery-published-outputs.png'))
    await page.reload()
    await expect(previewSurface(page).getByTestId('composer-input')).toBeVisible()
    expect((await history(page, session)).artifacts).toEqual(completed.artifacts)
    await expandConversation(page)
    await expect(previewSurface(page).getByTestId(`turn-artifact-${final.artifact_id}`)).toBeVisible()
    await capturePreview(page, testInfo.outputPath('delivery-reentered.png'))
  } finally {
    const path = testInfo.outputPath('delivery-http-summary.json')
    await writeFile(path, JSON.stringify({ failures, externalOrigins, pageErrors, requestFailures }, null, 2))
    await testInfo.attach('delivery-http-summary', { path, contentType: 'application/json' })
  }
  expect(failures).toEqual([])
  expect(externalOrigins).toEqual([])
  expect(pageErrors).toEqual([])
})
