import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before, type TestContext } from 'node:test'
import { chromium, expect, type Page, type Request } from '@playwright/test'
import { createServer } from 'vite'
import { renderFixture } from '../../test-helpers/render.ts'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOTS = path.resolve(ROOT, '../../../test-results')
const FIXTURE_STARTUP_TIMEOUT_MS = 60_000
const INSTANCE = 'launch-instance'
const SESSION = 'd'.repeat(32)
const IMAGE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=',
  'base64'
)
const CONTINUE_TASK_PROMPT = JSON.parse(
  readFileSync(new URL('../../localization/locales/zh/components.json', import.meta.url), 'utf8')
).stream.continueTaskPrompt as string
const MODELS = ['model-a', 'model-b'].map((key) => ({
  key,
  label: key,
  model_name: key,
  source: 'builtin',
  reasoning_efforts: ['low', 'high'],
}))

let resources: Awaited<ReturnType<typeof renderFixture>>

test('native preview failures keep selections and release loaded image URLs', async (context) => {
  let legacyReads = 0
  await fixture(
    context,
    async (page) => {
      await page.evaluate(
        (bytes) => {
          Reflect.set(window, 'scholarseed', {
            pickImport: async () => [],
            pickImportPreview: async () => [
              {
                path: '/chosen/good.png',
                imagePreview: { status: 'image', bytes: new Uint8Array(bytes) },
              },
              {
                path: '/chosen/failed.png',
                imagePreview: Reflect.get(window, 'nativePreviewRecovered')
                  ? { status: 'image', bytes: new Uint8Array(bytes) }
                  : { status: 'error', code: 'pixel_limit', maxPixels: 40_000_000 },
              },
              { path: '/chosen/notes.txt', imagePreview: { status: 'empty' } },
              { path: '/chosen/folder', imagePreview: { status: 'empty' } },
            ],
          })
          const created: string[] = []
          const revoked: string[] = []
          const create = URL.createObjectURL.bind(URL)
          const revoke = URL.revokeObjectURL.bind(URL)
          Reflect.set(window, 'nativePreviewUrls', { created, revoked })
          URL.createObjectURL = (blob) => {
            const url = create(blob)
            created.push(url)
            return url
          }
          URL.revokeObjectURL = (url) => {
            revoked.push(url)
            revoke(url)
          }
        },
        [...IMAGE_PIXEL]
      )
      await page.getByTestId('composer-plus').click()
      await page.getByTestId('composer-add-file').click()
      const tray = page.getByTestId('composer-reference-tray')
      await expect(tray.getByRole('img', { name: 'good.png', exact: true })).toBeVisible()
      await tray.getByRole('button', { name: /查看图片 failed.png/ }).click()
      const viewer = page.getByTestId('attachment-image-viewer')
      await expect(viewer.getByRole('alert')).toContainText('图片加载失败')
      await expect(viewer.locator('output')).toContainText('2 / 2')
      await page.keyboard.press('ArrowLeft')
      await expect(viewer.getByRole('img', { name: 'good.png', exact: true })).toBeVisible()
      assert.equal(legacyReads, 0)
      await page.keyboard.press('Escape')
      await expect(tray.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible()
      await expect(tray.getByRole('button', { name: 'folder', exact: true })).toBeVisible()
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs.length),
        4
      )
      const identities = await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').state.composerRefs.map((ref: { id: string }) => ref.id)
      )
      await page.evaluate(() => Reflect.set(window, 'nativePreviewRecovered', true))
      await page.getByTestId('composer-plus').click()
      await page.getByTestId('composer-add-file').click()
      await expect(tray.getByRole('img', { name: 'failed.png', exact: true })).toBeVisible()
      assert.deepEqual(
        await page.evaluate(() =>
          Reflect.get(window, 'launchProbe').state.composerRefs.map((ref: { id: string }) => ref.id)
        ),
        identities
      )
      await page.evaluate(() => Reflect.get(window, 'launchProbe').hide())
      await expect
        .poll(() =>
          page.evaluate(() => {
            const urls = Reflect.get(window, 'nativePreviewUrls')
            return (
              urls.created.length === 3 &&
              urls.created.every((url: string) => urls.revoked.includes(url))
            )
          })
        )
        .toBe(true)
    },
    async (page) => {
      await page.route('**/api/research/workspace/file/raw?*', (route) => {
        legacyReads++
        return route.fulfill({ status: 404 })
      })
    }
  )
})

test('native draft image previews never replace the original file registration', async (context) => {
  await fixture(context, async (page) => {
    const control = await preparation(page)
    control.finish()
    let registrations = 0
    let uploads = 0
    const turns: unknown[] = []
    await page.evaluate(
      (bytes) => {
        Reflect.set(window, 'nativeImageSaves', [])
        Reflect.set(window, 'scholarseed', {
          getApiBase: () => '',
          pickImport: async () => ['/chosen/image.jpeg'],
          appsForFile: async () => [],
          saveFileCopy: async (payload: unknown) => {
            Reflect.get(window, 'nativeImageSaves').push(payload)
            return { ok: true }
          },
          pickImportPreview: async () => [
            {
              path: '/chosen/image.jpeg',
              imagePreview: { status: 'image', bytes: new Uint8Array(bytes) },
            },
          ],
        })
        Reflect.get(window, 'launchProbe').surface('assistant')
      },
      [...IMAGE_PIXEL]
    )
    await page.route('**/api/assistant/sessions/*/context', (route) =>
      route.fulfill({
        json: {
          session_id: SESSION,
          revision: 0,
          project_policy: 'explicit_only',
          search_scope: 'web',
          refs: [],
          capabilities: [],
          updated_at: 0,
        },
      })
    )
    await page.route('**/api/serve/sessions/open', (route) => {
      const response = opened()
      return route.fulfill({
        json: { ...response, runtime: { ...response.runtime, model_id: 'model-a' } },
      })
    })
    await page.route(`**/api/serve/sessions/${SESSION}/file-references`, (route) => {
      registrations++
      assert.deepEqual(route.request().postDataJSON(), { paths: ['/chosen/image.jpeg'] })
      return route.fulfill({
        json: {
          references: [
            {
              kind: 'file',
              path: '/chosen/image.jpeg',
              name: 'image.jpeg',
              reference_id: 'original-reference',
              media_type: 'image/jpeg',
              size: 900,
              sha256: 'original-file-sha',
            },
          ],
        },
      })
    })
    await page.route('**/api/serve/sessions/*/attachments', (route) => {
      uploads++
      return route.fulfill({ status: 500 })
    })
    await page.route(`**/api/serve/sessions/${SESSION}/turns`, (route) => {
      turns.push(route.request().postDataJSON())
      return route.fulfill({
        json: { ok: true, accepted: true, disposition: 'direct', turn_id: 'native-attachment' },
      })
    })
    await page.getByTestId('composer-plus').click()
    await page.getByTestId('composer-add-file').click()
    await expect(
      page
        .getByTestId('composer-reference-tray')
        .getByRole('img', { name: 'image.jpeg', exact: true })
    ).toBeVisible()
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'launchProbe').state.activeSession),
      null
    )
    assert.equal(registrations, 0)
    assert.deepEqual(
      await page.evaluate(() => {
        const reference = Reflect.get(window, 'launchProbe').state.composerRefs[0]
        return {
          path: reference.path,
          title: reference.title,
          mediaType: reference.mediaType,
          size: reference.size,
          sha256: reference.sha256,
          hasOriginalFile: Boolean(reference.localSource.file),
          previewType: reference.localSource.imagePreview.type,
        }
      }),
      {
        path: '/chosen/image.jpeg',
        title: 'image.jpeg',
        mediaType: undefined,
        size: undefined,
        sha256: undefined,
        hasOriginalFile: false,
        previewType: 'image/png',
      }
    )
    await page.getByRole('button', { name: /查看图片 image.jpeg/ }).click()
    await page.getByRole('button', { name: '图片更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '另存为…', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'nativeImageSaves').length))
      .toBe(1)
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'nativeImageSaves')[0]), {
      sourcePath: '/chosen/image.jpeg',
      suggestedName: 'image.jpeg',
    })
    await page.keyboard.press('Escape')
    await page.getByTestId('composer-input').fill('Use the original image')
    await page.getByTestId('composer-send').click()
    await expect.poll(() => turns.length).toBe(1)
    assert.equal(registrations, 1)
    assert.equal(uploads, 0)
    assert.match(JSON.stringify(turns[0]), /original-reference/)
    assert.doesNotMatch(JSON.stringify(turns[0]), /imagePreview|blob:/)
  })
})

test('AiPanel shows removable PDF selections before a session exists', async (context) => {
  await fixture(
    context,
    async (page) => {
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          aiPanel: {
            ...probe.state.aiPanel,
            refs: [
              {
                ref_id: 'pdf-selection',
                kind: 'literature',
                source_id: 'paper',
                label: 'Draft paper',
                retention: 'next_turn',
                origin: 'explicit',
                anchor: {
                  document_id: 'attachment',
                  locator: { kind: 'pdf', page: 1, rects: [] },
                  preview_text: 'Selected PDF passage',
                  snapshot_text: 'Selected PDF passage',
                },
              },
            ],
          },
        })
      })
      const reference = page.getByTestId('ai-context-ref')
      await expect(reference).toContainText('Draft paper')
      await reference.hover()
      await expect(page.getByTestId('assistant-selection-quote')).toContainText(
        'Selected PDF passage'
      )
      await page.getByTestId('composer-input').click()
      await reference.getByRole('button', { name: /移除/ }).click()
      await expect(reference).toHaveCount(0)
      assert.deepEqual(
        await page.evaluate(() => {
          const state = Reflect.get(window, 'launchProbe').state
          return {
            session: state.activeSession,
            refs: state.aiPanel.refs,
            launch: state.turnLaunch,
          }
        }),
        { session: null, refs: [], launch: null }
      )
    },
    async (page) => {
      await page.addInitScript(() => Reflect.set(window, 'aiPanelFixture', true))
    }
  )
})

test('AiPanel keeps read-only, submitted and other-session references out of the draft', async (context) => {
  await fixture(
    context,
    async (page) => {
      await restoreSession(page)
      for (const scenario of [
        {
          panelSession: SESSION,
          activeSession: SESSION,
          readOnly: false,
          submitted: false,
          visible: true,
        },
        {
          panelSession: SESSION,
          activeSession: SESSION,
          readOnly: false,
          submitted: true,
          visible: false,
        },
        {
          panelSession: SESSION,
          activeSession: SESSION,
          readOnly: true,
          submitted: false,
          visible: false,
        },
        {
          panelSession: 'other-session',
          activeSession: SESSION,
          readOnly: false,
          submitted: false,
          visible: false,
        },
        {
          panelSession: null,
          activeSession: SESSION,
          readOnly: false,
          submitted: false,
          visible: false,
        },
        {
          panelSession: SESSION,
          activeSession: null,
          readOnly: false,
          submitted: false,
          visible: false,
        },
      ]) {
        await page.evaluate(
          ({ scenario, session }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              activeSession: scenario.activeSession,
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], readOnly: scenario.readOnly },
              },
              aiPanel: {
                ...probe.state.aiPanel,
                sessionId: scenario.panelSession,
                submittedRefIds: scenario.submitted ? ['context-reference'] : [],
                refs: [
                  {
                    ref_id: 'context-reference',
                    kind: 'dir',
                    source_id: 'documents',
                    label: 'Scoped reference',
                    retention: 'next_turn',
                    origin: 'explicit',
                  },
                ],
              },
            })
          },
          { scenario, session: SESSION }
        )
        await expect(page.getByTestId('ai-context-ref')).toHaveCount(scenario.visible ? 1 : 0)
      }
    },
    async (page) => {
      await page.addInitScript(() => Reflect.set(window, 'aiPanelFixture', true))
    }
  )
})

