import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { apiBase, DesktopSession, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime, seedLiveConfig } from './fixtures/runtime'
import { createReadyProject } from './fixtures/projects'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const CORPUS = process.env.SCHOLARSEED_OFFICE_CORPUS
const REPETITIONS = Number(process.env.SCHOLARSEED_CSV_BENCH_ROUNDS || 3)
const OPEN_TIMEOUT_MS = 180_000
const CASES = [1000, 10000, 100000]
const AFTER = process.env.SCHOLARSEED_CSV_PHASE === 'after'
const INTERACTION_SAMPLES = 20
const SHORTCUT = process.platform === 'darwin' ? 'Meta' : 'Control'
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

async function selectionTiming(page: Page, grid: Locator, cell: Locator): Promise<number> {
  await grid.focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-action-host')).toBeHidden()
  await page.evaluate(() => {
    const state = window as typeof window & { csvSelectionStart?: number; csvSelectionMs?: number }
    state.csvSelectionStart = undefined
    state.csvSelectionMs = undefined
    const observer = new MutationObserver(() => {
      const menu = document.querySelector('[data-testid="selection-action-host"]')
      if (
        state.csvSelectionStart !== undefined &&
        menu &&
        menu.getBoundingClientRect().height > 0
      ) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.csvSelectionMs = performance.now() - state.csvSelectionStart!
          })
        )
        observer.disconnect()
      }
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true })
    document.addEventListener(
      'pointerup',
      () => {
        state.csvSelectionStart = performance.now()
      },
      { once: true, capture: true }
    )
  })
  await cell.click()
  await page.waitForFunction(
    () => (window as typeof window & { csvSelectionMs?: number }).csvSelectionMs !== undefined
  )
  return page.evaluate(() => (window as typeof window & { csvSelectionMs: number }).csvSelectionMs)
}

async function nativeInteractionTimings(
  page: Page,
  grid: Locator
): Promise<Record<string, unknown>> {
  const selection: number[] = [],
    scrolling: number[] = [],
    editing: number[] = []
  await grid.hover()
  await page.mouse.wheel(0, -100_000)
  await expect(grid.locator('[data-cell="A1"]')).toBeVisible()
  for (let sample = 0; sample < INTERACTION_SAMPLES; sample++) {
    selection.push(await selectionTiming(page, grid, grid.locator(`[data-cell="A${sample + 2}"]`)))
  }
  for (let sample = 0; sample < INTERACTION_SAMPLES; sample++) {
    await grid.evaluate((element) => {
      const state = window as typeof window & { csvScrollMs?: number; csvScrollStart?: number }
      state.csvScrollMs = undefined
      const before = [...element.querySelectorAll('[data-cell]')]
        .map((cell) => cell.getAttribute('data-cell'))
        .join(',')
      element.addEventListener(
        'wheel',
        () => {
          state.csvScrollStart = performance.now()
          const observer = new MutationObserver(() => {
            const cells = [...element.querySelectorAll('[data-cell]')]
            const after = cells.map((cell) => cell.getAttribute('data-cell')).join(',')
            // These original performance samples have no empty fields. A changed
            // virtual row address alone can precede its worker window contents.
            if (
              after !== before &&
              cells.length > 0 &&
              cells.every((cell) => Boolean(cell.textContent))
            ) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  state.csvScrollMs = performance.now() - state.csvScrollStart!
                })
              )
              observer.disconnect()
            }
          })
          observer.observe(element, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          })
        },
        { once: true, capture: true }
      )
    })
    await grid.hover()
    await page.mouse.wheel(0, 240)
    await page.waitForFunction(
      () => (window as typeof window & { csvScrollMs?: number }).csvScrollMs !== undefined
    )
    scrolling.push(
      await page.evaluate(() => (window as typeof window & { csvScrollMs: number }).csvScrollMs)
    )
  }
  await grid.hover()
  await page.mouse.wheel(0, -100_000)
  await expect(grid.locator('[data-cell="A2"]')).toBeVisible()
  const cell = grid.locator('[data-cell="A2"]')
  const original = await cell.innerText()
  for (let sample = 0; sample < INTERACTION_SAMPLES; sample++) {
    await cell.dblclick()
    const editor = page.getByTestId('csv-cell-editor')
    const value = `CSV performance edit ${sample}`
    await editor.fill(value)
    await editor.evaluate((element, value) => {
      const state = window as typeof window & { csvEditMs?: number; csvEditStart?: number }
      state.csvEditMs = undefined
      element.addEventListener(
        'keydown',
        (event) => {
          if ((event as KeyboardEvent).key !== 'Enter') return
          state.csvEditStart = performance.now()
          const observer = new MutationObserver(() => {
            if (document.querySelector('[data-cell="A2"]')?.textContent === value) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  state.csvEditMs = performance.now() - state.csvEditStart!
                })
              )
              observer.disconnect()
            }
          })
          observer.observe(document, { subtree: true, childList: true, characterData: true })
        },
        { once: true, capture: true }
      )
    }, value)
    await editor.press('Enter')
    await page.waitForFunction(
      () => (window as typeof window & { csvEditMs?: number }).csvEditMs !== undefined
    )
    editing.push(
      await page.evaluate(() => (window as typeof window & { csvEditMs: number }).csvEditMs)
    )
    await grid.focus()
    await page.keyboard.press(`${SHORTCUT}+z`)
    await expect(cell).toHaveText(original)
  }
  const percentile = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  const result = {
    selection,
    scrolling,
    editing,
    selectionP95Ms: percentile(selection),
    scrollP95Ms: percentile(scrolling),
    editP95Ms: percentile(editing),
  }
  if (await page.getByTestId('document-save').isEnabled())
    await page.getByTestId('document-save').click()
  return result
}

