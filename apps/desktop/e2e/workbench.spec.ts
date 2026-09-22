import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { expect, test } from '@playwright/test'
import { createServer, loadConfigFromFile, type UserConfig } from 'vite'
import { PDFDocument } from 'pdf-lib'
import { IMPORT_PICKER_TARGET, supportsImportPickerTarget } from '../src/picker'
import { MATHEMATICS_SOURCE } from './fixtures/mathematics'
import { TABLE_MATH_SOURCE } from './fixtures/table-math'
import { apiBase, DesktopSession, enterWorkbenchShell, waitForFinishedTurn } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { BROKEN_PDF_NAME, fileDigest, LONG_PDF_NAME, MARKDOWN_SOURCE, NOTE_TEXT, openFile, PDF_LONG_OUTLINE_TITLE, PDF_LONG_UNAVAILABLE_OUTLINE_TITLE, PDF_NAME, SECOND_PDF_NAME, seedLongPdf, seedProject, selectPdfText, selectProject, SOURCE_CASES } from './fixtures/workbench'

const SHORTCUT = process.platform === 'darwin' ? 'Meta' : 'Control'
const NATIVE_SHORTCUT_MODIFIER = process.platform === 'darwin' ? 'meta' : 'control'
const EMPTY_FOLDER_PROJECT_NAME = '空库文件夹验收'
const EMPTY_DOCUMENT_PROJECT_NAME = '空库文档验收'
const EMPTY_FOLDER_NAME = '首个文件夹'
const EMPTY_DOCUMENT_NAME = '首个文档'
const ROOT_DROP_FOLDER_NAME = '待整理'
const ROOT_DROP_FILE_NAME = '拖回顶层.md'
const RESOURCES_DIR = 'resources'
const POPOVER_ANCHOR_MAX_GAP_PX = 12
const POPOVER_ANCHOR_EXIT_MARGIN_PX = 8
const SELECTION_ANCHOR_EXIT_MARGIN_PX = 8
const SELECTION_SCROLL_DISTANCE_PX = 64
const PDF_NAVIGATION_MIN_WIDTH_PX = 190
const PDF_NAVIGATION_MAX_WIDTH_PX = 360
const PDF_NAVIGATION_DRAG_DISTANCE_PX = 600
const PDF_ACTUAL_SCALE_LABEL = '100%'
const PDF_ANNOTATION_MIN_WIDTH_PX = 400
const PDF_ANNOTATION_MAX_WIDTH_RATIO = 0.6
const PDF_ANNOTATION_DRAG_DISTANCE_PX = 1000
const PDF_LONG_SEARCH_REPEAT_COUNT = 4
const PDF_READER_MIN_WIDTH_PX = 320
const PDF_WHEEL_ZOOM_DELTA_PX = -120
const PDF_TRACKPAD_ZOOM_DELTA_PX = -4
const PDF_ZOOM_POINTER_OFFSET_PX = 180
const PDF_ZOOM_ANCHOR_TOLERANCE_PX = 4
const PDF_ZOOM_POINTER_X_RATIO = 0.5
const COMPACT_AI_BUTTON_MAX_WIDTH_PX = 32
const SPLIT_SCROLL_DISTANCE_PX = 520
const SPLIT_SCROLL_SECTION_COUNT = 80
const TREE_EDITOR_LOAD_TIMEOUT_MS = 15_000
const CODE_ACTION_SETTLE_MS = 250
const TREE_UNSAVED_EDIT = '\nUnsaved tree edit'
const OVERSIZED_TEST_LIMIT_KB = 1024
const BYTES_PER_KIBIBYTE = 1024
const FORMAT_ON_SAVE_SOURCE = 'const answer={value:42}\n'
const FORMAT_ON_SAVE_EXPECTED = 'const answer = { value: 42 };\n'
const FORMAT_ON_SAVE_DISABLED_SOURCE = 'const disabled={value:42}\r\n'
const HEADING_ONLY_MARKDOWN = '# Heading only'
const UNFORMATTED_MARKDOWN = '# 123\n```bash\nabcabc\n```'

for (const scope of ['global', 'project'] as const) {
  test(`literature ${scope} collection menu renames and moves within scope`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const desktop = new DesktopSession(runtime, testInfo)
    const projectName = '分类菜单验收'
    try {
      const page = await desktop.launch()
      const base = await apiBase(page)
      const projectResponse = await page.request.post(`${base}/api/content/projects`, { data: { name: projectName } })
      const project = await projectResponse.json()
      const otherResponse = await page.request.post(`${base}/api/content/projects`, { data: { name: '另一个分类项目' } })
      const other = await otherResponse.json()
      const projectId = scope === 'project' ? project.id : undefined
      const create = async (name: string, owner = projectId, parent_id?: string): Promise<{ id: string }> => {
        const response = await page.request.post(`${base}/api/v1/collections`, { data: { name, project_id: owner, parent_id } })
        expect(response.ok(), await response.text()).toBe(true)
        return response.json()
      }
      const source = await create('待移动分类')
      const child = await create('隐藏子分类', projectId, source.id)
      const grandchild = await create('隐藏孙分类', projectId, child.id)
      const destination = await create('目标分类')
      const foreign = await create('其他项目中的分类', other.id)
      await page.reload()
      await enterWorkbenchShell(page)
      if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel-layout-toggle').click()
      await page.getByTestId('topbar-project').click()
      if (scope === 'project') {
        await page.getByTestId(`project-menu-option-${projectName}`).click()
        await page.getByTestId('activity-literature').click()
      } else {
        await page.getByTestId('project-menu-literature').click()
      }
      const row = page.getByTestId(`literature-collection-${source.id}`)
      await row.click({ button: 'right' })
      for (const name of ['新建子分类', '重命名', '移动分类', '删除分类']) {
        await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible()
      }
      await page.screenshot({ path: join(runtime.artifacts, `${scope}-collection-menu.png`) })
      await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
      await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('已重命名分类')
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
      await expect(row).toContainText('已重命名分类')
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '新建子分类', exact: true }).click()
      await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('菜单新建子分类')
      await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
      await expect(page.getByText('菜单新建子分类', { exact: true })).toBeVisible()
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '移动分类', exact: true }).click()
      const dialog = page.getByTestId('collection-editor')
      await expect(dialog.getByTestId(`collection-destination-${source.id}`)).toBeDisabled()
      await expect(dialog.getByTestId(`collection-destination-${child.id}`)).toHaveCount(0)
      await expect(dialog.getByTestId(`collection-destination-${grandchild.id}`)).toHaveCount(0)
      await expect(dialog.getByText('菜单新建子分类', { exact: true })).toHaveCount(0)
      await expect(dialog.getByTestId(`collection-destination-${foreign.id}`)).toHaveCount(0)
      await dialog.getByTestId(`collection-destination-${destination.id}`).click()
      await expect(dialog.getByTestId(`collection-destination-${destination.id}`)).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: join(runtime.artifacts, `${scope}-collection-move.png`) })
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const listUrl = `${base}/api/v1/collections${projectId ? `?project_id=${projectId}` : ''}`
      const response = await page.request.get(listUrl)
      const entries = await response.json()
      expect(entries.find((entry: { id: string }) => entry.id === source.id).parent_id).toBe(destination.id)
      expect(entries.find((entry: { id: string }) => entry.id === child.id).parent_id).toBe(source.id)
      await page.getByTestId(`literature-collection-${destination.id}`).getByRole('button', { name: '展开「目标分类」里的子分类' }).click()
      await expect(row).toBeVisible()
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除分类', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
      await expect(row).toHaveCount(0)
      await expect(page.getByTestId(`literature-collection-${child.id}`)).toHaveCount(0)
      desktop.assertNoPageErrors()
    } finally { await desktop.attachArtifacts() }
  })
}

test('literature attachment picker uploads multiple files and opens them by double click', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const title = 'Multiple attachment acceptance'
  const names = ['附件一.pdf', '附件二.pdf']
  const content = 'Attachment double-click acceptance'
  try {
    const page = await desktop.launch()
    const base = await apiBase(page)
    const imported = await page.request.post(`${base}/api/v1/imports/bibliography`, {
      multipart: {
        files: {
          name: 'attachments.bib',
          mimeType: 'application/x-bibtex',
          buffer: Buffer.from(`@misc{attachments,title={${title}},author={Tester}}`)
        }
      }
    })
    expect(imported.ok()).toBe(true)
    const item = (await imported.json()).items[0]
    await page.reload()
    await enterWorkbenchShell(page)
    if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel-layout-toggle').click()
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-literature').click()
    await page.getByText(title, { exact: true }).click()
    await page.getByRole('tab', { name: /^附件/ }).click()
    const document = await PDFDocument.create()
    document.addPage().drawText(content, { x: 72, y: 740, size: 20 })
    const buffer = Buffer.from(await document.save())
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传附件', exact: true }).click()
    const chooser = await chooserPromise
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer })))
    const attachments = page.getByTestId('literature-detail-attachments')
    for (const name of names) await expect(attachments).toContainText(name)
    const detail = await page.request.get(`${base}/api/v1/literatures/${item.id}`)
    expect((await detail.json()).attachments.map((entry: { name: string }) => entry.name).sort()).toEqual(names)
    await page.screenshot({ path: join(runtime.artifacts, 'multiple-attachments.png') })
    await attachments.getByText(names[0].replace('.pdf', ''), { exact: true }).dblclick()
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.getByTestId('pdf-page-1').locator('.textLayer')).toContainText(content)
    await page.screenshot({ path: join(runtime.artifacts, 'detail-attachment-double-click.png') })
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-literature').click()
    await page.getByRole('button', { name: '展开附件', exact: true }).click()
    const stored = await page.request.get(`${base}/api/v1/literatures/${item.id}`)
    const second = (await stored.json()).attachments.find((entry: { name: string }) => entry.name === names[1])
    await page.getByTestId(`literature-attachment-${second.id}`).dblclick()
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.getByTestId('pdf-page-1').locator('.textLayer')).toContainText(content)
    await page.screenshot({ path: join(runtime.artifacts, 'list-attachment-double-click.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

for (const source of ['doi', 'arxiv'] as const) {
  test(`anonymous ${source} metadata sync uses public BibTeX`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const desktop = new DesktopSession(runtime, testInfo)
    const title = `Anonymous ${source} metadata acceptance`
    const identifier = source === 'doi'
      ? 'doi={10.48550/arXiv.1706.03762}, eprint={1706.03762}'
      : 'eprint={1706.03762}'
    try {
      const page = await desktop.launch()
      const base = await apiBase(page)
      const identity = await page.request.get(`${base}/api/auth/me`)
      expect((await identity.json()).auth).toBe(false)
      const imported = await page.request.post(`${base}/api/v1/imports/bibliography`, {
        multipart: {
          files: {
            name: 'anonymous.bib',
            mimeType: 'application/x-bibtex',
            buffer: Buffer.from(`@misc{anonymous, title={${title}}, author={Unknown}, ${identifier}}`)
          }
        }
      })
      expect(imported.ok()).toBe(true)
      const item = (await imported.json()).items[0]
      await page.reload()
      await enterWorkbenchShell(page)
      if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel-layout-toggle').click()
      await page.getByTestId('topbar-project').click()
      await page.getByTestId('project-menu-literature').click()
      await page.getByText(title, { exact: true }).click()
      const sync = page.getByRole('button', { name: '同步元数据', exact: true })
      await expect(sync).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, `anonymous-${source}-before.png`) })
      const response = page.waitForResponse((candidate) => candidate.url().endsWith('/api/literature/papermeta'))
      await sync.click()
      expect((await response).ok()).toBe(true)
      await expect.poll(async () => {
        const detail = await page.request.get(`${base}/api/v1/literatures/${item.id}`)
        return (await detail.json()).title
      }).toBe('Attention Is All You Need')
      const detail = await page.request.get(`${base}/api/v1/literatures/${item.id}`)
      const updated = await detail.json()
      expect(updated.creators_display).toContain('Ashish')
      expect(updated.year).toBe(source === 'doi' ? 2017 : 2023)
      await expect(page.getByText('Attention Is All You Need', { exact: true }).first()).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, `anonymous-${source}-synced.png`) })
      desktop.assertNoPageErrors()
    } finally { await desktop.attachArtifacts() }
  })
}

test('PDF import accepts missing metadata and persists extracted identifiers', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const blankName = '无元数据.v2.pdf'
  const identifiedTitle = 'PDF identifier acceptance'
  try {
    const blank = await PDFDocument.create()
    const bodyOnly = blank.addPage()
    bodyOnly.drawText('Body title must not become metadata', { x: 72, y: 740, size: 20 })
    bodyOnly.drawText('Body Author Must Be Ignored', { x: 72, y: 700, size: 12 })
    const identified = await PDFDocument.create()
    identified.setTitle(identifiedTitle)
    identified.setAuthor('Ada Researcher')
    const firstPage = identified.addPage()
    firstPage.drawText('arXiv:2609.09925v1', { x: 30, y: 800, size: 12 })
    firstPage.drawText('https://doi.org/10.1234/pdf-acceptance', { x: 60, y: 30, size: 12 })
    const page = await desktop.launch()
    await enterWorkbenchShell(page)
    if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('ai-panel-layout-toggle').click()
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-literature').click()
    await page.locator('input[type="file"][accept="application/pdf,.pdf"]').setInputFiles([
      { name: blankName, mimeType: 'application/pdf', buffer: Buffer.from(await blank.save()) },
      { name: 'identified.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await identified.save()) }
    ])
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('成功 2 / 2')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-import-missing-metadata-success.png') })
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(page.getByText('无元数据.v2', { exact: true })).toBeVisible()
    const base = await apiBase(page)
    const response = await page.request.get(`${base}/api/v1/literatures`)
    expect(response.ok()).toBe(true)
    const payload = await response.json()
    const blankItem = payload.items.find((item: { title: string }) => item.title === '无元数据.v2')
    const identifiedItem = payload.items.find((item: { title: string }) => item.title === identifiedTitle)
    expect(blankItem.creators_display).toBe('')
    expect(identifiedItem.arxiv).toBe('2609.09925v1')
    expect(identifiedItem.doi).toBe('10.1234/pdf-acceptance')
    await page.getByText(identifiedTitle, { exact: true }).click()
    await expect(page.getByText('2609.09925v1', { exact: true })).toBeVisible()
    await expect(page.getByText('10.1234/pdf-acceptance', { exact: true })).toBeVisible()
    await page.getByText('2609.09925v1', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-import-identifiers-detail.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('shortcut settings page stays hidden', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await expect(page.getByTestId('account-settings-nav-shortcuts')).toHaveCount(0)
    await expect(page.getByTestId('account-settings-shortcuts')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'shortcut-settings-hidden.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})
for (const theme of ['light', 'dark'] as const) {
  test(`literature association returns only to its originating project (${theme})`, async ({}, testInfo) => {
    const projectNames = ['关联来源甲', '关联来源乙']
    const runtime = createRuntime(testInfo)
    writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({ language: 'zh', theme }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      const base = await apiBase(page)
      for (const name of projectNames) {
        const created = await page.request.post(`${base}/api/content/projects`, { data: { name } })
        expect(created.ok(), await created.text()).toBe(true)
      }
      await page.reload()
      await enterWorkbenchShell(page)
      if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('topbar-ai').click()
      const returnButton = page.getByRole('button', { name: '返回项目', exact: true })
      const entry = page.getByRole('button', { name: '从文献全览关联', exact: true })
      const search = page.getByRole('searchbox', { name: '搜索文献', exact: true })
      const openOverview = async (): Promise<void> => {
        await page.getByTestId('topbar-project').click()
        await page.getByTestId('project-menu-literature').click()
      }
      const openProjectLibrary = async (name: string): Promise<void> => {
        await page.getByTestId('topbar-project').click()
        await page.getByTestId(`project-menu-option-${name}`).click()
        await page.getByTestId('activity-literature').click()
      }
      await openOverview()
      await expect(returnButton).toHaveCount(0)
      await page.getByRole('button', { name: '导入文献', exact: true }).click()
      await expect(entry).toHaveCount(0)
      await page.keyboard.press('Escape')

      for (const name of projectNames) {
        await openProjectLibrary(name)
        await expect(returnButton).toHaveCount(0)
        const filtered = page.waitForResponse((response) =>
          response.url().includes('/api/v1/literatures?') && new URL(response.url()).searchParams.get('q') === name
        )
        await search.fill(name)
        expect((await filtered).ok()).toBe(true)
        await page.getByRole('button', { name: '导入文献', exact: true }).click()
        await expect(entry).toBeVisible()
        const siblings = await entry.evaluate((element) =>
          Array.from(element.parentElement!.children)
            .filter((child) => child.tagName === 'BUTTON' || child.tagName === 'HR')
            .map((child) => child.tagName === 'HR' ? 'separator' : child.textContent?.trim())
        )
        expect(siblings).toEqual([
          '从文献全览关联', 'separator', '导入 PDF', '导入 Bib / RIS 文件', '从 Zotero 导入'
        ])
        if (name === projectNames[0]) {
          await page.screenshot({ path: join(runtime.artifacts, `literature-link-menu-${theme}.png`), animations: 'disabled' })
        }
        await entry.focus()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('topbar-project')).toContainText('文献全览')
        await expect(returnButton).toBeVisible()
        await expect(search).toBeVisible()
        const [backBounds, searchBounds] = await Promise.all([returnButton.boundingBox(), search.boundingBox()])
        expect(backBounds).not.toBeNull()
        expect(searchBounds).not.toBeNull()
        expect(backBounds!.x + backBounds!.width).toBeLessThan(searchBounds!.x)
        expect(Math.abs(backBounds!.y + backBounds!.height / 2 - searchBounds!.y - searchBounds!.height / 2)).toBeLessThanOrEqual(1)
        if (name === projectNames[0]) {
          const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
          await page.setViewportSize({ width: 960, height: 720 })
          await expect(returnButton).toBeVisible()
          await expect(search).toBeVisible()
          await page.setViewportSize(viewport)
          await page.screenshot({ path: join(runtime.artifacts, `literature-return-overview-${theme}.png`), animations: 'disabled' })
        }
        await returnButton.click()
        await expect(page.getByTestId('topbar-project')).toContainText(name)
        await expect(page.getByTestId('literature-overview')).toBeVisible()
        await expect(search).toHaveValue(name)
        await expect(returnButton).toHaveCount(0)
      }

      await page.getByRole('button', { name: '导入文献', exact: true }).click()
      await entry.click()
      await expect(returnButton).toBeVisible()
      await openOverview()
      await expect(returnButton).toHaveCount(0)
      await page.getByTestId('topbar-project').click()
      await page.getByTestId('project-menu-overview').click()
      await page.getByTestId('activity-literature').click()
      await expect(search).toBeVisible()
      await expect(page.getByLabel('加载文献', { exact: true })).toHaveCount(0)
      await expect(page.locator('.lit-side-loading')).toHaveCount(0)
      await expect(returnButton).toHaveCount(0)
      await page.mouse.move(0, 0)
      await page.screenshot({ path: join(runtime.artifacts, `literature-ordinary-overview-${theme}.png`), animations: 'disabled' })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}

test('literature overview and project library show every item without pagination', async ({}, testInfo) => {
  const projectName = '单页文献验收'
  const projectItemCount = 251
  const globalOnlyTitle = 'Global-only literature'
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const base = await apiBase(page)
    const created = await page.request.post(`${base}/api/content/projects`, { data: { name: projectName } })
    expect(created.ok(), await created.text()).toBe(true)
    const project = await created.json() as { id: string }
    const bibliography = Array.from({ length: projectItemCount }, (_, index) =>
      `@article{single${index},title={Single-page paper ${String(index + 1).padStart(3, '0')}},author={Researcher},year={2026}}`
    ).join('\n')
    const imported = await page.request.post(`${base}/api/v1/imports/bibliography?project_id=${encodeURIComponent(project.id)}`, {
      multipart: { files: { name: 'single-page.bib', mimeType: 'application/x-bibtex', buffer: Buffer.from(bibliography) } }
    })
    expect(imported.ok(), await imported.text()).toBe(true)
    expect((await imported.json()).count).toBe(projectItemCount)
    const globalImport = await page.request.post(`${base}/api/v1/imports/bibliography`, {
      multipart: { files: { name: 'global.bib', mimeType: 'application/x-bibtex',
        buffer: Buffer.from(`@article{global,title={${globalOnlyTitle}},author={Researcher},year={2026}}`) } }
    })
    expect(globalImport.ok(), await globalImport.text()).toBe(true)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-literature').click()
    if (await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('topbar-ai').click()
    const rows = page.locator('.lit-row')
    const selectAll = page.getByRole('checkbox', { name: '选择当前筛选的全部文献', exact: true })
    const search = page.getByRole('searchbox', { name: '搜索文献', exact: true })
    await expect(rows).toHaveCount(projectItemCount + 1)
    await expect(page.locator('.lit-pagination')).toHaveCount(0)
    await selectAll.check()
    await expect(page.getByText(`已选 ${projectItemCount + 1} 篇`, { exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-overview-all.png') })
    await selectAll.uncheck()
    await search.fill('Single-page paper 251')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Single-page paper 251')
    await search.fill('')
    await expect(rows).toHaveCount(projectItemCount + 1)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${projectName}`).click()
    await page.getByTestId('activity-literature').click()
    await expect(rows).toHaveCount(projectItemCount)
    await expect(rows.filter({ hasText: globalOnlyTitle })).toHaveCount(0)
    await expect(page.locator('.lit-pagination')).toHaveCount(0)
    const titleSort = page.locator('.lit-table-head').getByRole('button', { name: '标题', exact: true })
    await titleSort.focus()
    await page.keyboard.press('Enter')
    await expect(rows.first()).toContainText('Single-page paper 001')
    await expect(rows.last()).toContainText('Single-page paper 251')
    await expect(rows).toHaveCount(projectItemCount)
    await selectAll.check()
    await expect(page.getByText(`已选 ${projectItemCount} 篇`, { exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-project-all.png') })
    await selectAll.uncheck()
    await rows.last().scrollIntoViewIfNeeded()
    await expect(rows.last()).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-project-last.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('web search tabs follow their owning project and return without duplication', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  const projectNames = ['Search scope Alpha', 'Search scope Beta']
  const queries = ['Alpha project search', 'Beta project search']
  try {
    const page = await desktop.launch()
    for (const name of projectNames) {
      const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, { data: { name } })
      expect(response.ok(), await response.text()).toBe(true)
    }
    await page.reload()
    await enterWorkbenchShell(page)
    const switchProject = async (name: string): Promise<void> => {
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${name}`).click()
      await page.getByTestId('activity-resource').click()
    }
    const search = async (query: string): Promise<void> => {
      await page.getByPlaceholder('全网检索你想要的资料').fill(query)
      await page.getByTestId('resource-ai-search-go').click()
      await expect(page.getByRole('tab').filter({ hasText: query })).toBeVisible()
      await expect(page.getByTestId('web-search-tab')).toBeVisible()
    }
    await switchProject(projectNames[0])
    await search(queries[0])
    await switchProject(projectNames[1])
    await expect(page.getByRole('tab').filter({ hasText: queries[0] })).toHaveCount(0)
    await expect(page.getByTestId('web-search-tab')).toHaveCount(0)
    await search(queries[1])
    await page.screenshot({ path: join(runtime.artifacts, 'search-project-beta.png') })
    await switchProject(projectNames[0])
    const alphaTab = page.getByRole('tab').filter({ hasText: queries[0] })
    await expect(alphaTab).toHaveCount(1)
    await expect(page.getByRole('tab').filter({ hasText: queries[1] })).toHaveCount(0)
    await alphaTab.click()
    await expect(page.getByTestId('web-search-tab')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'search-project-alpha-restored.png') })
    await page.getByRole('button', { name: `关闭 ${queries[0]}`, exact: true }).click()
    await expect(alphaTab).toHaveCount(0)
    await expect(page.getByTestId('web-search-tab')).toHaveCount(0)
    await switchProject(projectNames[1])
    await expect(page.getByRole('tab').filter({ hasText: queries[1] })).toHaveCount(1)
    await switchProject(projectNames[0])
    await expect(alphaTab).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('non-Markdown text editors use the unified source toolbar and fill the document body', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await openFile(page, 'source.json')
    const body = page.locator('.vds-document-view-body:visible')
    const editor = page.getByTestId('monaco-editor')
    const toolbar = page.getByTestId('source-document-toolbar')
    await expect(editor.locator('.view-lines')).toContainText('"answer": 42')
    await expect(page.locator('.vds-document-toolbar:visible')).toHaveCount(0)
    await expect(toolbar.getByTestId('markdown-find')).toBeVisible()
    await expect(toolbar.getByTestId('document-version-history')).toBeVisible()
    await expect(toolbar.getByTestId('source-document-save')).toBeVisible()
    const [findBox, historyBox, saveBox] = await Promise.all([
      toolbar.getByTestId('markdown-find').boundingBox(),
      toolbar.getByTestId('document-version-history').boundingBox(),
      toolbar.getByTestId('source-document-save').boundingBox()
    ])
    expect(findBox).not.toBeNull()
    expect(historyBox).not.toBeNull()
    expect(saveBox).not.toBeNull()
    expect(Math.abs(historyBox!.y - findBox!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(saveBox!.y - findBox!.y)).toBeLessThanOrEqual(1)
    const [bodyBox, editorBox] = await Promise.all([body.boundingBox(), editor.boundingBox()])
    expect(bodyBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(editorBox!.height).toBeGreaterThan(bodyBox!.height * 0.9)
    await page.screenshot({ path: join(runtime.artifacts, 'source-toolbar-unified.png') })
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.type('// saved from unified toolbar')
    await expect(toolbar.getByTestId('source-document-save-dirty')).toBeVisible()
    await toolbar.getByTestId('source-document-save').click()
    await expect(toolbar.getByTestId('source-document-save')).toBeDisabled()
    await expect(toolbar.getByTestId('source-document-save-dirty')).toHaveCount(0)
    await expect.poll(() => readFileSync(join(resources, 'source.json'), 'utf8')).toContain('// saved from unified toolbar')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown source selection and code block copy write exact text through the desktop clipboard', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const codeCopy = 'console.log("markdown code copy");'
  let clipboardSaved = false
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, 'acceptance.md'), `${MARKDOWN_SOURCE}\n\`\`\`text\n${codeCopy}\n\`\`\`\n`)
    await page.getByTestId('resource-refresh').click()
    await desktop.app!.evaluate(async ({ clipboard }) => {
      const state = globalThis as typeof globalThis & { editorClipboard?: Electron.ClipboardItem[] }
      state.editorClipboard = await clipboard.read()
    })
    clipboardSaved = true

    await openFile(page, 'acceptance.md')
    await page.getByRole('tab', { name: '源码', exact: true }).click()
    await expect(page.locator('[data-testid="document-editor"]:visible textarea.inputarea')).toHaveCount(1)
    await page.locator('[data-testid^="document-tab-"]').filter({ hasText: 'acceptance.md' }).click({ button: 'right' })
    await page.getByTestId('tab-split-right').click()
    await openFile(page, 'source.txt')
    const sourceHeading = page.locator('[data-testid="document-editor"]:visible .view-line').filter({ hasText: '# Acceptance document' })
    await expect(sourceHeading).toBeVisible()
    const headingText = '# Acceptance document'
    const copiedHeading = 'Acceptance'
    const textBounds = await sourceHeading.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const bounds = range.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    })
    const characterWidth = textBounds.width / headingText.length
    const selectionY = textBounds.y + textBounds.height / 2
    const sourceWindow = await desktop.app!.browserWindow(page)
    await sourceWindow.evaluate(window => { window.show(); window.focus() })
    const receiverOpened = desktop.app!.waitForEvent('window')
    await desktop.app!.evaluate(async ({ BrowserWindow }) => {
      const receiver = new BrowserWindow({ webPreferences: { contextIsolation: true, nodeIntegration: false } })
      await receiver.loadURL('data:text/html,<textarea aria-label="Clipboard receiver"></textarea>')
    })
    const receiver = await receiverOpened
    for (const shortcut of new Set(['Control', SHORTCUT])) {
      for (const expectedText of [copiedHeading, 'document', copiedHeading]) {
        await sourceWindow.evaluate(window => window.focus())
        const start = textBounds.x + characterWidth * headingText.indexOf(expectedText)
        await page.mouse.move(start, selectionY)
        await page.mouse.down()
        await page.mouse.move(start + characterWidth * expectedText.length, selectionY, { steps: expectedText.length })
        await page.mouse.up()
        await desktop.app!.evaluate(({ clipboard }) => clipboard.writeText(''))
        await sourceWindow.evaluate((window, modifier) => {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: [modifier] })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: [modifier] })
        }, shortcut === 'Control' ? 'control' : 'meta')
        await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(expectedText)
        await (await desktop.app!.browserWindow(receiver)).evaluate(window => window.focus())
        const pasteTarget = receiver.getByRole('textbox', { name: 'Clipboard receiver', exact: true })
        await pasteTarget.fill('')
        await pasteTarget.press(`${SHORTCUT}+v`)
        await expect(pasteTarget).toHaveValue(expectedText)
      }
    }
    await receiver.screenshot({ path: join(runtime.artifacts, 'markdown-source-repeated-paste.png') })
    await receiver.close()
    await sourceWindow.evaluate(window => window.focus())
    await expect(page.getByRole('button', { name: '保存', exact: true }).first()).toBeDisabled()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-source-selection-copy.png') })
    const sourceWindowContents = `${MARKDOWN_SOURCE}\n\`\`\`text\n${codeCopy}\n\`\`\`\n`
    const pasteCases = [
      { text: '粘贴验证\nsecond line', nativeMenu: false },
      { text: 'Repeated paste', nativeMenu: false },
      ...(process.platform === 'darwin' ? [{ text: 'Native menu paste', nativeMenu: true }] : [])
    ]
    for (const { text: pastedText, nativeMenu } of pasteCases) {
      await sourceHeading.click()
      await page.keyboard.press(`${SHORTCUT}+Home`)
      await page.keyboard.press(`${SHORTCUT}+a`)
      await desktop.app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), pastedText)
      if (nativeMenu) {
        await desktop.app!.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('paste:'))
      } else await sourceWindow.evaluate((window, modifier) => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [modifier] })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [modifier] })
      }, NATIVE_SHORTCUT_MODIFIER)
      const markdownSource = page.locator('[data-testid="document-editor"]:visible').filter({ hasText: pastedText.split('\n')[0] })
      await expect(markdownSource).toBeVisible()
      await page.keyboard.press(`${SHORTCUT}+a`)
      await page.keyboard.press(`${SHORTCUT}+c`)
      await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(pastedText)
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-source-paste.png') })
      await page.getByTestId('markdown-undo').first().click()
      await expect(sourceHeading).toBeVisible()
      await sourceHeading.click()
      await page.keyboard.press(`${SHORTCUT}+a`)
      await page.keyboard.press(`${SHORTCUT}+c`)
      await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(sourceWindowContents)
    }
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    const markdown = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(markdown).toBeVisible()
    const codeCopyButton = page.locator('[data-testid="markdown-visual-editor"] .milkdown-code-block .copy-button')
    await expect(codeCopyButton).toBeVisible()
    await desktop.app!.evaluate(({ clipboard }) => clipboard.writeText(''))
    await codeCopyButton.click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(codeCopy)
    await expect(page.getByText('已复制代码', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-code-copy.png') })
    desktop.assertNoPageErrors()
  } finally {
    if (clipboardSaved && desktop.app) await desktop.app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const state = globalThis as typeof globalThis & { editorClipboard?: Electron.ClipboardItem[] }
      if (!state.editorClipboard) return
      const copies = await Promise.all(state.editorClipboard.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)] as const))
        return new ClipboardItem(Object.fromEntries(entries))
      }))
      await clipboard.write(copies)
    })
    await desktop.attachArtifacts()
  }
})

