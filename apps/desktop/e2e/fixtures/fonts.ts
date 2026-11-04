import { expect, type Locator, type Page, type Worker } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const OFFICE_WORKER_TIMEOUT_MS = 15_000
const OFFICE_CANVAS_CHROME_INSET_PX = 20
const OFFICE_OPEN_MEASURE = 'office-open-ready'
const OFFICE_SNAPSHOT_SCRIPT = String.raw`(() => {
  const toolkit = css.awt.Toolkit.create(zetajs.getUnoComponentContext());
  const device = toolkit.createScreenCompatibleDevice(1, 1);
  const fonts = device.getFontDescriptors().map(font => ({
    family: font.Name, style: font.StyleName, weight: font.Weight, slant: font.Slant.value
  }));
  const uniqueFonts = [...new Map(fonts.map(font => [JSON.stringify(font), font])).values()];
  uniqueFonts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  const controller = xModel.getCurrentController();
  const properties = controller.getPropertySetInfo();
  for (const name of ['PageCount', 'LineCount']) {
    if (!properties.hasPropertyByName(name)) throw new Error('Office layout property unavailable: ' + name);
  }
  const attributes = ['CharFontName', 'CharFontStyleName', 'CharWeight', 'CharPosture',
    'CharHeight', 'CharFontNameAsian', 'CharFontStyleNameAsian', 'CharWeightAsian',
    'CharPostureAsian', 'CharHeightAsian'];
  const paragraphs = [];
  const enumeration = xModel.getText().createEnumeration();
  while (enumeration.hasMoreElements()) {
    const paragraph = enumeration.nextElement();
    if (typeof paragraph.getString !== 'function') continue;
    const portions = paragraph.createEnumeration();
    const runs = [];
    while (portions.hasMoreElements()) {
      const portion = portions.nextElement();
      const text = portion.getString();
      if (!text) continue;
      const format = {};
      for (const name of attributes) {
        const value = portion.getPropertyValue(name);
        format[name] = typeof value === 'object' ? value.value : value;
      }
      runs.push({ text, format });
    }
    paragraphs.push({ text: paragraph.getString(), runs });
  }
  return { fonts: uniqueFonts, pageCount: controller.getPropertyValue('PageCount'),
    lineCount: controller.getPropertyValue('LineCount'), paragraphs };
})()`

export interface OfficeRenderingSnapshot {
  fonts: Array<{ family: string; style: string; weight: number; slant: number }>
  pageCount: number
  lineCount: number
  paragraphs: Array<{
    text: string
    runs: Array<{ text: string; format: Record<string, string | number> }>
  }>
}

/** Browser clock from the actual click through the ready DOM mutation, excluding Playwright polling. */
export async function armOfficeOpen(page: Page, name: string): Promise<void> {
  await page.getByTestId(`explorer-select-resources/${name}`).evaluate((node, { name, measure }) => {
    performance.clearMarks(measure)
    performance.clearMeasures(measure)
    node.addEventListener('click', () => {
      const start = performance.now()
      const observer = new MutationObserver(() => {
        const frame = [...document.querySelectorAll('iframe[data-testid="office-editor"]')]
          .find(candidate => candidate.getAttribute('title') === name && candidate.getAttribute('data-document-ready') === 'true')
        if (!frame) return
        performance.measure(measure, { start, end: performance.now() })
        observer.disconnect()
      })
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-document-ready'] })
    }, { once: true, capture: true })
  }, { name, measure: OFFICE_OPEN_MEASURE })
}

export async function measuredOfficeOpen(page: Page): Promise<number> {
  return page.evaluate(measure => {
    const entry = performance.getEntriesByName(measure, 'measure')[0]
    if (!entry) throw new Error('Office ready measurement missing')
    return entry.duration
  }, OFFICE_OPEN_MEASURE)
}

/** UNO may split equal-format portions at soft page boundaries after layout.
 * Compare the format of every character, independent of those internal splits. */
export function canonicalFontRuns(snapshot: OfficeRenderingSnapshot): OfficeRenderingSnapshot {
  return { ...snapshot, paragraphs: snapshot.paragraphs.map(paragraph => {
    const runs: OfficeRenderingSnapshot['paragraphs'][number]['runs'] = []
    for (const run of paragraph.runs) {
      const previous = runs.at(-1)
      if (previous && JSON.stringify(previous.format) === JSON.stringify(run.format)) previous.text += run.text
      else runs.push({ ...run })
    }
    expect(runs.map(run => run.text).join('')).toBe(paragraph.text)
    return { ...paragraph, runs }
  }) }
}

/** Inspect the actual document after a UI open; do not inject a replacement worker or font API. */
export async function officeWorker(page: Page): Promise<Worker> {
  let selected: Worker | undefined
  await expect.poll(async () => {
    for (const worker of page.workers()) {
      if (await worker.evaluate('typeof xModel !== "undefined" && xModel !== undefined && typeof zetajs !== "undefined"')) {
        selected = worker
        return true
      }
    }
    return false
  }, { timeout: OFFICE_WORKER_TIMEOUT_MS, message: 'The real Office UNO worker must expose its loaded document' }).toBe(true)
  return selected!
}

/** Supplemental engine evidence. UI rendering and document persistence are tested separately. */
export async function officeRenderingSnapshot(page: Page, rawPath?: string): Promise<OfficeRenderingSnapshot> {
  const worker = await officeWorker(page)
  const snapshot = await worker.evaluate<OfficeRenderingSnapshot>(OFFICE_SNAPSHOT_SCRIPT)
  if (rawPath) writeFileSync(rawPath, JSON.stringify(snapshot, null, 2))
  expect(snapshot.fonts.length).toBeGreaterThan(0)
  expect(snapshot.pageCount).toBeGreaterThan(0)
  expect(snapshot.lineCount).toBeGreaterThan(0)
  expect(snapshot.paragraphs.length).toBeGreaterThan(0)
  return canonicalFontRuns(snapshot)
}

/** Exclude native scrollbars and their hover state from the typography comparison. */
export async function officeCanvasContentScreenshot(page: Page, canvas: Locator, path: string): Promise<Buffer> {
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Office canvas has no visible bounds')
  return page.screenshot({ path, clip: {
    x: bounds.x + OFFICE_CANVAS_CHROME_INSET_PX,
    y: bounds.y + OFFICE_CANVAS_CHROME_INSET_PX,
    width: bounds.width - OFFICE_CANVAS_CHROME_INSET_PX * 2,
    height: bounds.height - OFFICE_CANVAS_CHROME_INSET_PX * 2,
  } })
}