for (const rows of CASES) {
  for (let round = 1; round <= REPETITIONS; round++) {
    test(`CSV foreground baseline ${rows} rows round ${round}`, async ({
      browserName: _browserName,
    }, testInfo) => {
      testInfo.annotations.push({ type: 'configured-browser', description: _browserName })
      test.skip(!CORPUS, 'requires original CSV corpus')
      test.setTimeout(OPEN_TIMEOUT_MS * 3)
      const name = `sample-data-${rows}-rows.csv`
      const source = join(CORPUS!, 'csv', name)
      expect(existsSync(source), source).toBe(true)
      const originalHash = hash(source)
      const runtime = createRuntime(testInfo)
      const desktop = new DesktopSession(runtime, testInfo, {
        nativeWindowLifecycle: true,
        preserveNavigation: true,
        recordTrace: false,
      })
      const diagnostics: unknown[] = []
      const measurements: unknown[] = []
      try {
        const page = await desktop.launch()
        const native = await desktop.browserWindow(page)
        const foreground = await native.evaluate((window) => ({
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          focused: window.isFocused(),
        }))
        expect(foreground.visible).toBe(true)
        expect(foreground.minimized).toBe(false)
        await page.bringToFront()
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
        page.on('console', (message) => {
          if (message.text().startsWith('[office-runtime] ')) {
            diagnostics.push(JSON.parse(message.text().slice('[office-runtime] '.length)))
          }
        })
        const project = await createReadyProject(page, `CSV baseline ${rows} ${round}`)
        const resources = join(project.root, 'resources')
        mkdirSync(resources, { recursive: true })
        copyFileSync(source, join(resources, name))
        await page.reload()
        const landing = page.getByTestId('landing-skip')
        if (await landing.isVisible()) await landing.click()
        await page.getByTestId(`home-project-${project.name}`).click()
        await page.getByTestId('activity-resource').click()
        await page.getByTestId('resource-refresh').click()
        const tree = page.getByTestId(`tree-resources/${name}`)
        await expect(tree).toBeVisible()

        for (const temperature of ['cold', 'warm'] as const) {
          await expect
            .poll(async () => {
              await desktop.app!.evaluate(({ app }) => app.focus({ steal: true }))
              await native.evaluate((window) => {
                window.show()
                window.focus()
              })
              return native.evaluate((window) => window.isFocused())
            })
            .toBe(true)
          expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
          await tree.evaluate((node, name) => {
            const state = window as typeof window & {
              csvMeasure?: { start: number; duration: number | null }
            }
            node.addEventListener(
              'click',
              () => {
                state.csvMeasure = { start: performance.now(), duration: null }
                const observer = new MutationObserver(() => {
                  const frame = [
                    ...document.querySelectorAll('iframe[data-testid="office-editor"]'),
                  ].find(
                    (element) =>
                      element.getAttribute('title') === name &&
                      element.getAttribute('data-document-ready') === 'true'
                  )
                  const grid = document.querySelector('[data-testid="csv-grid"]')
                  if (!frame && !grid?.querySelector('[data-cell="A1"]')) return
                  requestAnimationFrame(() => {
                    state.csvMeasure!.duration = performance.now() - state.csvMeasure!.start
                  })
                  observer.disconnect()
                })
                observer.observe(document, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                  attributeFilter: ['data-document-ready'],
                })
              },
              { once: true, capture: true }
            )
          }, name)
          await tree.click()
          await page.waitForFunction(
            () => {
              const state = window as typeof window & { csvMeasure?: { duration: number | null } }
              return state.csvMeasure?.duration !== null && state.csvMeasure?.duration !== undefined
            },
            undefined,
            { timeout: OPEN_TIMEOUT_MS }
          )
          const opening = await page.evaluate(
            () =>
              (window as typeof window & { csvMeasure: { duration: number } }).csvMeasure.duration
          )
          const frame = page.locator(`iframe[data-testid="office-editor"][title="${name}"]`)
          const legacy = (await frame.count()) > 0
          if (AFTER) expect(legacy, 'CSV must use the native grid, without Zeta Office').toBe(false)
          const canvas = legacy
            ? frame.contentFrame().locator('#qtcanvas')
            : page.getByTestId('csv-grid')
          const box = await canvas.boundingBox()
          expect(box).not.toBeNull()
          // Actual pointerup -> visible action host. Both clocks are in the renderer,
          // not Playwright request or locator polling time.
          await page.evaluate(() => {
            const state = window as typeof window & {
              csvSelectionStart?: number
              csvSelectionMs?: number
            }
            const observer = new MutationObserver(() => {
              const menu = document.querySelector('[data-testid="selection-action-host"]')
              if (
                state.csvSelectionStart !== undefined &&
                menu &&
                menu.getBoundingClientRect().height > 0
              ) {
                state.csvSelectionMs = performance.now() - state.csvSelectionStart
                observer.disconnect()
              }
            })
            observer.observe(document, { subtree: true, childList: true, attributes: true })
            state.csvSelectionMs = undefined
          })
          await canvas.evaluate((element) => {
            element.ownerDocument.addEventListener(
              'pointerup',
              () => {
                const parentWindow = element.ownerDocument.defaultView!.parent as Window & {
                  csvSelectionStart?: number
                }
                parentWindow.csvSelectionStart = parentWindow.performance.now()
              },
              { capture: true, once: true }
            )
          })
          await page.mouse.click(box!.x + 100, box!.y + 50)
          await expect(page.getByTestId('selection-action-host')).toBeVisible()
          const selectionMs = await page.evaluate(
            () => (window as typeof window & { csvSelectionMs?: number }).csvSelectionMs
          )
          expect(selectionMs).toBeDefined()
          // Wheel -> next actual frame is only a renderer scheduling metric. Canvas
          // screenshot changes separately prove the document scrolled; it is not a paint latency.
          await canvas.evaluate((element) => {
            element.addEventListener(
              'wheel',
              () => {
                const root = element.ownerDocument.defaultView!.parent as Window & {
                  csvWheelFrameMs?: number
                }
                const started = root.performance.now()
                element.ownerDocument.defaultView!.requestAnimationFrame(() => {
                  root.csvWheelFrameMs = root.performance.now() - started
                })
              },
              { once: true, capture: true }
            )
          })
          const beforeScroll = await canvas.screenshot()
          await canvas.hover()
          await page.mouse.wheel(0, 600)
          await expect
            .poll(async () => (await canvas.screenshot()).equals(beforeScroll))
            .toBe(false)
          const wheelFrameMs = await page.evaluate(
            () => (window as typeof window & { csvWheelFrameMs?: number }).csvWheelFrameMs
          )
          const saveVisible = (await page.getByTestId('document-save').count()) > 0
          const measurement = {
            rows,
            round,
            temperature,
            openingMs: opening,
            pointerupToSelectionMenuMs: selectionMs,
            wheelToNextFrameMs: wheelFrameMs,
            interactions: null as Record<string, unknown> | null,
            scrolled: true,
            saveVisible,
            editableBaseline: legacy ? 'readonly; editing and save N/A' : 'native',
          }
          measurements.push(measurement)
          if (AFTER && temperature === 'cold')
            measurement.interactions = await nativeInteractionTimings(page, canvas)
          await page.screenshot({ path: join(runtime.artifacts, `${temperature}-${rows}.png`) })
          expect(hash(source)).toBe(originalHash)
          expect(hash(join(resources, name))).toBe(originalHash)
          if (temperature === 'cold') {
            await page
              .getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })
              .click({ button: 'right' })
            await page.getByTestId('tab-close-all').click()
          }
        }
      } finally {
        if (desktop.app) {
          writeFileSync(
            join(runtime.artifacts, 'native-window-state.json'),
            JSON.stringify(
              await desktop.app
                .evaluate(({ app, BrowserWindow }) => ({
                  argv: process.argv,
                  hidden: app.isHidden(),
                  windows: BrowserWindow.getAllWindows().map((window) => ({
                    url: window.webContents.getURL(),
                    visible: window.isVisible(),
                    focused: window.isFocused(),
                    minimized: window.isMinimized(),
                  })),
                }))
                .catch((error) => ({ error: String(error) })),
              null,
              2
            )
          )
        }
        writeFileSync(
          join(runtime.artifacts, 'csv-baseline.json'),
          JSON.stringify(
            { phase: AFTER ? 'after' : 'before', source, originalHash, measurements, diagnostics },
            null,
            2
          )
        )
        await desktop.attachArtifacts()
      }
    })
  }
}

