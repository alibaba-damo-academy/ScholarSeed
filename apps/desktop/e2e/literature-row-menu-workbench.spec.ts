import { openProjectMenu } from './fixtures/projects'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DesktopSession, apiBase } from './fixtures/electron'
import { createRuntime, type RuntimePaths } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const SAMPLE_PDF = resolve('e2e/fixtures/data/minimal-project/sample.pdf')
const PROJECT_PDF = resolve('e2e/fixtures/preview_pdf_1MB.pdf')
const METADATA_BIB = resolve('e2e/fixtures/data/minimal-project/metadata-only.bib')
const BIB_TITLE = 'Row Menu Metadata Only Entry'
const PROJECT_NAME = 'Row-menu-project'
const IMPORT_PARSE_TIMEOUT_MS = 90_000

interface LiteratureRow {
  id: string
  title: string
}

async function literatures(page: Page, base: string, projectId?: string): Promise<LiteratureRow[]> {
  const query = projectId ? `?project_id=${projectId}` : ''
  const response = await page.request.get(`${base}/api/v1/literatures${query}`)
  expect(response.ok(), await response.text()).toBe(true)
  const payload = await response.json()
  return payload.items as LiteratureRow[]
}

/**
 * 走真实导入通道补数据: 直接把文件喂给列表里那两个隐藏 input, 不弹系统对话框,
 * 后端解析与入库全都是真的。
 */
async function importFiles(page: Page, label: string, ...paths: string[]): Promise<void> {
  await page.getByLabel(label, { exact: true }).setInputFiles(paths)
}