test('AiPanel combines context and pending images with source-scoped identities', async (context) => {
  await fixture(
    context,
    async (page) => {
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          aiPanel: {
            ...probe.state.aiPanel,
            refs: [
              {
                ref_id: 'same',
                kind: 'file',
                source_id: 'context.png',
                label: 'context.png',
                retention: 'next_turn',
                origin: 'explicit',
              },
              {
                ref_id: 'folder',
                kind: 'dir',
                source_id: 'folder',
                label: 'Context folder',
                retention: 'next_turn',
                origin: 'explicit',
              },
            ],
          },
        })
      })
      const tray = page.getByTestId('composer-reference-tray')
      await expect(tray.getByRole('button', { name: /查看图片 context.png/ })).toBeVisible()
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({
          composerRefs: [
            { type: 'file', id: 'same', title: 'pending.png', path: '/samples/pending.png' },
          ],
        })
      )
      await tray.getByRole('button', { name: /查看图片 pending.png/ }).click()
      const viewer = page.getByTestId('attachment-image-viewer')
      await expect(viewer).toHaveCount(1)
      await expect(viewer.getByRole('status')).toContainText('2 / 2')
      await page.keyboard.press('ArrowLeft')
      await expect(viewer.getByRole('heading')).toHaveText('context.png')
      await page.keyboard.press('Escape')
      const contextImage = tray.getByRole('img', { name: 'context.png', exact: true })
      const pendingImage = tray.getByRole('img', { name: 'pending.png', exact: true })
      await expect(contextImage).toBeVisible()
      await expect(pendingImage).toBeVisible()
      assert.notEqual(
        await contextImage.getAttribute('src'),
        await pendingImage.getAttribute('src')
      )
      await tray.getByRole('button', { name: '移除图片 context.png', exact: true }).click()
      await expect(tray.getByRole('button', { name: /查看图片 context.png/ })).toHaveCount(0)
      await expect(tray.getByRole('button', { name: /查看图片 pending.png/ })).toBeVisible()
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs[0].id),
        'same'
      )
      await expect(tray.getByText('Context folder', { exact: true })).toBeVisible()
    },
    async (page) => {
      await page.addInitScript(() => Reflect.set(window, 'aiPanelFixture', true))
      await page.route('**/api/research/workspace/file/raw?*', (route) =>
        route.fulfill({ contentType: 'image/png', body: IMAGE_PIXEL })
      )
      await page.route('**/api/workbench/open?*', (route) =>
        route.fulfill({
          json: {
            viewer: 'image',
            capabilities: {},
            revision: 'fixture',
            media_type: 'image/png',
            content_kind: 'binary',
          },
        })
      )
      await page.route('**/api/workbench/content?*', (route) =>
        route.fulfill({ contentType: 'image/png', body: IMAGE_PIXEL })
      )
    }
  )
})

test('composer shares one image gallery across ordered mixed draft references', async (context) => {
  const reads: string[] = []
  await fixture(
    context,
    async (page) => {
      await page.evaluate(() => {
        Reflect.get(window, 'launchProbe').patch({
          composerRefs: ['third.png', 'notes.txt', 'sample-folder', 'first.png', 'second.png'].map(
            (title) => ({
              type: title === 'sample-folder' ? 'directory' : 'file',
              id: title,
              title,
              path: `/samples/${title}`,
            })
          ),
        })
      })
      const tray = page.getByTestId('composer-reference-tray')
      await expect(tray.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible()
      await expect(tray.getByRole('button', { name: 'sample-folder', exact: true })).toBeVisible()
      await expect(tray.getByText('Context attachment', { exact: true })).toBeVisible()
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({ composerRefs: [...probe.state.composerRefs].reverse() })
      })
      await expect.poll(() => reads.length).toBe(3)
      await tray.getByRole('button', { name: /查看图片 first.png/ }).click()
      const viewer = page.getByTestId('attachment-image-viewer')
      await expect(viewer).toHaveCount(1)
      await expect(viewer.getByRole('status')).toContainText('2 / 3')
      await expect(viewer.getByRole('heading')).toHaveText('first.png')
      await page.keyboard.press('ArrowRight')
      await expect(viewer.getByRole('heading')).toHaveText('second.png')
      await viewer.getByRole('button', { name: '上一张', exact: true }).click()
      await page.keyboard.press('ArrowLeft')
      await expect(viewer.getByRole('heading')).toHaveText('third.png')
      assert.equal(reads.length, 3)
      await page.keyboard.press('Escape')
      await tray.getByRole('button', { name: '移除图片 first.png', exact: true }).click()
      await tray.getByRole('button', { name: /查看图片 second.png/ }).click()
      await expect(viewer.getByRole('heading')).toHaveText('second.png')
      await expect(viewer.getByRole('status')).toContainText('2 / 2')
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          composerRefs: probe.state.composerRefs.filter(
            (ref: { id: string }) => ref.id !== 'third.png'
          ),
        })
      })
      await expect(viewer).toHaveCount(0)
      await tray.getByRole('button', { name: /查看图片 second.png/ }).click()
      await expect(viewer.getByRole('status')).toContainText('1 / 1')
      await expect(viewer.getByRole('button', { name: '下一张', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await tray.getByRole('button', { name: '移除图片 second.png', exact: true }).click()
      await expect(tray.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible()
      await expect(tray.getByText('Context attachment', { exact: true })).toBeVisible()
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({
          composerRefs: [
            { type: 'skill', id: 'fixture-skill', title: 'Fixture skill', path: '/skills/fixture' },
          ],
        })
      )
      await expect(page.getByText('Fixture skill', { exact: true })).toBeVisible()
      await expect(tray.getByText('Context attachment', { exact: true })).toBeVisible()
      await page.evaluate(() => Reflect.get(window, 'launchProbe').patch({ composerRefs: [] }))
      await expect(tray.getByText('Context attachment', { exact: true })).toBeVisible()
      await page.evaluate(() => Reflect.get(window, 'launchProbe').hide())
      await expect
        .poll(() =>
          page.evaluate(() => {
            const probe = Reflect.get(window, 'imageUrls')
            return probe.created.every((url: string) => probe.revoked.includes(url))
          })
        )
        .toBe(true)
      assert.deepEqual(reads.slice(0, 3).sort(), [
        '/samples/first.png',
        '/samples/second.png',
        '/samples/third.png',
      ])
    },
    async (page) => {
      await page.addInitScript(() => {
        Reflect.set(window, 'composerContextFixture', true)
        const created: string[] = []
        const revoked: string[] = []
        const create = URL.createObjectURL.bind(URL)
        const revoke = URL.revokeObjectURL.bind(URL)
        Reflect.set(window, 'imageUrls', { created, revoked })
        URL.createObjectURL = (blob) => {
          const url = create(blob)
          created.push(url)
          return url
        }
        URL.revokeObjectURL = (url) => {
          revoked.push(url)
          revoke(url)
        }
      })
      await page.route('**/api/research/workspace/file/raw?*', (route) => {
        reads.push(new URL(route.request().url()).searchParams.get('path')!)
        return route.fulfill({ contentType: 'image/png', body: IMAGE_PIXEL })
      })
    }
  )
})

before(
  async () => {
    resources = await renderFixture(ROOT, {
      create: (config) =>
        createServer({
          ...config,
          define: { __SCHOLARSEED_WEB_VERSION__: JSON.stringify('test') },
          server: { ...config.server, hmr: false },
        }),
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
  },
  { timeout: FIXTURE_STARTUP_TIMEOUT_MS }
)

after(async () => {
  await resources?.close()
})

async function fixture(
  context: TestContext,
  run: (page: Page) => Promise<void>,
  prepare?: (page: Page) => Promise<void>
): Promise<void> {
  const { server } = resources
  const page = await resources.page(context)
  const errors: string[] = []
  const diagnostics: string[] = []
  const loading = new Set<Request>()
  const documents: Request[] = []
  const startedAt = performance.now()
  const events: { stage: string; elapsedMs: number }[] = []
  const record = (stage: string) => events.push({ stage, elapsedMs: performance.now() - startedAt })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    loading.add(request)
    if (request.isNavigationRequest()) {
      documents.push(request)
      record('browser-request')
    }
  })
  page.on('requestfinished', (request) => loading.delete(request))
  page.on('requestfailed', (request) => {
    loading.delete(request)
    diagnostics.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400)
      diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text())
  })
  page.on('domcontentloaded', () => record('domcontentloaded'))
  page.on('load', () => record('load'))
  try {
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, json: { error: 'fixture_unavailable' } })
    )
    await prepare?.(page)
    record('goto')
    await page.goto(new URL('/launch.render.fixture.html', server.resolvedUrls!.local[0]).href)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await page.evaluate(
      ({ models, instance }) =>
        Reflect.get(window, 'launchProbe').patch({
          model: 'model-a',
          serviceInstanceId: instance,
          runtimeReadiness: { ready: true },
          backendReady: false,
          workbenchReady: true,
          catalog: { models, hiddenModels: [], subscriptionGroups: [], personalProfiles: [] },
        }),
      { models: MODELS, instance: INSTANCE }
    )
    record('case')
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    record('failed')
    const document = await page
      .evaluate(() => ({
        url: location.href,
        body: globalThis.document.body?.innerText,
        rootChildren: globalThis.document.getElementById('root')?.childElementCount,
        scripts: Array.from(globalThis.document.scripts, (script) => script.src),
        visibility: globalThis.document.visibilityState,
        focused: globalThis.document.hasFocus(),
        fonts: globalThis.document.fonts.status,
      }))
      .catch((failure) => ({ error: String(failure) }))
    let screenshot: string
    try {
      await mkdir(SCREENSHOTS, { recursive: true })
      const directory = await mkdtemp(path.join(SCREENSHOTS, 'launch-'))
      screenshot = path.join(directory, 'failure.png')
      await page.screenshot({ path: screenshot })
    } catch (failure) {
      screenshot = `capture failed: ${String(failure)}`
    }
    throw new Error(
      JSON.stringify({
        errors,
        diagnostics,
        document,
        loading: [...loading].map((request) => request.url()),
        network: documents.map((request) => ({ url: request.url(), timing: request.timing() })),
        events,
        screenshot,
        failure: String(error),
      }),
      { cause: error }
    )
  }
}