const ORIGINAL_NAMES = [
  'sample-data-10-rows.csv',
  'sample-data-100-rows.csv',
  'sample-data-100-rows-no-header.csv',
  'sample-data-100-rows-quoted.csv',
  'sample-data-100-rows-semicolon.csv',
  'sample-data-100-rows-utf8-bom.csv',
  'sample-data-1000-rows.csv',
  'sample-data-10000-rows.csv',
  'sample-data-100000-rows.csv',
]
const AGENT_NAMES = new Set([
  'sample-data-100-rows-quoted.csv',
  'sample-data-100-rows-utf8-bom.csv',
  'sample-data-100000-rows.csv',
])
const SAVED_VALUE = 'CSV saved, "quoted" value\n第二行'
const PYTHON = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
)

/** Independent stdlib CSV parser checks every original field, not our product codec. */
function verifySavedCsv(source: string, saved: string): void {
  const script = String.raw`
import csv, json, pathlib, sys
source, saved = map(pathlib.Path, sys.argv[1:3])
delimiter = ';' if 'semicolon' in source.name else ','
with source.open(encoding='utf-8-sig', newline='') as stream: expected = list(csv.reader(stream, delimiter=delimiter))
with saved.open(encoding='utf-8-sig', newline='') as stream: actual = list(csv.reader(stream, delimiter=delimiter))
expected[1][0] = sys.argv[3]
expected[1][1:3] = ['Pasted CSV', 'Second pasted cell']
assert actual == expected, 'saved/reopened CSV fields differ from expected original-plus-three-edits'
before, after = source.read_bytes(), saved.read_bytes()
assert before.startswith(bytes.fromhex('efbbbf')) == after.startswith(bytes.fromhex('efbbbf')), 'UTF-8 BOM changed'
assert (before.endswith(bytes.fromhex('0d0a')), before.endswith(bytes.fromhex('0a'))) == (after.endswith(bytes.fromhex('0d0a')), after.endswith(bytes.fromhex('0a'))), 'record terminator changed'
print(json.dumps({'rows':len(actual), 'fields_valid':True, 'bom_preserved':True}))
`
  expect(
    JSON.parse(
      execFileSync(PYTHON, ['-c', script, source, saved, SAVED_VALUE], { encoding: 'utf8' })
    ).fields_valid
  ).toBe(true)
}