test('Markdown and source editors preserve native copy and paste shortcuts', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const markdownPaste = 'Markdown clipboard insertion'
  const sourcePaste = 'Source clipboard insertion'
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await desktop.app!.evaluate(async ({ clipboard }) => {
      const state = globalThis as typeof globalThis & { editorClipboard?: Electron.ClipboardItem[] }
      state.editorClipboard = await clipboard.read()
    })

    await openFile(page, 'acceptance.md')
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    const markdown = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(markdown).toBeVisible()
    await markdown.click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.press(`${SHORTCUT}+c`)
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain('Acceptance document')
    await desktop.app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), markdownPaste)
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.press(`${SHORTCUT}+v`)
    await expect(markdown).toContainText(markdownPaste)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-native-clipboard.png') })

    await openFile(page, 'source.txt')
    const source = page.locator('[data-testid="document-editor"]:visible')
    await expect(source.locator('.view-lines')).toContainText('plain answer 42')
    await source.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await desktop.app!.evaluate(({ BrowserWindow }, modifier) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      contents?.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: [modifier] })
      contents?.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: [modifier] })
    }, NATIVE_SHORTCUT_MODIFIER)
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain('plain answer 42')
    await desktop.app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), sourcePaste)
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.press('Enter')
    await desktop.app!.evaluate(({ BrowserWindow }, modifier) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      contents?.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [modifier] })
      contents?.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [modifier] })
    }, NATIVE_SHORTCUT_MODIFIER)
    await expect(source.locator('.view-lines')).toContainText(sourcePaste)
    await page.screenshot({ path: join(runtime.artifacts, 'source-native-clipboard.png') })
    desktop.assertNoPageErrors()
  } finally {
    if (desktop.app) await desktop.app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const state = globalThis as typeof globalThis & { editorClipboard?: Electron.ClipboardItem[] }
      if (!state.editorClipboard) return
      const copies = await Promise.all(state.editorClipboard.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)] as const))
        return new ClipboardItem(Object.fromEntries(entries))
      }))
      await clipboard.write(copies)
    })
    await desktop.attachArtifacts()
  }
})