test(
  'terminal announcements follow language changes without changing turn outcomes',
  { timeout: 60_000 },
  async (context) =>
    fixture(
      context,
      async (page) => {
        const announcement = page.locator('[role="status"][aria-live="polite"].sr-only')
        for (const outcome of ['running', 'unknown']) {
          await page.evaluate(
            ({ outcome, session }) => {
              const probe = Reflect.get(window, 'launchProbe')
              probe.patch({
                activeSession: session,
                threads: {
                  [session]: {
                    id: session,
                    sessionId: session,
                    title: 'Announcement test',
                    conversation: [],
                    lastSeq: 0,
                    turnOutcomes: { turn: outcome },
                    resumeState: 'ready',
                  },
                },
              })
            },
            { outcome, session: SESSION }
          )
          await expect(announcement).toHaveCount(0)
        }
        for (const [outcome, chinese, english] of [
          ['completed', '助手回复已完成', 'Assistant response completed'],
          ['failed', '助手回复失败', 'Assistant response failed'],
          ['interrupted', '助手回复已中断', 'Assistant response interrupted'],
        ]) {
          await page.evaluate(
            ({ outcome, session }) => {
              const probe = Reflect.get(window, 'launchProbe')
              probe.patch({
                threads: {
                  [session]: { ...probe.state.threads[session], turnOutcomes: { turn: outcome } },
                },
              })
            },
            { outcome, session: SESSION }
          )
          await expect(announcement).toHaveText(chinese)
          for (const [language, expected] of [
            ['en', english],
            ['zh', chinese],
          ]) {
            await page.evaluate(
              (language) => Reflect.get(window, 'launchProbe').language(language),
              language
            )
            await expect(announcement).toHaveText(expected)
            assert.deepEqual(
              await page.evaluate(
                (session) => Reflect.get(window, 'launchProbe').state.threads[session].turnOutcomes,
                SESSION
              ),
              { turn: outcome }
            )
          }
          await page.evaluate((session) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              threads: {
                [session]: { ...probe.state.threads[session], turnOutcomes: { turn: 'running' } },
              },
            })
          }, SESSION)
          await expect(announcement).toHaveText(chinese)
        }
      },
      async (page) => {
        await page.addInitScript(() => Reflect.set(window, 'streamFixture', true))
      }
    )
)

test('skill menu localizes generated source labels without translating custom categories', async (context) => {
  const skills = [
    { name: 'preset-skill', category: '系统预置', category_source: 'builtin' },
    { name: 'user-skill', category: '用户安装', category_source: 'user' },
    { name: 'custom-skill', category: '用户安装' },
  ].map((skill) => ({
    ...skill,
    enabled: true,
    active: true,
    group: 'user',
    path: `/skills/${skill.name}/SKILL.md`,
    removable: true,
    toggleable: true,
  }))
  await fixture(
    context,
    async (page) => {
      const plus = page.getByTestId('composer-plus')
      const menu = page.getByTestId('composer-plus-menu')
      const customSkill = page.getByTestId('composer-skill-custom-skill')
      const openSkills = async (label: string) => {
        await expect(plus).toHaveAccessibleName(label)
        await expect(plus).toHaveAttribute('aria-expanded', 'false')
        await plus.click()
        await expect(menu).toBeVisible()
        await page.getByTestId('composer-skills-menu').hover()
      }
      for (const language of ['en', 'zh', 'en']) {
        await page.evaluate(
          (language) => Reflect.get(window, 'launchProbe').language(language),
          language
        )
        await openSkills(language === 'en' ? 'Add menu' : '加号菜单')
        await expect(page.getByTestId('composer-skill-preset-skill')).toContainText(
          language === 'en' ? 'System preset' : '系统预置'
        )
        await expect(page.getByTestId('composer-skill-user-skill')).toContainText(
          language === 'en' ? 'User installed' : '用户安装'
        )
        await expect(customSkill).toContainText('用户安装')
        await plus.click()
        await expect(menu).toHaveCount(0)
      }
      await openSkills('Add menu')
      await customSkill.click()
      await openSkills('Add menu')
      await customSkill.click()
      assert.equal(
        await page.evaluate(
          () =>
            Reflect.get(window, 'launchProbe').state.composerRefs.filter(
              (reference: { type: string; id: string }) =>
                reference.type === 'skill' && reference.id === 'custom-skill'
            ).length
        ),
        1
      )
    },
    async (page) => {
      await page.route('**/api/capabilities/skills?**', (route) =>
        route.fulfill({ json: { skills } })
      )
    }
  )
})

async function preparation(page: Page) {
  let state = 'accepted'
  let terminalObserved = false
  let request: { request_id: string; model_id: string } | null = null
  const receipt = () => ({
    ...request,
    session_id: null,
    state,
    error: state === 'rejected' ? 'test_preparation_failed' : '',
    service_instance_id: INSTANCE,
  })
  await page.route('**/api/serve/runtime/reconfiguration', (route) =>
    route.fulfill({ json: { state: null, service_instance_id: INSTANCE } })
  )
  await page.route('**/api/serve/runtime/prepare**', (route) => {
    if (route.request().method() === 'POST') request = route.request().postDataJSON()
    if (state !== 'accepted') terminalObserved = true
    return route.fulfill({ json: receipt() })
  })
  return {
    finish: (next = 'applied') => {
      state = next
    },
    terminalObserved: () => terminalObserved,
  }
}

function opened() {
  return {
    session_id: SESSION,
    runtime_id: 'codex',
    runtime: { name: 'codex', model_id: 'model-b' },
    readiness: { ready: true },
    capabilities: {},
    uncertain_operations: [],
    unknown_outcome: false,
    active_turn_id: null,
    running: false,
    project_path: null,
  }
}

async function chooseAndSend(page: Page): Promise<void> {
  await page.getByTestId('model-selector-toggle').click()
  await page.getByTestId('model-option-model-b').click()
  await page.getByTestId('composer-input').fill('first prepared message')
  await page.getByTestId('composer-send').click()
}

test('new task stages local attachments without activating a session until send', async (context) => {
  await fixture(context, async (page) => {
    const control = await preparation(page)
    control.finish()
    const selectedPath = '/tmp/new-task.txt'
    const canonicalPath = '/private/tmp/new-task.txt'
    let opens = 0
    let registrations = 0
    const turns: unknown[] = []
    await page.evaluate((selectedPath) => {
      Reflect.set(window, 'scholarseed', {
        getApiBase: () => '',
        pathForFile: () => selectedPath,
        addAuthorizedRoot: async () => true,
      })
      Reflect.get(window, 'launchProbe').surface('assistant')
    }, selectedPath)
    await page.route('**/api/assistant/sessions/*/context', (route) =>
      route.fulfill({
        json: {
          session_id: SESSION,
          revision: 0,
          project_policy: 'explicit_only',
          search_scope: 'web',
          refs: [],
          capabilities: [],
          updated_at: 0,
        },
      })
    )
    await page.route('**/api/serve/sessions/open', (route) => {
      opens += 1
      const response = opened()
      return route.fulfill({
        json: { ...response, runtime: { ...response.runtime, model_id: 'model-a' } },
      })
    })
    await page.route(`**/api/serve/sessions/${SESSION}/file-references`, (route) => {
      registrations += 1
      assert.deepEqual(route.request().postDataJSON(), { paths: [selectedPath] })
      return route.fulfill({
        json: {
          references: [
            {
              kind: 'file',
              path: canonicalPath,
              name: 'new-task.txt',
              reference_id: 'registered-new-task',
              media_type: 'text/plain',
            },
          ],
        },
      })
    })
    await page.route(`**/api/serve/sessions/${SESSION}/turns`, (route) => {
      turns.push(route.request().postDataJSON())
      return route.fulfill({
        json: { ok: true, accepted: true, disposition: 'direct', turn_id: 'attachment-turn' },
      })
    })
    await page.getByTestId('composer-file-input').setInputFiles({
      name: 'new-task.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('test attachment'),
    })
    await expect(page.getByRole('button', { name: 'new-task.txt', exact: true })).toBeVisible()
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'launchProbe').state.activeSession),
      null
    )
    assert.equal(opens, 0)
    assert.equal(registrations, 0)
    await page.getByTestId('composer-input').fill('Use the attached file')
    await page.getByTestId('composer-send').click()
    await expect.poll(() => turns.length).toBe(1)
    assert.equal(opens, 1)
    assert.equal(registrations, 1)
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'launchProbe').state.activeSession),
      SESSION
    )
    assert.match(JSON.stringify(turns[0]), /registered-new-task/)
  })
})

async function chooseEffort(page: Page, effort: string): Promise<void> {
  await page.getByTestId('model-selector-toggle').click()
  await page.getByTestId('model-effort-row').click()
  await page.getByTestId(`model-effort-option-${effort}`).click()
  await page.keyboard.press('Escape')
}

for (const outcome of ['accepted', 'not_applied', 'preparation_rejected', 'unknown']) {
  test(
    `plan continuation ${outcome} preserves the draft and references without duplicate submission or prompt restoration`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const references = [
          { type: 'file', id: 'draft-reference', title: 'draft.txt', path: '/tmp/draft.txt' },
        ]
        await page.evaluate(
          ({ session, references }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({
              composerRefs: references,
              threads: {
                ...probe.state.threads,
                [session]: {
                  ...probe.state.threads[session],
                  running: false,
                  status: 'abandon',
                  queuedMessages: [],
                  conversation: [{ kind: 'user', text: 'original task', turnId: 'paused-plan' }],
                  todoTurnId: 'paused-plan',
                  todos: [
                    { content: 'already completed', status: 'completed' },
                    { content: 'remaining work', status: 'in_progress' },
                  ],
                  turnOutcomes: { 'paused-plan': 'interrupted' },
                  turnTimings: { 'paused-plan': { startedAt: 1000, completedAt: 61000 } },
                },
              },
            })
          },
          { session: SESSION, references }
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        let reconciliations = 0
        await page.route('**/api/serve/sessions/*/turns', async (route) => {
          turns.push(route.request().postDataJSON())
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill(
            outcome === 'accepted'
              ? {
                  json: {
                    ok: true,
                    accepted: true,
                    disposition: 'direct',
                    turn_id: 'continued-plan',
                  },
                }
              : {
                  status: 409,
                  json: {
                    error: 'test_continuation_rejected',
                    ...(outcome === 'preparation_rejected' ? { preparation_error: true } : {}),
                  },
                }
          )
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill(
            outcome === 'unknown'
              ? { status: 503, json: { error: 'test_queue_unavailable' } }
              : { json: { messages: [] } }
          )
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) => {
          reconciliations += 1
          return route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        })
        const draft = '  unsent draft\nkeep exact whitespace \t'
        const input = page.getByTestId('composer-input')
        const continuation = page.getByTestId('todo-continue')
        await input.fill(draft)
        await page.getByTestId('todo-toggle').click()
        await expect(continuation).toBeEnabled()
        await expect(page.getByTestId('todo-toggle').getByTestId('todo-mark-stopped')).toBeVisible()
        const pausedTiming = { startedAt: 1000, completedAt: 61000 }
        await continuation.evaluate((element) => {
          const button = element as HTMLButtonElement
          button.click()
          button.click()
        })
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(continuation).toBeDisabled()
        await expect(page.getByTestId('todo-toggle').getByTestId('todo-mark-stopped')).toBeVisible()
        assert.deepEqual(
          await page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe').state.threads[session].turnTimings['paused-plan'],
            SESSION
          ),
          pausedTiming
        )
        await expect(input).toHaveValue(draft)
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          references
        )
        assert.deepEqual(turns[0].input, [{ type: 'text', text: CONTINUE_TASK_PROMPT }])
        const edited = outcome === 'accepted' || outcome === 'not_applied'
        const expectedDraft = edited ? 'new draft typed during continuation' : draft
        const expectedReferences = edited
          ? [{ type: 'file', id: 'new-draft-reference', title: 'next.txt', path: '/tmp/next.txt' }]
          : references
        if (edited) {
          await input.fill(expectedDraft)
          await page.evaluate(
            (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
            expectedReferences
          )
        }
        release!()
        if (outcome === 'accepted') {
          await expect(page.getByTestId('todo-continue')).toHaveCount(0)
        } else {
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
        }
        await expect(input).toHaveValue(expectedDraft)
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          expectedReferences
        )
        await settleStartup(page)
        assert.equal(turns.length, 1)
        assert.equal(reconciliations, outcome === 'not_applied' ? 1 : 0)
      })
    }
  )
}