for (const name of ORIGINAL_NAMES) {
  test(`original CSV ${name} edits, pastes, undoes, saves and reopens with source Agent actions`, async ({
    browserName: _browserName,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'configured-browser', description: _browserName })
    test.skip(!AFTER || !CORPUS, 'requires after phase and original CSV corpus')
    test.setTimeout(OPEN_TIMEOUT_MS * 3)
    const source = join(CORPUS!, 'csv', name)
    const originalHash = hash(source)
    const runtime = createRuntime(testInfo)
    const realAgent = process.env.SCHOLARSEED_ONE_SHOT_E2E === '1' && AGENT_NAMES.has(name)
    if (realAgent) {
      const blocker = seedLiveConfig(runtime)
      if (blocker) throw new Error(blocker)
    }
    const desktop = new DesktopSession(runtime, testInfo, {
      nativeWindowLifecycle: true,
      preserveNavigation: true,
      recordTrace: false,
    })
    try {
      const page = await desktop.launch()
      const project = await createReadyProject(page, `CSV original ${name}`)
      const resources = join(project.root, 'resources')
      mkdirSync(resources, { recursive: true })
      const saved = join(resources, name)
      copyFileSync(source, saved)
      await page.reload()
      const landing = page.getByTestId('landing-skip')
      if (await landing.isVisible()) await landing.click()
      await page.getByTestId(`home-project-${project.name}`).click()
      await page.getByTestId('activity-resource').click()
      await page.getByTestId('resource-refresh').click()
      await page.getByTestId(`tree-resources/${name}`).click()
      const document = page.getByTestId('csv-document')
      const grid = document.getByTestId('csv-grid')
      await expect(grid.locator('[data-cell="A1"]')).toHaveText(
        name.includes('no-header') ? 'PB-100001' : 'order_id'
      )
      await expect(page.locator('[data-testid="office-editor"][data-runtime-view]:not([data-runtime-view=""])')).toHaveCount(0)
      const metadataResponse = await page.request.get(
        `${await apiBase(page)}/api/workbench/open?path=${encodeURIComponent(`resources/${name}`)}&project=${encodeURIComponent(project.id)}`
      )
      expect(metadataResponse.status()).toBe(200)
      const metadata = await metadataResponse.json()
      writeFileSync(
        join(runtime.artifacts, 'csv-public-capabilities.json'),
        JSON.stringify(
          {
            viewer: metadata.viewer,
            capabilities: metadata.capabilities,
            revision: metadata.revision,
          },
          null,
          2
        )
      )
      expect(metadata.capabilities.can_edit).toBe(true)
      expect(metadata.capabilities.can_save).toBe(true)
      await expect(grid.locator('[data-cell="H2"]')).toHaveText(
        name.includes('semicolon') ? '2400,0' : '2400.0'
      )
      const cell = grid.locator('[data-cell="A2"]')
      const originalCell = await cell.innerText()
      await cell.dblclick()
      const editor = page.getByTestId('csv-cell-editor')
      await editor.fill(SAVED_VALUE)
      await editor.press('Enter')
      await expect(cell).toHaveText(SAVED_VALUE)
      await grid.focus()
      await page.keyboard.press(`${SHORTCUT}+z`)
      await expect(cell).toHaveText(originalCell)
      await page.keyboard.press(`${SHORTCUT}+Shift+z`)
      await expect(cell).toHaveText(SAVED_VALUE)

      await grid.locator('[data-cell="B2"]').click()
      await page.evaluate(() => navigator.clipboard.writeText('Pasted CSV\tSecond pasted cell'))
      await grid.focus()
      await page.keyboard.press(`${SHORTCUT}+v`)
      await expect(grid.locator('[data-cell="B2"]')).toHaveText('Pasted CSV')
      await expect(grid.locator('[data-cell="C2"]')).toHaveText('Second pasted cell')
      await page.keyboard.press(`${SHORTCUT}+z`)
      await expect(grid.locator('[data-cell="B2"]')).not.toHaveText('Pasted CSV')
      await page.keyboard.press(`${SHORTCUT}+Shift+z`)
      await expect(grid.locator('[data-cell="B2"]')).toHaveText('Pasted CSV')
      expect(hash(saved), 'editing must not change disk before explicit save').toBe(originalHash)
      await expect(page.getByTestId('document-save')).toBeEnabled()
      await page.getByTestId('document-save').click()
      await expect.poll(() => hash(saved), { timeout: OPEN_TIMEOUT_MS }).not.toBe(originalHash)
      await expect(page.getByTestId('document-save')).toBeDisabled()
      verifySavedCsv(source, saved)
      const savedHash = hash(saved)
      await page
        .getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })
        .click({ button: 'right' })
      await page.getByTestId('tab-close-all').click()
      await page.getByTestId(`tree-resources/${name}`).click()
      await expect(grid.locator('[data-cell="A2"]')).toHaveText(SAVED_VALUE)
      await expect(grid.locator('[data-cell="B2"]')).toHaveText('Pasted CSV')
      await expect(grid.locator('[data-cell="C2"]')).toHaveText('Second pasted cell')
      verifySavedCsv(source, saved)
      await page.screenshot({ path: join(runtime.artifacts, 'csv-saved-reopened.png') })

      await cell.click()
      const menu = page.getByTestId('selection-action-host')
      await expect(menu).toBeVisible()
      await expect(menu).toContainText('A2:A2')
      await menu.getByRole('button', { name: '添加到对话', exact: true }).click()
      const reference = page.getByTestId('ai-context-ref').filter({ hasText: name })
      await expect(reference).toBeVisible()
      await reference.hover()
      await expect(page.getByTestId('assistant-selection-quote')).toContainText(SAVED_VALUE)
      if (realAgent) {
        const modelKey = process.env.SCHOLARSEED_ACTION_MODEL
        if (!modelKey)
          throw new Error('SCHOLARSEED_ACTION_MODEL must name a configured real model connection')
        const model = await page.request.post(`${await apiBase(page)}/api/serve/models/default`, {
          data: { model_key: modelKey, persist: true },
        })
        expect(model.status()).toBe(200)
        await cell.click()
        await menu.getByRole('button', { name: 'AI 解释', exact: true }).click()
        const explanation = page.getByTestId('resource-ai-suggestion')
        await explanation
          .getByRole('textbox')
          .fill('请仅逐字复述当前选区原文，保留换行，不添加其他内容。')
        const response = page.waitForResponse(
          (result) => result.url().endsWith('/api/resource/ai/explain'),
          { timeout: OPEN_TIMEOUT_MS }
        )
        await explanation.getByRole('button', { name: '提交AI 解释', exact: true }).click()
        await explanation.getByRole('button', { name: '固定浮窗', exact: true }).click()
        expect((await response).status()).toBe(200)
        await expect(
          explanation.getByRole('button', { name: '停止生成', exact: true })
        ).toHaveCount(0, { timeout: OPEN_TIMEOUT_MS })
        await expect(explanation.getByRole('alert')).toHaveCount(0)
        await expect(explanation.getByTestId('resource-translation-result')).toContainText(
          'CSV saved, "quoted" value'
        )
        await expect(explanation.getByTestId('resource-translation-result')).toContainText('第二行')
        await page.screenshot({ path: join(runtime.artifacts, 'csv-agent-explain.png') })
        await explanation.getByRole('button', { name: /关闭/ }).click()
        await page
          .getByTestId('composer-input')
          .fill('只根据已添加的 CSV 选区，逐字回复它的完整内容，保留换行，不添加解释。')
        await page.getByTestId('composer-send').click()
        await waitForFinishedTurn(page)
        const answer = page.locator('.answer-annotation-root').last()
        await expect(answer).toContainText('CSV saved, "quoted" value', {
          timeout: OPEN_TIMEOUT_MS,
        })
        await expect(answer).toContainText('第二行')
        await page.screenshot({ path: join(runtime.artifacts, 'csv-agent-followup.png') })
      }
      expect(hash(source)).toBe(originalHash)
      expect(hash(saved)).toBe(savedHash)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.page
        ?.screenshot({ path: join(runtime.artifacts, 'csv-final-state.png') })
        .catch(() => undefined)
      await desktop.attachArtifacts()
    }
  })
}