/** 单份 PDF 导入在 HEAD 上仍会弹进度框; 弹了就等它解析完再收掉。 */
async function dismissImportDialog(page: Page): Promise<void> {
  const done = page.getByRole('dialog').getByRole('button', { name: '完成', exact: true })
  await expect(done).toBeVisible({ timeout: IMPORT_PARSE_TIMEOUT_MS })
  await done.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function openRowMenu(row: Locator): Promise<Locator> {
  await row.click({ button: 'right' })
  const menu = row.page().locator('[role="menu"]')
  await expect(menu).toBeVisible()
  return menu
}

async function closeRowMenu(page: Page): Promise<void> {
  // 行内单元格的悬停 Tooltip 会先吃掉一次 Escape(components/ui 里 Tooltip 的 capture
  // 处理器早于菜单注册, 且它的 :hover 判定对 portal 到 body 的内容恒真)。先把指针移出
  // 列表让 Tooltip 收起, 再用 Escape 收菜单 —— 两步都是真实用户动作。
  await page.mouse.move(4, 4)
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[role="menu"]')).toHaveCount(0)
}

async function shoot(page: Page, runtime: RuntimePaths, name: string): Promise<void> {
  await page.screenshot({ path: resolve(runtime.artifacts, `${name}.png`), fullPage: true })
}

test('literature rows carry a right click menu with scoped destructive action', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  writeFileSync(
    resolve(runtime.userData, 'renderer-preferences.json'),
    JSON.stringify({
      language: 'zh',
      onboarding: { seen: { home: true, project: true, globalLib: true, pdf: true } }
    })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    page.setDefaultTimeout(20_000)
    const base = await apiBase(page)

    // ---- 文献中心: 一份带主附件的 PDF + 一条只有题录的条目 ----
    await page.getByTestId('activity-literature').click()
    await expect(page.getByTestId('literature-drop-target')).toBeVisible()
    await importFiles(page, '选择要导入的 PDF', SAMPLE_PDF)
    await dismissImportDialog(page)
    await expect
      .poll(async () => (await literatures(page, base)).length, { timeout: IMPORT_PARSE_TIMEOUT_MS })
      .toBe(1)
    await importFiles(page, '选择要导入的 Bib 或 RIS 文件', METADATA_BIB)
    await expect
      .poll(async () => (await literatures(page, base)).length, { timeout: IMPORT_PARSE_TIMEOUT_MS })
      .toBe(2)
    const entries = await literatures(page, base)
    const pdfTitle = entries.find((entry) => entry.title !== BIB_TITLE)?.title ?? ''
    expect(pdfTitle).not.toBe('')
    const pdfRow = page.locator('.lit-row').filter({ hasText: pdfTitle }).first()
    const bibRow = page.locator('.lit-row').filter({ hasText: BIB_TITLE }).first()
    await expect(pdfRow).toBeVisible()
    await expect(bibRow).toBeVisible()

    // 菜单条目与顺序: 查看 PDF / 查看基本信息 | 添加笔记 / 添加附件 | 全览里是删除文献。
    const menu = await openRowMenu(pdfRow)
    await expect(menu.getByRole('menuitem', { name: '查看 PDF', exact: true })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: '查看基本信息', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '添加笔记', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '添加附件', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '删除文献', exact: true })).toBeVisible()
    // 设计系统的分隔线是 <hr>; 隐式 separator 角色不带 role 属性, 按标签数。
    await expect(menu.locator('hr')).toHaveCount(2)
    await expect(menu.locator('svg.lucide-eye')).toHaveCount(1)
    await expect(menu.locator('svg.lucide-paperclip')).toHaveCount(1)
    await shoot(page, runtime, 'row-menu-overview')

    // 没有主附件的条目: 查看 PDF 置灰, 其余动作照常可用。
    await closeRowMenu(page)
    const bareMenu = await openRowMenu(bibRow)
    await expect(bareMenu.getByRole('menuitem', { name: '查看 PDF', exact: true })).toBeDisabled()
    await expect(bareMenu.getByRole('menuitem', { name: '查看基本信息', exact: true })).toBeEnabled()
    await shoot(page, runtime, 'row-menu-without-pdf')

    // 查看基本信息 = 打开详情并停在基本信息页。
    await closeRowMenu(page)
    const infoMenu = await openRowMenu(pdfRow)
    await infoMenu.getByRole('menuitem', { name: '查看基本信息', exact: true }).click()
    await expect(page.getByRole('tab', { name: '基本信息', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await shoot(page, runtime, 'row-menu-info')
    await page.getByLabel('关闭详情', { exact: true }).click()

    // 添加笔记 = 打开详情并直接进入新笔记编辑态。
    const noteMenu = await openRowMenu(pdfRow)
    await noteMenu.getByRole('menuitem', { name: '添加笔记', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^笔记/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByPlaceholder('使用 Markdown 记录阅读笔记')).toBeVisible()
    await shoot(page, runtime, 'row-menu-note')
    await page.getByLabel('关闭详情', { exact: true }).click()

    // 全览里的破坏性动作是删除, 且先确认。
    const deleteMenu = await openRowMenu(bibRow)
    await deleteMenu.getByRole('menuitem', { name: '删除文献', exact: true }).click()
    const confirm = page.getByTestId('literature-row-remove-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('删除文献')
    await expect(confirm).toContainText(BIB_TITLE)
    await shoot(page, runtime, 'row-menu-delete-confirm')
    await confirm.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(bibRow).toHaveCount(0)
    await expect(page.getByText('已删除 1 篇文献', { exact: true })).toBeVisible()
    await expect
      .poll(async () => (await literatures(page, base)).length, { timeout: IMPORT_PARSE_TIMEOUT_MS })
      .toBe(1)

    // ---- 项目文献库: 同一条菜单的最后一项变成「移出项目」 ----
    await openProjectMenu(page)
    await page.getByTestId('project-menu-create').click()
    const projectDialog = page.getByTestId('project-new-modal')
    await projectDialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await projectDialog.getByTestId('project-create').click()
    await expect(projectDialog).toHaveCount(0)
    const projectsResponse = await page.request.get(`${base}/api/content/projects`)
    expect(projectsResponse.ok(), await projectsResponse.text()).toBe(true)
    const projects = await projectsResponse.json()
    const project = projects.projects.find((item: { name: string }) => item.name === PROJECT_NAME)
    expect(project).toBeTruthy()

    await page.getByTestId('project-library').click()
    await page.getByTestId('project-library-content').getByRole('tab', { name: '文献', exact: true }).click()
    await importFiles(page, '选择要导入的 PDF', PROJECT_PDF)
    await dismissImportDialog(page)
    await expect
      .poll(async () => (await literatures(page, base, project.id)).length, {
        timeout: IMPORT_PARSE_TIMEOUT_MS
      })
      .toBe(1)
    const projectEntry = (await literatures(page, base, project.id))[0]
    const projectRow = page.locator('.lit-row').filter({ hasText: projectEntry.title }).first()
    const projectMenu = await openRowMenu(projectRow)
    await expect(projectMenu.getByRole('menuitem', { name: '移出项目', exact: true })).toBeVisible()
    await expect(projectMenu.getByRole('menuitem', { name: '删除文献', exact: true })).toHaveCount(0)
    await shoot(page, runtime, 'row-menu-project')
    await projectMenu.getByRole('menuitem', { name: '移出项目', exact: true }).click()
    const projectConfirm = page.getByTestId('literature-row-remove-confirm')
    await expect(projectConfirm).toContainText('移出项目')
    await shoot(page, runtime, 'row-menu-remove-confirm')
    await projectConfirm.getByRole('button', { name: '确认移出', exact: true }).click()
    await expect(page.getByText('已移出 1 篇文献', { exact: true })).toBeVisible()
    // 移出项目不是删除: 项目里没了, 文献中心里还在。
    await expect
      .poll(async () => (await literatures(page, base, project.id)).length, {
        timeout: IMPORT_PARSE_TIMEOUT_MS
      })
      .toBe(0)
    await expect
      .poll(async () => (await literatures(page, base)).length, { timeout: IMPORT_PARSE_TIMEOUT_MS })
      .toBe(2)

    // ---- 添加附件: 打开详情附件页并唤起选择器 (放最后, 系统对话框可能模态) ----
    await page.getByTestId('activity-literature').click()
    const overviewRow = page.locator('.lit-row').filter({ hasText: pdfTitle }).first()
    await expect(overviewRow).toBeVisible()
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null)
    const attachmentMenu = await openRowMenu(overviewRow)
    await attachmentMenu.getByRole('menuitem', { name: '添加附件', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^附件/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: '上传附件', exact: true })).toBeVisible()
    const picked = await chooser
    await shoot(page, runtime, 'row-menu-attachment')
    if (picked) {
      await picked.setFiles(PROJECT_PDF)
      await expect
        .poll(async () => {
          const detail = await page.request.get(`${base}/api/v1/literatures/${projectEntry.id}`)
          return detail.ok() ? (await detail.json()).attachments.length : -1
        }, { timeout: IMPORT_PARSE_TIMEOUT_MS })
        .toBeGreaterThan(0)
      await shoot(page, runtime, 'row-menu-attachment-uploaded')
    } else {
      // 选择器没被 Playwright 接管 = Electron 弹了系统原生对话框, 这同样是「唤起成功」。
      await testInfo.attach('native-file-chooser', {
        body: Buffer.from('Electron opened the native file chooser; not interceptable.'),
        contentType: 'text/plain'
      })
    }

    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