for (const { editing, outcome } of [
  'unchanged',
  'replaced',
  'retyped',
  'same-reference-id',
  'text-only',
  'references-only',
].flatMap((editing) => ['accepted', 'not_applied'].map((outcome) => ({ editing, outcome })))) {
  test(
    `successful registration then ${outcome} keeps ${editing} edits and consumes only unchanged snapshot fields`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const originalReferences = [
          {
            type: 'file',
            id: 'original-file',
            title: 'original.txt',
            path: '/tmp/original.txt',
            registrationRequired: true,
          },
        ]
        await page.evaluate(
          ({ session, references }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({
              composerRefs: references,
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], running: true },
              },
            })
          },
          { session: SESSION, references: originalReferences }
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/file-references', async (route) => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill({
            json: {
              references: [
                {
                  reference_id: 'registered-original',
                  path: '/tmp/original.txt',
                  name: 'original.txt',
                  kind: 'file',
                  media_type: 'text/plain',
                },
              ],
            },
          })
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          const request = route.request().postDataJSON()
          turns.push(request)
          return route.fulfill(
            outcome === 'accepted'
              ? {
                  json: {
                    ok: true,
                    accepted: true,
                    disposition: 'queued',
                    queued_message_id: request.client_user_message_id,
                  },
                }
              : { status: 409, json: { error: 'test_submission_rejected' } }
          )
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill({ json: { messages: [] } })
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) =>
          route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        )
        const submitted = 'original message'
        const nextDraft = editing === 'retyped' ? submitted : '  next draft\nnew content \t'
        const nextReferences = [
          {
            type: 'file',
            id: editing === 'same-reference-id' ? 'original-file' : 'next-file',
            title: 'next.txt',
            path: '/tmp/next.txt',
          },
        ]
        const input = page.getByTestId('composer-input')
        const textEdited = editing !== 'unchanged' && editing !== 'references-only'
        const referencesEdited = editing !== 'unchanged' && editing !== 'text-only'
        await input.fill(submitted)
        await input.press('Enter')
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(input).toHaveValue(submitted)
        await input.press('Enter')
        await input.press('Enter')
        assert.equal(turns.length, 0)
        if (textEdited) {
          await expect(input).toBeEnabled()
          await input.fill('')
          await input.fill(nextDraft)
        }
        if (referencesEdited) {
          await page.evaluate(
            (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
            nextReferences
          )
        }
        release!()
        await expect.poll(() => turns.length).toBe(1)
        assert.deepEqual(turns[0].input, [
          { type: 'text', text: submitted },
          {
            type: 'file',
            reference_id: 'registered-original',
            name: 'original.txt',
            media_type: 'text/plain',
          },
        ])
        if (outcome === 'not_applied') {
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
        }
        await expect(input).toHaveValue(
          textEdited ? nextDraft : outcome === 'accepted' ? '' : submitted
        )
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          referencesEdited ? nextReferences : outcome === 'accepted' ? [] : originalReferences
        )
      })
    }
  )
}

for (const sameIdentity of [false, true]) {
  test(
    `postclear rejection restores consumed references without losing ${sameIdentity ? 'a replacement of the same identity' : 'a newly added reference'}`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const original = {
          type: 'file',
          id: 'original-file',
          title: 'original.txt',
          path: '/tmp/original.txt',
        }
        const next = {
          type: 'file',
          id: sameIdentity ? original.id : 'next-file',
          title: 'next.txt',
          path: '/tmp/next.txt',
        }
        await page.evaluate(
          (reference) => Reflect.get(window, 'launchProbe').patch({ composerRefs: [reference] }),
          original
        )
        let release: (() => void) | undefined
        const turns: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/turns', async (route) => {
          turns.push(route.request().postDataJSON())
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await route.fulfill({ status: 409, json: { error: 'test_submission_rejected' } })
        })
        await page.route('**/api/serve/sessions/*/queue', (route) =>
          route.fulfill({ json: { messages: [] } })
        )
        await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) =>
          route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
        )
        const input = page.getByTestId('composer-input')
        await input.fill('submitted message')
        await page.getByTestId('composer-send').click()
        await expect.poll(() => Boolean(release)).toBe(true)
        await expect(input).toHaveValue('')
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          []
        )
        await input.fill('new draft')
        await page.evaluate(
          (reference) => Reflect.get(window, 'launchProbe').patch({ composerRefs: [reference] }),
          next
        )
        release!()
        await expect(input).toHaveValue('submitted message\nnew draft')
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
          sameIdentity ? [next] : [original, next]
        )
        assert.equal(turns.length, 1)
      })
    }
  )
}

for (const failure of ['open', 'authorization', 'context', 'registration', 'input']) {
  test(
    `preclear ${failure} failure preserves the exact assistant draft and references`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        let opens = 0
        let turns = 0
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill(
            failure === 'open'
              ? { status: 503, json: { error: 'test_open_unavailable' } }
              : {
                  json: {
                    ...opened(),
                    ...(failure === 'authorization'
                      ? { runtime_workdir: '/tmp/session-root' }
                      : {}),
                  },
                }
          )
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true, accepted: true, turn_id: 'unexpected-turn' } })
        })
        if (failure === 'registration' || failure === 'input') await restoreSession(page)
        const references = [
          {
            type: 'file',
            id: 'draft-file',
            title: 'draft.txt',
            path: failure === 'input' ? 'relative.txt' : '/tmp/draft.txt',
            registrationRequired: failure === 'registration',
            mediaType: 'text/plain',
          },
        ]
        await page.evaluate(
          ({ references, failure }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface('assistant')
            probe.patch({ model: 'model-b', composerRefs: references })
            if (failure === 'authorization')
              Object.assign(window.scholarseed, { addAuthorizedRoot: async () => false })
          },
          { references, failure }
        )
        const draft = ' \t repeat\nrepeat \n'
        await page.getByTestId('composer-input').fill(draft)
        for (let attempt = 0; attempt < (failure === 'open' ? 2 : 1); attempt += 1) {
          await page.getByTestId('composer-send').click()
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
          await expect(page.getByTestId('composer-send')).toBeEnabled()
          await expect(page.getByTestId('composer-input')).toHaveValue(draft)
          assert.deepEqual(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
            references
          )
        }
        assert.equal(
          opens,
          failure === 'open' ? 2 : ['registration', 'input'].includes(failure) ? 0 : 1
        )
        assert.equal(turns, 0)
      })
    }
  )
}

for (const surface of ['conversation', 'assistant'] as const) {
  test(
    `running ${surface} hides send while Enter still queues the draft`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const requests: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          requests.push(route.request().postDataJSON())
          return route.fulfill({
            json: {
              ok: true,
              accepted: true,
              disposition: 'queued',
              queued_message_id: requests.at(-1)!.client_user_message_id,
            },
          })
        })
        await page.evaluate(
          ({ session, surface }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.surface(surface)
            probe.patch({
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], running: true, queuedMessages: [] },
              },
            })
          },
          { session: SESSION, surface }
        )
        const input = page.getByTestId('composer-input')
        await expect(page.getByTestId('composer-stop')).toBeVisible()
        await input.fill('queued follow-up')
        await expect(page.getByTestId('composer-send')).toHaveCount(0)
        await input.press('Shift+Enter')
        await expect(input).toHaveValue('queued follow-up\n')
        assert.equal(requests.length, 0)
        await input.press('Enter')
        await expect.poll(() => requests.length).toBe(1)
        await expect(input).toHaveValue('')
        assert.deepEqual(requests[0].input, [{ type: 'text', text: 'queued follow-up' }])
        await expect(page.getByTestId('composer-send')).toHaveCount(0)
        await expect(page.getByTestId('composer-stop')).toBeVisible()
        await page.evaluate((session) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: { ...probe.state.threads[session], running: false, queuedMessages: [] },
            },
          })
        }, SESSION)
        await expect(page.getByTestId('composer-stop')).toHaveCount(0)
        await expect(page.getByTestId('composer-send')).toBeVisible()
      })
    }
  )
}

test(
  'preclear registration failure preserves edits made while a running-session send waits',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      control.finish()
      await restoreSession(page)
      let release: (() => void) | undefined
      let turns = 0
      await page.route('**/api/serve/sessions/*/file-references', async (route) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        await route.fulfill({ status: 503, json: { error: 'test_registration_unavailable' } })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true, accepted: true, turn_id: 'unexpected-turn' } })
      })
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.surface('assistant')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: { ...probe.state.threads[session], running: true },
          },
          composerRefs: [
            {
              type: 'file',
              id: 'original-file',
              title: 'original.txt',
              path: '/tmp/original.txt',
              registrationRequired: true,
            },
          ],
        })
      }, SESSION)
      await page.getByTestId('composer-input').fill('original message')
      await page.getByTestId('composer-input').press('Enter')
      await expect.poll(() => Boolean(release)).toBe(true)
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      const edited = '  edited\nedited \t'
      await page.getByTestId('composer-input').fill(edited)
      const references = [{ type: 'file', id: 'new-file', title: 'new.txt', path: '/tmp/new.txt' }]
      await page.evaluate(
        (references) => Reflect.get(window, 'launchProbe').patch({ composerRefs: references }),
        references
      )
      release!()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError))
        .not.toBe(null)
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      await expect(page.getByTestId('composer-input')).toHaveValue(edited)
      assert.deepEqual(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.composerRefs),
        references
      )
      assert.equal(turns, 0)
    })
  }
)