test('CSV compare-and-swap conflict retains the draft and reloads actual external bytes', async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.annotations.push({ type: 'configured-browser', description: _browserName })
  test.skip(!AFTER || !CORPUS, 'requires original CSV after phase')
  test.setTimeout(OPEN_TIMEOUT_MS)
  const name = 'sample-data-10-rows.csv'
  const source = join(CORPUS!, 'csv', name)
  const originalHash = hash(source)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, {
    nativeWindowLifecycle: true,
    preserveNavigation: true,
    recordTrace: false,
  })
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, 'CSV real CAS conflict')
    const resources = join(project.root, 'resources')
    mkdirSync(resources, { recursive: true })
    const saved = join(resources, name)
    copyFileSync(source, saved)
    await page.reload()
    const landing = page.getByTestId('landing-skip')
    if (await landing.isVisible()) await landing.click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-resources/${name}`).click()
    const grid = page.getByTestId('csv-grid')
    const cell = grid.locator('[data-cell="A2"]')
    await expect(cell).toHaveText('PB-100001')
    await cell.dblclick()
    const editor = page.getByTestId('csv-cell-editor')
    await editor.fill('local conflict draft')
    await editor.press('Enter')
    await expect(cell).toHaveText('local conflict draft')
    const external = readFileSync(source)
      .toString('utf8')
      .replace('PB-100001', 'external disk version')
    writeFileSync(saved, external)
    const externalHash = hash(saved)
    const response = page.waitForResponse(
      (result) =>
        result.request().method() === 'PUT' && result.url().includes('/api/workbench/content?')
    )
    await page.getByTestId('document-save').click()
    // Workbench content If-Match uses HTTP 412 (routes.py revision_conflict),
    // distinct from the 409 source/selection conflict contracts.
    expect((await response).status()).toBe(412)
    await expect(page.getByTestId('document-save-conflict')).toBeVisible()
    await expect(cell).toHaveText('local conflict draft')
    expect(hash(saved)).toBe(externalHash)
    await page.screenshot({
      path: join(runtime.artifacts, 'csv-real-cas-conflict-preserves-draft.png'),
    })
    await page.getByTestId('document-conflict-discard').click()
    await expect(page.getByTestId('document-save-conflict')).toBeHidden()
    await expect(cell).toHaveText('external disk version')
    await expect(page.getByTestId('document-save')).toBeDisabled()
    expect(hash(saved)).toBe(externalHash)
    expect(hash(source)).toBe(originalHash)
    await page.screenshot({
      path: join(runtime.artifacts, 'csv-conflict-real-external-reloaded.png'),
    })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('CSV save acknowledgement preserves a newer edit and undo history through reopen', async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.annotations.push({ type: 'configured-browser', description: _browserName })
  test.skip(!AFTER || !CORPUS, 'requires original CSV after phase')
  test.setTimeout(OPEN_TIMEOUT_MS)
  const name = 'sample-data-10-rows.csv'
  const source = join(CORPUS!, 'csv', name)
  const originalHash = hash(source)
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, {
    nativeWindowLifecycle: true,
    preserveNavigation: true,
    recordTrace: false,
  })
  let releaseSave: (() => void) | undefined
  try {
    const page = await desktop.launch()
    const project = await createReadyProject(page, 'CSV in-flight save')
    const resources = join(project.root, 'resources')
    mkdirSync(resources, { recursive: true })
    const saved = join(resources, name)
    copyFileSync(source, saved)
    await page.reload()
    const landing = page.getByTestId('landing-skip')
    if (await landing.isVisible()) await landing.click()
    await page.getByTestId(`home-project-${project.name}`).click()
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-resources/${name}`).click()
    const document = page.getByTestId('csv-document')
    const grid = document.getByTestId('csv-grid')
    const cell = grid.locator('[data-cell="A2"]')
    const edit = async (value: string): Promise<void> => {
      await cell.dblclick()
      const editor = page.getByTestId('csv-cell-editor')
      await editor.fill(value)
      await editor.press('Enter')
      await expect(cell).toHaveText(value)
    }
    const diskValue = (): string =>
      JSON.parse(
        execFileSync(
          PYTHON,
          [
            '-c',
            'import csv,json,sys; f=open(sys.argv[1],encoding="utf-8-sig",newline=""); print(json.dumps(list(csv.reader(f))[1][0]))',
            saved,
          ],
          { encoding: 'utf8' }
        )
      )
    await edit('saved version V')
    const firstRevision = await document.getAttribute('data-document-revision')
    let signalCaptured: (() => void) | undefined
    const captured = new Promise<void>((resolve) => {
      signalCaptured = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let paused = false
    await page.route('**/api/workbench/content?*', async (route) => {
      if (route.request().method() === 'PUT' && !paused) {
        paused = true
        const body = route.request().postDataBuffer()!.toString('utf8')
        expect(body).toContain('saved version V')
        expect(body).not.toContain('newer version V+1')
        signalCaptured!()
        await held
      }
      // Delay the original request, then send it to the real backend unchanged.
      // No fake response, route fulfillment or replacement bytes are used.
      await route.continue()
    })
    const firstResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().includes('/api/workbench/content?')
    )
    await page.getByTestId('document-save').click()
    await captured
    expect(hash(saved)).toBe(originalHash)
    await edit('newer version V+1')
    releaseSave!()
    const persisted = await firstResponse
    expect(persisted.status()).toBe(204)
    expect(persisted.headers().etag).toBeTruthy()
    await expect(document).not.toHaveAttribute('data-document-revision', firstRevision!)
    await expect.poll(diskValue).toBe('saved version V')
    await expect(cell).toHaveText('newer version V+1')
    await expect(page.getByTestId('document-save')).toBeEnabled()
    await page.screenshot({ path: join(runtime.artifacts, 'csv-save-v-ack-keeps-v-plus-one.png') })

    await page.getByTestId('document-save').click()
    await expect.poll(diskValue).toBe('newer version V+1')
    await expect(page.getByTestId('document-save')).toBeDisabled()
    await grid.focus()
    await page.keyboard.press(`${SHORTCUT}+z`)
    await expect(cell).toHaveText('saved version V')
    await expect(page.getByTestId('document-save')).toBeEnabled()
    await page.keyboard.press(`${SHORTCUT}+Shift+z`)
    await expect(cell).toHaveText('newer version V+1')
    await expect(page.getByTestId('document-save')).toBeDisabled()
    await expect.poll(diskValue).toBe('newer version V+1')
    await page
      .getByRole('tab', { name: new RegExp(name.replaceAll('.', '\\.')) })
      .click({ button: 'right' })
    await page.getByTestId('tab-close-all').click()
    await page.getByTestId(`tree-resources/${name}`).click()
    await expect(cell).toHaveText('newer version V+1')
    expect(hash(source)).toBe(originalHash)
    await page.screenshot({ path: join(runtime.artifacts, 'csv-save-v-plus-one-reopened.png') })
    desktop.assertNoPageErrors()
  } finally {
    releaseSave?.()
    await desktop.page
      ?.screenshot({ path: join(runtime.artifacts, 'csv-save-race-final-state.png') })
      .catch(() => undefined)
    await desktop.attachArtifacts()
  }
})