test('format on save defaults off, formats code when enabled, and opening Markdown stays clean', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)

    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-files').click()
    const formatOnSave = page.getByTestId('file-version-format-on-save')
    await expect(formatOnSave).toHaveAttribute('aria-checked', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'format-on-save-setting.png') })
    await page.keyboard.press('Escape')

    writeFileSync(join(resources, 'source.js'), 'const original={value:1}\r\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'source.js')
    let editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-testid="source-document-save-dirty"]:visible')).toHaveCount(0)
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.insertText(FORMAT_ON_SAVE_DISABLED_SOURCE)
    await page.locator('[data-testid="source-document-save"]:visible').click()
    await expect.poll(() => readFileSync(join(resources, 'source.js'), 'utf8')).toBe(FORMAT_ON_SAVE_DISABLED_SOURCE)

    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-files').click()
    await page.getByTestId('file-version-format-on-save').click()
    await expect(page.getByTestId('file-version-format-on-save')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')

    await openFile(page, 'source.ts')
    editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor).toBeVisible()
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.insertText(FORMAT_ON_SAVE_SOURCE)
    await expect(page.locator('[data-testid="source-document-save-dirty"]:visible')).toBeVisible()
    await page.locator('[data-testid="source-document-save"]:visible').click()
    await expect(page.locator('[data-testid="source-document-save"]:visible')).toBeDisabled()
    await expect.poll(() => readFileSync(join(resources, 'source.ts'), 'utf8')).toBe(FORMAT_ON_SAVE_EXPECTED)
    await expect(editor.locator('.view-lines')).toContainText('const answer = { value: 42 };')
    await page.screenshot({ path: join(runtime.artifacts, 'format-on-save-code.png') })

    writeFileSync(join(resources, 'heading-only.md'), HEADING_ONLY_MARKDOWN)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'heading-only.md')
    await expect(page.getByTestId('markdown-visual-editor')).toBeVisible()
    await expect(page.getByTestId('markdown-save-dirty')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /heading-only\.md/ }).locator('i[aria-label="未保存"]')).toHaveCount(0)
    expect(readFileSync(join(resources, 'heading-only.md'), 'utf8')).toBe(HEADING_ONLY_MARKDOWN)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-open-clean.png') })

    await page.getByTestId('activity-account').click()
    await page.getByTestId('account-menu-settings').click()
    await page.getByTestId('account-settings-nav-files').click()
    await page.getByTestId('file-version-format-on-save').click()
    await expect(page.getByTestId('file-version-format-on-save')).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')

    writeFileSync(join(resources, 'projection.md'), '')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'projection.md')
    await page.locator('[data-testid="markdown-open-source"]:visible').click()
    editor = page.locator('[data-testid="document-editor"]:visible')
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.insertText(UNFORMATTED_MARKDOWN)
    await page.locator('[data-testid="markdown-save"]:visible').click()
    await expect.poll(() => readFileSync(join(resources, 'projection.md'), 'utf8')).toBe(UNFORMATTED_MARKDOWN)

    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible')).toBeVisible()
    await expect(page.locator('[data-testid="markdown-save-dirty"]:visible')).toHaveCount(0)
    await page.waitForTimeout(300)
    await page.locator('[data-testid="markdown-open-source"]:visible').click()
    editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor.locator('.view-line')).toHaveCount(4)
    await expect(page.locator('[data-testid="markdown-save-dirty"]:visible')).toHaveCount(0)
    expect(readFileSync(join(resources, 'projection.md'), 'utf8')).toBe(UNFORMATTED_MARKDOWN)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-view-switch-source-fidelity.png') })

    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await page.locator('[data-testid="markdown-paper"]:visible').getByText('123', { exact: true }).click()
    await page.keyboard.press('End')
    await page.keyboard.insertText(' changed')
    await page.locator('[data-testid="markdown-open-source"]:visible').click()
    editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor.locator('.view-lines')).toContainText('123 changed')
    await expect(editor.locator('.view-lines')).toContainText('abcabc')
    await expect(page.locator('[data-testid="markdown-save-dirty"]:visible')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-visual-edit-preserved.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('version history opens a resizable read-only text comparison tab', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, 'source.txt')
    const editor = page.getByTestId('monaco-editor')
    await expect(editor.locator('.view-lines')).toContainText('plain answer 42')
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.type('\ncurrent version addition')
    await page.getByTestId('source-document-save').click()
    await expect(page.getByTestId('source-document-save')).toBeDisabled()

    await page.getByTestId('document-version-history').click()
    const rows = page.locator('.vds-version-row')
    await expect(rows).toHaveCount(2)
    await rows.nth(1).getByTestId('version-history-row-action').click()

    const comparison = page.getByTestId('version-text-diff')
    await expect(comparison).toBeVisible()
    await expect(page.getByRole('tab', { name: /版本对比 · v1 · source\.txt/ })).toBeVisible()
    await expect(comparison.locator('.original .view-lines')).toContainText('plain answer 42')
    await expect(comparison.locator('.modified .view-lines')).toContainText('current version addition')

    const divider = comparison.locator('.monaco-sash.vertical').first()
    const before = await divider.boundingBox()
    expect(before).not.toBeNull()
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
    await page.mouse.down()
    await page.mouse.move(before!.x + 120, before!.y + before!.height / 2, { steps: 8 })
    await page.mouse.up()
    const after = await divider.boundingBox()
    expect(after).not.toBeNull()
    expect(after!.x).toBeGreaterThan(before!.x + 80)
    await page.screenshot({ path: join(runtime.artifacts, 'version-text-diff.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('file tabs follow projects and auto-save on workspace blur with a version', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const createProject = async (name: string, fileName: string, content: string): Promise<{ id: string; path: string }> => {
      const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, { data: { name } })
      expect(response.ok(), await response.text()).toBe(true)
      const project = await response.json() as { id: string; root: string }
      const resources = join(project.root, RESOURCES_DIR)
      mkdirSync(resources, { recursive: true })
      const path = join(resources, fileName)
      writeFileSync(path, content)
      return { id: project.id, path }
    }
    const alpha = await createProject('Tab scope Alpha', 'alpha.md', '# ALPHA_PROJECT\n')
    const beta = await createProject('Tab scope Beta', 'beta.md', '# BETA_PROJECT\n')
    await page.reload()
    await enterWorkbenchShell(page)

    const openFileSettings = async (): Promise<void> => {
      await page.getByTestId('activity-account').click()
      await page.getByTestId('account-menu-settings').click()
      await page.getByTestId('account-settings-nav-files').click()
    }
    const closePreferences = async (): Promise<void> => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
    }
    await openFileSettings()
    const autoSave = page.getByTestId('file-version-auto-save')
    await expect(autoSave).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: join(runtime.artifacts, 'auto-save-preference.png') })
    await closePreferences()

    const openProject = async (name: string): Promise<void> => {
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${name}`).click()
      if (!await page.getByTestId('resource-panel').isVisible().catch(() => false)) {
        await page.getByTestId('activity-resource').click()
      }
      await page.getByTestId('resource-refresh').click()
    }
    await openProject('Tab scope Alpha')
    await openFile(page, 'alpha.md')
    await page.getByTestId('markdown-open-source').click()
    const editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor.locator('.view-lines')).toContainText('ALPHA')
    await expect(page.getByRole('tab', { name: /alpha\.md/ })).toBeVisible()
    await expect(page.getByTestId('document-version-history')).toBeVisible()
    await editor.locator('.view-lines').click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.type('\nAuto-saved Alpha')
    await expect(editor.locator('.view-lines')).toContainText('Auto-saved Alpha')
    await page.getByTestId('activity-literature').click()
    await expect.poll(() => readFileSync(alpha.path, 'utf8')).toContain('Auto-saved Alpha')
    await page.getByTestId('activity-resource').click()

    await openProject('Tab scope Beta')
    await expect(page.getByRole('tab', { name: /alpha\.md/ })).toHaveCount(0)
    await expect.poll(() => readFileSync(alpha.path, 'utf8')).toContain('Auto-saved Alpha')
    await openFile(page, 'beta.md')
    await page.getByTestId('markdown-open-source').click()
    await expect(page.getByRole('tab', { name: /beta\.md/ })).toBeVisible()
    await expect(editor.locator('.view-lines')).toContainText('BETA')

    await openProject('Tab scope Alpha')
    const alphaTab = page.getByRole('tab', { name: /alpha\.md/ })
    await expect(alphaTab).toBeVisible()
    await expect(alphaTab.locator('i[aria-label="未保存"]')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /beta\.md/ })).toHaveCount(0)
    await expect(editor.locator('.view-lines')).toContainText('Auto-saved Alpha')
    await expect(page.getByTestId('document-save-version')).toHaveCount(0)
    const capability = await page.request.get(`${await apiBase(page)}/api/resource/capability?project=${encodeURIComponent(alpha.id)}&path=${encodeURIComponent('resources/alpha.md')}`)
    const identity = await capability.json() as { file_id: string }
    const versions = await page.request.get(`${await apiBase(page)}/api/resource/files/${encodeURIComponent(identity.file_id)}/versions?project=${encodeURIComponent(alpha.id)}`)
    const history = await versions.json() as { versions: unknown[] }
    expect(history.versions).toHaveLength(2)
    await page.screenshot({ path: join(runtime.artifacts, 'project-scoped-tabs.png') })
    expect(readFileSync(beta.path, 'utf8')).toBe('# BETA_PROJECT\n')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('empty resource library creates its first folder and Markdown document from the add menu', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const createEmptyProject = async (name: string): Promise<string> => {
      const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, {
        data: { name }
      })
      expect(response.ok(), await response.text()).toBe(true)
      const project = await response.json() as { root: string }
      await page.reload()
      await enterWorkbenchShell(page)
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${name}`).click()
      if (!await page.getByTestId('resource-panel').isVisible().catch(() => false)) {
        await page.getByTestId('activity-resource').click()
      }
      await expect(page.getByTestId('resource-empty-guide')).toBeVisible()
      return project.root
    }

    const folderProjectRoot = await createEmptyProject(EMPTY_FOLDER_PROJECT_NAME)
    await page.getByTestId('resource-add').click()
    await page.getByTestId('resource-new-folder').click()
    const folderInput = page.getByTestId('resource-name-input')
    await expect(folderInput).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'empty-library-folder-input.png') })
    await folderInput.fill(EMPTY_FOLDER_NAME)
    await folderInput.press('Enter')
    await expect(page.getByTestId('resource-notice')).toContainText('已创建')
    await expect.poll(() => existsSync(join(folderProjectRoot, RESOURCES_DIR, EMPTY_FOLDER_NAME))).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'empty-library-first-folder.png') })

    const documentProjectRoot = await createEmptyProject(EMPTY_DOCUMENT_PROJECT_NAME)
    await page.getByTestId('resource-add').click()
    await page.getByTestId('resource-new-doc').click()
    const documentInput = page.getByTestId('resource-name-input')
    await expect(documentInput).toBeVisible()
    await expect(page.getByTestId('resource-name-suffix')).toHaveText('.md')
    await page.screenshot({ path: join(runtime.artifacts, 'empty-library-document-input.png') })
    await documentInput.fill(EMPTY_DOCUMENT_NAME)
    await documentInput.press('Enter')
    await expect(page.getByTestId('resource-notice')).toContainText('已创建')
    const documentPath = join(documentProjectRoot, RESOURCES_DIR, `${EMPTY_DOCUMENT_NAME}.md`)
    await expect.poll(() => existsSync(documentPath)).toBe(true)
    expect(readFileSync(documentPath, 'utf8')).toContain(`# ${EMPTY_DOCUMENT_NAME}`)
    await page.screenshot({ path: join(runtime.artifacts, 'empty-library-first-document.png') })

    await page.getByTestId('resource-add').click()
    await page.getByTestId('resource-import').click()
    await expect(page.getByTestId('resource-import-dialog')).toBeVisible()
    const copyChoice = page.getByTestId('import-copy')
    if (supportsImportPickerTarget(process.platform, IMPORT_PICKER_TARGET.RESOURCE)) {
      await expect(copyChoice).not.toHaveAttribute('aria-haspopup', 'menu')
      await page.screenshot({ path: join(runtime.artifacts, 'resource-import-macos-direct-picker.png') })
    } else {
      await expect(copyChoice).toHaveAttribute('aria-haspopup', 'menu')
      await copyChoice.click()
      const fileChoice = page.getByTestId('import-copy-file')
      const directoryChoice = page.getByTestId('import-copy-directory')
      await expect(fileChoice).toBeVisible()
      await expect(fileChoice).toHaveText('选择文件')
      await expect(directoryChoice).toBeVisible()
      await expect(directoryChoice).toHaveText('选择文件夹')
      await page.screenshot({ path: join(runtime.artifacts, 'resource-import-target-menu.png') })
    }
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('resource tree moves a nested file back to the library root by drag and drop', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const nestedDirectory = join(resources, ROOT_DROP_FOLDER_NAME)
    const nestedFile = join(nestedDirectory, ROOT_DROP_FILE_NAME)
    const rootFile = join(resources, ROOT_DROP_FILE_NAME)
    mkdirSync(nestedDirectory)
    writeFileSync(nestedFile, '# 拖拽验收\n')
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-resources/${ROOT_DROP_FOLDER_NAME}`).click()

    const nestedRow = page.getByTestId(
      `tree-resources/${ROOT_DROP_FOLDER_NAME}/${ROOT_DROP_FILE_NAME}`
    )
    const resourceTreeRoot = page.getByTestId('resource-tree-root')
    await expect(nestedRow).toBeVisible()
    await nestedRow.dragTo(resourceTreeRoot, {
      sourcePosition: { x: 12, y: 12 },
      targetPosition: { x: 2, y: 2 }
    })

    await expect(page.getByTestId('resource-notice')).toContainText(
      `已移动为 resources/${ROOT_DROP_FILE_NAME}`
    )
    await expect(page.getByTestId(`tree-resources/${ROOT_DROP_FILE_NAME}`)).toBeVisible()
    await expect(nestedRow).toHaveCount(0)
    await expect.poll(() => existsSync(rootFile) && !existsSync(nestedFile)).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'resource-drag-to-root.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown source supports highlighted editing, replace, undo, redo and durable save', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await openFile(page, 'acceptance.md')
    await page.getByTestId('markdown-open-source').click()
    const editor = page.locator('[data-testid="document-editor"]:visible')
    for (const testId of ['markdown-undo', 'markdown-redo', 'markdown-find', 'markdown-replace']) {
      await expect(page.getByTestId(testId)).toBeVisible()
      await expect(page.getByTestId(testId).locator('svg')).toHaveCount(1)
    }
    await expect(editor).toHaveAttribute('data-language', 'markdown')
    await expect(editor.locator('.view-lines')).toContainText('Original needle')
    expect(await editor.locator('.view-lines span[class*="mtk"]').count()).toBeGreaterThan(1)
    const firstLine = editor.locator('.view-line').first()
    const lineBeforeFind = await firstLine.boundingBox()
    await page.getByTestId('markdown-replace').click()
    const widget = editor.locator('.find-widget')
    await expect(widget).toHaveAttribute('aria-hidden', 'false')
    await expect(widget).toHaveClass(/\bvisible\b/)
    const lineWithFind = await firstLine.boundingBox()
    expect(lineBeforeFind).not.toBeNull()
    expect(lineWithFind).not.toBeNull()
    expect(Math.abs(lineWithFind!.y - lineBeforeFind!.y)).toBeLessThanOrEqual(1)
    const regexToggle = widget.getByRole('checkbox', { name: /正则表达式|Regular Expression/ })
    await regexToggle.hover()
    const monacoTooltip = page.locator('.monaco-hover[role="tooltip"]:visible')
    await expect(monacoTooltip).toBeVisible()
    const [tooltipBox, widgetBox] = await Promise.all([
      monacoTooltip.boundingBox(),
      widget.boundingBox()
    ])
    expect(tooltipBox).not.toBeNull()
    expect(widgetBox).not.toBeNull()
    expect(tooltipBox!.y).toBeGreaterThanOrEqual(0)
    expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(widgetBox!.y)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-find-tooltip.png') })
    await widget.getByRole('textbox', { name: '查找', exact: true }).fill('No matching document text')
    const lineWithoutMatch = await firstLine.boundingBox()
    expect(lineWithoutMatch).not.toBeNull()
    expect(Math.abs(lineWithoutMatch!.y - lineBeforeFind!.y)).toBeLessThanOrEqual(1)
    await widget.getByRole('textbox', { name: '查找', exact: true }).fill('Fold section')
    const lineWithLowerMatch = await firstLine.boundingBox()
    expect(lineWithLowerMatch).not.toBeNull()
    expect(Math.abs(lineWithLowerMatch!.y - lineBeforeFind!.y)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-find-lower-match.png') })
    await widget.getByRole('textbox', { name: '查找', exact: true }).fill('Acceptance document')
    const findViewZone = editor.locator('.dock-find-viewzone[monaco-visible-view-zone="true"]')
    await expect(findViewZone).toBeVisible()
    await expect.poll(async () => {
      const currentLine = await firstLine.boundingBox()
      return currentLine ? currentLine.y - lineBeforeFind!.y : 0
    }).toBeGreaterThan(0)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-find-overlay.png') })
    await widget.getByRole('textbox', { name: '查找', exact: true }).fill('Fold section')
    await expect.poll(async () => {
      const currentLine = await firstLine.boundingBox()
      return currentLine ? Math.abs(currentLine.y - lineBeforeFind!.y) : Number.POSITIVE_INFINITY
    }).toBeLessThanOrEqual(1)
    await editor.locator('.view-lines').click({ position: { x: 30, y: 10 } })
    await expect(widget).toHaveAttribute('aria-hidden', 'true')
    await expect(widget).not.toHaveClass(/\bvisible\b/)
    await expect.poll(async () => {
      const [widgetBox, hostBox] = await Promise.all([
        widget.boundingBox(),
        editor.getByTestId('monaco-editor').boundingBox()
      ])
      return Boolean(widgetBox && hostBox && widgetBox.y + widgetBox.height <= hostBox.y)
    }).toBe(true)
    const lineAfterFind = await firstLine.boundingBox()
    expect(lineAfterFind).not.toBeNull()
    expect(Math.abs(lineAfterFind!.y - lineBeforeFind!.y)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-find-blurred.png') })
    await page.getByTestId('markdown-replace').click()
    await widget.getByRole('textbox', { name: '查找', exact: true }).fill('Original needle')
    await expect(page.getByTestId('selection-action-host')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-find-selection-suppressed.png') })
    await widget.getByRole('textbox', { name: '替换', exact: true }).fill('Replaced evidence')
    await widget.getByRole('button', { name: /全部替换|Replace All/ }).click()
    await page.keyboard.press('Escape')
    await expect(editor.locator('.view-lines')).toContainText('Replaced evidence')
    await editor.locator('.view-lines').click({ position: { x: 30, y: 10 } })
    await page.getByTestId('markdown-undo').click()
    await expect(editor.locator('.view-lines')).toContainText('Original needle')
    await page.getByTestId('markdown-redo').click()
    await expect(editor.locator('.view-lines')).toContainText('Replaced evidence')
    await page.keyboard.press(`${SHORTCUT}+z`)
    await expect(editor.locator('.view-lines')).toContainText('Original needle')
    await page.keyboard.press(`${SHORTCUT}+Shift+z`)
    await expect(editor.locator('.view-lines')).toContainText('Replaced evidence')
    await page.keyboard.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'acceptance.md'), 'utf8')).toBe(MARKDOWN_SOURCE.replace('Original needle', 'Replaced evidence'))
    await editor.locator('.view-line').filter({ hasText: 'Replaced evidence' }).click({ clickCount: 3 })
    await expect(page.getByTestId('selection-action-host')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-source.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PRD source suffixes resolve real syntax grammars and code folds through the editor UI', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    for (const [suffix, language] of SOURCE_CASES) {
      await openFile(page, `source.${suffix}`)
      const editor = page.locator('[data-testid="document-editor"]:visible')
      await expect(editor).toHaveAttribute('data-language', language)
      await expect(editor.locator('.view-lines')).not.toBeEmpty()
      if (language !== 'plaintext') {
        await expect.poll(async () => new Set(await editor.locator('.view-lines span[class*="mtk"]').evaluateAll((spans) => spans.map((span) => span.className))).size).toBeGreaterThan(1)
      }
    }
    await openFile(page, 'source.js')
    const editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor.locator('.view-lines')).toContainText('return 42')
    const iconFont = await page.evaluate(async () => {
      const faces = await document.fonts.load('16px codicon')
      return { count: faces.length, loaded: faces.every(face => face.status === 'loaded'), ready: document.fonts.check('16px codicon') }
    })
    expect(iconFont.count).toBeGreaterThan(0)
    expect(iconFont.loaded && iconFont.ready).toBe(true)
    await editor.locator('.codicon-folding-expanded').first().click()
    await expect(editor.locator('.view-lines')).not.toContainText('return 42')
    await editor.locator('.codicon-folding-collapsed').first().click()
    await expect(editor.locator('.view-lines')).toContainText('return 42')
    await page.screenshot({ path: join(runtime.artifacts, 'source-grammar-folding.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('code editor shortcuts apply language comments and indentation', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await openFile(page, 'source.py')
    const editor = page.locator('[data-testid="document-editor"]:visible')
    const input = editor.locator('textarea').first()
    await editor.locator('.view-line').first().click()
    await input.press('Tab')
    await page.waitForTimeout(CODE_ACTION_SETTLE_MS)
    await input.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'source.py'), 'utf8')).toBe('    def answer():\n    return 42\n')
    await editor.locator('.view-line').first().click()
    await input.press('Shift+Tab')
    await page.waitForTimeout(CODE_ACTION_SETTLE_MS)
    await input.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'source.py'), 'utf8')).toBe('def answer():\n    return 42\n')
    await editor.locator('.view-line').first().click()
    await input.press(`${SHORTCUT}+/`)
    await page.waitForTimeout(CODE_ACTION_SETTLE_MS)
    await input.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'source.py'), 'utf8')).toBe('# def answer():\n    return 42\n')
    await editor.locator('.view-line').first().click()
    await input.press(`${SHORTCUT}+/`)
    await page.waitForTimeout(CODE_ACTION_SETTLE_MS)
    await input.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'source.py'), 'utf8')).toBe('def answer():\n    return 42\n')

    await openFile(page, 'source.java')
    await editor.locator('.view-line').first().click()
    await input.press(`${SHORTCUT}+/`)
    await page.waitForTimeout(CODE_ACTION_SETTLE_MS)
    await input.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, 'source.java'), 'utf8')).toMatch(/^\/\/ class Answer \{/)
    await page.screenshot({ path: join(runtime.artifacts, 'code-shortcut-language-comment.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('visual Markdown save and save-on-close clear dirty state and close the tab', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const sourcePath = join(resources, 'acceptance.md')
    writeFileSync(sourcePath, readFileSync(join(__dirname, '..', '..', '..', 'AGENTS.md'), 'utf8'))
    await page.getByTestId('resource-refresh').click()
    const tab = page.locator('.vds-document-tab').filter({ hasText: 'acceptance.md' })
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')

    await openFile(page, 'acceptance.md')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.type('\nSaved through visual editor')
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(1)
    await expect(page.getByTestId('markdown-save-dirty')).toBeVisible()
    await page.getByTestId('markdown-save').click()
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(0)
    await expect(page.getByTestId('markdown-save')).toBeDisabled()
    await expect(page.getByTestId('markdown-save-dirty')).toHaveCount(0)
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toContain('Saved through visual editor')
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-save-clean.png') })

    await tab.getByRole('button', { name: '关闭 acceptance.md' }).click()
    await expect(tab).toHaveCount(0)
    await expect(page.getByTestId('document-close-dialog')).toHaveCount(0)

    await openFile(page, 'acceptance.md')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.type('\nSaved while closing')
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(1)
    await tab.getByRole('button', { name: '关闭 acceptance.md' }).click()
    const dialog = page.getByTestId('document-close-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('document-close-cancel')).toHaveText('取消')
    await expect(dialog.getByTestId('document-close-discard')).toHaveText('不保存')
    await expect(dialog.getByTestId('document-close-save')).toHaveText('保存并关闭')
    await dialog.getByTestId('document-close-save').click()
    await expect(dialog).toHaveCount(0)
    await expect(tab).toHaveCount(0)
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toContain('Saved while closing')

    await openFile(page, 'acceptance.md')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.type('\nLocal visual conflict winner')
    await expect(tab.locator('i[aria-label="未保存"]')).toHaveCount(1)
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nExternal visual change`)

    await tab.getByRole('button', { name: '关闭 acceptance.md' }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('document-close-save').click()
    await expect(dialog.getByTestId('document-close-save')).toHaveText('覆盖保存并关闭')
    await dialog.getByTestId('document-close-save').click()
    await expect(dialog).toHaveCount(0)
    await expect(tab).toHaveCount(0)
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toContain('Local visual conflict winner')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('visual Markdown uses the full available width without a width selector', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, 'acceptance.md')

    const paper = page.getByTestId('markdown-paper')
    await expect(paper).toBeVisible()
    await expect(page.locator('[data-testid^="markdown-page-width-"]')).toHaveCount(0)
    await expect(paper).toHaveCSS('max-width', 'none')
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-full-width.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('renaming an open resource keeps version state out of the tree and toolbar', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('document-version-history')).toBeVisible()
    await expect(page.getByTestId('document-save-version')).toHaveCount(0)

    await page.getByTestId(`tree-resources/${PDF_NAME}`).click({ button: 'right' })
    await page.getByTestId('menu-rename').click()
    await page.getByTestId('resource-name-input').fill('renamed-version-state')
    await page.getByTestId('resource-name-input').press('Enter')
    await expect(page.getByTestId('resource-notice')).toContainText('已重命名')

    const renamedRow = page.getByTestId('tree-resources/renamed-version-state.pdf')
    await expect(renamedRow.getByTestId('tree-version-resources/renamed-version-state.pdf')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'renamed-version-state-synchronized.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF opens in fit-width mode by default', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const canvas = page.getByTestId('pdf-page-1').locator('canvas').first()
    await expect(canvas).toBeVisible()
    const initialWidth = await canvas.evaluate((node) => node.getBoundingClientRect().width)
    const scale = page.getByTestId('pdf-scale')
    await scale.click()
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(initialWidth)
    await scale.click()
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeCloseTo(initialWidth, 0)
    await scale.dblclick()
    const scaleInput = page.getByTestId('pdf-scale-input')
    await expect(scaleInput).toBeFocused()
    await scaleInput.fill('125%')
    await scaleInput.press('Enter')
    await expect(scale).toHaveText('125%')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-fit-width-default.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('inactive PDF tabs release canvases while an 86-page document paints its first page', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await seedLongPdf(resources)
    await page.getByTestId('resource-refresh').click()

    const firstCanvasStartedAt = Date.now()
    await openFile(page, LONG_PDF_NAME)
    const longDocument = page.locator('[data-testid="pdf-document"][data-pdf-active="true"]')
    await expect(longDocument.getByTestId('pdf-page-1')).toHaveAttribute('data-canvas-rendered', 'true')
    await expect(longDocument.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
    const firstCanvasMs = Date.now() - firstCanvasStartedAt

    await openFile(page, SECOND_PDF_NAME)
    const activeDocument = page.locator('[data-testid="pdf-document"][data-pdf-active="true"]')
    const inactiveDocument = page.locator('[data-testid="pdf-document"][data-pdf-active="false"]')
    await expect(activeDocument.getByTestId('pdf-page-1')).toHaveAttribute('data-canvas-rendered', 'true')
    await expect(inactiveDocument.locator('canvas')).toHaveCount(0)
    const inactiveCanvasCount = await inactiveDocument.locator('canvas').count()

    await openFile(page, LONG_PDF_NAME)
    await expect(longDocument.getByTestId('pdf-page-1')).toHaveAttribute('data-canvas-rendered', 'true')
    writeFileSync(
      join(runtime.artifacts, 'pdf-lifecycle-evidence.json'),
      JSON.stringify({ firstCanvasMs, inactiveCanvasCount }, null, 2)
    )
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-inactive-tab-lifecycle.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF outline navigation preserves scale and keeps the target page visible', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const document = page.getByTestId('pdf-document')
    const viewport = document.locator('.vds-pdf-pages')
    const scale = document.getByTestId('pdf-scale')
    const pageInput = document.getByTestId('pdf-page-input')
    await expect(document.getByTestId('pdf-page-1')).toHaveAttribute('data-rendered', 'true')
    await expect(document.getByTestId('pdf-page-1').locator('canvas')).toBeVisible()
    await expect.poll(() => scale.textContent()).not.toBe(PDF_ACTUAL_SCALE_LABEL)
    const viewportWidthBeforeNavigation = await viewport.evaluate((element) => element.getBoundingClientRect().width)
    const scaleBeforeNavigation = await scale.textContent()

    await document.getByTestId('pdf-sidebar-toggle').click()
    const navigation = document.getByRole('complementary', { name: 'PDF 导航' })
    await expect.poll(() => viewport.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(viewportWidthBeforeNavigation, 0)
    await expect(scale).toHaveText(scaleBeforeNavigation ?? '')

    const navigationTabs = navigation.getByRole('tab')
    await expect(navigationTabs).toHaveCount(3)
    expect(await navigationTabs.evaluateAll((tabs) => tabs.every((tab) => tab.scrollHeight <= tab.clientHeight))).toBe(true)
    await navigation.getByRole('button', { name: 'Level 3', exact: true }).click()
    await expect(pageInput).toHaveValue('3')
    await expect(scale).toHaveText(scaleBeforeNavigation ?? '')
    await expect(document.getByTestId('pdf-page-3')).toHaveAttribute('data-rendered', 'true')
    await expect(document.getByTestId('pdf-page-3').locator('canvas')).toBeVisible()

    const resizeHandle = document.getByTestId('pdf-navigation-resizable').locator('.vds-resizable-split__handle')
    const handleBounds = await resizeHandle.boundingBox()
    expect(handleBounds).not.toBeNull()
    await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBounds!.x - PDF_NAVIGATION_DRAG_DISTANCE_PX, handleBounds!.y + handleBounds!.height / 2)
    await page.mouse.up()
    const navigationMinWidth = await navigation.evaluate((element) => element.getBoundingClientRect().width)
    expect(navigationMinWidth).toBeLessThanOrEqual(PDF_NAVIGATION_MIN_WIDTH_PX)
    expect(navigationMinWidth).toBeGreaterThan(PDF_NAVIGATION_MIN_WIDTH_PX - 2)
    expect(await navigationTabs.evaluateAll((tabs) => tabs.every((tab) => tab.scrollHeight <= tab.clientHeight))).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-outline-navigation-stable.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF selection survives page virtualization and restores its toolbar when scrolled back', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const selectedPage = page.getByTestId('pdf-page-2')
    const viewport = page.locator('.vds-pdf-pages')
    await viewport.evaluate((node) => {
      const target = node.querySelector<HTMLElement>('[data-testid="pdf-page-2"]')
      if (target) node.scrollTop = target.offsetTop
    })
    await expect(selectedPage).toHaveAttribute('data-rendered', 'true')
    await selectPdfText(page, 2)
    const toolbar = page.getByTestId('selection-action-host')
    const initialToolbar = await toolbar.boundingBox()
    expect(initialToolbar).not.toBeNull()
    const initialScroll = await viewport.evaluate(node => node.scrollTop)
    await viewport.evaluate((node, distance) => { node.scrollTop += distance }, SELECTION_SCROLL_DISTANCE_PX)
    const scrolled = await viewport.evaluate(node => node.scrollTop)
    const actualDistance = scrolled - initialScroll
    expect(actualDistance).toBeGreaterThan(0)
    await expect.poll(async () => {
      const current = await toolbar.boundingBox()
      return current ? initialToolbar!.y - current.y : 0
    }).toBeCloseTo(actualDistance, 0)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-toolbar-scrolled.png') })
    const selectedText = selectedPage.locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
    const [selectedBounds, viewportBounds] = await Promise.all([
      selectedText.boundingBox(),
      viewport.boundingBox()
    ])
    expect(selectedBounds).not.toBeNull()
    expect(viewportBounds).not.toBeNull()
    await viewport.evaluate((node, distance) => { node.scrollTop += distance },
      selectedBounds!.y + selectedBounds!.height - viewportBounds!.y + SELECTION_ANCHOR_EXIT_MARGIN_PX)
    await expect(toolbar).toBeHidden()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-toolbar-scrolled-away.png') })

    await viewport.evaluate(node => { node.scrollTop = node.scrollHeight })
    await expect(selectedPage).toHaveAttribute('data-rendered', 'false')
    await expect(toolbar).toBeHidden()
    await viewport.evaluate((node) => {
      const target = node.querySelector<HTMLElement>('[data-testid="pdf-page-2"]')
      if (target) node.scrollTop = target.offsetTop
    })
    await expect(selectedPage).toHaveAttribute('data-rendered', 'true')
    await expect(toolbar).toBeVisible()
    await expect(selectedPage.locator('[data-pdf-selection-highlight]')).not.toHaveCount(0)
    await page.getByRole('button', { name: '复制选中文本' }).click()
    await expect(page.getByRole('status')).toContainText('已复制')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-toolbar-restored.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF selection keeps every crossed page rendered and highlighted throughout a scrolling drag', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const firstPage = page.getByTestId('pdf-page-1')
    const secondPage = page.getByTestId('pdf-page-2')
    const thirdPage = page.getByTestId('pdf-page-3')
    const viewport = page.locator('.vds-pdf-pages')
    await page.getByTestId('pdf-scale').dblclick()
    await page.getByTestId('pdf-scale-input').fill('200%')
    await page.getByTestId('pdf-scale-input').press('Enter')
    await page.getByTestId('pdf-page-input').fill('1')
    await page.getByTestId('pdf-page-input').press('Enter')
    await expect(firstPage).toHaveAttribute('data-rendered', 'true')
    const anchor = firstPage.locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
    await expect(anchor).toBeVisible()
    const anchorBounds = await anchor.boundingBox()
    expect(anchorBounds).not.toBeNull()

    await page.mouse.move(anchorBounds!.x + 1, anchorBounds!.y + anchorBounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(anchorBounds!.x + Math.min(32, anchorBounds!.width / 2), anchorBounds!.y + anchorBounds!.height / 2, { steps: 4 })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('')
    await viewport.evaluate(node => { node.scrollTop = node.scrollHeight })
    await expect(thirdPage).toHaveAttribute('data-rendered', 'true')
    await expect(firstPage).toHaveAttribute('data-rendered', 'true')
    await expect(secondPage).toHaveAttribute('data-rendered', 'true')
    expect(await firstPage.evaluate((element) => element.contains(window.getSelection()?.anchorNode ?? null))).toBe(true)

    const focus = thirdPage.locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
    await focus.scrollIntoViewIfNeeded()
    const focusBounds = await focus.boundingBox()
    expect(focusBounds).not.toBeNull()
    await page.mouse.move(focusBounds!.x + focusBounds!.width - 1, focusBounds!.y + focusBounds!.height / 2, { steps: 15 })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Needle marker')
    await page.mouse.up()
    await expect(page.getByTestId('selection-action-host')).toBeVisible()
    await viewport.evaluate(node => { node.scrollTop -= 1 })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect(firstPage).toHaveAttribute('data-rendered', 'false')
    for (const [pageNumber, selectedPage] of [firstPage, secondPage, thirdPage].entries()) {
      await selectedPage.scrollIntoViewIfNeeded()
      const selectionHighlight = selectedPage.locator('[data-pdf-selection-highlight]').first()
      await expect(selectionHighlight).toBeAttached()
      await selectionHighlight.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(runtime.artifacts, `pdf-selection-multipage-page-${pageNumber + 1}.png`) })
    }
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF annotation editor expands directly beneath the selection toolbar', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    await selectPdfText(page)

    const toolbar = page.getByTestId('selection-action-host')
    const annotationButton = page.getByRole('button', { name: '添加批注', exact: true })
    await expect(annotationButton).toBeEnabled()
    await annotationButton.click()

    const commentEditor = page.getByRole('textbox', { name: '标注内容', exact: true })
    await expect(commentEditor).toBeVisible()
    const [expandedToolbarBounds, toolbarActionsBounds, commentEditorBounds] = await Promise.all([
      toolbar.boundingBox(),
      toolbar.getByRole('toolbar', { name: '划词操作', exact: true }).boundingBox(),
      commentEditor.boundingBox()
    ])
    expect(expandedToolbarBounds).not.toBeNull()
    expect(toolbarActionsBounds).not.toBeNull()
    expect(commentEditorBounds).not.toBeNull()
    expect(commentEditorBounds!.y).toBeGreaterThanOrEqual(toolbarActionsBounds!.y + toolbarActionsBounds!.height)
    expect(commentEditorBounds!.x).toBeGreaterThanOrEqual(expandedToolbarBounds!.x)
    expect(commentEditorBounds!.x + commentEditorBounds!.width).toBeLessThanOrEqual(
      expandedToolbarBounds!.x + expandedToolbarBounds!.width
    )
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-comment-editor.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF selection color menu remains interactive inside its portalled popover', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible({ timeout: TREE_EDITOR_LOAD_TIMEOUT_MS })
    const selected = await selectPdfText(page)

    const toolbar = page.getByTestId('selection-action-host')
    await toolbar.getByRole('button', { name: '添加高亮颜色', exact: true }).click()
    const palette = page.getByRole('region', { name: '添加高亮颜色', exact: true })
    await expect(palette).toBeVisible()
    await expect(toolbar).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(selected)

    const saved = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith('/records') && response.request().method() === 'PUT'
    )
    await palette.getByRole('button', { name: '橙色标注', exact: true }).click()
    const response = await saved
    expect(response.ok(), await response.text()).toBe(true)
    const savedMark = page.locator('[data-testid^="pdf-mark-"]').first()
    await expect(savedMark).toBeVisible()
    const firstPage = page.getByTestId('pdf-page-1')
    await expect.poll(() => firstPage.locator('[data-pdf-highlight-layer]').evaluate(element => getComputedStyle(element).mixBlendMode)).toBe('darken')
    await expect(firstPage.locator('[data-pdf-annotation-highlight]')).toHaveCount(1)
    await expect.poll(() => savedMark.evaluate(element => getComputedStyle(element).mixBlendMode)).toBe('normal')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-highlight-text-color.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('newest same-style PDF annotation owns overlapping color and click target', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible({ timeout: TREE_EDITOR_LOAD_TIMEOUT_MS })

    const addUnderline = async (color: string, expectedMarks: number): Promise<void> => {
      await selectPdfText(page)
      const toolbar = page.getByTestId('selection-action-host')
      await toolbar.getByRole('button', { name: '添加下划线颜色', exact: true }).click()
      const palette = page.getByRole('region', { name: '添加下划线颜色', exact: true })
      const saved = page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith('/records') && response.request().method() === 'PUT'
      )
      await palette.getByRole('button', { name: `${color}标注`, exact: true }).click()
      const response = await saved
      const snapshot = await response.json() as { records: { marks: unknown[] } }
      expect(response.ok(), JSON.stringify(snapshot)).toBe(true)
      expect(snapshot.records.marks).toHaveLength(expectedMarks)
    }

    await addUnderline('黄色', 1)
    await addUnderline('橙色', 2)
    await addUnderline('蓝色', 3)

    const visibleMark = page.locator('[data-testid^="pdf-mark-"]')
    const annotatedText = page.locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
    const openVisibleAnnotation = async (): Promise<void> => {
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await annotatedText.click()
    }
    await expect(visibleMark).toHaveCount(1)
    await expect.poll(() => visibleMark.evaluate(element =>
      getComputedStyle(element).getPropertyValue('--pdf-mark-color').trim()
    )).toBe('#72aee6')
    await openVisibleAnnotation()
    let inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(inspector.getByRole('button', { name: '切换为蓝色标注', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-overlap-newest-blue.png') })

    const deleted = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith('/records') && response.request().method() === 'PUT'
    )
    await inspector.getByRole('button', { name: '删除标记', exact: true }).click()
    await deleted
    await expect(visibleMark).toHaveCount(1)
    await expect.poll(() => visibleMark.evaluate(element =>
      getComputedStyle(element).getPropertyValue('--pdf-mark-color').trim()
    )).toBe('#f2a45c')
    await openVisibleAnnotation()
    inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(inspector.getByRole('button', { name: '切换为橙色标注', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-overlap-restored-orange.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF selection toolbar closes on document and side-panel clicks after internal actions', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const document = page.getByTestId('pdf-document')
    const toolbar = page.getByTestId('selection-action-host')
    await expect(document).toBeVisible()

    const selected = await selectPdfText(page)
    await toolbar.getByRole('button', { name: '复制选中文本', exact: true }).click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain(selected)
    await expect(toolbar).toBeVisible()

    await document.getByTestId('pdf-sidebar-toggle').click()
    await expect(toolbar).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

    await expect(document.getByRole('complementary', { name: 'PDF 导航' })).toBeVisible()
    await selectPdfText(page)
    await toolbar.getByRole('button', { name: '添加高亮颜色', exact: true }).click()
    const palette = page.getByRole('region', { name: '添加高亮颜色', exact: true })
    await expect(palette).toBeVisible()
    await expect(toolbar).toBeVisible()

    await document.getByRole('complementary', { name: 'PDF 导航' }).click()
    await expect(toolbar).toHaveCount(0)
    await expect(palette).toHaveCount(0)

    await selectPdfText(page)
    await expect(toolbar).toBeVisible()
    await document.getByTestId('pdf-page-1').click({ position: { x: 12, y: 12 } })
    await expect(toolbar).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-toolbar-dismissed.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF annotations auto-save without document save or file versions', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    await selectPdfText(page)
    await page.getByTestId('selection-action-host')
      .getByRole('button', { name: '添加删除线', exact: true }).click()
    await expect(page.locator('[data-testid^="pdf-mark-"]').first()).toBeVisible()
    await expect(page.getByTestId(`tree-warning-resources/${PDF_NAME}`)).toHaveCount(0)

    const projectListing = await page.request.get(`${await apiBase(page)}/api/content/projects`)
    expect(projectListing.ok(), await projectListing.text()).toBe(true)
    const project = (await projectListing.json() as { projects: Array<{ id: string; root: string }> })
      .projects.find(candidate => candidate.root === dirname(resources))
    expect(project).toBeTruthy()
    const capabilityResponse = await page.request.get(
      `${await apiBase(page)}/api/resource/capability?project=${encodeURIComponent(project!.id)}&path=${encodeURIComponent(`resources/${PDF_NAME}`)}`
    )
    expect(capabilityResponse.ok(), await capabilityResponse.text()).toBe(true)
    const capability = await capabilityResponse.json() as {
      drifted: boolean
      file_id: string
      pending: unknown
      snapshot_state: string
    }
    expect(capability).toMatchObject({ drifted: false, pending: null, snapshot_state: 'saved' })
    const versionResponse = await page.request.get(
      `${await apiBase(page)}/api/resource/files/${encodeURIComponent(capability.file_id)}/versions?project=${encodeURIComponent(project!.id)}`
    )
    expect(versionResponse.ok(), await versionResponse.text()).toBe(true)
    const versionHistory = await versionResponse.json() as { versions: unknown[] }
    expect(versionHistory.versions).toHaveLength(1)
    await page.screenshot({
      path: join(runtime.artifacts, 'pdf-annotation-auto-saved-no-file-version.png')
    })

    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    await expect(page.locator('[data-testid^="pdf-mark-"]').first()).toBeVisible()
    await expect(page.getByTestId(`tree-warning-resources/${PDF_NAME}`)).toHaveCount(0)
    await page.screenshot({
      path: join(runtime.artifacts, 'pdf-annotation-restored-after-restart.png')
    })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF modifier wheel zoom preserves its pointer anchor', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await page.getByRole('tab', { name: new RegExp(PDF_NAME) }).click()
    await expect(page.getByTestId('pdf-document')).toBeVisible({ timeout: TREE_EDITOR_LOAD_TIMEOUT_MS })
    const viewport = page.locator('.vds-pdf-pages')
    const canvas = page.getByTestId('pdf-page-1').locator('canvas').first()
    await viewport.click({ position: { x: 24, y: 24 } })
    await page.keyboard.press(`${SHORTCUT}+0`)
    const firstPage = page.getByTestId('pdf-page-1')
    await expect(firstPage).toHaveAttribute('data-canvas-rendered', 'true')
    await firstPage.evaluate((node) => {
      node.dataset.canvasReadinessRegressions = '0'
      const observer = new MutationObserver(() => {
        if (node.dataset.canvasRendered !== 'true') {
          node.dataset.canvasReadinessRegressions = String(
            Number(node.dataset.canvasReadinessRegressions ?? '0') + 1
          )
        }
      })
      observer.observe(node, { attributeFilter: ['data-canvas-rendered'] })
    })
    const [canvasBounds, viewportBounds] = await Promise.all([canvas.boundingBox(), viewport.boundingBox()])
    expect(canvasBounds).not.toBeNull()
    expect(viewportBounds).not.toBeNull()
    const pointer = {
      x: canvasBounds!.x + canvasBounds!.width * PDF_ZOOM_POINTER_X_RATIO,
      y: Math.min(canvasBounds!.y + PDF_ZOOM_POINTER_OFFSET_PX, viewportBounds!.y + viewportBounds!.height - PDF_ZOOM_ANCHOR_TOLERANCE_PX)
    }
    const anchor = {
      x: (pointer.x - canvasBounds!.x) / canvasBounds!.width,
      y: (pointer.y - canvasBounds!.y) / canvasBounds!.height
    }
    const wheelWidth = canvasBounds!.width
    await page.mouse.move(pointer.x, pointer.y)
    await page.keyboard.down(SHORTCUT)
    await page.mouse.wheel(0, PDF_WHEEL_ZOOM_DELTA_PX)
    await page.keyboard.up(SHORTCUT)
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(wheelWidth)
    await expect(firstPage).toHaveAttribute('data-canvas-rendered', 'true')
    expect(await firstPage.getAttribute('data-canvas-readiness-regressions')).toBe('0')
    const anchoredBounds = await canvas.boundingBox()
    expect(anchoredBounds).not.toBeNull()
    expect(Math.abs(anchoredBounds!.x + anchoredBounds!.width * anchor.x - pointer.x)).toBeLessThanOrEqual(PDF_ZOOM_ANCHOR_TOLERANCE_PX)
    expect(Math.abs(anchoredBounds!.y + anchoredBounds!.height * anchor.y - pointer.y)).toBeLessThanOrEqual(PDF_ZOOM_ANCHOR_TOLERANCE_PX)
    const modifiedWidth = anchoredBounds!.width
    await page.mouse.wheel(0, -PDF_WHEEL_ZOOM_DELTA_PX)
    expect(await canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeCloseTo(modifiedWidth, 0)
    if (process.platform === 'darwin') {
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, PDF_TRACKPAD_ZOOM_DELTA_PX)
      await page.mouse.wheel(0, PDF_TRACKPAD_ZOOM_DELTA_PX)
      await page.keyboard.up('Control')
      await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(modifiedWidth)
    }
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-pointer-zoom.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF reader shortcuts navigate, search, zoom, and open page jump', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible({ timeout: TREE_EDITOR_LOAD_TIMEOUT_MS })
    const viewport = page.locator('.vds-pdf-pages')
    const pageInput = page.getByTestId('pdf-page-input')
    const canvas = page.getByTestId('pdf-page-1').locator('canvas').first()
    await expect(pageInput).toHaveValue('1')
    await expect(pageInput).toHaveAttribute('max', '3')

    await viewport.click({ position: { x: 24, y: 24 } })
    await page.keyboard.press('PageDown')
    await expect(pageInput).toHaveValue('2')
    await page.keyboard.press('PageUp')
    await expect(pageInput).toHaveValue('1')
    await page.keyboard.press('End')
    await expect(pageInput).toHaveValue('3')
    await page.keyboard.press('Home')
    await expect(pageInput).toHaveValue('1')

    await page.keyboard.press(`${SHORTCUT}+l`)
    const goToPageDialog = page.getByTestId('pdf-go-to-page-dialog')
    await expect(goToPageDialog).toBeVisible()
    await page.getByTestId('pdf-go-to-page-input').fill('3')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-shortcut-go-to-page.png') })
    await page.keyboard.press('Enter')
    await expect(pageInput).toHaveValue('3')

    await viewport.click({ position: { x: 24, y: 24 } })
    await page.keyboard.press('Home')
    const initialWidth = await canvas.evaluate((node) => node.getBoundingClientRect().width)
    await page.keyboard.press(`${SHORTCUT}+-`)
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(initialWidth)
    const zoomedWidth = await canvas.evaluate((node) => node.getBoundingClientRect().width)
    await page.keyboard.press(`${SHORTCUT}+0`)
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(zoomedWidth)

    await page.keyboard.press(`${SHORTCUT}+f`)
    const search = page.getByTestId('pdf-search')
    await expect(search).toBeFocused()
    await search.fill('Needle marker')
    await expect(page.getByTestId('pdf-search-next')).toBeEnabled()
    await search.press('Enter')
    await expect(pageInput).toHaveValue('2')
    await search.press('Shift+Enter')
    await expect(pageInput).toHaveValue('1')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF reader inspects and persists annotations without modifying source', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const originalHash = fileDigest(join(resources, PDF_NAME))
    await openFile(page, PDF_NAME)
    const document = page.getByTestId('pdf-document')
    await expect(document).toBeVisible()
    const sidebarToggle = page.getByTestId('pdf-sidebar-toggle')
    const recordsToggle = page.getByTestId('pdf-annotation-toggle')
    const reader = page.locator('.vds-pdf-reader')
    const viewport = page.locator('.vds-pdf-pages')
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(recordsToggle).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'PDF 导航' })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'PDF 标注' })).toHaveCount(0)
    await expect(document).not.toContainText('此 PDF 没有大纲。')
    await expect(document).not.toContainText('还没有标注。')
    const focusedReaderBounds = await reader.boundingBox()
    const focusedViewportBounds = await viewport.boundingBox()
    expect(focusedReaderBounds).not.toBeNull()
    expect(focusedViewportBounds).not.toBeNull()
    expect(Math.abs(focusedViewportBounds!.width - focusedReaderBounds!.width)).toBeLessThan(2)
    const focusedPageBounds = await page.getByTestId('pdf-page-1').boundingBox()
    expect(focusedPageBounds).not.toBeNull()
    const viewportContentWidth = await viewport.evaluate(node => node.clientWidth)
    const viewportCenter = focusedViewportBounds!.x + viewportContentWidth / 2
    const pageCenter = focusedPageBounds!.x + focusedPageBounds!.width / 2
    expect(Math.abs(pageCenter - viewportCenter)).toBeLessThan(2)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-focus-reading.png') })
    const pageInput = page.getByTestId('pdf-page-input')
    await expect(pageInput).toHaveValue('1')
    await page.getByTestId('pdf-next').click()
    await expect(pageInput).toHaveValue('2')
    await page.getByTestId('pdf-previous').click()
    await expect(pageInput).toHaveValue('1')
    await pageInput.fill('3')
    await pageInput.press('Enter')
    await expect(page.getByTestId('pdf-page-3')).toBeVisible()
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(recordsToggle).toHaveCount(0)
    await sidebarToggle.click()
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('complementary', { name: 'PDF 导航' })).toBeVisible()
    await expect.poll(async () => (await viewport.boundingBox())?.width ?? 0).toBeLessThan(focusedViewportBounds!.width)
    const level1 = page.getByRole('button', { name: PDF_LONG_OUTLINE_TITLE, exact: true })
    const level2 = page.getByTestId('pdf-outline-row-0-0')
    const level3 = page.getByRole('button', { name: 'Level 3', exact: true })
    await expect(level2).toHaveAttribute('aria-disabled', 'true')
    const [level1Box, level2Box, level3Box] = await Promise.all([
      level1.boundingBox(), level2.boundingBox(), level3.boundingBox()
    ])
    expect(level2Box!.x).toBeGreaterThan(level1Box!.x)
    expect(level3Box!.x).toBeGreaterThan(level2Box!.x)
    const outlineTitle = level1.locator('[data-slot="ellipsis-text"]')
    await expect.poll(() => outlineTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await outlineTitle.hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await expect(page.getByRole('tooltip')).toContainText(PDF_LONG_OUTLINE_TITLE)
    const unavailableOutlineTitle = level2.locator('[data-slot="ellipsis-text"]')
    await expect.poll(() => unavailableOutlineTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await unavailableOutlineTitle.hover()
    await expect(page.getByRole('tooltip')).toContainText(PDF_LONG_UNAVAILABLE_OUTLINE_TITLE)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-outline.png') })
    await pageInput.fill('1')
    await pageInput.press('Enter')
    await level3.click()
    await expect(pageInput).toHaveValue('3')
    await page.getByRole('tab', { name: '页面', exact: true }).click()
    await expect(page.getByTestId('pdf-thumbnail-1')).toBeVisible()
    await pageInput.fill('1')
    await pageInput.press('Enter')
    await sidebarToggle.click()
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await viewport.boundingBox())?.width ?? 0).toBeCloseTo(focusedViewportBounds!.width, 0)
    await expect(pageInput).toHaveValue('1')
    const canvas = page.getByTestId('pdf-page-1').locator('canvas').first()
    const width = await canvas.evaluate((node) => node.getBoundingClientRect().width)
    await page.getByTestId('pdf-zoom-in').click()
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(width)
    await page.getByTestId('pdf-zoom-out').click()
    await page.getByTestId('pdf-scale').click()
    await expect(page.getByTestId('pdf-scale')).toHaveAttribute('aria-label', /适应页面/)
    const fitWidth = await canvas.evaluate((node) => node.getBoundingClientRect().width)
    expect(fitWidth).toBeCloseTo(width, 0)
    await page.getByTestId('pdf-scale').click()
    await expect.poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(fitWidth)
    await pageInput.fill('1')
    await pageInput.press('Enter')
    await sidebarToggle.click()
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    const selected = await selectPdfText(page)
    const toolbar = page.getByTestId('selection-action-host')
    const compactBounds = await toolbar.boundingBox()
    expect(compactBounds).not.toBeNull()
    expect(compactBounds!.height).toBeGreaterThanOrEqual(44)
    expect(compactBounds!.height).toBeLessThanOrEqual(52)
    expect(compactBounds!.width).toBeLessThan(await page.evaluate(() => window.innerWidth) - 100)
    for (const name of ['选择高亮颜色', '添加下划线', '添加删除线', '添加批注', '复制选中文本']) {
      const bounds = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(bounds?.height).toBeGreaterThanOrEqual(32)
      expect(bounds?.height).toBeLessThanOrEqual(36)
    }
    await page.getByRole('button', { name: '复制选中文本', exact: true }).click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain(selected)
    const highlightButton = page.getByRole('button', { name: '选择高亮颜色', exact: true })
    await page.getByRole('button', { name: '添加删除线', exact: true }).click()
    await expect(page.locator('.vds-pdf-status')).toContainText('删除线已保存')
    const strikethroughMark = page.locator('[data-testid^="pdf-mark-"]').first()
    await expect(strikethroughMark).toBeVisible()
    await strikethroughMark.click()
    const strikethroughInspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await strikethroughInspector.getByRole('button', { name: '删除标记', exact: true }).click()
    await expect(page.locator('[data-testid^="pdf-mark-"]')).toHaveCount(0)
    await selectPdfText(page)
    const reselectedCompactBounds = await toolbar.boundingBox()
    await highlightButton.click()
    const colorPalette = page.getByRole('region', { name: '高亮颜色' })
    await expect(colorPalette).toBeVisible()
    await expect(highlightButton).toHaveAttribute('aria-expanded', 'true')
    const colorButtons = colorPalette.getByRole('button')
    await expect(colorButtons).toHaveCount(8)
    const colorButtonRows = await colorButtons.evaluateAll(nodes =>
      nodes.map(node => Math.round(node.getBoundingClientRect().y))
    )
    expect(new Set(colorButtonRows).size).toBe(1)
    const paletteBounds = await toolbar.boundingBox()
    expect(paletteBounds).toEqual(reselectedCompactBounds)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-selection-palette.png') })
    await page.getByRole('button', { name: '橙色高亮', exact: true }).click()
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(recordsToggle).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'PDF 标注' })).toHaveCount(0)
    const savedMark = page.locator('[data-testid^="pdf-mark-"]').first()
    await savedMark.click()
    const inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(inspector).toBeVisible()
    await expect.poll(async () => {
      const [markBounds, inspectorBounds] = await Promise.all([
        savedMark.boundingBox(),
        inspector.boundingBox()
      ])
      if (!markBounds || !inspectorBounds) return Number.POSITIVE_INFINITY
      return Math.min(
        Math.abs(inspectorBounds.y - (markBounds.y + markBounds.height)),
        Math.abs(markBounds.y - (inspectorBounds.y + inspectorBounds.height))
      )
    }).toBeLessThanOrEqual(POPOVER_ANCHOR_MAX_GAP_PX)
    await expect(inspector).toContainText('p.1 ·')
    await expect(inspector.getByRole('button', { name: /^切换为.*标注$/ })).toHaveCount(8)
    await expect(inspector.getByRole('button', { name: '解释', exact: true })).toBeEnabled()
    await expect(inspector.getByRole('button', { name: '翻译', exact: true })).toBeEnabled()
    await expect(inspector).not.toContainText('笔记')
    await inspector.getByRole('button', { name: '删除线', exact: true }).click()
    await expect(page.locator('.vds-pdf-status')).toContainText('标注样式已更新')
    await inspector.getByRole('button', { name: '写批注', exact: true }).click()
    await inspector.getByRole('textbox', { name: '批注内容', exact: true }).fill(NOTE_TEXT)
    await inspector.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(page.locator('.vds-pdf-status')).toContainText('批注已保存')
    if (!await inspector.isVisible().catch(() => false)) await savedMark.click()
    await expect(inspector).toContainText('· 已有批注')
    await expect(inspector).toContainText(NOTE_TEXT)
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-annotation-inspector.png') })
    const [visibleMarkBounds, visibleViewportBounds] = await Promise.all([
      savedMark.boundingBox(),
      viewport.boundingBox()
    ])
    expect(visibleMarkBounds).not.toBeNull()
    expect(visibleViewportBounds).not.toBeNull()
    await viewport.evaluate((node, distance) => { node.scrollTop += distance },
      visibleMarkBounds!.y + visibleMarkBounds!.height - visibleViewportBounds!.y + POPOVER_ANCHOR_EXIT_MARGIN_PX)
    await expect(inspector).toBeHidden()
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-annotation-inspector-scrolled-away.png') })
    await expect(page.getByTestId('pdf-annotation-list')).toHaveCount(0)
    await page.getByTestId(`tree-resources/${PDF_NAME}`).click({ button: 'right' })
    await page.getByTestId('menu-ai-context').click()
    await expect(page.getByTestId('ai-context-workspace')).toContainText(PDF_NAME)
    await page.getByTestId(`tree-resources/${PDF_NAME}`).click({ button: 'right' })
    await page.getByTestId('menu-rename').click()
    await expect(page.getByTestId('resource-name-suffix')).toHaveText('.pdf')
    await page.getByTestId('resource-name-input').fill('renamed')
    await page.getByTestId('resource-name-input').press('Enter')
    await expect(page.getByTestId('resource-notice')).toContainText('已重命名')
    await expect(page.getByRole('tab', { name: /renamed\.pdf/ })).toBeVisible()
    await expect(page.getByTestId('ai-context-workspace')).toContainText('renamed.pdf')
    await expect(page.getByTestId('ai-context-workspace')).not.toContainText(PDF_NAME)
    await expect(page.locator('[data-testid^="pdf-mark-"]').first()).toBeVisible()
    expect(fileDigest(join(resources, 'renamed.pdf'))).toBe(originalHash)
    mkdirSync(join(resources, 'archive'))
    await page.getByTestId('resource-refresh').click()
    const renamedRow = page.getByTestId('tree-resources/renamed.pdf')
    const archiveRow = page.getByTestId('tree-resources/archive')
    await expect(renamedRow).toBeVisible()
    await expect(archiveRow).toBeVisible()
    await renamedRow.dragTo(archiveRow, {
      sourcePosition: { x: 12, y: 12 },
      targetPosition: { x: 12, y: 12 }
    })
    await expect(page.getByTestId('resource-notice')).toContainText('已移动')
    await expect(page.getByRole('tab', { name: /renamed\.pdf/ })).toBeVisible()
    await expect(page.getByTestId('ai-context-workspace')).toContainText('renamed.pdf')
    await expect(page.locator('[data-testid^="pdf-mark-"]').first()).toBeVisible()
    expect(fileDigest(join(resources, 'archive', 'renamed.pdf'))).toBe(originalHash)
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await page.getByTestId('tree-resources/archive').click()
    await page.getByTestId('tree-resources/archive/renamed.pdf').click()
    await page.locator('[data-testid^="pdf-mark-"]').first().click()
    const reopenedInspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(reopenedInspector).toContainText(NOTE_TEXT)
    await reopenedInspector.getByRole('button', { name: '删除标记', exact: true }).click()
    await expect(page.locator('.vds-pdf-status')).toContainText('标注已删除')
    await expect(page.locator('[data-testid^="pdf-mark-"]')).toHaveCount(0)
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await page.getByTestId('tree-resources/archive').click()
    await page.getByTestId('tree-resources/archive/renamed.pdf').click()
    await expect(page.locator('[data-testid^="pdf-mark-"]')).toHaveCount(0)
    expect(fileDigest(join(resources, 'archive', 'renamed.pdf'))).toBe(originalHash)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('literature PDF opens annotations from the right rail and excludes the resource-only global control', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const base = await apiBase(page)
    const listing = await page.request.get(`${base}/api/content/projects`)
    expect(listing.ok(), await listing.text()).toBe(true)
    const project = (await listing.json() as { projects: Array<{ id: string; root: string }> })
      .projects.find(candidate => candidate.root === dirname(resources))
    expect(project).toBeTruthy()
    const response = await page.request.post(`${base}/api/literature/import`, {
      data: { project: project!.id, source: 'local', sources: [join(resources, PDF_NAME)] }
    })
    expect(response.ok(), await response.text()).toBe(true)
    const sourceText = 'Needle marker 1 searchable selectable text.'
    const secondCommentText = 'Second independent annotation'
    const literatureList = await page.request.get(`${base}/api/v1/literatures?project_id=${encodeURIComponent(project!.id)}`)
    expect(literatureList.ok(), await literatureList.text()).toBe(true)
    const literature = (await literatureList.json() as { items: Array<{ id: string; title: string }> }).items
      .find((candidate) => candidate.title.includes('acceptance'))
    expect(literature).toBeTruthy()
    const detailResponse = await page.request.get(
      `${base}/api/v1/literatures/${literature!.id}?project_id=${encodeURIComponent(project!.id)}`
    )
    expect(detailResponse.ok(), await detailResponse.text()).toBe(true)
    const detail = await detailResponse.json() as { primary_attachment: { id: string } }
    const recordsRoute = `${base}/api/v1/literatures/${literature!.id}/attachments/${detail.primary_attachment.id}/records`
    const initialRecords = await page.request.get(recordsRoute)
    expect(initialRecords.ok(), await initialRecords.text()).toBe(true)
    const initial = await initialRecords.json() as { record_revision: string; source_revision: string }
    const saved = await page.request.put(recordsRoute, {
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${initial.record_revision}"` },
      data: {
        expected_source_revision: initial.source_revision,
        records: {
          schema_version: 1,
          marks: [
            {
              id: 'literature-copy-mark-first', style: 'highlight', color: 'yellow', page: 1,
              quads: [[0.1, 0.1, 0.4, 0.2]], text: sourceText,
              anchor_state: 'anchored', created_at: 1, updated_at: 1
            },
            {
              id: 'literature-copy-mark-second', style: 'highlight', color: 'yellow', page: 1,
              quads: [[0.1, 0.1, 0.4, 0.2]], text: sourceText,
              anchor_state: 'anchored', created_at: 2, updated_at: 2
            }
          ],
          comments: [
            { id: 'literature-copy-comment-first', mark_id: 'literature-copy-mark-first', body: NOTE_TEXT, created_at: 1 },
            { id: 'literature-copy-comment-second', mark_id: 'literature-copy-mark-second', body: secondCommentText, created_at: 2 }
          ],
          notes: []
        }
      }
    })
    expect(saved.ok(), await saved.text()).toBe(true)

    await page.getByTestId('topbar-project').click()
    await page.getByTestId('project-menu-literature').click()
    const literatureRow = page.locator('.lit-row').filter({ hasText: 'acceptance' }).first()
    await expect(literatureRow).toBeVisible()
    await literatureRow.click()
    await page.getByRole('button', { name: '打开', exact: true }).first().click()

    const document = page.locator('[data-testid="pdf-document"]:visible')
    const annotationToggle = document.getByTestId('pdf-annotation-toggle')
    await expect(page.getByTestId('document-save')).toHaveCount(0)
    await expect(annotationToggle).toBeVisible()
    await expect(annotationToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(document.getByRole('button', { name: '记录', exact: true })).toHaveCount(0)

    const annotationAiRequests: Array<{ instruction?: string; kind: string; page: number; text: string; quads: number[][] }> = []
    await page.route('**/api/literature/ai/tasks', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      annotationAiRequests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { code: 'pdf_ai_selection_unlocated', diagnostic: 'Selection text is required.' } })
      })
    })
    const selectedText = await selectPdfText(page)
    const selectionToolbar = page.getByTestId('selection-action-host')
    await selectionToolbar.getByRole('button', { name: 'AI 解释', exact: true }).click()
    const selectionExplanationPrompt = selectionToolbar.getByLabel('输入希望 AI 重点解释的问题')
    await expect(selectionExplanationPrompt).toBeFocused()
    await selectionExplanationPrompt.fill('解释选区中的核心概念')
    expect(annotationAiRequests).toHaveLength(0)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-selection-explain-input.png') })
    await selectionToolbar.getByRole('button', { name: '开始解释', exact: true }).click()
    await expect.poll(() => annotationAiRequests.length).toBe(1)
    expect(annotationAiRequests[0]).toMatchObject({ kind: 'selection_explanation', page: 1, text: selectedText })
    expect(annotationAiRequests[0]?.instruction).toContain('解释选区中的核心概念')
    const selectionExplanationResult = page.getByRole('dialog', { name: 'AI 解释', exact: true })
    await expect(selectionExplanationResult.getByRole('alert')).toBeVisible()
    await selectionExplanationResult.getByRole('alert').click()
    await expect(selectionExplanationResult).toBeVisible()
    await selectionExplanationResult.getByRole('button', { name: '关闭AI 解释', exact: true }).click()
    const savedMark = document.locator('[data-testid^="pdf-mark-"]').first()
    for (const [label, kind, dialogName] of [
      ['解释', 'selection_explanation', 'AI 解释'],
      ['翻译', 'selection_translation', '翻译']
    ] as const) {
      await savedMark.focus()
      await page.keyboard.press('Enter')
      const inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
      await expect(inspector).toBeVisible()
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await inspector.getByRole('button', { name: label, exact: true }).click()
      if (label === '解释') {
        const explanationPrompt = inspector.getByLabel('输入希望 AI 重点解释的问题')
        await expect(explanationPrompt).toBeFocused()
        await explanationPrompt.fill('解释这个术语在段落中的作用')
        expect(annotationAiRequests).toHaveLength(1)
        await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-annotation-explain-input.png') })
        await inspector.getByRole('button', { name: '开始解释', exact: true }).click()
      }
      await expect.poll(() => annotationAiRequests.length).toBe(label === '解释' ? 2 : 3)
      const request = annotationAiRequests.at(-1)!
      expect(request).toMatchObject({ kind, page: 1, text: sourceText, quads: [[0.1, 0.1, 0.4, 0.2]] })
      if (label === '解释') expect(request.instruction).toContain('解释这个术语在段落中的作用')
      const result = page.getByRole('dialog', { name: dialogName, exact: true })
      await expect(result).toBeVisible()
      await expect(result.getByRole('alert')).toBeVisible()
      await result.getByRole('alert').click()
      await expect(result).toBeVisible()
      await result.getByRole('button', { name: `关闭${dialogName}`, exact: true }).click()
    }
    await page.unroute('**/api/literature/ai/tasks')

    const navigationToggle = document.getByTestId('pdf-sidebar-toggle')
    const pages = document.locator('.vds-pdf-pages')
    const figureToggle = document.getByTestId('pdf-figure-explanation')
    await figureToggle.click()
    await expect(figureToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(pages).toHaveClass(/cursor-crosshair/)
    await annotationToggle.click()
    await expect(figureToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(pages).not.toHaveClass(/cursor-crosshair/)
    await annotationToggle.click()
    const pagesWithoutPanels = await pages.evaluate((element) => element.getBoundingClientRect().width)
    await navigationToggle.click()
    const navigation = document.getByRole('complementary', { name: 'PDF 导航' })
    const navigationResizable = document.getByTestId('pdf-navigation-resizable')
    const navigationResizeHandle = navigationResizable.locator('.vds-resizable-split__handle')
    await expect(navigation).toBeVisible()
    const navigationMetrics = await navigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      width: element.getBoundingClientRect().width
    }))
    const pagesWithNavigation = await pages.evaluate((element) => element.getBoundingClientRect().width)
    expect(navigationMetrics.width).toBeLessThanOrEqual(PDF_NAVIGATION_MAX_WIDTH_PX)
    expect(navigationMetrics.scrollWidth).toBeLessThanOrEqual(navigationMetrics.clientWidth + 1)
    expect(await navigation.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect(pagesWithNavigation).toBeCloseTo(pagesWithoutPanels, 0)

    const dragNavigationTo = async (distance: number): Promise<void> => {
      const bounds = await navigationResizeHandle.boundingBox()
      if (!bounds) throw new Error('PDF navigation resize handle is not visible')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + distance, bounds.y + bounds.height / 2)
      await page.mouse.up()
    }
    await dragNavigationTo(PDF_NAVIGATION_DRAG_DISTANCE_PX)
    await expect.poll(() => navigation.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(navigationMetrics.width)
    const navigationMaxWidth = await navigation.evaluate((element) => element.getBoundingClientRect().width)
    expect(navigationMaxWidth).toBeLessThanOrEqual(PDF_NAVIGATION_MAX_WIDTH_PX)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-navigation-resize-max.png') })
    await dragNavigationTo(PDF_NAVIGATION_DRAG_DISTANCE_PX)
    await expect.poll(() => navigation.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(navigationMaxWidth, 0)
    expect(await pages.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(pagesWithoutPanels, 0)
    await dragNavigationTo(-PDF_NAVIGATION_DRAG_DISTANCE_PX)
    await expect.poll(() => navigation.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(PDF_NAVIGATION_MIN_WIDTH_PX)
    const navigationMinWidth = await navigation.evaluate((element) => element.getBoundingClientRect().width)
    expect(navigationMinWidth).toBeGreaterThan(PDF_NAVIGATION_MIN_WIDTH_PX - 2)
    const navigationTabs = navigation.getByRole('tab')
    expect(await navigationTabs.evaluateAll((tabs) => tabs.every((tab) => tab.scrollHeight <= tab.clientHeight))).toBe(true)
    expect(await pages.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(pagesWithoutPanels, 0)

    await navigationToggle.click()
    await expect(navigation).toHaveCount(0)
    expect(await pages.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(pagesWithoutPanels, 0)

    await navigationToggle.click()
    await expect.poll(() => navigation.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(navigationMinWidth, 0)
    const longOutlineTitle = navigation.getByRole('button', { name: PDF_LONG_OUTLINE_TITLE, exact: true })
      .locator('[data-slot="ellipsis-text"]')
    await expect.poll(() => longOutlineTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await longOutlineTitle.hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await expect(page.getByRole('tooltip')).toContainText(PDF_LONG_OUTLINE_TITLE)
    const unavailableOutline = navigation.getByTestId('pdf-outline-row-0-0')
    await expect(unavailableOutline).toHaveAttribute('aria-disabled', 'true')
    const unavailableOutlineTitle = unavailableOutline.locator('[data-slot="ellipsis-text"]')
    await expect.poll(() => unavailableOutlineTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await unavailableOutlineTitle.hover()
    await expect(page.getByRole('tooltip')).toContainText(PDF_LONG_UNAVAILABLE_OUTLINE_TITLE)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-outline-tooltip.png') })
    await navigation.getByRole('tab', { name: '查找', exact: true }).click()
    const searchInput = document.getByTestId('pdf-search')
    await searchInput.fill(Array.from({ length: PDF_LONG_SEARCH_REPEAT_COUNT }, () => sourceText).join(' '))
    const searchInputMetrics = await searchInput.evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      whiteSpace: getComputedStyle(element).whiteSpace
    }))
    expect(searchInputMetrics.scrollWidth).toBeLessThanOrEqual(searchInputMetrics.clientWidth + 1)
    expect(searchInputMetrics.scrollHeight).toBeGreaterThan(searchInputMetrics.clientHeight)
    expect(searchInputMetrics.whiteSpace).toBe('pre-wrap')
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-search-wrap.png') })
    await searchInput.fill(sourceText)
    const searchResults = document.getByRole('navigation', { name: 'PDF 搜索结果' })
    await expect(searchResults.getByRole('button').first()).toBeVisible()
    const searchMetrics = await navigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(searchMetrics.scrollWidth).toBeLessThanOrEqual(searchMetrics.clientWidth + 1)
    await expect(searchResults.locator('mark')).toContainText(sourceText)

    await annotationToggle.click()
    await expect(navigationResizable).toHaveCSS('position', 'absolute')
    expect(await pages.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(pagesWithoutPanels, 0)
    const annotations = document.getByRole('complementary', { name: 'PDF 标注' })
    const annotationsResizable = document.getByTestId('pdf-annotations-resizable')
    const annotationsResizeHandle = annotationsResizable.locator('.vds-resizable-split__handle')
    expect(await annotations.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await expect(annotations).toBeVisible()
    const dragAnnotationsTo = async (distance: number): Promise<void> => {
      const bounds = await annotationsResizeHandle.boundingBox()
      if (!bounds) throw new Error('PDF annotation resize handle is not visible')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + distance, bounds.y + bounds.height / 2)
      await page.mouse.up()
    }
    const annotationInitialWidth = await annotations.evaluate((element) => element.getBoundingClientRect().width)
    await dragAnnotationsTo(-PDF_ANNOTATION_DRAG_DISTANCE_PX)
    await expect.poll(() => annotations.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(annotationInitialWidth)
    const annotationHostWidth = await annotationsResizable.evaluate((element) => element.getBoundingClientRect().width)
    expect(await annotations.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(annotationHostWidth * PDF_ANNOTATION_MAX_WIDTH_RATIO + 2)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-annotation-resize-max.png') })
    await dragAnnotationsTo(PDF_ANNOTATION_DRAG_DISTANCE_PX)
    await expect.poll(() => annotations.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(PDF_ANNOTATION_MIN_WIDTH_PX, 0)
    const annotationTabs = annotations.getByRole('tab')
    await expect(annotationTabs).toHaveCount(5)
    expect(await annotationTabs.evaluateAll((tabs) => tabs.every((tab) => tab.scrollHeight <= tab.clientHeight))).toBe(true)
    expect(await pages.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(pagesWithoutPanels, 0)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-annotation-resize.png') })
    await expect(document.getByTestId('pdf-annotation-list')).toContainText('Needle')
    await expect(annotations.getByText('全部 2', { exact: true })).toBeVisible()
    await expect(annotations.getByRole('button', { name: '复制原文', exact: true })).toHaveCount(2)
    await expect(annotations.getByRole('button', { name: '复制批注', exact: true })).toHaveCount(2)
    await annotations.getByRole('button', { name: '复制原文', exact: true }).first().click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(sourceText)
    await annotations.getByRole('button', { name: '复制批注', exact: true }).first().click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(NOTE_TEXT)
    await annotations.getByRole('button', { name: '复制批注', exact: true }).click()
    await expect.poll(() => desktop.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(secondCommentText)

    await document.getByRole('button', { name: 'AI 解读', exact: true }).click()
    await expect(annotations).toHaveCount(0)
    await expect(annotationToggle).toHaveAttribute('aria-pressed', 'false')
    await annotationToggle.click()
    await expect(annotations).toBeVisible()
    await expect(document.getByRole('complementary', { name: 'AI 解读' })).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-pdf-navigation-resize-min-dual.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF records retain stable identity through missing files, authorization recovery and name collisions', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await selectProject(page)
    const base = await apiBase(page)
    const listing = await page.request.get(`${base}/api/content/projects`)
    expect(listing.ok()).toBe(true)
    const project = (await listing.json() as { projects: Array<{ id: string; root: string }> })
      .projects.find(candidate => candidate.root === dirname(resources))
    expect(project).toBeTruthy()
    const openPdf = async (path: string): Promise<{ asset_id: string; project_id: string }> => {
      const query = new URLSearchParams({ path, project: project!.id })
      const response = await page.request.get(`${base}/api/workbench/open?${query}`)
      expect(response.ok()).toBe(true)
      return await response.json() as { asset_id: string; project_id: string }
    }
    const recordsFor = async (project: string, asset: string): Promise<Record<string, any>> => {
      const response = await page.request.get(
        `${base}/api/workbench/assets/${asset}/pdf/records?project=${encodeURIComponent(project)}`
      )
      expect(response.ok()).toBe(true)
      return await response.json() as Record<string, any>
    }
    const original = await openPdf(`resources/${PDF_NAME}`)
    const initial = await recordsFor(original.project_id, original.asset_id)
    const saved = await page.request.put(
      `${base}/api/workbench/assets/${original.asset_id}/pdf/records?project=${encodeURIComponent(original.project_id)}`,
      {
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${initial.record_revision}"` },
        data: {
          expected_source_revision: initial.source_revision,
          records: {
            schema_version: 1,
            marks: [{
              id: 'stable-mark', style: 'highlight', color: 'yellow', page: 2,
              quads: [[0.1, 0.1, 0.4, 0.2]], text: 'stable source text',
              anchor_state: 'anchored', created_at: 1, updated_at: 1
            }],
            comments: [{ id: 'stable-comment', mark_id: 'stable-mark', body: 'stable comment', created_at: 1 }],
            notes: [{
              id: 'stable-note', title: 'Stable note', body: 'independent record',
              excerpts: [{ id: 'stable-excerpt', mark_id: 'stable-mark', text: 'stable source text', page: 2 }]
            }]
          }
        }
      }
    )
    expect(saved.ok()).toBe(true)

    const sameBytes = await openPdf(`resources/${SECOND_PDF_NAME}`)
    expect(sameBytes.asset_id).not.toBe(original.asset_id)
    expect((await recordsFor(sameBytes.project_id, sameBytes.asset_id)).records.marks).toEqual([])

    const source = join(resources, PDF_NAME)
    const unavailable = join(resources, '.temporarily-unavailable.pdf')
    const sourceHash = fileDigest(source)
    renameSync(source, unavailable)
    const missing = await recordsFor(original.project_id, original.asset_id)
    expect(missing.source_state).toBe('missing')
    expect(missing.records.notes).toHaveLength(1)
    renameSync(unavailable, source)
    const restored = await recordsFor(original.project_id, original.asset_id)
    expect(restored.source_state).toBe('available')
    expect(restored.source_path).toBe(`resources/${PDF_NAME}`)
    expect(fileDigest(source)).toBe(sourceHash)

    const external = join(runtime.root, 'linked-pdf-source')
    mkdirSync(external)
    const linkedSource = join(external, PDF_NAME)
    writeFileSync(linkedSource, readFileSync(source))
    const authorization = await page.request.post(`${base}/api/content/roots`, {
      data: { project: original.project_id, source: external, mount: 'linked-pdf' }
    })
    expect(authorization.ok()).toBe(true)
    const root = await authorization.json() as { root_id: string; mount_path: string }
    const linked = await openPdf(`${root.mount_path}/${PDF_NAME}`)
    expect(linked.asset_id).not.toBe(original.asset_id)
    const linkedInitial = await recordsFor(linked.project_id, linked.asset_id)
    const linkedSaved = await page.request.put(
      `${base}/api/workbench/assets/${linked.asset_id}/pdf/records?project=${encodeURIComponent(linked.project_id)}`,
      {
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${linkedInitial.record_revision}"` },
        data: {
          expected_source_revision: linkedInitial.source_revision,
          records: {
            schema_version: 1,
            marks: [{
              id: 'linked-mark', style: 'underline', color: 'blue', page: 1,
              quads: [[0.2, 0.2, 0.5, 0.25]], text: 'linked source text',
              anchor_state: 'anchored', created_at: 1, updated_at: 1
            }],
            comments: [], notes: []
          }
        }
      }
    )
    expect(linkedSaved.ok()).toBe(true)
    const revoked = await page.request.delete(
      `${base}/api/content/roots/${root.root_id}?project=${encodeURIComponent(original.project_id)}`
    )
    expect(revoked.ok()).toBe(true)
    const unauthorized = await recordsFor(linked.project_id, linked.asset_id)
    expect(unauthorized.source_state).toBe('authorization_required')
    expect(unauthorized.records.marks).toHaveLength(1)
    const reauthorized = await page.request.post(`${base}/api/content/roots`, {
      data: { project: original.project_id, source: external, mount: 'linked-pdf' }
    })
    expect(reauthorized.ok()).toBe(true)
    expect((await reauthorized.json() as { root_id: string }).root_id).toBe(root.root_id)
    expect((await recordsFor(linked.project_id, linked.asset_id)).source_state).toBe('available')
    expect(fileDigest(linkedSource)).toBe(sourceHash)

    const failedMove = await page.request.post(`${base}/api/resource/node`, {
      data: {
        action: 'move', path: `resources/${SECOND_PDF_NAME}`,
        parent: '', name: '', target_dir: 'resources/missing-target', project: original.project_id
      }
    })
    expect(failedMove.ok()).toBe(false)
    expect(fileDigest(join(resources, SECOND_PDF_NAME))).toBe(sourceHash)
    expect((await openPdf(`resources/${SECOND_PDF_NAME}`)).asset_id).toBe(sameBytes.asset_id)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('real invalid-Contents PDF exports through Electron save and reopens in the product', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const sourcePath = join(resources, BROKEN_PDF_NAME)
    const exportedName = 'preview_pdf_1MB-带批注.pdf'
    const exportedPath = join(resources, exportedName)
    const originalHash = fileDigest(sourcePath)
    await openFile(page, BROKEN_PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible()

    const text = page.getByTestId('pdf-page-1').locator('.textLayer span').filter({ hasText: 'PDF Preview Test' }).first()
    await expect(text).toBeVisible()
    const bounds = await text.boundingBox()
    if (!bounds) throw new Error('Real PDF text has no visible selection rectangle')
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 15 })
    await page.mouse.up()
    await page.getByRole('button', { name: '选择高亮颜色', exact: true }).click()
    await page.getByRole('button', { name: '蓝色高亮', exact: true }).click()

    await desktop.app!.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, 'showSaveDialog', async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return { canceled: false, filePath: path }
      })
    }, exportedPath)
    const exportButton = page.getByTestId('pdf-export')
    await exportButton.click()
    await expect(exportButton).toHaveAttribute('data-loading', 'true')
    await expect.poll(() => existsSync(exportedPath)).toBe(true)
    await expect(page.locator('.vds-pdf-status')).toContainText('导出成功')
    expect(fileDigest(sourcePath)).toBe(originalHash)

    const reopened = await PDFDocument.load(readFileSync(exportedPath))
    expect(reopened.getPageCount()).toBe(1)
    expect(reopened.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
    await page.getByTestId('resource-refresh').click()
    await openFile(page, exportedName)
    await expect(page.locator('[data-testid="pdf-document"]:visible').getByTestId('pdf-page-1').locator('.textLayer')).toContainText('PDF Preview Test')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-export-reopened.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF focus-reading panels stay tab-scoped and new PDFs start closed', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    const activePdf = page.locator('[data-testid="pdf-document"]:visible')
    const sidebarToggle = activePdf.getByTestId('pdf-sidebar-toggle')
    const scale = activePdf.getByTestId('pdf-scale')
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(activePdf.getByTestId('pdf-annotation-toggle')).toHaveCount(0)
    await sidebarToggle.click()
    await scale.dblclick()
    await activePdf.getByTestId('pdf-scale-input').fill('125')
    await activePdf.getByTestId('pdf-scale-input').press('Enter')
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(scale).toHaveText('125%')

    await openFile(page, SECOND_PDF_NAME)
    await expect(activePdf.getByTestId('pdf-sidebar-toggle')).toHaveAttribute('aria-pressed', 'false')
    await expect(activePdf.getByTestId('pdf-annotation-toggle')).toHaveCount(0)
    await expect(activePdf.getByRole('complementary', { name: 'PDF 导航' })).toHaveCount(0)
    await expect(activePdf.getByRole('complementary', { name: 'PDF 标注' })).toHaveCount(0)

    await openFile(page, PDF_NAME)
    await expect(activePdf.getByTestId('pdf-sidebar-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(activePdf.getByTestId('pdf-scale')).toHaveText('125%')
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-focus-reading-tab-state.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PNG JPEG JPG WebP SVG GIF preview offers fit, actual size, zoom, pointer pan and per-tab viewport restoration', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, 'acceptance.png')
    const viewport = page.locator('[data-testid="image-viewport"]:visible')
    await expect(viewport).toBeVisible()
    await expect(page.getByTestId('image-dimensions')).toContainText('1600')
    await page.getByRole('button', { name: '实际大小', exact: true }).click()
    await expect(viewport).toHaveAttribute('data-scale', '1')
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeGreaterThan(1)
    await page.getByRole('button', { name: '缩小图片', exact: true }).click()
    const box = await viewport.boundingBox()
    if (!box) throw new Error('Image viewport is not visible')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await expect.poll(async () => Number(await viewport.getAttribute('data-pan-x'))).not.toBe(0)
    const before = await viewport.evaluate((node) => [node.getAttribute('data-scale'), node.getAttribute('data-pan-x'), node.getAttribute('data-pan-y')])
    for (const suffix of ['jpg', 'jpeg', 'webp', 'svg', 'gif']) {
      await openFile(page, `acceptance.${suffix}`)
      await expect(page.locator('[data-testid="image-viewer"]:visible').locator('img')).toBeVisible()
      await expect.poll(() => page.locator('[data-testid="image-viewer"]:visible').locator('img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
    }
    await openFile(page, 'acceptance.png')
    await expect.poll(() => viewport.evaluate((node) => [node.getAttribute('data-scale'), node.getAttribute('data-pan-x'), node.getAttribute('data-pan-y')])).toEqual(before)
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(viewport).toHaveAttribute('data-mode', 'fit')
    await page.screenshot({ path: join(runtime.artifacts, 'image-fit.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF next search occurrence moves within one page and blank-page click clears annotation selection', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await page.getByTestId('pdf-sidebar-toggle').click()
    await page.getByRole('tab', { name: '查找', exact: true }).click()
    await page.getByTestId('pdf-search').fill('Repeated page occurrence')
    const currentHit = page.getByTestId('pdf-page-1').locator('[data-current-search="true"]')
    await expect.soft(currentHit).toHaveCount(1)
    const firstTop = await currentHit.count() ? await currentHit.first().getAttribute('style') : null
    const pagesViewport = page.locator('.vds-pdf-pages')
    const initialScroll = await pagesViewport.evaluate(node => node.scrollTop)
    await page.getByTestId('pdf-search-next').click()
    await expect(page.getByTestId('pdf-page-input')).toHaveValue('1')
    await expect.soft(currentHit).toHaveCount(1)
    await expect.configure({ soft: true }).poll(() => pagesViewport.evaluate(node => node.scrollTop)).toBeGreaterThan(initialScroll)
    if (firstTop !== null) {
      await expect.poll(() => currentHit.first().getAttribute('style')).not.toBe(firstTop)
      await expect(currentHit).toBeInViewport()
    }
    await page.getByTestId('pdf-search').fill('')
    await page.getByTestId('pdf-scale').click()
    await page.getByTestId('pdf-page-input').fill('1')
    await page.getByTestId('pdf-page-input').press('Enter')
    await selectPdfText(page)
    await expect(page.getByRole('button', { name: '选择高亮颜色', exact: true })).toBeEnabled()
    await page.getByTestId('pdf-page-1').click({ position: { x: 20, y: 20 } })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect.soft(page.getByRole('button', { name: '选择高亮颜色', exact: true })).toBeDisabled()
    await expect.soft(page.getByRole('button', { name: '添加批注', exact: true })).toBeDisabled()
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-search-selection-regression.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF explicit search and repeated annotation clicks each focus the requested visible rectangle', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  const bottomNote = 'Bottom page focus acceptance'
  try {
    const page = await desktop.launch()
    await seedProject(page, runtime)
    await openFile(page, PDF_NAME)
    await expect(page.getByTestId('pdf-document')).toBeVisible()
    await page.getByTestId('pdf-sidebar-toggle').click()
    await page.getByRole('tab', { name: '查找', exact: true }).click()
    const bottomText = page.getByTestId('pdf-page-1').locator('.textLayer span').filter({ hasText: 'Repeated page occurrence' }).last()
    await bottomText.scrollIntoViewIfNeeded()
    const bounds = await bottomText.boundingBox()
    if (!bounds) throw new Error('Bottom PDF text has no visible selection rectangle')
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 15 })
    await page.mouse.up()
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Repeated page occurrence')
    await page.getByRole('button', { name: '添加批注', exact: true }).click()
    await page.getByRole('textbox', { name: '标注内容', exact: true }).fill(bottomNote)
    await page.getByRole('button', { name: '保存标注', exact: true }).click()
    const markButton = page.locator('[data-testid^="pdf-mark-"]').first()
    const selectedAnnotation = page.getByTestId('pdf-page-1').locator('.vds-pdf-annotation-layer .is-selected:not([data-current-search="true"])')
    await expect(markButton).toBeVisible()
    await markButton.click()
    await expect.soft(selectedAnnotation).toBeInViewport()

    await page.getByTestId('pdf-search').fill('Needle marker 2')
    const secondPageHit = page.getByTestId('pdf-page-2').locator('[data-current-search="true"]')
    await expect(secondPageHit).toHaveCount(1)
    await expect.soft(secondPageHit).toBeInViewport()
    await expect.soft(page.getByTestId('pdf-page-input')).toHaveValue('2')

    await page.getByTestId('pdf-search').fill('Needle marker 1')
    const firstPageHit = page.getByTestId('pdf-page-1').locator('[data-current-search="true"]')
    await expect(firstPageHit).toHaveCount(1)
    await expect.soft(firstPageHit).toBeInViewport()
    await page.getByTestId('pdf-search').fill('')
    await page.getByTestId('pdf-sidebar-toggle').click()
    await markButton.click()
    await expect.soft(selectedAnnotation).toBeInViewport()
    const viewport = page.locator('.vds-pdf-pages')
    const viewportBounds = await viewport.boundingBox()
    if (!viewportBounds) throw new Error('PDF viewport has no bounds')
    await page.mouse.move(viewportBounds.x + viewportBounds.width / 2, viewportBounds.y + viewportBounds.height / 2)
    await page.mouse.wheel(0, -1800)
    await expect(selectedAnnotation).not.toBeInViewport()
    await markButton.click()
    await expect.soft(selectedAnnotation).toBeInViewport()
    await page.screenshot({ path: join(runtime.artifacts, 'pdf-focus-request-regression.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})


test('Markdown pasted images persist beside the document and survive reopening', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = '中文 notes (1).md'
    const sourcePath = join(resources, name)
    writeFileSync(sourcePath, '# Pasted image\n\n* List image\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(editor).toBeVisible()
    // Exercise Chromium's actual clipboard paste event with a real image file.
    await desktop.app!.evaluate(({ clipboard, nativeImage }, path) => {
      clipboard.writeImage(nativeImage.createFromPath(path))
    }, join(resources, 'acceptance.png'))
    await editor.locator('li').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.press('Enter')
    await page.keyboard.press(`${SHORTCUT}+v`)
    const images = editor.locator('.milkdown-image-block img, .milkdown-image-inline img')
    await expect.poll(async () => images.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLImageElement).naturalWidth > 0).length)).toBe(1)
    await expect(editor.locator('li img')).toHaveCount(1)
    await page.getByTestId('markdown-save').click()
    await expect(page.getByTestId('markdown-save')).toBeDisabled()
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toContain('.assert/')
    const markdown = readFileSync(sourcePath, 'utf8')
    expect(markdown).toContain('.assert/')
    expect(markdown).not.toContain('blob:')
    const directory = join(resources, '.assert', name, 'img')
    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    const samePixels = await desktop.app!.evaluate(({ nativeImage }, paths) => {
      const original = nativeImage.createFromPath(paths.original)
      const persisted = nativeImage.createFromPath(paths.persisted)
      return original.toBitmap().equals(persisted.toBitmap())
    }, { original: join(resources, 'acceptance.png'), persisted: join(directory, files[0]) })
    expect(samePixels).toBe(true)
    await page.getByTestId('markdown-open-source').click()
    await expect(page.locator('[data-testid="document-editor"]:visible .view-lines')).toContainText('.assert/')
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await openFile(page, name)
    await page.getByTestId('markdown-open-editor').click()
    const reopened = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror img')
    await expect.poll(async () => reopened.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLImageElement).naturalWidth > 0).length)).toBe(1)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-pasted-image-reopened.png') })
    // A real filesystem obstruction must report failure without inserting a temporary URL.
    const blockedName = 'blocked.md'
    writeFileSync(join(resources, blockedName), '# Blocked image\n')
    writeFileSync(join(resources, '.assert', blockedName), 'directory obstruction')
    await page.getByTestId('resource-refresh').click()
    await desktop.app!.evaluate(({ clipboard, nativeImage }, path) => {
      clipboard.writeImage(nativeImage.createFromPath(path))
    }, join(resources, 'acceptance.png'))
    await openFile(page, blockedName)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    const blockedEditor = page.locator('[data-testid="markdown-visual-editor"]:visible .ProseMirror')
    await blockedEditor.click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.press(`${SHORTCUT}+v`)
    await expect(page.getByRole('alert')).toContainText('图片保存失败')
    await expect(blockedEditor.locator('img')).toHaveCount(0)
    const save = page.locator('[data-testid="markdown-save"]:visible')
    if (await save.isEnabled()) await save.click()
    await expect(save).toBeDisabled()
    expect(readFileSync(join(resources, blockedName), 'utf8')).not.toContain('blob:')
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-pasted-image-error.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown bold shortcut keeps editor priority over the module panel', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'shortcut-bold.md'
    writeFileSync(join(resources, name), 'Keyboard shortcut evidence\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(editor).toBeVisible()
    await expect(page.locator('.vds-module-panel')).toBeVisible()
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.press(`${SHORTCUT}+b`)
    await expect(editor.locator('strong')).toHaveText('Keyboard shortcut evidence')
    await expect(page.locator('.vds-module-panel')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-shortcut-bold.png') })
    await page.getByTestId('activity-resource').focus()
    await page.keyboard.press(`${SHORTCUT}+b`)
    await expect(page.locator('.vds-module-panel')).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown bold follows a user rebound shortcut without toggling the module panel', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    shortcutOverrides: {
      'markdown.bold': { key: 'p', modifiers: ['primary', 'shift'] }
    }
  }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'shortcut-rebound-bold.md'
    writeFileSync(join(resources, name), 'Rebound editor shortcut\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)

    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.press(`${SHORTCUT}+b`)
    await expect(editor.locator('strong')).toHaveCount(0)
    await expect(page.locator('.vds-module-panel')).toBeVisible()
    await page.keyboard.press(`${SHORTCUT}+Shift+p`)
    await expect(editor.locator('strong')).toHaveText('Rebound editor shortcut')
    await expect(page.locator('.vds-module-panel')).toBeVisible()
    const save = page.getByTestId('markdown-save')
    await save.click()
    await expect(save).toBeDisabled()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-shortcut-rebound.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown shortcuts format blocks and open visual find', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'shortcut-markdown.md'
    writeFileSync(join(resources, name), 'Shortcut evidence appears twice: Shortcut evidence\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    await page.getByTestId(`tree-resources/${name}`).dblclick()
    const openEditor = page.locator('[data-testid="markdown-open-editor"]:visible')
    if (await openEditor.isVisible()) await openEditor.click()
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+2`)
    await expect(editor.locator('h2')).toContainText('Shortcut evidence')
    await page.keyboard.press(`${SHORTCUT}+z`)
    await expect(editor.locator('h2')).toHaveCount(0)
    await page.keyboard.press(`${SHORTCUT}+Shift+z`)
    await expect(editor.locator('h2')).toContainText('Shortcut evidence')
    await page.keyboard.press(`${SHORTCUT}+0`)
    await expect(editor.locator('h2')).toHaveCount(0)
    await page.keyboard.press(`${SHORTCUT}+a`)
    await page.keyboard.press(`${SHORTCUT}+i`)
    await expect(editor.locator('em')).toContainText('Shortcut evidence')
    await page.keyboard.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, name), 'utf8')).toContain('*Shortcut evidence')
    await page.keyboard.press(`${SHORTCUT}+e`)
    await expect(editor.locator('code')).toHaveCount(0)
    await page.keyboard.press(`${SHORTCUT}+Backquote`)
    await expect(editor.locator('code')).toContainText('Shortcut evidence')
    await page.keyboard.press(`${SHORTCUT}+Backquote`)
    await expect(editor.locator('code')).toHaveCount(0)
    await page.keyboard.press(`${SHORTCUT}+f`)
    const find = page.getByTestId('markdown-find-input')
    await expect(find).toBeVisible()
    await find.fill('Shortcut evidence')
    await find.press('Enter')
    await expect(page.getByText('第 1 个，共 2 个')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-shortcuts-find.png') })
    await find.press('Escape')
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown native toolbar applies formats and preserves them after reopening', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'toolbar.md'
    writeFileSync(join(resources, name), 'Toolbar evidence\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(editor).toBeVisible()
    const bar = page.locator('.vds-markdown-header .milkdown-top-bar')
    const button = (label: string) => bar.locator('button').filter({ has: page.locator(`[title="${label}"]`) })
    await expect(page.getByTestId('markdown-editor-actions')).toContainText('H1')
    await expect(page.locator('[data-testid="markdown-visual-editor"] .milkdown-top-bar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '格式工具栏', exact: true })).toHaveCount(0)
    await expect(bar.locator('button')).toHaveCount(14)
    for (const [label, tag] of [['粗体', 'strong'], ['斜体', 'em'], ['行内代码', 'code']]) {
      await editor.fill('Toolbar evidence')
      await page.keyboard.press(`${SHORTCUT}+a`)
      await button(label).click()
      await expect(editor.locator(tag)).toHaveText('Toolbar evidence')
      await expect(button(label)).toHaveClass(/active/)
      await button(label).click()
      await expect(editor.locator(tag)).toHaveCount(0)
    }
    for (const [label, tag] of [['一级标题 H1', 'h1'], ['二级标题 H2', 'h2'], ['三级标题 H3', 'h3'], ['项目符号', 'ul'], ['编号列表', 'ol'], ['引用', 'blockquote']]) {
      await editor.fill('Toolbar evidence')
      await button(label).click()
      await expect(editor.locator(tag)).toContainText('Toolbar evidence')
      await expect(button(label)).toHaveClass(/active/)
      await editor.click()
      await page.keyboard.press(`${SHORTCUT}+z`)
      await expect(editor.locator(tag)).toHaveCount(0)
      await page.keyboard.press(`${SHORTCUT}+Shift+z`)
      await expect(editor.locator(tag)).toContainText('Toolbar evidence')
      await page.keyboard.press(`${SHORTCUT}+z`)
      await expect(editor.locator(tag)).toHaveCount(0)
    }
    await editor.fill('Toolbar evidence')
    await page.keyboard.press(`${SHORTCUT}+a`)
    await button('链接').click()
    const linkInput = page.locator('.link-edit input:visible')
    await linkInput.fill('https://example.com/toolbar')
    await linkInput.press('Enter')
    await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/toolbar')
    await editor.click()
    await button('表格').click()
    await expect(editor.locator('table.children')).toHaveCount(1)
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, name), 'utf8')).toContain('|')
    await page.screenshot({ path: join(runtime.artifacts, 'toolbar-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: join(runtime.artifacts, 'toolbar-dark.png') })
    await page.setViewportSize({ width: 1000, height: 800 })
    await button('图片').scrollIntoViewIfNeeded()
    await expect(button('图片')).toBeInViewport()
    await page.screenshot({ path: join(runtime.artifacts, 'toolbar-narrow.png') })
    await button('图片').click()
    await expect(editor.locator('.milkdown-image-block')).toHaveCount(1)
    await editor.locator('input[type="file"]').setInputFiles(join(resources, 'acceptance.png'))
    await expect.poll(async () => editor.locator('.milkdown-image-block img').evaluateAll((images) => images.some((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, name), 'utf8')).toContain('.assert/')
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await openFile(page, name)
    await expect(page.locator('.ProseMirror table.children')).toHaveCount(1)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown slash menu groups insertion actions before headings', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, 'slash.md'), '\n')
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'slash.md')
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await editor.fill('/')
    const menu = page.locator('.milkdown-slash-menu:visible')
    await expect(menu.locator('.menu-group li > span:last-child')).toHaveText(['图片', '公式', '表格', '代码块', '引用', '无序列表', '有序列表', '分隔线', '链接', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
    await expect(menu.locator('.menu-group')).toHaveCount(3)
    expect(await menu.locator('.menu-group').nth(1).evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('solid')
    await page.screenshot({ path: join(runtime.artifacts, 'slash-menu.png') })
    await menu.getByText('分隔线', { exact: true }).click()
    await expect(editor.locator('hr')).toHaveCount(1)
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, 'slash.md'), 'utf8')).toMatch(/---|\*\*\*/)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown long document scrolls and math survives edit save and reopen', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'mathematics.md'
    writeFileSync(join(resources, name), MATHEMATICS_SOURCE)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    await expect(editor).toBeVisible()
    const bar = page.locator('.milkdown-top-bar')
    const scroller = page.locator('[data-testid="markdown-visual-editor"] > .milkdown')
    const initialBar = await bar.boundingBox()
    const visibleBody = await page.locator('.vds-markdown-visual').boundingBox()
    await page.mouse.move(visibleBody!.x + 100, visibleBody!.y + 100)
    await page.mouse.wheel(0, 1500)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(bar).toBeInViewport()
    expect((await bar.boundingBox())!.y).toBe(initialBar!.y)
    await page.mouse.wheel(0, -100000)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0)
    const bounds = (await scroller.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width - 6, bounds.y + 16)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 6, bounds.y + bounds.height - 6, { steps: 20 })
    await page.mouse.up()
    await expect(editor.getByText('DOCUMENT END', { exact: true })).toBeInViewport()
    await expect(bar).toBeInViewport()
    await page.setViewportSize({ width: 1100, height: 800 })
    const resized = (await scroller.boundingBox())!
    await page.mouse.move(resized.x + 100, resized.y + 100)
    await page.mouse.wheel(0, -100000)
    await expect(editor.locator('h1')).toBeInViewport()
    await page.mouse.wheel(0, 100000)
    await expect(editor.getByText('DOCUMENT END', { exact: true })).toBeInViewport()
    await page.screenshot({ path: join(runtime.artifacts, 'mathematics-scroll-end.png') })
    await page.mouse.wheel(0, -100000)
    await expect(editor.locator('h1')).toBeInViewport()

    await expect(bar).toBeVisible()
    await page.mouse.move(resized.x + 100, resized.y + 100)
    await page.mouse.wheel(0, -100000)
    await expect(editor.locator('h1')).toBeInViewport()
    writeFileSync(join(runtime.artifacts, 'math-dom.json'), JSON.stringify(await editor.locator('.katex, .katex-error').evaluateAll((elements) => elements.map((element) => ({ math: element.querySelector('annotation')?.textContent ?? element.textContent, parent: element.parentElement?.outerHTML.slice(0, 500) }))), null, 2))
    await expect(editor.locator('.katex')).toHaveCount(6)
    await expect(editor.locator('.katex-error')).toHaveCount(1)
    await expect(editor.locator('code .katex, .cm-editor .katex')).toHaveCount(0)
    await expect(editor.locator('.cm-content').filter({ hasText: '$$\\frac{a}{b}$$' })).toHaveCount(1)
    await expect(editor.locator('.cm-content').filter({ hasText: '\\frac{a}{b} + \\sqrt{x}' })).toHaveCount(1)
    const mathTypography = await editor.evaluate((root) => {
      const paragraph = Array.from(root.querySelectorAll('p')).find((element) => element.textContent?.startsWith('INLINE:'))
      const plainParagraph = Array.from(root.querySelectorAll('p')).find((element) => element.textContent?.startsWith('PLAIN:'))
      const inlineMath = paragraph?.querySelector<HTMLElement>('[data-type="math_inline"] .katex')
      const blockMath = root.querySelector<HTMLElement>('.milkdown-code-block[data-math-block="true"] .preview .katex')
      if (!paragraph || !plainParagraph || !inlineMath || !blockMath) throw new Error('Markdown math typography fixture is incomplete')
      return {
        bodyFontSize: getComputedStyle(paragraph).fontSize,
        inlineFontSize: getComputedStyle(inlineMath).fontSize,
        blockFontSize: getComputedStyle(blockMath).fontSize,
        inlineLineHeight: paragraph.getBoundingClientRect().height,
        plainLineHeight: plainParagraph.getBoundingClientRect().height
      }
    })
    expect(mathTypography.inlineFontSize).toBe(mathTypography.bodyFontSize)
    expect(mathTypography.blockFontSize).toBe(mathTypography.bodyFontSize)
    expect(mathTypography.inlineLineHeight).toBe(mathTypography.plainLineHeight)
    await page.getByTestId('markdown-open-source').click()
    await page.getByTestId('markdown-open-editor').click()
    await expect(editor.locator('.katex')).toHaveCount(6)
    const inlineFormula = editor.locator('[data-type="math_inline"]').first()
    await inlineFormula.click()
    const formulaInput = page.locator('.milkdown-latex-inline-edit[data-show="true"] .ProseMirror')
    await formulaInput.fill(String.raw`x_i^3 + \frac{a}{b} + \sqrt{x}`)
    await formulaInput.press('Enter')
    await expect(inlineFormula).toHaveAttribute('data-value', String.raw`x_i^3 + \frac{a}{b} + \sqrt{x}`)
    await expect.poll(() => editor.locator('img').evaluateAll((images) => images.some((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    await editor.locator('h1').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.type(' edited')
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, name), 'utf8')).toContain('edited')
    const saved = readFileSync(join(resources, name), 'utf8')
    expect(saved).toContain('```latex')
    expect(saved).toContain('\\begin{pmatrix}')
    expect(saved).toContain('x_i^3')
    expect(saved).not.toContain('latex-source')
    expect(saved).toContain('`$x_i$ \\(x^2\\)`')
    await page.screenshot({ path: join(runtime.artifacts, 'mathematics-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: join(runtime.artifacts, 'mathematics-dark.png') })
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await openFile(page, name)
    await expect(page.locator('.ProseMirror .katex')).toHaveCount(6)
    await expect(page.locator('.ProseMirror .katex-error')).toHaveCount(1)
    await expect(page.locator('[data-type="math_inline"]').first()).toHaveAttribute('data-value', String.raw`x_i^3 + \frac{a}{b} + \sqrt{x}`)
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('Markdown table boundaries and block math keep native structure and focused editing', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const name = 'table-math.md'
    writeFileSync(join(resources, name), TABLE_MATH_SOURCE)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, name)
    const editor = page.locator('[data-testid="markdown-visual-editor"] .ProseMirror')
    const tableBlock = editor.locator('.milkdown-table-block').first()
    const headerCells = tableBlock.locator('table.children tr').first().locator('th')
    const addColumnAt = async (boundary: number): Promise<void> => {
      const cells = await headerCells.all()
      if (boundary === cells.length) {
        await tableBlock.locator('.table-wrapper').evaluate((element) => { element.scrollLeft = element.scrollWidth })
      }
      const reference = boundary === cells.length ? cells[cells.length - 1] : cells[boundary]
      await reference.scrollIntoViewIfNeeded()
      const box = await reference.boundingBox()
      if (!box) throw new Error('Table header boundary is not visible')
      await page.mouse.move(boundary === cells.length ? box.x + box.width - 1 : box.x + 1, box.y + box.height / 2)
      const handle = tableBlock.locator('[data-role="y-line-drag-handle"][data-show="true"]')
      await expect(handle).toBeVisible()
      await handle.locator('.add-button').click()
    }

    await expect(headerCells).toHaveCount(3)
    await addColumnAt(0)
    await expect(headerCells).toHaveText(['', '左侧中文长标题', 'Middle column with long English text', '末列'])
    await expect(headerCells.nth(0)).toHaveCSS('text-align', 'left')
    await addColumnAt(2)
    await expect(headerCells).toHaveText(['', '左侧中文长标题', '', 'Middle column with long English text', '末列'])
    await expect(headerCells.nth(2)).toHaveCSS('text-align', 'center')
    await addColumnAt(5)
    await expect(headerCells).toHaveText(['', '左侧中文长标题', '', 'Middle column with long English text', '末列', ''])
    await expect(headerCells.nth(5)).toHaveCSS('text-align', 'right')
    await addColumnAt(3)
    await expect(headerCells).toHaveCount(7)
    await expect(tableBlock.locator('table.children tr')).toHaveCount(3)
    await expect(tableBlock.locator('table.children tr').nth(1).locator('td')).toHaveCount(7)

    await page.setViewportSize({ width: 920, height: 720 })
    const tableWrapper = tableBlock.locator('.table-wrapper')
    await expect.poll(() => tableWrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await tableWrapper.evaluate((element) => { element.scrollLeft = element.scrollWidth })
    await expect(headerCells.last()).toBeInViewport()

    const codeBlocks = editor.locator('.milkdown-code-block')
    await expect(codeBlocks).toHaveCount(4)
    await codeBlocks.nth(0).scrollIntoViewIfNeeded()
    await expect(codeBlocks.nth(0)).toHaveAttribute('data-math-block', 'true')
    await codeBlocks.nth(1).scrollIntoViewIfNeeded()
    await expect(codeBlocks.nth(1)).toHaveAttribute('data-math-block', 'true')
    const formulaBlocks = editor.locator('.milkdown-code-block[data-math-block="true"]')
    await expect(formulaBlocks).toHaveCount(2)
    await formulaBlocks.nth(0).scrollIntoViewIfNeeded()
    await expect(formulaBlocks.nth(0).locator('.katex')).toBeVisible()
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).toHaveClass(/hidden/)
    await expect(formulaBlocks.nth(0).locator('.preview-panel')).toBeVisible()
    await formulaBlocks.nth(0).locator('.preview').click()
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).not.toHaveClass(/hidden/)
    await expect(formulaBlocks.nth(0).locator('.preview-panel')).toBeVisible()
    await formulaBlocks.nth(1).locator('.preview').click()
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).toHaveClass(/hidden/)
    await expect(formulaBlocks.nth(1).locator('.codemirror-host')).not.toHaveClass(/hidden/)
    await page.keyboard.press('Escape')
    await expect(formulaBlocks.nth(1).locator('.codemirror-host')).toHaveClass(/hidden/)

    await formulaBlocks.nth(0).locator('.preview').click()
    const formulaSource = formulaBlocks.nth(0).locator('.cm-content')
    await formulaSource.fill(String.raw`\frac{broken`)
    await expect(formulaBlocks.nth(0).locator('.katex-error')).toBeVisible()
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).not.toHaveClass(/hidden/)
    await formulaSource.fill(String.raw`x_1^3 + \sqrt{y}`)
    await expect(formulaSource).toHaveText(String.raw`x_1^3 + \sqrt{y}`)
    await expect(formulaBlocks.nth(0).locator('.katex')).toBeVisible()
    await expect(formulaBlocks.nth(0).locator('.katex-error')).toHaveCount(0)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).toHaveClass(/hidden/)
    await formulaBlocks.nth(0).locator('.preview').click()
    await editor.locator('h1').click()
    await expect(formulaBlocks.nth(0).locator('.codemirror-host')).toHaveClass(/hidden/)
    await expect(editor.locator('code .katex, .cm-editor .katex')).toHaveCount(0)
    await expect(editor.locator('.cm-content').filter({ hasText: '$$not-rendered$$' })).toHaveCount(1)
    await expect(editor.locator('.cm-content').filter({ hasText: '\\frac{code}{only}' })).toHaveCount(1)

    await page.getByTestId('markdown-open-source').click()
    await page.getByTestId('markdown-open-editor').click()
    const restoredCodeBlocks = editor.locator('.milkdown-code-block')
    await restoredCodeBlocks.nth(0).scrollIntoViewIfNeeded()
    await expect(restoredCodeBlocks.nth(0).locator('.katex')).toBeVisible()
    await restoredCodeBlocks.nth(1).scrollIntoViewIfNeeded()
    await expect(restoredCodeBlocks.nth(1).locator('.katex')).toBeVisible()
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, name), 'utf8')).toContain('x_1^3')
    const savedSource = readFileSync(join(resources, name), 'utf8')
    expect(savedSource).toContain('Middle content must remain unchanged')
    expect(savedSource).toContain('```markdown\n$$not-rendered$$\n```')
    expect(savedSource).toContain('```latex\n\\frac{code}{only}\n```')
    await page.screenshot({ path: join(runtime.artifacts, 'table-math-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: join(runtime.artifacts, 'table-math-dark.png') })
    await desktop.close()
    page = await desktop.launch()
    await selectProject(page)
    await openFile(page, name)
    await expect(page.locator('.ProseMirror table.children th')).toHaveCount(7)
    const reopenedFormula = page.locator('.ProseMirror .milkdown-code-block').first()
    await reopenedFormula.scrollIntoViewIfNeeded()
    await expect(reopenedFormula.locator('.cm-content')).toHaveText(String.raw`x_1^3 + \sqrt{y}`)
    await expect(reopenedFormula.locator('.katex')).toBeVisible()
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('development Markdown documents keep table editors alive across tab switching, splitting and restart', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  console.log(`Isolated renderer runtime: ${runtime.home}`)
  const desktopRoot = resolve(__dirname, '..')
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(desktopRoot, 'electron.vite.config.ts'))
  expect(loaded).toBeTruthy()
  const renderer = (loaded!.config as UserConfig & { renderer: UserConfig }).renderer
  const server = await createServer({
    ...renderer,
    configFile: false,
    root: join(desktopRoot, 'src', 'renderer'),
    cacheDir: join(runtime.root, 'vite-cache'),
    server: { ...renderer.server, port: 0, strictPort: false }
  })
  const previousRendererUrl = process.env.ELECTRON_RENDERER_URL
  const firstName = 'first-table.md'
  const secondName = 'second-table.md'
  const tableSource = '# Selection registration\n\n| Name | Value |\n| --- | --- |\n| Original cell | 1 |\n'
  const editedCell = 'Persisted table edit'
  const projectName = 'Markdown editor regression'
  try {
    await server.listen()
    process.env.ELECTRON_RENDERER_URL = server.resolvedUrls!.local[0]
    let page = await desktop.launch()
    const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, { data: { name: projectName } })
    expect(response.ok(), await response.text()).toBe(true)
    const project = await response.json() as { root: string }
    expect(relative(runtime.workspace, project.root).startsWith('..')).toBe(false)
    const resources = join(project.root, RESOURCES_DIR)
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, firstName), tableSource)
    writeFileSync(join(resources, secondName), tableSource)
    const selectMarkdownProject = async (): Promise<void> => {
      await enterWorkbenchShell(page)
      await page.getByTestId('topbar-project').click()
      await page.getByTestId(`project-menu-option-${projectName}`).click()
      await page.getByTestId('activity-resource').click()
      await page.getByTestId('resource-refresh').click()
      await page.screenshot({ path: join(runtime.artifacts, 'markdown-resources.png') })
    }
    await page.reload()
    await selectMarkdownProject()
    await openFile(page, firstName)
    await page.locator('[data-testid="markdown-open-editor"]:visible').first().click()
    const visual = page.locator('[data-testid="markdown-visual-editor"]:visible .ProseMirror')
    const table = visual.locator('table.children')
    await expect(table).toHaveCount(1)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-table-editor.png') })
    // Triple-click the cell's text paragraph through the real UI. Table keyboard
    // navigation can move to a neighboring header instead of selecting cell text.
    await table.locator('td p').first().click({ clickCount: 3 })
    await page.keyboard.type(editedCell)
    await expect(table.locator('td').first()).toHaveText(editedCell)
    await page.getByTestId('markdown-save').click()
    await expect.poll(() => readFileSync(join(resources, firstName), 'utf8')).toContain(editedCell)
    await openFile(page, secondName)
    await page.locator('[data-testid="markdown-open-editor"]:visible').first().click()
    await expect(table.locator('td').first()).toHaveText('Original cell')
    await page.getByRole('tab', { name: new RegExp(firstName) }).click()
    await expect(table.locator('td').first()).toHaveText(editedCell)
    const firstTab = page.getByRole('tab', { name: new RegExp(firstName) })
    await firstTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '向下拆分', exact: true }).click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible')).toHaveCount(2)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-table-split.png') })
    await expect(page.getByTestId('document-view-error')).toHaveCount(0)
    desktop.assertNoPageErrors()
    await desktop.close()
    page = await desktop.launch()
    await selectMarkdownProject()
    await openFile(page, firstName)
    await page.locator('[data-testid="markdown-open-editor"]:visible').first().click()
    await expect(page.locator('[data-testid="markdown-visual-editor"]:visible .ProseMirror').first()).toContainText(editedCell)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-table-reopened.png') })
    await expect(page.getByTestId('document-view-error')).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
    if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = previousRendererUrl
    await server.close()
  }
})

test('long resource folder names stay clear of row actions at every depth', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const folderName = '超长文本超长文本超长文本超长文本超长文本'
  const nestedPath = `${folderName}/${folderName}`
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    mkdirSync(join(resources, nestedPath), { recursive: true })
    writeFileSync(join(resources, nestedPath, 'note.md'), '# Long folder layout\n')
    await page.getByTestId('resource-refresh').click()
    await page.getByTestId(`tree-resources/${folderName}`).click()
    for (const path of [`resources/${folderName}`, `resources/${nestedPath}`]) {
      const row = page.getByTestId(`tree-${path}`)
      const name = row.locator('.vds-tree-name')
      await row.hover()
      await expect.poll(() => name.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      const textBounds = await name.boundingBox()
      const actionBounds = await page.getByTestId(`tree-more-${path}`).boundingBox()
      expect(textBounds!.x + textBounds!.width).toBeLessThanOrEqual(actionBounds!.x)
      await page.getByTestId(`tree-create-${path}`).click()
      await expect(page.getByTestId(`tree-new-folder-${path}`)).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.getByTestId(`tree-resources/${folderName}`).hover()
    await page.screenshot({ path: join(runtime.artifacts, 'resource-long-folder-actions.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('switching compressed document tabs does not resurrect previous tooltips', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const names = ['tooltip-alpha.md', 'tooltip-bravo.md', 'tooltip-charlie.md', 'tooltip-delta.md', 'tooltip-echo.md']
  try {
    const page = await desktop.launch()
    await (await desktop.app!.browserWindow(page)).evaluate(window => window.setSize(1100, 800))
    const resources = await seedProject(page, runtime)
    for (const name of names) writeFileSync(join(resources, name), `# ${name}\n`)
    await page.getByTestId('resource-refresh').click()
    for (const name of names) await openFile(page, name)
    for (const name of names) {
      const tab = page.locator('[data-testid^="document-tab-"]').filter({ hasText: name })
      const label = tab.locator('[data-slot="ellipsis-text"]')
      await expect.poll(() => label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      await label.hover({ position: { x: 1, y: 1 } })
      await expect(page.getByRole('tooltip').filter({ hasText: name })).toBeVisible()
      await label.click({ position: { x: 1, y: 1 } })
      await expect.poll(() => label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
      await page.mouse.move(0, 0)
      await expect(page.getByRole('tooltip')).toHaveCount(0)
    }
    await expect(page.locator('[data-testid="document-editor"]:visible, [data-testid="markdown-visual-editor"]:visible')).toBeVisible()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'document-tabs-no-stale-tooltips.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('horizontal split keeps navigation aligned and trailing tab icons clear of actions', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({
    language: 'zh',
    onboarding: { seen: { globalLib: true, home: true, pdf: true, project: true } }
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  const dividerTolerancePx = 1
  try {
    const page = await desktop.launch()
    await page.getByTestId('ai-panel').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByTestId('topbar-ai')).toBeVisible()
    const resources = await seedProject(page, runtime)
    writeFileSync(
      join(resources, 'acceptance.md'),
      Array.from(
        { length: SPLIT_SCROLL_SECTION_COUNT },
        (_, index) => `## Independent section ${index + 1}\n\nEach pane keeps its own scroll position.\n`
      ).join('\n')
    )
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'acceptance.md')
    await expect(page.getByTestId('topbar-ai')).toContainText('书深 AI')
    await page.locator('[data-testid="markdown-open-editor"]:visible').first().click()
    const expectTrailingTabIconClear = async (): Promise<void> => {
      const actions = page.locator('.vds-top-bar-actions')
      const trailingNavigation = page.locator('.vds-top-bar-navigation-trailing')
      const activeTabIcon = trailingNavigation.getByRole('tab', { selected: true }).locator('svg').first()
      await expect(actions).toBeVisible()
      await expect(activeTabIcon).toBeVisible()
      await expect.poll(async () => {
        const [actionBounds, iconBounds] = await Promise.all([
          actions.boundingBox(),
          activeTabIcon.boundingBox()
        ])
        if (!actionBounds || !iconBounds) return Number.NEGATIVE_INFINITY
        return actionBounds.x - (iconBounds.x + iconBounds.width)
      }).toBeGreaterThanOrEqual(0)
    }
    await expectTrailingTabIconClear()
    const fileTab = page.locator('[data-testid^="document-tab-"]').filter({ hasText: 'acceptance.md' })
    await fileTab.click({ button: 'right' })
    await page.getByTestId('tab-split-right').click()

    const aiButton = page.getByTestId('topbar-ai')
    await expect(aiButton).toHaveText('')
    await expect(aiButton.locator('img')).toBeVisible()
    await expect.poll(async () => (await aiButton.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(COMPACT_AI_BUTTON_MAX_WIDTH_PX)

    const paneScrollers = page.locator('.vds-dock-leaf .vds-markdown-crepe > .milkdown')
    await expect(paneScrollers).toHaveCount(2)
    expect(await paneScrollers.evaluateAll(nodes => nodes.every(node => node.scrollHeight > node.clientHeight))).toBe(true)
    await paneScrollers.evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0 }))
    await paneScrollers.nth(0).hover()
    await page.mouse.wheel(0, SPLIT_SCROLL_DISTANCE_PX)
    const firstPaneScrollTop = await paneScrollers.nth(0).evaluate(node => node.scrollTop)
    expect(firstPaneScrollTop).toBeGreaterThan(0)
    expect(await paneScrollers.nth(1).evaluate(node => node.scrollTop)).toBe(0)
    await page.screenshot({ path: join(runtime.artifacts, 'split-pane-independent-scroll.png') })
    await paneScrollers.nth(1).hover()
    await page.mouse.wheel(0, SPLIT_SCROLL_DISTANCE_PX)
    await expect.poll(() => paneScrollers.nth(1).evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    expect(await paneScrollers.nth(0).evaluate(node => node.scrollTop)).toBe(firstPaneScrollTop)

    const navigationDivider = page.getByTestId('navigation-split-divider')
    const documentDivider = page.locator('.vds-dock-split.is-horizontal > .vds-dock-divider').first()
    const expectAligned = async (): Promise<void> => {
      await expect(navigationDivider).toBeVisible()
      await expect(documentDivider).toBeVisible()
      await expect.poll(async () => {
        const [navigation, document] = await Promise.all([
          navigationDivider.boundingBox(),
          documentDivider.boundingBox()
        ])
        if (!navigation || !document) return Number.POSITIVE_INFINITY
        return Math.abs(navigation.x - document.x)
      }).toBeLessThanOrEqual(dividerTolerancePx)
    }

    await expectAligned()
    await expectTrailingTabIconClear()
    const documentBounds = await documentDivider.boundingBox()
    if (!documentBounds) throw new Error('Document split divider is not visible')
    await page.mouse.move(
      documentBounds.x + documentBounds.width / 2,
      documentBounds.y + documentBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      documentBounds.x + documentBounds.width / 2 + 120,
      documentBounds.y + documentBounds.height / 2
    )
    await page.mouse.up()
    await expectAligned()

    if (await page.getByTestId('ai-panel').isVisible()) {
      await page.getByTestId('ai-panel-layout-toggle').click()
    }
    await expectAligned()
    await page.screenshot({ path: join(runtime.artifacts, 'split-pane-compact-ai-independent-scroll.png') })

    await page.setViewportSize({ width: 900, height: 700 })
    await expectAligned()
    await expectTrailingTabIconClear()
    await page.screenshot({ path: join(runtime.artifacts, 'split-pane-divider-alignment-narrow.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('file tree separates disk edits, warnings and global policy setup without version state', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const serviceSettings = join(runtime.home, 'service')
  mkdirSync(serviceSettings, { recursive: true })
  writeFileSync(join(serviceSettings, 'settings.json'), JSON.stringify({ max_versions_per_file: 50 }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    let page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    await expect(page.getByTestId('tree-confirm-policy')).toBeVisible()
    await expect(page.locator('.vds-tree-version')).toHaveCount(0)
    await page.getByTestId('tree-confirm-policy').click()
    await expect(page.getByTestId('account-settings-nav-files')).toBeVisible()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.getByText('文件版本设置已保存', { exact: true })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
    await expect(page.getByTestId('tree-confirm-policy')).toHaveCount(0)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'source.h')
    const dirty = page.getByTestId('tree-dirty-resources/source.h')
    const editor = page.locator('[data-testid="document-editor"]:visible')
    await expect(editor).toBeVisible({ timeout: TREE_EDITOR_LOAD_TIMEOUT_MS })
    await expect(dirty).toHaveCount(0)
    await expect(page.getByTestId('tree-version-resources/source.h')).toHaveCount(0)
    await editor.click()
    await page.keyboard.press(`${SHORTCUT}+End`)
    await page.keyboard.insertText(TREE_UNSAVED_EDIT)
    await expect(dirty).toBeVisible()
    await dirty.hover()
    await expect(page.getByRole('tooltip')).toHaveText('尚未保存到文件')
    expect(readFileSync(join(resources, 'source.h'), 'utf8')).not.toContain('Unsaved tree edit')
    await page.screenshot({ path: join(runtime.artifacts, 'tree-unsaved.png') })
    for (let remaining = TREE_UNSAVED_EDIT.length; remaining > 0 && await dirty.count(); remaining -= 1) {
      await page.keyboard.press(`${SHORTCUT}+z`)
    }
    await expect(dirty).toHaveCount(0)
    await page.keyboard.insertText('\nSaved tree edit')
    await expect(dirty).toBeVisible()
    await page.keyboard.press(`${SHORTCUT}+s`)
    await expect(dirty).toHaveCount(0)
    await expect.poll(() => readFileSync(join(resources, 'source.h'), 'utf8')).toContain('Saved tree edit')
    await page.getByTestId('resource-refresh').click()
    await expect(version).toBeVisible()
    await version.hover()
    await expect(page.getByRole('tooltip')).toHaveText('待存版本 · 查看差异和版本历史')
    await page.screenshot({ path: join(runtime.artifacts, 'tree-pending-version.png') })
    await version.click()
    await expect(page.getByTestId('snapshot-pending')).toBeVisible()
    await page.getByTestId('snapshot-save-pending').click()
    await expect(page.getByTestId('snapshot-pending')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(version).toHaveCount(0)
    const oversized = join(resources, 'large.bin')
    const sizeLimit = 64 * 1024 * 1024
    const payload = Buffer.alloc(sizeLimit + 1)
    writeFileSync(oversized, payload)
    await page.getByTestId('resource-refresh').click()
    const warning = page.getByTestId('tree-warning-resources/large.bin')
    await expect(warning).toBeVisible()
    await warning.hover()
    await expect(page.getByRole('tooltip')).toHaveText('文件大小超过版本管理上限')
    await page.screenshot({ path: join(runtime.artifacts, 'tree-warning-tooltip.png') })
    await warning.click()
    await expect(page.getByText('文件大小超过版本管理上限', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重新检查', exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'tree-warning.png') })
    await page.keyboard.press('Escape')
    await desktop.close()
    writeFileSync(join(runtime.userData, 'renderer-preferences.json'), JSON.stringify({ language: 'zh', theme: 'dark' }))
    page = await desktop.launch()
    await selectProject(page)
    await page.getByTestId('resource-refresh').click()
    await openFile(page, 'source.h')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: join(runtime.artifacts, 'tree-dark.png') })
    await page.setViewportSize({ width: 800, height: 720 })
    await page.screenshot({ path: join(runtime.artifacts, 'tree-narrow.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.page?.screenshot({ path: join(runtime.artifacts, 'tree-final-state.png') }).catch(() => undefined)
    await desktop.attachArtifacts()
  }
})

test('oversized files stay quiet in the tree and menu while keeping the detail warning', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const serviceSettings = join(runtime.home, 'service')
  mkdirSync(serviceSettings, { recursive: true })
  writeFileSync(join(serviceSettings, 'settings.json'), JSON.stringify({
    file_version_mode: 'whitelist',
    file_version_include: ['*'],
    file_version_ignore: [],
    max_versions_per_file: 50,
    max_version_file_size_kb: OVERSIZED_TEST_LIMIT_KB
  }))
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    writeFileSync(join(resources, 'large.bin'), Buffer.alloc(OVERSIZED_TEST_LIMIT_KB * BYTES_PER_KIBIBYTE + 1))
    await page.getByTestId('resource-refresh').click()
    await expect(page.getByTestId('tree-warning-resources/large.bin')).toHaveCount(0)
    await page.getByTestId('tree-resources/large.bin').click({ button: 'right' })
    const menu = page.getByTestId('resource-node-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByText('文件大小超过版本管理上限', { exact: true })).toHaveCount(0)
    await expect(menu.locator('p')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'tree-oversized-menu.png') })
    await page.keyboard.press('Escape')
    await openFile(page, 'large.bin')
    await expect(page.getByText('文件大小超过版本管理上限', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'tree-oversized-detail.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('file tree review indicator follows a real Agent file edit', async ({}, testInfo) => {
  const realHome = process.env.SCHOLARSEED_REAL_HOME
  test.skip(!realHome, 'SCHOLARSEED_REAL_HOME is required for the real model flow')
  const runtime = createRuntime(testInfo)
  const modelSettings = JSON.parse(readFileSync(join(realHome!, 'service', 'settings.json'), 'utf8')) as { codex_model: string }
  copyFileSync(join(realHome!, 'model_profiles.json'), join(runtime.home, 'model_profiles.json'))
  const service = join(runtime.home, 'service')
  mkdirSync(service, { recursive: true })
  writeFileSync(join(service, 'settings.json'), JSON.stringify({ codex_model: modelSettings.codex_model, file_version_mode: 'whitelist', file_version_include: ['*.md'], max_versions_per_file: 50 }))
  const desktop = new DesktopSession(runtime, testInfo, { preserveRuntime: true })
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    if (!await page.getByTestId('ai-panel').isVisible()) await page.getByTestId('topbar-ai').click()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await page.getByTestId('mode-chip').click()
    await page.getByTestId('mode-bypassPermissions').click()
    await page.getByTestId('mode-bypassPermissions-confirm').click()
    await page.getByTestId('composer-input').fill('请实际修改当前项目 resources/acceptance.md，在末尾追加一段“文件树真实审阅验收”。不要修改其他文件，完成后简短回复。')
    await expect(page.getByTestId('composer-send')).toBeEnabled()
    await page.getByTestId('composer-send').click()
    await waitForFinishedTurn(page)
    expect(readFileSync(join(resources, 'acceptance.md'), 'utf8')).toContain('文件树真实审阅验收')
    await page.getByTestId('resource-refresh').click()
    const review = page.getByTestId('tree-review-resources/acceptance.md')
    await expect(review).toBeVisible()
    await expect(page.getByTestId('tree-dirty-resources/acceptance.md')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'tree-real-review.png') })
    await review.hover()
    await expect(page.getByRole('tooltip')).toHaveText('待审阅 · 查看并处理修改')
    await review.click()
    await expect(page.getByTestId('snapshot-review')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'tree-real-review-panel.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.page?.screenshot({ path: join(runtime.artifacts, 'tree-final-state.png') }).catch(() => undefined)
    await desktop.attachArtifacts()
  }
})

const MARKDOWN_TITLE_PROJECT = 'Markdown 展示标题验收'
const MARKDOWN_EXISTING_NAME = '已有笔记.markdown'
const MARKDOWN_EXISTING_BODY = '# 用户自定标题\n\n原始正文。\n'
const MARKDOWN_PLAIN_NAME = '无标题.MD'
const MARKDOWN_PLAIN_BODY = '第一行就是正文。\n'
const MARKDOWN_IMPORTED_NAME = '导入笔记.md'
const MARKDOWN_LINKED_NAME = '关联笔记.md'
const MARKDOWN_CREATED_NAME = '新建展示标题'
const MARKDOWN_RENAMED_NAME = '新文件名 & [literal]'
const MARKDOWN_SAVED_BODY = '用户编辑后的正文。'
const MARKDOWN_SOURCE_BODY = '源码编辑正文。'
const MARKDOWN_SCROLL_NAME = '滚动文档.md'
const MARKDOWN_SCROLL_PARAGRAPHS = 80
const MARKDOWN_SCROLL_DISTANCE = 300

test('Markdown filename titles render independently of creation, body editing and rename', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const response = await page.request.post(`${await apiBase(page)}/api/content/projects`, { data: { name: MARKDOWN_TITLE_PROJECT } })
    expect(response.ok(), await response.text()).toBe(true)
    const project = await response.json() as { id: string; root: string }
    const resources = join(project.root, RESOURCES_DIR)
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, MARKDOWN_EXISTING_NAME), MARKDOWN_EXISTING_BODY)
    writeFileSync(join(resources, MARKDOWN_PLAIN_NAME), MARKDOWN_PLAIN_BODY)
    writeFileSync(join(resources, MARKDOWN_SCROLL_NAME), MARKDOWN_PLAIN_BODY.repeat(MARKDOWN_SCROLL_PARAGRAPHS).replaceAll('。\n', '。\n\n'))
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${MARKDOWN_TITLE_PROJECT}`).click()
    if (!await page.getByTestId('resource-panel').isVisible().catch(() => false)) await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()

    const title = page.locator('[data-testid="markdown-filename-title"]:visible')
    const editor = page.locator('[data-testid="markdown-visual-editor"]:visible .ProseMirror')
    await openFile(page, MARKDOWN_EXISTING_NAME)
    await expect(title).toHaveCount(0)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(title).toHaveText('已有笔记')
    await expect(editor.locator('h1')).toHaveText('用户自定标题')
    const paper = page.locator('[data-testid="markdown-paper"]:visible')
    await expect(paper.locator('[data-testid="markdown-filename-title"]')).toHaveText('已有笔记')
    await expect(paper.locator('.ProseMirror')).toHaveCount(1)
    await expect(paper).toHaveCSS('padding-left', '64px')
    await expect(paper).toHaveCSS('padding-top', '64px')
    const titleBounds = await title.boundingBox()
    const bodyBounds = await editor.boundingBox()
    expect(titleBounds).not.toBeNull()
    expect(bodyBounds).not.toBeNull()
    expect(Math.abs(titleBounds!.x - bodyBounds!.x)).toBeLessThan(1)
    expect(titleBounds!.y + titleBounds!.height).toBeLessThan(bodyBounds!.y)
    await expect(title).toHaveCSS('font-weight', '700')
    const firstBlock = editor.locator(':scope > *').first()
    const titleBodyGap = async (): Promise<number> => {
      const [currentTitle, currentBlock] = await Promise.all([title.boundingBox(), firstBlock.boundingBox()])
      expect(currentTitle).not.toBeNull()
      expect(currentBlock).not.toBeNull()
      return currentBlock!.y - currentTitle!.y - currentTitle!.height
    }
    const initialTitleBodyGap = await titleBodyGap()
    expect(initialTitleBodyGap).toBeGreaterThanOrEqual(31)
    expect(initialTitleBodyGap).toBeLessThanOrEqual(33)
    expect(readFileSync(join(resources, MARKDOWN_EXISTING_NAME), 'utf8')).toBe(MARKDOWN_EXISTING_BODY)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-existing-heading.png') })

    const existingTab = page.getByRole('tab', { name: new RegExp(MARKDOWN_EXISTING_NAME) })
    await page.getByRole('button', { name: `关闭 ${MARKDOWN_EXISTING_NAME}` }).click()
    await expect(existingTab).toHaveCount(0)
    await openFile(page, MARKDOWN_EXISTING_NAME)
    await expect(title).toHaveCount(0)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(title).toHaveText('已有笔记')
    await expect(editor.locator('h1')).toHaveText('用户自定标题')
    expect(Math.abs(await titleBodyGap() - initialTitleBodyGap)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-reopened-heading.png') })

    await openFile(page, MARKDOWN_PLAIN_NAME)
    await expect(title).toHaveCount(0)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(title).toHaveText('无标题')
    await expect(editor).toContainText('第一行就是正文。')
    await expect(editor.locator('h1')).toHaveCount(0)
    expect(readFileSync(join(resources, MARKDOWN_PLAIN_NAME), 'utf8')).toBe(MARKDOWN_PLAIN_BODY)

    await page.getByTestId('resource-add').click()
    await page.getByTestId('resource-new-doc').click()
    await page.getByTestId('resource-name-input').fill(MARKDOWN_CREATED_NAME)
    await page.getByTestId('resource-name-input').press('Enter')
    await expect.poll(() => existsSync(join(resources, `${MARKDOWN_CREATED_NAME}.md`))).toBe(true)
    expect(readFileSync(join(resources, `${MARKDOWN_CREATED_NAME}.md`), 'utf8')).toBe('')
    await openFile(page, `${MARKDOWN_CREATED_NAME}.md`)
    await page.locator('[data-testid="markdown-open-source"]:visible').click()
    await expect(title).toHaveCount(0)
    const source = page.locator('[data-testid="document-editor"]:visible .view-lines')
    await expect(source).not.toContainText(MARKDOWN_CREATED_NAME)
    await source.click()
    await page.keyboard.insertText(MARKDOWN_SOURCE_BODY)
    await page.keyboard.press(`${SHORTCUT}+s`)
    await expect.poll(() => readFileSync(join(resources, `${MARKDOWN_CREATED_NAME}.md`), 'utf8')).toBe(MARKDOWN_SOURCE_BODY)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(title).toHaveText(MARKDOWN_CREATED_NAME)
    await expect(editor.locator('h1')).toHaveCount(0)
    await editor.fill(MARKDOWN_SAVED_BODY)
    await page.locator('[data-testid="markdown-save"]:visible').click()
    await expect.poll(() => readFileSync(join(resources, `${MARKDOWN_CREATED_NAME}.md`), 'utf8').trim()).toBe(MARKDOWN_SAVED_BODY)

    await page.getByTestId(`tree-resources/${MARKDOWN_CREATED_NAME}.md`).click({ button: 'right' })
    await page.getByTestId('menu-rename').click()
    await page.getByTestId('resource-name-input').fill(MARKDOWN_RENAMED_NAME)
    await page.getByTestId('resource-name-input').press('Enter')
    await expect(title).toHaveText(MARKDOWN_RENAMED_NAME)
    await expect(editor).toContainText(MARKDOWN_SAVED_BODY)
    expect(readFileSync(join(resources, `${MARKDOWN_RENAMED_NAME}.md`), 'utf8').trim()).toBe(MARKDOWN_SAVED_BODY)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-renamed-title.png') })

    // Rename a file whose first H1 deliberately differs from its filename.
    await openFile(page, MARKDOWN_EXISTING_NAME)
    await page.getByTestId(`tree-resources/${MARKDOWN_EXISTING_NAME}`).click({ button: 'right' })
    await page.getByTestId('menu-rename').click()
    await page.getByTestId('resource-name-input').fill('保留正文标题')
    await page.getByTestId('resource-name-input').press('Enter')
    await expect(title).toHaveText('保留正文标题')
    expect(readFileSync(join(resources, '保留正文标题.markdown'), 'utf8')).toBe(MARKDOWN_EXISTING_BODY)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${MARKDOWN_TITLE_PROJECT}`).click()
    if (!await page.getByTestId('resource-panel').isVisible().catch(() => false)) await page.getByTestId('activity-resource').click()
    await openFile(page, '保留正文标题.markdown')
    await expect(title).toHaveText('保留正文标题')
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(editor.locator('h1')).toHaveText('用户自定标题')

    const external = join(runtime.root, 'external-markdown')
    mkdirSync(external)
    const importedPath = join(external, MARKDOWN_IMPORTED_NAME)
    const linkedPath = join(external, MARKDOWN_LINKED_NAME)
    writeFileSync(importedPath, MARKDOWN_PLAIN_BODY)
    writeFileSync(linkedPath, MARKDOWN_EXISTING_BODY)
    const imported = await page.request.post(`${await apiBase(page)}/api/resource/import`, {
      data: { project: project.id, mode: 'copy', sources: [importedPath], target_dir: '' }
    })
    expect(imported.ok(), await imported.text()).toBe(true)
    const authorization = await page.request.post(`${await apiBase(page)}/api/content/roots`, {
      data: { project: project.id, source: external, mount: '关联 Markdown' }
    })
    expect(authorization.ok(), await authorization.text()).toBe(true)
    const root = await authorization.json() as { mount_path: string }
    await page.getByTestId('resource-refresh').click()
    await openFile(page, MARKDOWN_IMPORTED_NAME)
    await expect(title).toHaveText('导入笔记')
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(editor).toContainText('第一行就是正文。')
    expect(readFileSync(join(resources, MARKDOWN_IMPORTED_NAME), 'utf8')).toBe(MARKDOWN_PLAIN_BODY)
    await page.getByTestId(`tree-${root.mount_path}`).click()
    await page.getByTestId(`tree-${root.mount_path}/${MARKDOWN_LINKED_NAME}`).click()
    await expect(title).toHaveText('关联笔记')
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(editor.locator('h1')).toHaveText('用户自定标题')
    expect(readFileSync(linkedPath, 'utf8')).toBe(MARKDOWN_EXISTING_BODY)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-linked-heading.png') })
    await page.setViewportSize({ width: 900, height: 760 })
    await expect(title).toBeVisible()
    await expect(editor.locator('h1')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-narrow-title.png') })
    await openFile(page, MARKDOWN_SCROLL_NAME)
    await page.locator('[data-testid="markdown-open-editor"]:visible').click()
    await expect(title).toHaveText('滚动文档')
    const beforeScroll = await title.boundingBox()
    expect(beforeScroll).not.toBeNull()
    await page.locator('.vds-markdown-crepe > .milkdown:visible').hover()
    await page.mouse.wheel(0, MARKDOWN_SCROLL_DISTANCE)
    await expect.poll(async () => (await title.boundingBox())?.y ?? beforeScroll!.y).toBeLessThan(beforeScroll!.y)
    await page.screenshot({ path: join(runtime.artifacts, 'markdown-scrolled-title.png') })
    desktop.assertNoPageErrors()
  } finally { await desktop.attachArtifacts() }
})

test('PDF annotation text clicks anchor details without blocking drag selection', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    const resources = await seedProject(page, runtime)
    const sourceHash = fileDigest(join(resources, PDF_NAME))
    await openFile(page, PDF_NAME)
    await selectPdfText(page)
    await page.getByRole('button', { name: '添加高亮', exact: true }).first().click()
    const mark = page.locator('[data-testid^="pdf-mark-"]').first()
    await expect(mark).toBeAttached()
    const markedText = page.getByTestId('pdf-page-1').locator('.textLayer span').filter({ hasText: 'Needle marker' }).first()
    await markedText.click()
    const inspector = page.locator('[data-testid^="pdf-annotation-inspector-"]')
    await expect(inspector).toBeInViewport()
    const [markBounds, inspectorBounds] = await Promise.all([mark.boundingBox(), inspector.boundingBox()])
    expect(markBounds).not.toBeNull()
    expect(inspectorBounds).not.toBeNull()
    expect(Math.min(
      Math.abs(inspectorBounds!.y - (markBounds!.y + markBounds!.height)),
      Math.abs(markBounds!.y - (inspectorBounds!.y + inspectorBounds!.height))
    )).toBeLessThanOrEqual(POPOVER_ANCHOR_MAX_GAP_PX)
    await inspector.getByRole('button', { name: '写批注', exact: true }).click()
    await inspector.getByRole('textbox', { name: '批注内容', exact: true }).fill(NOTE_TEXT)
    await inspector.getByRole('button', { name: '保存批注', exact: true }).click()
    await expect(inspector).toContainText(NOTE_TEXT)
    await page.screenshot({ path: join(runtime.artifacts, 'annotation-mouse-details.png') })
    await page.getByTestId('pdf-page-1').click({ position: { x: 10, y: 10 } })
    await expect(inspector).toHaveCount(0)
    await mark.locator('span').filter({ hasText: '“' }).click()
    await expect(inspector).toBeInViewport()
    await expect(inspector).toContainText(NOTE_TEXT)
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)
    await selectPdfText(page)
    await expect(inspector).toHaveCount(0)
    expect(fileDigest(join(resources, PDF_NAME))).toBe(sourceHash)
  } finally {
    await desktop.close()
  }
})