for (const outcome of ['preparation_rejected', 'not_applied', 'unknown']) {
  for (const repeated of outcome === 'unknown' ? [true] : [false, true]) {
    test(
      `postclear ${outcome} ${repeated ? 'retains identical new input' : 'merges new input'} without replay`,
      { timeout: 60000 },
      async (context) => {
        await fixture(context, async (page) => {
          const control = await preparation(page)
          control.finish()
          await restoreSession(page)
          await page.evaluate(() => Reflect.get(window, 'launchProbe').surface('assistant'))
          let release: (() => void) | undefined
          let turns = 0
          let reconciliations = 0
          await page.route('**/api/serve/sessions/*/turns', async (route) => {
            turns += 1
            await new Promise<void>((resolve) => {
              release = resolve
            })
            await route.fulfill({
              status: 409,
              json: {
                error: 'test_admission_rejected',
                ...(outcome === 'preparation_rejected' ? { preparation_error: true } : {}),
              },
            })
          })
          await page.route('**/api/serve/sessions/*/queue', (route) =>
            route.fulfill(
              outcome === 'unknown'
                ? { status: 503, json: { error: 'test_queue_unavailable' } }
                : { json: { messages: [] } }
            )
          )
          await page.route('**/api/serve/sessions/*/queue/*/reconcile', (route) => {
            reconciliations += 1
            return route.fulfill({ json: { ok: true, outcome: 'not_applied' } })
          })
          const submitted = 'submitted message'
          const nextDraft = repeated ? submitted : '  next message \n'
          await page.getByTestId('composer-input').fill(submitted)
          await page.getByTestId('composer-send').click()
          await expect.poll(() => Boolean(release)).toBe(true)
          await expect(page.getByTestId('composer-input')).toHaveValue('')
          await expect(page.getByTestId('composer-input')).toBeEnabled()
          await page.getByTestId('composer-input').fill(nextDraft)
          release!()
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError)
            )
            .not.toBe(null)
          await expect(page.getByTestId('composer-input')).toHaveValue(
            outcome === 'unknown' ? nextDraft : `${submitted}\n${nextDraft}`
          )
          if (outcome === 'unknown') {
            await expect
              .poll(() =>
                page.evaluate(
                  (session) =>
                    Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.some(
                      (message: { state: string }) => message.state === 'outcome_unknown'
                    ),
                  SESSION
                )
              )
              .toBe(true)
          }
          await settleStartup(page)
          assert.equal(turns, 1)
          assert.equal(reconciliations, outcome === 'not_applied' ? 1 : 0)
        })
      }
    )
  }
}

test(
  'changing draft effort while preparation waits invalidates only the old send',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const opens: Record<string, unknown>[] = []
      const turns: unknown[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        opens.push(route.request().postDataJSON())
        return route.fulfill({
          json: { ...opened(), runtime: { ...opened().runtime, reasoning_effort: 'high' } },
        })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await chooseAndSend(page)
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await chooseEffort(page, 'high')
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, 'launchProbe').state.reasoningPreferences['model-b']
          )
        )
        .toBe('high')
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.modelSelectionPending)
        )
        .toBe(0)
      assert.equal(opens.length, 0)
      assert.deepEqual(turns, [])
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(1)
      assert.equal(opens.length, 1)
      assert.equal(opens[0].reasoning_effort, 'high')
    })
  }
)

test(
  'restored-session effort selection fences waiting sends until the selected tuple is saved',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      let selectedEffort = 'low'
      let release: (() => void) | undefined
      let turns = 0
      let mutations = 0
      const snapshot = () => ({
        session_id: SESSION,
        model_id: 'model-b',
        reasoning_effort: selectedEffort,
        runtime: { name: 'codex', model_id: 'model-b', reasoning_effort: selectedEffort },
      })
      await page.route('**/api/serve/sessions/*/model', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: snapshot() })
        const body = route.request().postDataJSON()
        mutations += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        selectedEffort = body.reasoning_effort
        return route.fulfill({ json: { ok: true, ...snapshot() } })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await restoreSession(page)
      await page.getByTestId('composer-input').fill('retained effort change')
      await page.getByTestId('composer-send').click()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await chooseEffort(page, 'high')
      assert.equal(mutations, 0)
      control.finish()
      await expect.poll(() => Boolean(release)).toBe(true)
      assert.equal(turns, 0)
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      release?.()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.modelSelectionPending)
        )
        .toBe(0)
      await expect(page.getByTestId('composer-input')).toHaveValue('retained effort change')
      assert.equal(turns, 0)
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
          SESSION
        ),
        1
      )
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns).toBe(1)
      assert.equal(mutations, 1)
    })
  }
)

test(
  'first send waits before session/outbox/turn and submits once after target readiness',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const opens: unknown[] = []
      const turns: unknown[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        opens.push(route.request().postDataJSON())
        return route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
      })
      await chooseAndSend(page)
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.deepEqual(opens, [])
      assert.deepEqual(turns, [])
      assert.equal(
        await page.evaluate(() =>
          Object.values(Reflect.get(window, 'launchProbe').state.threads).some(
            (thread) => (thread as { queuedMessages?: unknown[] }).queuedMessages?.length
          )
        ),
        false
      )
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(opens.length, 1)
      assert.equal((opens[0] as { prepare_runtime: boolean }).prepare_runtime, true)
      assert.equal((turns[0] as { expected_model_id: string }).expected_model_id, 'model-b')
      assert.equal((turns[0] as { service_instance_id: string }).service_instance_id, INSTANCE)
    })
  }
)

for (const matchingInstance of [true, false]) {
  test(
    `maintenance health 503 ${matchingInstance ? 'preserves' : 'invalidates'} first-send waiting by service identity`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        let opens = 0
        let turns = 0
        await page.route('**/api/healthz/backend', (route) =>
          route.fulfill({
            status: 503,
            json: { error: 'runtime_host_draining' },
          })
        )
        await page.route('**/api/serve/runtime/reconfiguration', (route) =>
          route.fulfill({
            json: {
              state: 'accepted',
              service_instance_id: matchingInstance ? INSTANCE : 'replacement',
            },
          })
        )
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill({ json: opened() })
        })
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
        })
        await page.evaluate(() => Reflect.get(window, 'launchProbe').patch({ backendReady: true }))
        await chooseAndSend(page)
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate(() => Reflect.get(window, 'launchProbe').health())
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.serviceInstanceId)
          )
          .toBe(matchingInstance ? INSTANCE : null)
        if (matchingInstance) {
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase),
            'preparing'
          )
          assert.equal(
            await page.evaluate(() => Reflect.get(window, 'launchProbe').state.workbenchReady),
            true
          )
        }
        assert.equal(opens, 0)
        assert.equal(turns, 0)
        control.finish()
        if (matchingInstance) {
          await expect.poll(() => turns).toBe(1)
          assert.equal(opens, 1)
          await page.waitForTimeout(600)
          assert.equal(turns, 1)
        } else {
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch))
            .toBe(null)
          await page.waitForTimeout(600)
          assert.equal(opens, 0)
          assert.equal(turns, 0)
        }
      })
    }
  )
}

for (const panel of [false, true]) {
  test(
    `new ${panel ? 'panel' : 'conversation'} draft invalidates a waiting first send`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        let opens = 0
        await page.route('**/api/serve/sessions/open', (route) => {
          opens += 1
          return route.fulfill({ json: opened() })
        })
        await chooseAndSend(page)
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate((value) => Reflect.get(window, 'launchProbe').draft(value), panel)
        await page.getByTestId('composer-input').fill('new draft remains')
        control.finish()
        await expect.poll(control.terminalObserved).toBe(true)
        await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
        assert.equal(opens, 0)
        await expect(page.getByTestId('composer-input')).toHaveValue('new draft remains')
      })
    }
  )
}

test(
  'preparation rejection preserves text without creating a failed queue item',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      let opens = 0
      await page.route('**/api/serve/sessions/open', (route) => {
        opens += 1
        return route.fulfill({ json: opened() })
      })
      await chooseAndSend(page)
      control.finish('rejected')
      await expect(page.getByTestId('runtime-preparation')).toContainText('消息尚未提交')
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      assert.equal(opens, 0)
      await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
    })
  }
)

test(
  'intermediate tool failure retains evidence without a composer card or recovery request',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      await restoreSession(page)
      const recoveryRequests: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.endsWith('/tools/recovery'))
          recoveryRequests.push(request.url())
      })
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              queuedMessages: [],
              activeTurnId: 'failed-turn',
              conversation: [
                {
                  kind: 'tool',
                  toolId: 'failed-tool',
                  turnId: 'failed-turn',
                  name: 'shell_command',
                  status: 'error',
                  result: 'permission denied',
                },
              ],
            },
          },
        })
      }, SESSION)
      await expect(page.getByTestId('tool-failure-notice')).toHaveCount(0)
      await expect(page.getByTestId('tool-retry-confirmation')).toHaveCount(0)
      await page.getByTestId('composer-input').fill('continue after the failed tool')
      await expect(page.getByTestId('composer-input')).toBeEnabled()
      const evidence = await page.evaluate(
        (session) => Reflect.get(window, 'launchProbe').state.threads[session].conversation[0],
        SESSION
      )
      assert.equal(evidence.status, 'error')
      assert.equal(evidence.result, 'permission denied')
      assert.deepEqual(recoveryRequests, [])
    })
  }
)

test(
  'confirmed restart guidance survives maintenance health failure without reopening admission',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      await chooseAndSend(page)
      control.finish('restart_required')
      const alert = page.getByTestId('runtime-preparation')
      await expect(alert).toContainText('完整退出并重新启动应用')
      await page.route('**/api/healthz/backend', (route) => route.fulfill({ status: 503 }))
      await page.route('**/api/serve/runtime/reconfiguration', (route) =>
        route.fulfill({ status: 503 })
      )
      await page.evaluate(() => Reflect.get(window, 'launchProbe').health())
      await page.waitForTimeout(300)
      await expect(alert).toContainText('完整退出并重新启动应用')
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.backendReady),
        false
      )
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      const submissions: string[] = []
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname.startsWith('/api/serve/')
        )
          submissions.push(new URL(request.url()).pathname)
      })
      await page.getByTestId('composer-input').press('Enter')
      await page.waitForTimeout(300)
      assert.deepEqual(submissions, [])
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
    })
  }
)

for (const [state, expected] of [
  ['restart_required', 'runtimeSwitch.restartRequired'],
  ['rejected', 'runtimePreparation.failed'],
  ['unsupported', 'runtimeSwitch.unsupported'],
]) {
  test(
    `first-send preparation ${state} preserves the draft without submission or replay`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        let submissions = 0
        page.on('request', (request) => {
          if (
            request.method() === 'POST' &&
            /\/api\/serve\/sessions\/(open|[^/]+\/turns)$/.test(new URL(request.url()).pathname)
          )
            submissions += 1
        })
        await chooseAndSend(page)
        control.finish(state)
        await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
        await expect.poll(() => control.terminalObserved()).toBe(true)
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError?.key)
          )
          .toBe(expected)
        await page.waitForTimeout(1100)
        assert.equal(submissions, 0)
        await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      })
    }
  )
}