test('native CSV performance meets the frozen foreground baseline and agreed targets', async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.annotations.push({ type: 'configured-browser', description: _browserName })
  test.skip(!AFTER, 'requires measured native CSV after phase')
  const baselinePath = process.env.SCHOLARSEED_CSV_BASELINE
  expect(
    baselinePath,
    'SCHOLARSEED_CSV_BASELINE must name the frozen same-device summary'
  ).toBeTruthy()
  const baseline = JSON.parse(readFileSync(baselinePath!, 'utf8')) as {
    summary: Array<{ rows: number; temperature: string; openingMedianMs: number }>
  }
  interface Measurement {
    rows: number
    temperature: string
    openingMs: number
    interactions: {
      selection: number[]
      scrolling: number[]
      editing: number[]
      selectionP95Ms: number
      scrollP95Ms: number
      editP95Ms: number
    } | null
  }
  const samples: Measurement[] = []
  for (const entry of readdirSync(testInfo.project.outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(
      testInfo.project.outputDir,
      entry.name,
      'runtime',
      'artifacts',
      'csv-baseline.json'
    )
    if (!existsSync(path)) continue
    const result = JSON.parse(readFileSync(path, 'utf8'))
    if (result.phase === 'after') samples.push(...result.measurements)
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const limits = new Map([
    [1000, { cold: 2000, warm: 1000 }],
    [10000, { cold: 3000, warm: 1000 }],
    [100000, { cold: 5000, warm: 2000 }],
  ])
  const comparisons: unknown[] = []
  for (const rows of CASES) {
    for (const temperature of ['cold', 'warm'] as const) {
      const matching = samples.filter(
        (sample) => sample.rows === rows && sample.temperature === temperature
      )
      expect(
        matching,
        `${rows} ${temperature} must have three actual foreground samples`
      ).toHaveLength(3)
      const opening = median(matching.map((sample) => sample.openingMs))
      const prior = baseline.summary.find(
        (sample) => sample.rows === rows && sample.temperature === temperature
      )!
      expect(prior, 'same-device baseline size/temperature must exist').toBeTruthy()
      expect(opening).toBeLessThanOrEqual(limits.get(rows)![temperature])
      expect(opening).toBeLessThanOrEqual(
        temperature === 'cold' ? prior.openingMedianMs * 0.5 : prior.openingMedianMs
      )
      comparisons.push({
        rows,
        temperature,
        n: matching.length,
        beforeMedianMs: prior.openingMedianMs,
        afterMedianMs: opening,
        improvementPercent: (1 - opening / prior.openingMedianMs) * 100,
      })
    }
    const cold = samples.filter((sample) => sample.rows === rows && sample.temperature === 'cold')
    for (const operation of ['selection', 'scrolling', 'editing'] as const) {
      const values = cold
        .flatMap((sample) => sample.interactions?.[operation] ?? [])
        .sort((a, b) => a - b)
      expect(values, `${rows} ${operation} must contain 20 actual inputs per round`).toHaveLength(
        INTERACTION_SAMPLES * 3
      )
      const p95 = values[Math.ceil(values.length * 0.95) - 1]
      comparisons.push({ rows, operation, n: values.length, p95Ms: p95, maxMs: values.at(-1) })
      expect(
        p95,
        `${rows} ${operation} input through committed rendering frame`
      ).toBeLessThanOrEqual(100)
    }
  }
  await testInfo.attach('csv-foreground-performance-comparison', {
    body: JSON.stringify({ baselinePath, comparisons, samples }, null, 2),
    contentType: 'application/json',
  })
  writeFileSync(
    testInfo.outputPath('csv-performance-comparison.json'),
    JSON.stringify({ baselinePath, comparisons, samples }, null, 2)
  )
})