test(
  'normal runtime preparation stays silent while terminal failures remain visible',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      await page.getByTestId('composer-input').fill('draft stays available')
      for (const state of ['accepted', 'applied', 'rejected', 'restart_required', 'unsupported']) {
        await page.evaluate(
          ({ state, instance }) =>
            Reflect.get(window, 'launchProbe').patch({
              runtimePreparationTarget: state === 'accepted' ? 'model-a' : null,
              runtimePreparation: {
                request_id: '12345678-1234-4234-8234-123456789abc',
                session_id: null,
                model_id: 'model-a',
                state,
                error: '',
                service_instance_id: instance,
              },
            }),
          { state, instance: INSTANCE }
        )
        if (state === 'accepted' || state === 'applied') {
          await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
        } else {
          await expect(page.getByTestId('runtime-preparation')).toBeVisible()
          await expect(page.getByTestId('runtime-preparation')).toHaveAttribute('role', 'alert')
        }
        await expect(page.getByTestId('composer-input')).toHaveValue('draft stays available')
      }
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({ runtimePreparationTarget: 'model-a' })
      )
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
    })
  }
)

test(
  'unmount during session opening cannot submit a late first message',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      let releaseOpen: (() => void) | undefined
      let turns = 0
      await page.route('**/api/serve/sessions/open', async (route) => {
        await new Promise<void>((resolve) => {
          releaseOpen = resolve
        })
        await route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns += 1
        return route.fulfill({ json: { ok: true } })
      })
      await chooseAndSend(page)
      control.finish()
      await expect.poll(() => Boolean(releaseOpen)).toBe(true)
      await page.evaluate(() => Reflect.get(window, 'launchProbe').hide())
      releaseOpen!()
      await expect(page.getByTestId('composer-hidden')).toBeAttached()
      await page.waitForTimeout(300)
      assert.equal(turns, 0)
    })
  }
)

test(
  'prequeue preparation rejection stays unsubmitted and an explicit retry retains target admission',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const turns: { expected_model_id?: string }[] = []
      let opens = 0
      await page.route('**/api/serve/sessions/open', (route) => {
        opens += 1
        return route.fulfill({ json: opened() })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill(
          turns.length === 1
            ? {
                status: 409,
                json: {
                  ok: false,
                  error: 'runtime_reconfiguration_stale',
                  preparation_error: true,
                },
              }
            : { json: { ok: true, accepted: true, disposition: 'direct' } }
        )
      })
      await chooseAndSend(page)
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      await expect(page.getByTestId('composer-input')).toHaveValue('first prepared message')
      await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          aiPanel: { ...probe.state.aiPanel, sessionId: session, contextState: 'ready' },
        })
      }, SESSION)
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(2)
      assert.equal(turns[1].expected_model_id, 'model-b')
      assert.equal(opens, 1)
    })
  }
)

test('keyboard send respects context admission and retains the draft until an explicit ready retry', async (context) => {
  await fixture(context, async (page) => {
    const control = await preparation(page)
    control.finish()
    await restoreSession(page)
    const turns: Record<string, unknown>[] = []
    await page.route('**/api/serve/sessions/*/turns', (route) => {
      turns.push(route.request().postDataJSON())
      return route.fulfill({
        json: { ok: true, accepted: true, disposition: 'direct', turn_id: 'retry-turn' },
      })
    })
    const input = page.getByTestId('composer-input')
    const draft = 'keep the restored draft'
    await input.fill(draft)
    for (const contextState of ['loading', 'refreshing', 'saving', 'error', 'wrong-session']) {
      await page.evaluate(
        ({ session, contextState }) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            foregroundError: null,
            aiPanel: {
              ...probe.state.aiPanel,
              sessionId: contextState === 'wrong-session' ? 'another-session' : session,
              contextState: contextState === 'wrong-session' ? 'ready' : contextState,
            },
          })
        },
        { session: SESSION, contextState }
      )
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      await input.press('Enter')
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
        null,
        contextState
      )
      await expect(input).toHaveValue(draft)
      assert.equal(turns.length, 0)
    }
    await page.evaluate((session) => {
      const probe = Reflect.get(window, 'launchProbe')
      probe.patch({
        aiPanel: { ...probe.state.aiPanel, sessionId: session, contextState: 'ready' },
      })
    }, SESSION)
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await expect(input).toHaveValue(draft)
    assert.equal(turns.length, 0)
    await input.press('Enter')
    await expect.poll(() => turns.length).toBe(1)
    await expect(input).toHaveValue('')
    assert.deepEqual(turns[0].input, [{ type: 'text', text: draft }])
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
      null
    )
  })
})

test('queued message updates preserve editable text and the ordinary draft without duplicate submission', async (context) => {
  await fixture(context, async (page) => {
    const control = await preparation(page)
    control.finish()
    await restoreSession(page)
    const input = page.getByTestId('composer-input')
    await input.fill('ordinary unsent draft')
    await page.getByTestId('queued-more-old-failure').click()
    await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click()
    await expect(input).toHaveValue('do not replay')
    await input.fill('updated queue message')
    let release: (() => void) | undefined
    const updates: unknown[] = []
    await page.route('**/api/serve/sessions/*/queue/old-failure', async (route) => {
      assert.equal(route.request().method(), 'PATCH')
      updates.push(route.request().postDataJSON())
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.fulfill({ status: 503, json: { error: 'test_queue_update_failed' } })
    })
    await input.press('Enter')
    await expect.poll(() => Boolean(release)).toBe(true)
    await expect(input).toBeEditable()
    await input.fill('new edits while queue update is pending')
    await input.press('Enter')
    assert.deepEqual(updates, [{ text: 'updated queue message' }])
    release!()
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue('new edits while queue update is pending')
    await expect(
      page.getByText('无法修改消息，编辑文字已保留，可复制。', { exact: true })
    ).toBeVisible()
    await input.press('Escape')
    await expect(input).toHaveValue('ordinary unsent draft')
  })
})

for (const hostOwned of [true, false]) {
  test(
    `clarification Enter preserves the whole reply and failed draft through the ${hostOwned ? 'host' : 'HTTP'} route`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        control.finish()
        await restoreSession(page)
        const requests: unknown[] = []
        let status = 403
        const reply =
          '网络安全，仅公开UNSW-NB15；重构自编码器；PR-AUC并报告F1。仅确认，不检索、不下载。'
        const body = { free_text: reply, answers: { scope: reply } }
        const response = () => ({
          ok: true,
          interaction: {
            request_id: 'clarification',
            kind: 'question',
            state: 'resolved',
            ...body,
          },
        })
        await page.exposeFunction('answerClarification', (request: unknown) => {
          requests.push(request)
          return {
            status,
            body: JSON.stringify(status === 200 ? response() : { detail: 'host_process_only' }),
          }
        })
        await page.evaluate(() => {
          window.scholarseed.deviceSkills = (request) =>
            Reflect.get(window, 'answerClarification')(request)
        })
        await page.route('**/api/serve/sessions/*/hil/*', (route) => {
          requests.push({ operation: 'HTTP', body: route.request().postDataJSON() })
          return route.fulfill({
            status,
            json: status === 200 ? response() : { detail: 'host_process_only' },
          })
        })
        await page.evaluate(
          ({ session, hostOwned }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              threads: {
                [session]: {
                  ...probe.state.threads[session],
                  running: true,
                  status: 'waiting',
                  activeTurnId: 'clarification-turn',
                  queuedMessages: ['B', 'Q'].map((text, index) => ({
                    queuedMessageId: text,
                    enqueueSeq: index + 1,
                    state: 'queued',
                    input: [{ type: 'text', text }],
                    text,
                    assistantReferences: [],
                    submissionMode: 'queued',
                  })),
                  conversation: [
                    {
                      kind: 'hil',
                      requestId: 'clarification',
                      hilKind: 'question',
                      hilState: 'pending',
                      questions: ['scope', 'method', 'metric'].map((id) => ({
                        id,
                        question: id,
                        options: [],
                        ...(hostOwned ? { component: { plugin: 'host' } } : {}),
                      })),
                    },
                  ],
                },
              },
            })
          },
          { session: SESSION, hostOwned }
        )
        const queued = await page.evaluate(
          (session) => Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages,
          SESSION
        )
        for (const message of ['B', 'Q'])
          await expect(page.getByTestId(`queued-steer-${message}`)).toBeDisabled()
        await expect(page.locator('[data-testid^="queued-send-"]')).toHaveCount(0)
        const input = page.getByTestId('composer-input')
        await input.fill(reply)
        await input.press('Enter')
        await expect.poll(() => requests.length).toBe(1)
        await expect
          .poll(() =>
            page.evaluate(
              (session) =>
                Reflect.get(window, 'launchProbe').state.threads[session].conversation[0].hilState,
              SESSION
            )
          )
          .toBe('failed')
        await expect(input).toHaveValue(reply)
        for (const message of ['B', 'Q'])
          await expect(page.getByTestId(`queued-steer-${message}`)).toBeDisabled()
        status = 200
        await input.press('Enter')
        await expect.poll(() => requests.length).toBe(2)
        await expect(input).toHaveValue('')
        const expected = hostOwned
          ? { operation: 'plugin-answer', session: SESSION, request: 'clarification', body }
          : { operation: 'HTTP', body }
        assert.deepEqual(requests, [expected, expected])
        assert.deepEqual(
          await page.evaluate((session) => {
            const item = Reflect.get(window, 'launchProbe').state.threads[session].conversation[0]
            return { state: item.hilState, answers: item.answers, freeText: item.freeText }
          }, SESSION),
          { state: 'resolved', answers: body.answers, freeText: reply }
        )
        assert.deepEqual(
          await page.evaluate(
            (session) => Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages,
            SESSION
          ),
          queued
        )
      })
    }
  )
}

for (const hilKind of ['permission', 'question']) {
  test(`conversation controls keep ${hilKind} decisions card-only`, async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      control.finish()
      await restoreSession(page)
      const requests: unknown[] = []
      await page.route('**/api/serve/sessions/*/hil/*', async (route) => {
        requests.push(route.request().postDataJSON())
        await route.fulfill({ json: { ok: true } })
      })
      await page.exposeFunction('blockedClarification', (request: unknown) => {
        requests.push(request)
        return { status: 200, body: JSON.stringify({ ok: true }) }
      })
      await page.evaluate(
        ({ session, hilKind }) => {
          window.scholarseed.deviceSkills = (request) =>
            Reflect.get(window, 'blockedClarification')(request)
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              [session]: {
                ...probe.state.threads[session],
                queuedMessages: [],
                conversation: [
                  {
                    kind: 'hil',
                    requestId: 'card-only',
                    hilKind,
                    hilState: 'pending',
                    questions: [
                      {
                        id: 'file-recovery:request',
                        header: 'file_read_failed',
                        question: 'resources/broken.pdf',
                        options: [{ label: 'retry_file' }, { label: 'remove_file' }],
                      },
                    ],
                  },
                ],
              },
            },
          })
        },
        { session: SESSION, hilKind }
      )
      const input = page.getByTestId('composer-input')
      await input.fill('Do not authorize this from free text')
      await input.press('Enter')
      await expect(page.getByTestId('composer-send')).toBeDisabled()
      await expect(input).toHaveValue('Do not authorize this from free text')
      assert.deepEqual(requests, [])
    })
  })
}

for (const surface of ['composer', 'card']) {
  test(
    `${surface} editing notification uses the host route without resolving the clarification`,
    { timeout: 60000 },
    async (context) => {
      await fixture(
        context,
        async (page) => {
          const control = await preparation(page)
          control.finish()
          await restoreSession(page)
          const requests: unknown[] = []
          await page.exposeFunction('editingClarification', (request: unknown) => {
            requests.push(request)
            return {
              status: 200,
              body: JSON.stringify({ ok: true, interaction: { timeout_cancelled: true } }),
            }
          })
          await page.evaluate((session) => {
            window.scholarseed.deviceSkills = (request) =>
              Reflect.get(window, 'editingClarification')(request)
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              threads: {
                [session]: {
                  ...probe.state.threads[session],
                  queuedMessages: [],
                  conversation: [
                    {
                      kind: 'hil',
                      requestId: 'editing',
                      hilKind: 'question',
                      hilState: 'pending',
                      cancelTimeoutOnEdit: true,
                      questions: [
                        {
                          id: 'scope',
                          question: 'Scope?',
                          options: [],
                          component: {
                            plugin: 'host',
                            component: 'question',
                            fingerprint: 'host-v1',
                          },
                        },
                        { id: 'supplement', question: 'Supplement?', options: [] },
                      ],
                    },
                  ],
                },
              },
            })
          }, SESSION)
          await page
            .getByTestId(surface === 'composer' ? 'composer-input' : 'hil-question-text-1')
            .fill('Revise the outline')
          await expect.poll(() => requests.length).toBe(1)
          assert.deepEqual(requests, [
            {
              operation: 'plugin-answer',
              session: SESSION,
              request: 'editing',
              body: { editing: true },
            },
          ])
          await expect
            .poll(() =>
              page.evaluate(
                (session) =>
                  Reflect.get(window, 'launchProbe').state.threads[session].conversation[0]
                    .timeoutCancelled,
                SESSION
              )
            )
            .toBe(true)
          assert.equal(
            await page.evaluate(
              (session) =>
                Reflect.get(window, 'launchProbe').state.threads[session].conversation[0].hilState,
              SESSION
            ),
            'pending'
          )
        },
        async (page) => {
          if (surface === 'card')
            await page.addInitScript(() => Reflect.set(window, 'hilDockFixture', true))
        }
      )
    }
  )
}

async function restoreSession(page: Page): Promise<void> {
  await page.route('**/api/assistant/sessions/*/context', (route) =>
    route.fulfill({
      json: {
        session_id: SESSION,
        revision: 0,
        project_policy: 'explicit_only',
        search_scope: 'web',
        refs: [],
        capabilities: [],
        updated_at: 0,
      },
    })
  )
  await page.evaluate((session) => {
    const probe = Reflect.get(window, 'launchProbe')
    probe.patch({
      activeSession: session,
      threads: {
        [session]: {
          id: session,
          sessionId: session,
          title: 'restored',
          conversation: [],
          lastSeq: 0,
          runtime: { name: 'codex', model_id: 'model-b' },
          readiness: { ready: true },
          resumeState: 'ready',
          queuedMessages: [
            {
              queuedMessageId: 'old-failure',
              enqueueSeq: 1,
              state: 'failed',
              input: [{ type: 'text', text: 'do not replay' }],
              text: 'do not replay',
              assistantReferences: [],
              submissionMode: 'direct',
              safeErrorCode: 'runtime_host_configuration_conflict',
            },
          ],
        },
      },
      aiPanel: { ...probe.state.aiPanel, sessionId: session, contextState: 'ready' },
    })
  }, SESSION)
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 2000 })
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.aiPanel.contextState))
    .toBe('ready')
}

async function settleStartup(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function startupReady(page: Page): Promise<void> {
  await page.evaluate(
    (instance) =>
      Reflect.get(window, 'launchProbe').patch({
        backendReady: true,
        workbenchReady: true,
        navigationRestored: true,
        projectsLoaded: true,
        workspaceLoadState: 'ready',
        modelCatalogInstanceId: instance,
      }),
    INSTANCE
  )
  await settleStartup(page)
}

test(
  'startup prepares only the restored session target after current-instance hydration',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const requests: Record<string, unknown>[] = []
      const mutations: string[] = []
      page.on('request', (request) => {
        if (request.method() !== 'POST') return
        if (new URL(request.url()).pathname === '/api/serve/runtime/prepare')
          requests.push(request.postDataJSON())
        else mutations.push(new URL(request.url()).pathname)
      })
      await restoreSession(page)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        const thread = probe.state.threads[session]
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...thread,
              queuedMessages: [
                ...thread.queuedMessages,
                {
                  ...thread.queuedMessages[0],
                  queuedMessageId: 'old-unknown',
                  enqueueSeq: 2,
                  state: 'outcome_unknown',
                },
              ],
            },
          },
        })
      }, SESSION)
      await startupReady(page)
      assert.equal(requests.length, 0)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              resumeServiceInstanceId: 'retired-instance',
            },
          },
        })
      }, SESSION)
      await settleStartup(page)
      assert.equal(requests.length, 0)
      await page.evaluate(
        ({ session, instance }) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: {
                ...probe.state.threads[session],
                resumeServiceInstanceId: instance,
              },
            },
          })
        },
        { session: SESSION, instance: INSTANCE }
      )
      await expect.poll(() => requests.length).toBe(1)
      assert.equal(requests[0].model_id, 'model-b')
      assert.equal(requests[0].persist_default, false)
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.runtimePreparation?.state)
        )
        .toBe('applied')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
        'model-a'
      )
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          catalog: { ...probe.state.catalog, models: [...probe.state.catalog.models] },
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              runtime: { name: 'codex', model_id: 'model-a' },
            },
          },
        })
      }, SESSION)
      await settleStartup(page)
      assert.equal(requests.length, 1)
      assert.deepEqual(mutations, [])
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[1].state,
          SESSION
        ),
        'outcome_unknown'
      )
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[0].state,
          SESSION
        ),
        'failed'
      )
    })
  }
)

test(
  'startup new draft waits for catalogue identity and does not prepare on later navigation',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const requests: Record<string, unknown>[] = []
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/serve/runtime/prepare'
        )
          requests.push(request.postDataJSON())
      })
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({
          backendReady: true,
          projectsLoaded: true,
          workspaceLoadState: 'ready',
          navigationRestored: true,
        })
      )
      await settleStartup(page)
      assert.equal(requests.length, 0)
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: probe.state.serviceInstanceId,
          current_model: 'model-a',
          available_models: probe.state.catalog.models,
        })
      })
      await expect.poll(() => requests.length).toBe(1)
      assert.equal(requests[0].model_id, 'model-a')
      control.finish()
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'launchProbe').state.runtimePreparation?.state)
        )
        .toBe('applied')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      await restoreSession(page)
      await settleStartup(page)
      assert.equal(requests.length, 1)
    })
  }
)

for (const unavailable of ['missing', 'disabled']) {
  test(
    `startup never falls back from an ${unavailable} persisted session model`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        let prepares = 0
        await preparation(page)
        page.on('request', (request) => {
          if (request.method() === 'POST') prepares += 1
        })
        await restoreSession(page)
        await page.evaluate(
          ({ session, instance, unavailable }) => {
            const probe = Reflect.get(window, 'launchProbe')
            probe.patch({
              threads: {
                ...probe.state.threads,
                [session]: { ...probe.state.threads[session], resumeServiceInstanceId: instance },
              },
              catalog: {
                ...probe.state.catalog,
                models:
                  unavailable === 'missing'
                    ? probe.state.catalog.models.filter(
                        (model: { key: string }) => model.key !== 'model-b'
                      )
                    : probe.state.catalog.models.map((model: { key: string }) => ({
                        ...model,
                        disabled: model.key === 'model-b',
                      })),
              },
            })
          },
          { session: SESSION, instance: INSTANCE, unavailable }
        )
        await startupReady(page)
        assert.equal(prepares, 0)
        assert.notEqual(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
          null
        )
        assert.equal(
          await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
          'model-a'
        )
      })
    }
  )
}

test(
  'service replacement waits for both new catalogue and new session recovery',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const requests: Record<string, unknown>[] = []
      await page.route('**/api/serve/runtime/prepare**', (route) => {
        const request = route.request().postDataJSON()
        requests.push(request)
        return route.fulfill({
          json: { ...request, state: 'applied', session_id: null, error: '' },
        })
      })
      await restoreSession(page)
      await page.evaluate(
        ({ session, instance }) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: { ...probe.state.threads[session], resumeServiceInstanceId: instance },
            },
          })
        },
        { session: SESSION, instance: INSTANCE }
      )
      await startupReady(page)
      await expect.poll(() => requests.length).toBe(1)
      await page.evaluate(() =>
        Reflect.get(window, 'launchProbe').patch({ serviceInstanceId: 'replacement' })
      )
      const priorCatalog = await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        return {
          model: probe.state.model,
          catalog: probe.state.catalog,
          instance: probe.state.modelCatalogInstanceId,
        }
      })
      await page.evaluate((instance) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: instance,
          current_model: 'stale-model',
          available_models: [],
        })
        probe.catalog({ current_model: 'unidentified-model', available_models: [] })
      }, INSTANCE)
      await settleStartup(page)
      assert.equal(requests.length, 1)
      assert.deepEqual(
        await page.evaluate(() => {
          const probe = Reflect.get(window, 'launchProbe')
          return {
            model: probe.state.model,
            catalog: probe.state.catalog,
            instance: probe.state.modelCatalogInstanceId,
          }
        }),
        priorCatalog
      )
      await page.evaluate(() => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.catalog({
          service_instance_id: 'replacement',
          current_model: 'model-a',
          available_models: probe.state.catalog.models,
        })
      })
      await settleStartup(page)
      assert.equal(requests.length, 1)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: { ...probe.state.threads[session], resumeServiceInstanceId: 'replacement' },
          },
        })
      }, SESSION)
      await expect.poll(() => requests.length).toBe(2)
      assert.deepEqual(
        requests.map((request) => [request.model_id, request.service_instance_id]),
        [
          ['model-b', INSTANCE],
          ['model-b', 'replacement'],
        ]
      )
    })
  }
)

for (const change of ['session', 'draft', 'project']) {
  test(
    `startup hydration cannot prepare a late target after ${change} changes`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        let prepares = 0
        await preparation(page)
        page.on('request', (request) => {
          if (request.method() === 'POST') prepares += 1
        })
        await restoreSession(page)
        await startupReady(page)
        assert.equal(prepares, 0)
        await page.evaluate(
          ({ session, instance, change }) => {
            const probe = Reflect.get(window, 'launchProbe')
            if (change === 'session') probe.patch({ activeSession: 'other-session' })
            if (change === 'draft') probe.draft()
            if (change === 'project') probe.patch({ homeSelectedProjectId: 'other-project' })
            probe.patch({
              threads: {
                ...probe.state.threads,
                [session]: {
                  ...probe.state.threads[session],
                  resumeServiceInstanceId: instance,
                },
              },
            })
          },
          { session: SESSION, instance: INSTANCE, change }
        )
        await settleStartup(page)
        assert.equal(prepares, 0)
      })
    }
  )
}

test(
  'restored session prepares its own model on every explicit send without replaying failures',
  { timeout: 60000 },
  async (context) => {
    await fixture(context, async (page) => {
      const control = await preparation(page)
      const turns: Record<string, unknown>[] = []
      const forbidden: string[] = []
      await page.route('**/api/serve/sessions/open', (route) => {
        forbidden.push('open')
        return route.fulfill({ status: 500 })
      })
      await page.route('**/api/serve/sessions/*/queue/**', (route) => {
        forbidden.push(route.request().method())
        return route.fulfill({ status: 500 })
      })
      await page.route('**/api/serve/sessions/*/turns', (route) => {
        turns.push(route.request().postDataJSON())
        return route.fulfill({
          json: {
            ok: true,
            accepted: true,
            disposition: 'direct',
            turn_id: `continued-${turns.length}`,
          },
        })
      })
      await restoreSession(page)
      await page.getByTestId('composer-input').fill('continued message')
      await page.getByTestId('composer-send').click()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await expect(page.getByTestId('runtime-preparation')).toHaveCount(0)
      assert.equal(turns.length, 0)
      await expect(page.getByTestId('composer-input')).toHaveValue('continued message')
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
          SESSION
        ),
        1
      )
      control.finish()
      await expect.poll(() => turns.length).toBe(1)
      assert.equal(turns[0].expected_model_id, 'model-b')
      assert.equal(turns[0].service_instance_id, INSTANCE)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.model),
        'model-a'
      )
      await expect
        .poll(() =>
          page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe')
                .state.threads[session].queuedMessages.filter(
                  (message: { queuedMessageId: string }) =>
                    message.queuedMessageId !== 'old-failure'
                )
                .map((message: { state: string }) => message.state),
            SESSION
          )
        )
        .toEqual(['queued'])
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
        null
      )
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              queuedMessages: probe.state.threads[session].queuedMessages.filter(
                (message: { queuedMessageId: string }) => message.queuedMessageId === 'old-failure'
              ),
            },
          },
        })
      }, SESSION)
      await page.getByTestId('composer-input').fill('another explicit message')
      await page.getByTestId('composer-send').click()
      await expect.poll(() => turns.length).toBe(2)
      assert.equal(turns[1].expected_model_id, 'model-b')
      assert.deepEqual(forbidden, [])
      await expect
        .poll(() =>
          page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe')
                .state.threads[session].queuedMessages.filter(
                  (message: { queuedMessageId: string }) =>
                    message.queuedMessageId !== 'old-failure'
                )
                .every(
                  (message: { state: string; serverPresent: boolean }) =>
                    message.state === 'queued' && message.serverPresent
                ),
            SESSION
          )
        )
        .toBe(true)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'launchProbe').state.foregroundError),
        null
      )
      assert.equal(
        await page.evaluate(
          (session) =>
            Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages[0].state,
          SESSION
        ),
        'failed'
      )
    })
  }
)

for (const outcome of ['applied', 'rejected', 'session', 'unmount']) {
  test(`conversation continuity: preparing follow-up keeps its bubble through ${outcome}`, async (context) => {
    await fixture(
      context,
      async (page) => {
        const control = await preparation(page)
        const turns: Record<string, unknown>[] = []
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns.push(route.request().postDataJSON())
          return route.fulfill({ json: { ok: true, accepted: true, disposition: 'direct' } })
        })
        await restoreSession(page)
        await page.evaluate((session) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: {
                ...probe.state.threads[session],
                running: false,
                queuedMessages: [],
                conversation: [
                  { kind: 'user', text: '你好', itemId: 'previous-user', turnId: 'previous' },
                ],
              },
            },
          })
        }, SESSION)
        await page.getByTestId('composer-input').fill('你好')
        await page.getByTestId('composer-send').click()
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await expect(page.getByTestId('assistant-working')).toBeVisible()
        await expect(page.locator('[data-message-kind="user"]')).toHaveCount(2)
        const itemId = await page
          .locator('[data-message-kind="user"]')
          .last()
          .getAttribute('data-message-item-id')
        assert.ok(itemId)
        assert.equal(turns.length, 0)
        if (outcome === 'session')
          await page.evaluate(() => Reflect.get(window, 'launchProbe').draft())
        if (outcome === 'unmount')
          await page.evaluate(() => Reflect.get(window, 'launchProbe').hide())
        control.finish(outcome === 'rejected' ? 'rejected' : 'applied')
        if (outcome === 'applied') {
          await expect.poll(() => turns.length).toBe(1)
          await expect(page.locator('[data-message-kind="user"]')).toHaveCount(2)
          await expect(page.locator('[data-message-kind="user"]').last()).toHaveAttribute(
            'data-message-item-id',
            itemId!
          )
        } else {
          await expect
            .poll(() =>
              page.evaluate(
                (session) =>
                  Reflect.get(window, 'launchProbe').state.threads[session].conversation.length,
                SESSION
              )
            )
            .toBe(1)
          assert.equal(turns.length, 0)
          if (outcome === 'rejected')
            await expect(page.getByTestId('composer-input')).toHaveValue('你好')
        }
      },
      async (page) => {
        await page.addInitScript(() => Reflect.set(window, 'streamFixture', true))
      }
    )
  })
}

test('conversation continuity: preparing queued work keeps queue presentation', async (context) => {
  await fixture(
    context,
    async (page) => {
      const control = await preparation(page)
      await restoreSession(page)
      await page.evaluate((session) => {
        const probe = Reflect.get(window, 'launchProbe')
        probe.patch({
          threads: {
            ...probe.state.threads,
            [session]: {
              ...probe.state.threads[session],
              conversation: [
                { kind: 'user', text: 'previous', itemId: 'previous-user', turnId: 'previous' },
              ],
            },
          },
        })
      }, SESSION)
      await page.getByTestId('composer-input').fill('queued follow-up')
      await page.getByTestId('composer-send').click()
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase))
        .toBe('preparing')
      await expect(page.locator('[data-message-kind="user"]')).toHaveCount(1)
      await page.evaluate(() => Reflect.get(window, 'launchProbe').draft())
      control.finish()
    },
    async (page) => {
      await page.addInitScript(() => Reflect.set(window, 'streamFixture', true))
    }
  )
})
for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`conversation continuity: first activity is open on mount with ${reducedMotion}`, async (context) => {
    await fixture(
      context,
      async (page) => {
        await page.emulateMedia({ reducedMotion })
        await restoreSession(page)
        await page.evaluate((session) => {
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: {
                ...probe.state.threads[session],
                running: true,
                queuedMessages: [],
                turnOutcomes: { current: 'running' },
                conversation: [
                  { kind: 'user', text: '你好', itemId: 'current-user', turnId: 'current' },
                ],
              },
            },
          })
        }, SESSION)
        await expect(page.getByTestId('assistant-working')).toBeVisible()
        await page.evaluate((session) => {
          Reflect.set(window, 'activityMountCollapsed', null)
          const observer = new MutationObserver(() => {
            const group = document.querySelector(
              '[data-testid="turn-activity"] > [aria-hidden="false"]'
            )
            const step = document.querySelector('[data-testid="thinking-activity-content"]')
            if (!group || !step) return
            Reflect.set(window, 'activityMountCollapsed', [
              group.classList.contains('opacity-0'),
              step.classList.contains('opacity-0'),
            ])
            observer.disconnect()
          })
          observer.observe(document.body, { childList: true, subtree: true })
          const probe = Reflect.get(window, 'launchProbe')
          probe.patch({
            threads: {
              ...probe.state.threads,
              [session]: {
                ...probe.state.threads[session],
                conversation: [
                  ...probe.state.threads[session].conversation,
                  {
                    kind: 'thinking',
                    text: 'fixture progress',
                    itemId: 'current-thinking',
                    turnId: 'current',
                  },
                ],
              },
            },
          })
        }, SESSION)
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'activityMountCollapsed')))
          .toEqual([false, false])
        await expect(page.getByTestId('assistant-working')).toHaveCount(0)
        await expect(page.getByTestId('thinking-activity-step')).toHaveCount(1)
        await expect(page.locator('[data-message-kind="user"]')).toHaveCount(1)
      },
      async (page) => {
        await page.addInitScript(() => Reflect.set(window, 'streamFixture', true))
      }
    )
  })
}

for (const change of ['session', 'model', 'instance', 'context', 'unmount', 'rejection']) {
  test(
    `restored send remains unsubmitted after ${change} during preparation`,
    { timeout: 60000 },
    async (context) => {
      await fixture(context, async (page) => {
        const control = await preparation(page)
        let turns = 0
        await page.route('**/api/serve/sessions/*/turns', (route) => {
          turns += 1
          return route.fulfill({ json: { ok: true } })
        })
        await restoreSession(page)
        await page.getByTestId('composer-input').fill('retained continuation')
        await page.getByTestId('composer-send').click()
        await expect
          .poll(() =>
            page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch?.phase)
          )
          .toBe('preparing')
        await page.evaluate(
          ({ change, session }) => {
            const probe = Reflect.get(window, 'launchProbe')
            if (change === 'session') probe.draft()
            if (change === 'model')
              probe.patch({
                threads: {
                  ...probe.state.threads,
                  [session]: {
                    ...probe.state.threads[session],
                    runtime: { name: 'codex', model_id: 'model-a' },
                  },
                },
              })
            if (change === 'instance') probe.patch({ serviceInstanceId: 'replacement' })
            if (change === 'context')
              probe.patch({
                aiPanel: { ...probe.state.aiPanel, revision: probe.state.aiPanel.revision + 1 },
              })
            if (change === 'unmount') probe.hide()
          },
          { change, session: SESSION }
        )
        control.finish(change === 'rejection' ? 'rejected' : 'applied')
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'launchProbe').state.turnLaunch))
          .toBe(null)
        assert.equal(turns, 0)
        assert.equal(
          await page.evaluate(
            (session) =>
              Reflect.get(window, 'launchProbe').state.threads[session].queuedMessages.length,
            SESSION
          ),
          1
        )
        if (['model', 'instance', 'context', 'rejection'].includes(change))
          await expect(page.getByTestId('composer-input')).toHaveValue('retained continuation')
      })
    }
  )
}
