import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../src/window'
import { DEFAULT_PROJECT_LAYOUT } from '../src/layout'

import { DesktopSession } from './fixtures/electron'
import { createRuntime, seedSkillHost } from './fixtures/runtime'
import { createReadyProject, projectOption } from './fixtures/projects'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = '面板交互验收'
const DRAFT = '切换面板时保留的未发送草稿'
const METADATA_BIB = join(process.cwd(), 'e2e/fixtures/data/minimal-project/metadata-only.bib')

for (const theme of ['light', 'dark']) {
  test(`project workspace fills remaining space in split and floating modes in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await createReadyProject(page, PROJECT_NAME)
      await page.reload()
      await page.getByTestId('activity-home').click()
      await page.getByTestId(`home-project-${PROJECT_NAME}`).click()
      await page.getByTestId('workspace-open').click()
      const workspace = page.getByTestId('workspace-content')
      const geometry = () => workspace.evaluate(element => {
        const pane = element.getBoundingClientRect()
        const host = element.closest('[data-testid="workspace-floating-area"]')!.getBoundingClientRect()
        const split = element.parentElement!.parentElement!
        return {
          pane: { left: pane.left, right: pane.right, width: pane.width },
          host: { left: host.left, right: host.right, width: host.width },
          panels: [...split.children].map(child => {
            const rect = child.getBoundingClientRect()
            const style = getComputedStyle(child)
            return { left: rect.left, width: rect.width, flex: style.flex, display: style.display }
          }),
        }
      })
      const divider = page.getByTestId('workspace-floating-area').locator(':scope > .vds-resizable-split > button')
      const handle = (await divider.boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + WORKSPACE_WINDOW_SIZE.width - WORKSPACE_WINDOW_MINIMUM.width, handle.y + handle.height / 2)
      await page.mouse.up()
      const conversation = page.getByTestId('workspace-conversation')
      const requestedWidth = (await conversation.boundingBox())!.width
      await page.getByTestId('composer-input').fill(DRAFT)
      for (const mode of ['split', 'floating']) {
        if (mode === 'floating') {
          await page.getByTestId('workspace-conversation-menu').click()
          await page.getByRole('menuitem', { name: '进入悬浮模式', exact: true }).click()
        }
        for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
          await desktop.app!.evaluate(({ BrowserWindow }, dimensions) => {
            BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height)
          }, size)
          await page.mouse.move(0, 0)
          await page.screenshot({ path: join(runtime.artifacts, `workspace-fill-${mode}-${size.width}.png`) })
          writeFileSync(join(runtime.artifacts, `workspace-fill-${mode}-${size.width}.json`), JSON.stringify(await geometry(), null, 2))
          await expect.poll(async () => {
            const { pane, host } = await geometry()
            return Math.abs(pane.right - host.right)
          }).toBeLessThanOrEqual(1)
          if (mode === 'floating') {
            await expect.poll(async () => {
              const { pane, host } = await geometry()
              return Math.abs(pane.left - host.left)
            }).toBeLessThanOrEqual(1)
          }
        }
      }
      await page.getByTestId('project-sidebar-collapse').click()
      await expect.poll(async () => {
        const { pane, host } = await geometry()
        return Math.abs(pane.left - host.left) + Math.abs(pane.right - host.right)
      }).toBeLessThanOrEqual(1)
      await page.screenshot({ path: join(runtime.artifacts, 'workspace-fill-floating-sidebar-hidden.png') })
      await page.getByTestId('project-sidebar-expand').click()
      await page.getByTestId('composer-input').click()
      await page.getByTestId('workspace-conversation-menu').click()
      await page.getByRole('menuitem', { name: '退出悬浮模式', exact: true }).click()
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_SIZE)
      await expect.poll(async () => (await conversation.boundingBox())!.width).toBe(requestedWidth)
      await expect.poll(async () => {
        const { pane, host } = await geometry()
        return Math.abs(pane.right - host.right)
      }).toBeLessThanOrEqual(1)
      await expect(page.getByTestId('composer-input')).toHaveValue(DRAFT)
      await page.screenshot({ path: join(runtime.artifacts, 'workspace-fill-restored.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
      await desktop.close()
    }
  })
}

for (const theme of ['light', 'dark']) {
  test(`project library empty states share artwork and outline actions in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await createReadyProject(page, PROJECT_NAME)
      await page.reload()
      await page.getByTestId('activity-home').click()
      await page.getByTestId(`home-project-${PROJECT_NAME}`).click()
      const notification = page.getByRole('button', { name: '关闭通知', exact: true })
      if (await notification.isVisible()) await notification.click()
      await page.getByTestId('project-library').click()
      await page.getByTestId('workspace-full').click()
      const library = page.getByTestId('project-library-content')
      let artwork = ''
      for (const [tab, title, action] of [
        ['资料', '暂无资料', '新建资料'],
        ['文献', '暂无文献', '添加文献'],
        ['任务产物', '暂无任务产物', ''],
      ]) {
        await library.getByRole('tab', { name: tab, exact: true }).click()
        const empty = library.locator('.vds-empty-state').filter({ hasText: title })
        await expect(empty).toBeVisible()
        const image = empty.locator('img')
        await expect(image).toBeVisible()
        const source = await image.getAttribute('src')
        if (artwork) expect(source).toBe(artwork)
        else artwork = source!
        if (action) {
          const button = empty.getByRole('button', { name: action, exact: true })
          await expect(button).toHaveClass(/border-color:var\(--vds-fill-6\)/)
          if (theme === 'light') await expect(button).toHaveCSS('background-color', 'rgb(255, 255, 255)')
          await button.click()
          await expect(page.getByRole('menu')).toHaveCount(1)
          await page.keyboard.press('Escape')
        } else await expect(empty.getByRole('button')).toHaveCount(0)
        await page.mouse.move(0, 0)
        await page.screenshot({ path: join(runtime.artifacts, `library-empty-${tab}.png`) })
      }
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
      await desktop.close()
    }
  })
}

for (const theme of ['light', 'dark']) {
  test(`project library search collapses with available toolbar space and preserves its query in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await createReadyProject(page, PROJECT_NAME)
      await page.reload()
      await page.getByTestId('activity-home').click()
      await page.getByTestId(`home-project-${PROJECT_NAME}`).click()
      const notification = page.getByRole('button', { name: '关闭通知', exact: true })
      if (await notification.isVisible()) await notification.click()
      await page.getByTestId('workspace-open').click()
      await page.getByTestId('project-library').click()
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_MINIMUM)
      const library = page.getByTestId('project-library-content')
      const divider = page.getByTestId('workspace-floating-area').locator(':scope > .vds-resizable-split > button')
      await expect(divider).toBeVisible()
      const handle = (await divider.boundingBox())!
      const dividerX = handle.x + handle.width / 2
      const dividerY = handle.y + handle.height / 2
      await page.mouse.move(dividerX, dividerY)
      await page.mouse.down()
      await page.mouse.move(dividerX + 240, dividerY, { steps: 8 })
      await page.mouse.up()
      const toolbar = library.getByTestId('project-library-toolbar-actions')
      const materialAdd = toolbar.getByRole('button', { name: '新建资料', exact: true })
      await expect(materialAdd).toBeVisible()
      await expect.poll(() => materialAdd.innerText()).toBe('')
      await expect(materialAdd.locator('svg.lucide-plus')).toBeVisible()
      await expect(materialAdd.locator('svg.lucide-chevron-down')).toBeHidden()
      await materialAdd.hover()
      await expect(page.getByRole('tooltip', { name: '新建资料', exact: true })).toBeVisible()
      await library.getByRole('tab', { name: '文献', exact: true }).click()
      const group = toolbar.getByRole('button', { name: '文献分类', exact: true })
      await expect(group).toHaveCSS('width', '80px')
      const defaultPadding = await group.evaluate(element =>
        `${parseFloat(getComputedStyle(element).getPropertyValue('--vds-space-4'))}px`
      )
      await expect(group).toHaveCSS('padding-left', defaultPadding)
      await expect(group).toHaveCSS('padding-right', defaultPadding)
      await group.hover()
      await expect(page.getByRole('tooltip', { name: '全部文献', exact: true })).toBeVisible()
      const paperAdd = toolbar.getByRole('button', { name: '添加文献', exact: true })
      await expect.poll(() => paperAdd.innerText()).toBe('')
      await expect(paperAdd.locator('svg.lucide-chevron-down')).toBeHidden()
      await paperAdd.hover()
      await expect(page.getByRole('tooltip', { name: '添加文献', exact: true })).toBeVisible()
      await paperAdd.click()
      await expect(page.getByRole('menu')).toHaveCount(1)
      await page.keyboard.press('Escape')
      const searchLabel = '搜索标题、作者、年份'
      const trigger = library.getByRole('button', { name: searchLabel, exact: true })
      await expect(trigger).toBeVisible()
      await expect(library.getByRole('searchbox')).toHaveCount(0)
      await expect(toolbar).toHaveCSS('scrollbar-width', 'none')
      await expect(toolbar).toHaveCSS('overflow-x', 'auto')
      const toolbarLayout = () => toolbar.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll('button')]
          .filter(control => control.getClientRects().length)
          .map(control => {
            const rect = control.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })
        return { height: bounds.height, controls }
      })
      await expect.poll(async () => {
        const { controls } = await toolbarLayout()
        return new Set(controls.map(control => Math.round(control.y + control.height / 2))).size
      }).toBe(1)
      const closedLayout = await toolbarLayout()
      await page.screenshot({ path: join(runtime.artifacts, 'library-search-compact.png') })
      await trigger.click()
      const search = page.getByRole('searchbox', { name: searchLabel, exact: true })
      await expect(search).toBeFocused()
      expect(await toolbarLayout()).toEqual(closedLayout)
      expect(await search.evaluate(element =>
        element.closest('[role="region"]')?.parentElement === document.body
      )).toBe(true)
      await search.fill('Attention')
      await search.press('Escape')
      await expect(search).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await expect(search).toHaveValue('Attention')
      await page.screenshot({ path: join(runtime.artifacts, 'library-search-popover.png') })
      await search.press('Escape')
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_SIZE)
      await page.getByTestId('workspace-full').click()
      await expect(library.getByRole('searchbox')).toHaveValue('Attention')
      await expect(trigger).toHaveCount(0)
      await expect(paperAdd).toHaveText('添加文献')
      await expect(paperAdd.locator('svg.lucide-chevron-down')).toBeVisible()
      await expect.poll(() => group.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(runtime.artifacts, 'library-search-wide.png') })
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_MINIMUM)
      await expect(library.getByRole('searchbox')).toHaveValue('Attention')
      await expect.poll(() => group.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await expect(paperAdd).toHaveText('添加文献')
      await page.screenshot({ path: join(runtime.artifacts, 'library-search-full-minimum.png') })
      await page.getByTestId('workspace-full').click()
      await expect(trigger).toBeVisible()
      const actions = library.getByTestId('project-library-toolbar-actions')
      await expect(actions).toHaveCSS('overflow-x', 'auto')
      await expect(actions).toHaveCSS('scrollbar-width', 'none')
      await expect.poll(() => actions.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      const explorer = library.getByTestId('project-library-explorer')
      const tabs = library.getByRole('tablist')
      const tabsBeforeScroll = (await tabs.boundingBox())!
      const explorerBeforeScroll = (await explorer.boundingBox())!
      await actions.hover()
      await page.mouse.wheel(await actions.evaluate(element => element.scrollWidth), 0)
      await expect.poll(() => actions.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
      await expect.poll(async () => (await explorer.boundingBox())!.x).toBeLessThan(explorerBeforeScroll.x)
      await expect.poll(async () => (await tabs.boundingBox())!.x).toBeLessThan(tabsBeforeScroll.x)
      await trigger.click()
      await expect(search).toHaveValue('Attention')
      await search.fill('')
      await search.press('Escape')
      await expect(trigger).toBeFocused()
      await page.mouse.move(0, 0)
      await page.screenshot({ path: join(runtime.artifacts, 'library-search-minimum.png') })
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
      await desktop.close()
    }
  })
}

test('skills marketplace shares the empty surface and mutations use toast', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  seedSkillHost(runtime)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-skills').click()
    const skills = page.getByTestId('skills-page')
    const empty = skills.getByTestId('skills-empty')
    const search = skills.getByTestId('skills-search')
    await search.fill('e2e-no-such-skill-88483262')
    await expect(empty).toBeVisible({ timeout: 30000 })
    await expect(empty.getByRole('button')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'skills-marketplace-empty.png') })
    await search.fill('')
    await skills.getByTestId('skills-tab-user').click()
    const file = join(runtime.artifacts, 'SKILL.md')
    writeFileSync(file, '---\nname: toast-empty-proof\ndescription: Skill center toast acceptance\n---\n# Toast acceptance\nUse only for the isolated UI acceptance.\n')
    await page.getByTestId('skills-add').click()
    await expect(page.getByTestId('skill-add-modal')).toBeVisible()
    await page.getByTestId('skill-upload-input').setInputFiles(file)
    await page.getByTestId('skill-install').click()
    const installed = '已安装 toast-empty-proof'
    await expect(page.locator('.vds-toast').filter({ hasText: installed })).toBeVisible()
    await expect(skills).not.toContainText(installed)
    const card = page.getByTestId('skill-card-toast-empty-proof')
    await expect(card).toBeVisible({ timeout: 30000 })
    await card.hover()
    await card.getByTestId('skill-more-toast-empty-proof').click()
    await page.getByTestId('skill-remove-toast-empty-proof').click()
    await page.getByTestId('skill-remove-ok').click()
    await expect(card).toHaveCount(0)
    await expect(skills.getByTestId('skills-empty')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'skills-removed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('floating composer keeps its height and dock after literature navigation', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notification = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notification.isVisible()) await notification.click()
    await page.getByTestId('workspace-conversation-menu').click()
    await page.getByRole('menuitem', { name: '进入悬浮模式', exact: true }).click()
    const conversation = page.getByTestId('workspace-conversation')
    const controls = conversation.locator('.vds-ai-composer-host')
    const geometry = async () => {
      const panel = (await conversation.boundingBox())!
      const composer = (await controls.boundingBox())!
      const host = (await page.getByTestId('workspace-floating-area').boundingBox())!
      return {
        extraHeight: Math.round(panel.height - composer.height),
        bottom: Math.round(host.y + host.height - panel.y - panel.height),
        right: Math.round(host.x + host.width - panel.x - panel.width),
      }
    }
    await expect.poll(async () => (await geometry()).extraHeight).toBe(0)
    const initial = await geometry()
    for (const cycle of [1, 2]) {
      await page.getByTestId('activity-literature').click()
      await expect(conversation).toBeHidden()
      await page.getByTestId('activity-home').click()
      await expect(conversation).toBeVisible()
      await expect.poll(geometry).toEqual(initial)
      await expect(conversation).toHaveAttribute('data-floating-dock', 'bottomRight')
      await page.screenshot({ path: join(runtime.artifacts, `floating-return-${cycle}.png`) })
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
    await desktop.close()
  }
})

test('project literature groups create nested entries and confirm deletion', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notification = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notification.isVisible()) await notification.click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('workspace-full').click()
    const library = page.getByTestId('project-library-content')
    await library.getByRole('tab', { name: '文献', exact: true }).click()
    const trigger = library.getByRole('button', { name: '文献分类', exact: true })
    await trigger.click()
    const groups = page.getByTestId('literature-groups')
    await expect(groups.getByText('最近添加', { exact: true })).toHaveCount(0)
    await expect(groups.getByText('管理分类与标签', { exact: true })).toHaveCount(0)
    await groups.getByRole('menuitem', { name: '新建分类', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: '新增分组', exact: true })
    await expect(createDialog).toBeVisible()
    await expect(groups.getByRole('textbox')).toHaveCount(0)
    const input = createDialog.getByRole('textbox', { name: '分组名', exact: true })
    await expect(createDialog.locator('.vds-label__required')).toHaveText('*')
    await expect(input).toHaveAttribute('required', '')
    await expect(createDialog.getByRole('button', { name: '创建', exact: true })).toBeDisabled()
    await expect(input).toHaveAttribute('placeholder', '输入分组名称')
    await input.fill('分组一')
    const rootRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/collections'))
    await createDialog.getByRole('button', { name: '创建', exact: true }).click()
    expect((await rootRequest).postDataJSON().parent_id).toBe('')
    await expect(createDialog).toHaveCount(0)
    const parent = groups.getByTestId('literature-group-row').filter({ hasText: '分组一' })
    await expect(parent).toBeVisible()
    await parent.hover()
    await parent.getByRole('button', { name: '在分组一下新建子分组', exact: true }).click()
    await expect(createDialog).toBeVisible()
    await expect(createDialog.getByRole('combobox')).toHaveCount(0)
    await input.fill('子分组 A')
    const childRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/collections'))
    await input.press('Enter')
    expect((await childRequest).postDataJSON().parent_id).not.toBe('')
    const child = groups.getByRole('menuitemradio', { name: '子分组 A', exact: true })
    await expect(child).toBeVisible()
    const expand = parent.getByRole('button', { name: '展开或收起分组一', exact: true })
    await expand.click()
    await expect(child).toHaveCount(0)
    await expand.click()
    await expect(child).toBeVisible()
    const parentName = parent.getByRole('menuitemradio', { name: '分组一', exact: true })
    await parentName.hover()
    await expect(parentName).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({ path: join(runtime.artifacts, 'literature-groups-tree.png') })
    await child.click()
    await expect(trigger).toContainText('子分组 A')
    await trigger.click()
    await child.hover()
    await expect(child).toBeChecked()
    await expect(child).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({ path: join(runtime.artifacts, 'literature-groups-selected.png') })
    const openDelete = async () => {
      await parent.hover()
      await parent.getByRole('button', { name: '分组一的更多操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '删除分组', exact: true }).click()
    }
    await openDelete()
    await expect(page.getByRole('alertdialog')).toContainText('文献本身不会被删除')
    const covered = await page.getByRole('alertdialog').evaluate(element => {
      const popover = document.querySelector('[data-testid="literature-groups"]')!
      const overlay = element.previousElementSibling!
      const bounds = popover.getBoundingClientRect()
      return {
        overlayAbove: Number(getComputedStyle(overlay).zIndex) > Number(getComputedStyle(popover).zIndex),
        dialogAbove: Number(getComputedStyle(element).zIndex) > Number(getComputedStyle(overlay).zIndex),
        blocksPopover: document.elementFromPoint(bounds.left + 4, bounds.top + 4) === overlay,
      }
    })
    expect(covered).toEqual({ overlayAbove: true, dialogAbove: true, blocksPopover: true })
    await page.screenshot({ path: join(runtime.artifacts, 'literature-groups-delete-confirm.png') })
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
    if (!(await groups.isVisible())) await trigger.click()
    await expect(parent).toBeVisible()
    await openDelete()
    await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect(parent).toHaveCount(0)
    await expect(trigger).toContainText('全部文献')
    if (!(await groups.isVisible())) await trigger.click()
    await groups.getByRole('menuitem', { name: '新建分类', exact: true }).click()
    await expect(createDialog).toBeVisible()
    await input.fill('最外层分组')
    await expect(createDialog.getByRole('button', { name: '创建', exact: true })).toBeEnabled()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-groups-create.png') })
    await createDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(createDialog).toHaveCount(0)
    await expect(groups.getByRole('textbox')).toHaveCount(0)
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('project literature selection actions share the toolbar and group add destinations', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const projectDialog = page.getByTestId('project-new-modal')
    await projectDialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await projectDialog.getByTestId('project-create').click()
    await expect(projectDialog).toHaveCount(0)
    const closeNotification = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await closeNotification.isVisible()) await closeNotification.click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('workspace-full').click()
    const library = page.getByTestId('project-library-content')
    await library.getByRole('tab', { name: '文献', exact: true }).click()
    await page.getByLabel('选择要导入的 Bib 或 RIS 文件', { exact: true }).setInputFiles(METADATA_BIB)
    const row = library.locator('.lit-row').filter({ hasText: 'Row Menu Metadata Only Entry' })
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    const addTag = row.getByRole('button', { name: '添加标签', exact: true })
    await expect(addTag).toBeVisible()
    await addTag.click()
    const tagPicker = page.getByTestId('literature-tag-picker')
    const newTag = tagPicker.getByRole('textbox', { name: '新标签，回车添加', exact: true })
    await expect(newTag).toHaveCount(0)
    await tagPicker.getByRole('button', { name: '新建标签', exact: true }).click()
    await expect(newTag).toHaveAttribute('maxlength', '10')
    await newTag.fill('方法')
    await newTag.press('Enter')
    await expect(tagPicker.getByRole('menuitemcheckbox', { name: '方法', exact: true })).toBeChecked()
    await expect(row.locator('.vds-tag')).toContainText('方法')
    await tagPicker.getByRole('button', { name: '新建标签', exact: true }).click()
    await newTag.fill('aaa')
    await newTag.press('Enter')
    await expect(tagPicker.getByRole('menuitemcheckbox', { name: 'aaa', exact: true })).toBeChecked()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-tag-options.png') })
    await tagPicker.getByRole('button', { name: '新建标签', exact: true }).click()
    await newTag.fill('一二三四五六七八九十')
    await expect(tagPicker).toContainText('10/10')
    await page.screenshot({ path: join(runtime.artifacts, 'literature-tag-create.png') })
    const firstTagText = row.locator('.vds-tag > span').first()
    await expect.poll(() => firstTagText.evaluate(element => element.clientWidth >= element.scrollWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await addTag.scrollIntoViewIfNeeded()
    await addTag.hover()
    await row.locator('.vds-tag').scrollIntoViewIfNeeded()
    await expect(firstTagText).toBeInViewport({ ratio: 1 })
    await expect.poll(() => row.getByTestId('literature-row-tags').evaluate(element => {
      const tag = element.querySelector('.vds-tag')!.getBoundingClientRect()
      const add = element.querySelector('[aria-expanded]')!.getBoundingClientRect()
      return Math.abs(tag.y + tag.height / 2 - add.y - add.height / 2) <= 1
    })).toBe(true)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-first-tag-multiple.png') })
    const hoverHeight = (await row.boundingBox())!.height
    await library.getByRole('tab', { name: '文献', exact: true }).focus()
    await library.getByRole('tab', { name: '文献', exact: true }).hover()
    expect(await row.evaluate(element => ({
      hover: element.matches(':hover'),
      focus: element.matches(':focus-within')
    }))).toEqual({ hover: false, focus: false })
    await expect(row.getByRole('button', { name: '移除标签' })).toHaveCount(0)
    await expect(addTag).toHaveCSS('opacity', '1')
    await expect(addTag.locator('..')).toHaveCSS('opacity', '0')
    expect((await row.boundingBox())!.height).toBe(hoverHeight)
    await page.screenshot({ path: join(runtime.artifacts, 'literature-tags-default.png') })
    const tagCell = row.getByTestId('literature-row-tags')
    const wideTagWidth = (await tagCell.boundingBox())!.width
    expect(wideTagWidth).toBeGreaterThanOrEqual(110)
    expect(await tagCell.evaluate(element => element.clientWidth >= element.scrollWidth)).toBe(true)
    expect(await tagCell.evaluate(element => {
      const tag = element.querySelector('.vds-tag')!.getBoundingClientRect()
      const count = element.querySelector('.vds-badge')!.getBoundingClientRect()
      return count.left - tag.right
    })).toBeLessThanOrEqual(8)
    const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.setViewportSize({ width: 1040, height: 840 })
    await expect.poll(async () => (await tagCell.boundingBox())!.width).toBe(wideTagWidth)
    await addTag.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-tags-narrow.png') })
    await page.setViewportSize(originalViewport)
    await row.hover()
    await addTag.click()
    await tagPicker.getByRole('menuitemcheckbox', { name: 'aaa', exact: true }).click()
    await expect(tagPicker.getByRole('menuitemcheckbox', { name: 'aaa', exact: true })).not.toBeChecked()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-row-tag-picker.png') })
    await page.keyboard.press('Escape')
    await expect(tagPicker).toHaveCount(0)
    await row.hover()
    const removeTag = row.getByRole('button', { name: '移除标签', exact: true })
    await expect(removeTag).toBeVisible()
    await addTag.scrollIntoViewIfNeeded()
    await expect(addTag).toBeInViewport()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-row-tag-hover.png') })
    await removeTag.click()
    await expect(row.locator('.vds-tag')).toHaveCount(0)
    await addTag.click()
    await expect(tagPicker.getByRole('menuitemcheckbox', { name: '方法', exact: true })).not.toBeChecked()
    await tagPicker.getByRole('menuitemcheckbox', { name: '方法', exact: true }).click()
    await expect(tagPicker.getByRole('menuitemcheckbox', { name: '方法', exact: true })).toBeChecked()
    await page.keyboard.press('Escape')
    await row.getByRole('checkbox').click()
    const actions = page.getByTestId('literature-selection-toolbar')
    await expect(actions).toBeVisible()
    await expect(library.getByRole('button', { name: '项目资源管理器', exact: true })).toHaveCount(0)
    await expect(actions.getByRole('button', { name: '删除', exact: true })).toBeVisible()
    await actions.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toContainText('移出项目')
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
    const tabs = (await library.getByRole('tablist').boundingBox())!
    const bar = (await actions.boundingBox())!
    expect(Math.abs(tabs.y + tabs.height / 2 - bar.y - bar.height / 2)).toBeLessThan(2)
    await expect(actions.getByRole('button', { name: '加入我的分类', exact: true })).toHaveCount(0)
    await expect(actions.getByRole('button', { name: '加入标签', exact: true })).toHaveCount(0)
    await actions.getByRole('button', { name: '添加到', exact: true }).click()
    const groupsDestination = page.getByRole('menuitem', { name: '我的分组', exact: true })
    const tagsDestination = page.getByRole('menuitem', { name: '标签', exact: true })
    await expect(groupsDestination).toBeVisible()
    await expect(tagsDestination).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-selection-add-to.png') })
    await tagsDestination.click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: '标签', exact: true })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    await actions.getByRole('button', { name: '添加到', exact: true }).click()
    await groupsDestination.click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: '我的分组', exact: true })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-selection-toolbar.png') })
    await actions.getByRole('button', { name: '取消', exact: true }).click()
    await expect(actions).toHaveCount(0)
    await expect(library.getByRole('button', { name: '项目资源管理器', exact: true })).toBeVisible()
    await expect(library.getByRole('searchbox')).toBeVisible()
    await row.click()
    const detailTags = page.getByRole('tabpanel', { name: '基本信息', exact: true })
    await detailTags.getByRole('button', { name: '添加标签', exact: true }).click()
    await expect(page.getByTestId('literature-tag-picker').getByRole('menuitemcheckbox', { name: '方法', exact: true })).toBeChecked()
    await page.screenshot({ path: join(runtime.artifacts, 'literature-detail-shared-tags.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '关闭详情', exact: true }).click()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('workspace header blank space drags the window without capturing controls', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notificationClose.isVisible()) await notificationClose.click()
    await page.getByTestId('project-library').click()
    const content = page.getByTestId('workspace-content')
    const header = content.locator(':scope > header')
    const tabs = header.locator(':scope > div').filter({ has: page.getByRole('tablist') })
    await expect(header).toHaveCSS('-webkit-app-region', 'drag')
    await expect(tabs).toHaveCSS('-webkit-app-region', 'drag')
    for (const button of await header.getByRole('button').all()) {
      await expect(button).toHaveCSS('-webkit-app-region', 'no-drag')
    }
    await content.getByTestId('workspace-new-tab').click()
    await expect(content.getByTestId('project-new-tab')).toBeVisible()
    const initialWidth = (await content.boundingBox())!.width
    await content.getByTestId('workspace-full').click()
    await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThan(initialWidth)
    await content.getByTestId('workspace-full').click()
    await expect.poll(async () => (await content.boundingBox())!.width).toBeCloseTo(initialWidth, 0)
    await page.screenshot({ path: join(runtime.artifacts, 'workspace-header-drag.png') })
    await content.getByTestId('workspace-close').click()
    await expect(content).toBeHidden()
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

for (const theme of ['light', 'dark']) {
  test(`floating composer keeps focus, menus and dragging in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferencesPath, JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await page.getByTestId('activity-home').click()
      await page.getByTestId('home-project-create-top').click()
      const dialog = page.getByTestId('project-new-modal')
      await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
      await dialog.getByTestId('project-create').click()
      await expect(dialog).toHaveCount(0)
      const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
      if (await notificationClose.isVisible()) await notificationClose.click()
      await page.getByTestId('workspace-conversation-menu').click()
      await page.getByRole('menuitem', { name: '进入悬浮模式' }).click()
      const panel = page.getByTestId('workspace-conversation')
      const input = panel.getByTestId('composer-input')
      const header = panel.getByTestId('workspace-drag-handle')
      await page.getByTestId('workspace-new-tab').click()
      await expect(panel).toHaveAttribute('data-floating-active', 'false')
      await expect(page.locator('[data-testid="project-new-tab"]:visible')).toBeVisible()
      await expect(page.getByTestId('workbench-overview')).toHaveCount(0)
      await expect(header).toHaveAttribute('inert', '')
      await expect(panel.getByTestId('ai-stream')).toBeHidden()
      expect((await panel.boundingBox())!.width).toBeCloseTo(388, 0)
      expect((await panel.getByTestId('composer-drop-zone').boundingBox())!.width).toBeCloseTo(388, 0)
      expect((await panel.getByTestId('composer-drop-zone').boundingBox())!.height).toBeCloseTo(56, 0)
      await page.screenshot({ path: join(runtime.artifacts, 'floating-idle.png') })
      await panel.screenshot({ path: join(runtime.artifacts, 'floating-slim-idle-detail.png') })
      await input.fill(DRAFT)
      await expect(header).toBeVisible()
      await input.fill('简短输入')
      const singleLineHeight = (await input.boundingBox())!.height
      const multilineDraft = ['第一行：说明研究目标', '第二行：补充分析范围', '第三行：列出验收要求'].join('\n')
      await input.fill(multilineDraft)
      await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(singleLineHeight)
      await expect.poll(() => input.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
      const toolbar = panel.getByTestId('composer-toolbar')
      await expect.poll(async () => {
        const editorBounds = (await input.boundingBox())!
        return (await toolbar.boundingBox())!.y >= editorBounds.y + editorBounds.height
      }).toBe(true)
      await page.screenshot({ path: join(runtime.artifacts, 'floating-multiline.png') })
      await input.fill(Array.from({ length: 30 }, (_, index) => `第${index + 1}行：长文本仍可编辑`).join('\n'))
      await expect(input).toHaveCSS('overflow-y', 'auto')
      await expect.poll(() => input.evaluate(element => {
        const style = getComputedStyle(element)
        return (element.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)) / Number.parseFloat(style.lineHeight)
      })).toBe(10)
      await input.evaluate(element => { element.scrollTop = 0 })
      await expect(panel.getByTestId('composer-fade-bottom')).toBeVisible()
      await expect(panel.getByTestId('composer-fade-top')).toHaveCount(0)
      await input.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(panel.getByTestId('composer-fade-bottom')).toHaveCount(0)
      await expect(panel.getByTestId('composer-fade-top')).toBeVisible()
      await input.fill('自动换行内容。'.repeat(8))
      await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(singleLineHeight)
      await input.fill('简短输入')
      await expect.poll(async () => (await input.boundingBox())!.height).toBe(singleLineHeight)
      await expect(input).toHaveCSS('overflow-y', 'hidden')
      await expect(toolbar).toHaveCSS('display', 'contents')
      await input.fill('')
      await expect.poll(async () => (await input.boundingBox())!.height).toBe(singleLineHeight)
      await input.fill(DRAFT)
      await expect(panel).toHaveAttribute('data-floating-active', 'true')
      await expect(panel.getByTestId('ai-session-title')).toBeVisible()
      await expect(panel.getByTestId('ai-session-title')).toHaveCSS('font-weight', '400')
      await expect(header.getByRole('button')).toHaveCount(3)
      for (const [trigger, menu] of [
        ['composer-plus', 'composer-plus-menu'],
        ['mode-chip', 'mode-menu'],
        ['model-selector-toggle', 'model-selector-menu'],
      ]) {
        await panel.getByTestId(trigger).click()
        await expect(page.getByTestId(menu)).toBeVisible()
        await expect(header).toBeVisible()
        await page.getByTestId(menu).click({ position: { x: 8, y: 8 } })
        await expect(header).toBeVisible()
        await page.keyboard.press('Escape')
      }
      await input.focus()
      await page.screenshot({ path: join(runtime.artifacts, 'floating-active.png') })
      await panel.screenshot({ path: join(runtime.artifacts, 'floating-slim-active-detail.png') })
      const toggleContent = panel.getByTestId('floating-conversation-toggle')
      const inputBeforeExpansion = (await input.boundingBox())!
      await toggleContent.click()
      await expect(toggleContent).toHaveAttribute('aria-expanded', 'true')
      await expect(panel.getByTestId('ai-stream')).toBeVisible()
      await expect(panel.locator('[data-testid^="ai-task-starter-"]').first()).toBeVisible()
      expect(Math.abs((await input.boundingBox())!.x - inputBeforeExpansion.x)).toBeLessThanOrEqual(1)
      expect((await input.boundingBox())!.y).toBeCloseTo(inputBeforeExpansion.y, 0)
      await page.screenshot({ path: join(runtime.artifacts, 'floating-new-conversation-expanded.png') })
      await toggleContent.click()
      await expect(toggleContent).toHaveAttribute('aria-expanded', 'false')
      await expect(panel.getByTestId('ai-stream')).toBeHidden()
      expect((await input.boundingBox())!.y).toBeCloseTo(inputBeforeExpansion.y, 0)
      await toggleContent.press('Enter')
      await expect(toggleContent).toHaveAttribute('aria-expanded', 'true')
      await toggleContent.press('Enter')
      await expect(toggleContent).toHaveAttribute('aria-expanded', 'false')
      await expect(input).toHaveValue(DRAFT)
      const before = (await panel.boundingBox())!
      const title = (await panel.getByTestId('ai-session-title').boundingBox())!
      await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2)
      await page.mouse.down()
      await page.mouse.move(title.x - 100, title.y - 80, { steps: 8 })
      await page.mouse.up()
      expect((await panel.boundingBox())!.x).toBeCloseTo(before.x, 0)
      expect((await panel.boundingBox())!.y).toBeCloseTo(before.y, 0)
      const inputBounds = (await input.boundingBox())!
      await page.mouse.move(inputBounds.x + inputBounds.width / 2, inputBounds.y + inputBounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(inputBounds.x - 100, inputBounds.y - 80, { steps: 8 })
      await page.mouse.up()
      expect((await panel.boundingBox())!.x).toBeCloseTo(before.x, 0)
      expect((await panel.boundingBox())!.y).toBeCloseTo(before.y, 0)
      const area = (await page.getByTestId('workspace-floating-area').boundingBox())!
      for (const dock of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'bottomCenter']) {
        await input.focus()
        const handle = (await panel.locator('[data-workspace-drag-handle]').boundingBox())!
        const current = (await panel.boundingBox())!
        const targetLeft = dock.endsWith('Left') ? area.x + 16 : dock.endsWith('Right')
          ? area.x + area.width - current.width - 16 : area.x + (area.width - current.width) / 2
        const targetTop = dock.startsWith('top') ? area.y + 100 : area.y + area.height - current.height - 16
        const offsetX = handle.x + handle.width / 2 - current.x
        const offsetY = handle.y + handle.height / 2 - current.y
        await page.mouse.move(current.x + offsetX, current.y + offsetY)
        await page.mouse.down()
        await page.mouse.move(targetLeft + offsetX, targetTop + offsetY, { steps: 8 })
        await page.mouse.up()
        await expect(page.getByTestId('floating-conversation-menu')).toHaveCount(0)
        await expect(panel).toHaveAttribute('data-floating-dock', dock)
        const after = (await panel.boundingBox())!
        expect(after.x).toBeCloseTo(targetLeft, 0)
        expect(after.y).toBeCloseTo(targetTop, 0)
        expect((await header.boundingBox())!.y).toBeGreaterThanOrEqual(area.y)
        await page.screenshot({ path: join(runtime.artifacts, `floating-dock-${dock}.png`) })
        await panel.getByTestId('workspace-conversation-menu').click()
        await page.getByTestId('floating-conversation-menu').getByRole('menuitem', { name: '最小化任务入口' }).click()
        const restore = page.getByTestId('workspace-restore-conversation')
        await expect(panel).toBeHidden()
        const minimizedBounds = (await restore.boundingBox())!
        const minimizedLeft = dock.endsWith('Left') ? area.x + 16 : dock.endsWith('Right')
          ? area.x + area.width - minimizedBounds.width - 16
          : area.x + (area.width - minimizedBounds.width) / 2
        expect(minimizedBounds.x).toBeCloseTo(minimizedLeft, 0)
        expect(minimizedBounds.y).toBeCloseTo(dock.startsWith('top')
          ? area.y + 64 : area.y + area.height - minimizedBounds.height - 16, 0)
        await restore.click()
        await input.focus()
        await expect.poll(async () => (await panel.boundingBox())!.x).toBeCloseTo(after.x, 0)
        await expect.poll(async () => (await panel.boundingBox())!.y).toBeCloseTo(after.y, 0)
        await expect(input).toHaveValue(DRAFT)
        await desktop.app!.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
        }, WORKSPACE_WINDOW_MINIMUM)
        await expect.poll(async () => {
          const resizedArea = (await page.getByTestId('workspace-floating-area').boundingBox())!
          const resizedPanel = (await panel.boundingBox())!
          const expectedLeft = dock.endsWith('Left') ? resizedArea.x + 16 : dock.endsWith('Right')
            ? resizedArea.x + resizedArea.width - resizedPanel.width - 16
            : resizedArea.x + (resizedArea.width - resizedPanel.width) / 2
          return Math.abs(resizedPanel.x - expectedLeft)
        }).toBeLessThan(1)
        await expect(panel).toHaveAttribute('data-floating-dock', dock)
        const resizedHeader = (await header.boundingBox())!
        const resizedArea = (await page.getByTestId('workspace-floating-area').boundingBox())!
        expect(resizedHeader.y).toBeGreaterThanOrEqual(resizedArea.y)
        await page.screenshot({ path: join(runtime.artifacts, `floating-dock-${dock}-minimum.png`) })
        await desktop.app!.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
        }, WORKSPACE_WINDOW_SIZE)
        await expect.poll(async () => (await panel.boundingBox())!.x).toBeCloseTo(targetLeft, 0)
      }
      await expect(input).toHaveValue(DRAFT)
      await panel.getByTestId('workspace-conversation-menu').click()
      const floatingMenu = page.getByTestId('floating-conversation-menu')
      await expect(floatingMenu.getByRole('menuitem')).toHaveText([
        '移至右侧面板', '移至左侧面板', '最小化任务入口', '退出悬浮模式',
      ])
      await expect(header).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, 'floating-layout-menu.png') })
      await page.keyboard.press('Escape')
      await panel.getByTestId('workspace-conversation-menu').click()
      await floatingMenu.getByRole('menuitem', { name: '退出悬浮模式' }).click()
      await expect(panel).toHaveAttribute('data-mode', 'split')
      await expect(input).toHaveValue(DRAFT)
      await panel.getByTestId('workspace-conversation-menu').click()
      await page.getByRole('menuitem', { name: '进入悬浮模式' }).click()
      await expect(panel).toHaveAttribute('data-mode', 'floating')
      await input.focus()
      await panel.getByTestId('workspace-conversation-menu').click()
      await floatingMenu.getByRole('menuitem', { name: '最小化任务入口' }).click()
      await expect(panel).toBeHidden()
      await page.getByTestId('workspace-restore-conversation').click()
      await input.focus()
      await expect(input).toHaveValue(DRAFT)
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
      }, WORKSPACE_WINDOW_MINIMUM)
      await page.screenshot({ path: join(runtime.artifacts, 'floating-minimum.png') })
      await page.getByTestId('workspace-new-tab').click()
      await expect(header).toHaveAttribute('inert', '')
      await expect(input).toHaveValue(DRAFT)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}

test('project file toolbar stays in one row across categories', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const closeNotification = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await closeNotification.isVisible()) await closeNotification.click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('workspace-full').click()
    const library = page.getByTestId('project-library-content')
    const toolbar = library.getByRole('tablist').locator('..')
    await toolbar.getByRole('button', { name: '新建资料' }).click()
    await page.getByRole('menuitem', { name: '新建文件夹' }).click()
    await page.getByTestId('resource-name-input').fill('评测数据')
    await page.getByTestId('resource-name-input').press('Enter')
    const folderRow = library.getByRole('row').filter({ hasText: '评测数据' })
    await expect(folderRow).toBeVisible()
    await toolbar.getByRole('button', { name: '新建资料' }).focus()
    await toolbar.getByRole('button', { name: '新建资料' }).hover()
    await expect(folderRow.getByRole('cell').nth(4).locator('div')).toHaveCSS('opacity', '0')
    await page.screenshot({ path: join(runtime.artifacts, 'material-actions-default.png') })
    await folderRow.hover()
    const cells = folderRow.getByRole('cell')
    await expect(cells).toHaveCount(5)
    const actions = cells.nth(4)
    await expect(actions.locator('div')).toHaveCSS('opacity', '1')
    await expect(actions.getByRole('button')).toHaveCount(2)
    for (const button of await actions.getByRole('button').all()) {
      await expect(button).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    for (const [index, filename] of [[0, 'create'], [1, 'more']] as const) {
      const button = actions.getByRole('button').nth(index)
      await button.click()
      await page.getByRole('menu').hover()
      await expect(button).toHaveAttribute('aria-expanded', 'true')
      await expect(button).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(actions.locator('div')).toHaveCSS('opacity', '1')
      await page.screenshot({ path: join(runtime.artifacts, `material-${filename}-open.png`) })
      await page.keyboard.press('Escape')
      await expect(button).toHaveAttribute('aria-expanded', 'false')
    }
    const tertiary = await library.getByRole('columnheader', { name: '更新时间' }).evaluate((element) => getComputedStyle(element).color)
    for (const index of [1, 2, 3]) await expect(cells.nth(index)).toHaveCSS('color', tertiary)
    expect((await actions.boundingBox())!.x).toBeGreaterThan((await cells.nth(3).boundingBox())!.x)
    const typeFilter = library.getByRole('button', { name: '类型', exact: true })
    const funnel = typeFilter.locator('svg.lucide-funnel')
    const defaultFilterColor = await funnel.evaluate((element) => getComputedStyle(element).color)
    await typeFilter.click()
    const allTypes = page.getByRole('menuitemradio', { name: '全部', exact: true })
    await expect(allTypes).toHaveAttribute('aria-checked', 'true')
    await expect(allTypes.locator('svg.lucide-check')).toBeVisible()
    await page.getByRole('menuitemradio', { name: '文件夹', exact: true }).click()
    await expect(funnel).not.toHaveCSS('color', defaultFilterColor)
    await typeFilter.click()
    const selectedType = page.getByRole('menuitemradio', { name: '文件夹', exact: true })
    await expect(selectedType).toHaveAttribute('aria-checked', 'true')
    await expect(selectedType.locator('svg.lucide-check')).toBeVisible()
    await expect(allTypes.locator('svg.lucide-check')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'material-filter-selected.png') })
    await allTypes.click()
    await expect(funnel).toHaveCSS('color', defaultFilterColor)
    await actions.getByRole('button').first().click()
    await page.getByRole('menuitem', { name: '新建md文档' }).click()
    await page.getByTestId('resource-name-input').fill('123')
    const creation = page.waitForRequest((request) => request.url().includes('/api/resource/node') && request.method() === 'POST')
    await page.getByTestId('resource-name-input').press('Enter')
    expect((await creation).postDataJSON().parent).toBe('resources/评测数据')
    await expect(page.getByRole('tab', { name: /123.md/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('workspace-content').getByRole('tab', { name: /项目文件/ }).first().click()
    const createdFile = library.getByTestId('material-resources/评测数据/123.md')
    await expect(createdFile).toBeVisible()
    await expect(library.getByTestId('material-resources/123.md')).toHaveCount(0)
    const folder = folderRow.getByRole('button', { name: '评测数据', exact: true })
    await folder.click()
    await expect(folder).toHaveAttribute('aria-expanded', 'false')
    await expect(createdFile).toHaveCount(0)
    await folder.click()
    await expect(folder).toHaveAttribute('aria-expanded', 'true')
    await expect(createdFile).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'material-nested-created.png') })
    for (const [category, search, filename] of [
      ['资料', '搜索文件', 'materials'],
      ['文献', '搜索标题、作者、年份', 'literature'],
      ['任务产物', '搜索任务或产物文件', 'outputs'],
    ]) {
      await library.getByRole('tab', { name: category, exact: true }).click()
      await expect(toolbar.getByRole('searchbox', { name: search })).toBeVisible()
      await expect(library.getByRole('tabpanel').getByRole('searchbox')).toHaveCount(0)
      await expect(toolbar).toHaveCSS('flex-wrap', 'nowrap')
      await expect(toolbar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(library.getByRole('tabpanel').getByRole('status')).toHaveCount(0)
      const searchBounds = (await toolbar.getByRole('searchbox', { name: search }).boundingBox())!
      const listBounds = (await library.getByRole('tablist').boundingBox())!
      expect(Math.abs(searchBounds.y + searchBounds.height / 2 - listBounds.y - listBounds.height / 2)).toBeLessThan(2)
      if (category === '资料') await folderRow.hover()
      if (category === '任务产物') {
        const outputs = library.getByTestId('project-outputs')
        await expect(outputs.getByText('暂无任务产物')).toBeVisible()
        for (let sample = 0; sample < 6; sample++) {
          await page.waitForTimeout(1000)
          await expect(outputs.getByRole('status')).toHaveCount(0)
          await expect(outputs.getByText('暂无任务产物')).toBeVisible()
        }
        await toolbar.getByRole('button', { name: '刷新资料库', exact: true }).click()
        await expect(outputs.getByText('暂无任务产物')).toBeVisible()
        await expect(outputs.getByRole('status')).toHaveCount(0)
      }
      await page.screenshot({ path: join(runtime.artifacts, `toolbar-${filename}.png`) })
    }
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('closing the final workspace tab collapses the panel without the removed menu', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notificationClose.isVisible()) await notificationClose.click()
    await page.getByTestId('workspace-open').click()
    const content = page.getByTestId('workspace-content')
    await expect(content).toBeVisible()
    await expect(page.getByTestId('workbench-add-tab')).toHaveCount(0)
    await content.getByTestId('workspace-new-tab').click()
    const closeTab = content.getByRole('button', { name: '关闭 新标签页', exact: true })
    await expect(content.getByRole('tab', { name: /^新标签页/ })).toHaveCount(2)
    await content.getByRole('tab', { selected: true }).getByRole('button', { name: '关闭 新标签页', exact: true }).click()
    await expect(content).toBeVisible()
    await closeTab.click()
    await expect(content).toBeHidden()
    await expect(page.getByTestId('workspace-open')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'last-tab-collapsed.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

for (const theme of ['light', 'dark']) {
  test(`active tab curves have no protruding edges in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(preferencesPath, JSON.stringify({
      ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme,
    }))
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await createReadyProject(page, PROJECT_NAME)
      await page.reload()
      await page.getByTestId('activity-home').click()
      await page.getByTestId(`home-project-${PROJECT_NAME}`).click()
      await page.getByTestId('workspace-open').click()
      const content = page.getByTestId('workspace-content')
      await content.getByTestId('workspace-new-tab').click()
      const samples: unknown[] = []
      for (const mode of ['split', 'floating']) {
        if (mode === 'floating') {
          await page.getByTestId('workspace-conversation-menu').click()
          await page.getByRole('menuitem', { name: '进入悬浮模式', exact: true }).click()
        }
        for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
          await desktop.app!.evaluate(({ BrowserWindow }, dimensions) => {
            BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height)
          }, size)
          const tabs = content.getByRole('tab')
          await expect(tabs).toHaveCount(mode === 'floating' ? 3 : 2)
          for (const tab of await tabs.all()) {
            await tab.click()
            await expect(tab).toHaveAttribute('aria-selected', 'true')
            await expect(content.getByRole('tab', { selected: true })).toHaveCount(1)
            const geometry = await tab.evaluate((element) => {
              const decorations = [...element.querySelectorAll('[data-slot="navigation-tab-left-foot"], [data-slot="navigation-tab-right-foot"]')]
              return {
                tab: element.getBoundingClientRect().bottom,
                header: element.closest('header')!.getBoundingClientRect().bottom,
                feet: decorations.map((foot) => foot.getBoundingClientRect().bottom),
              }
            })
            samples.push({ mode, width: size.width, geometry })
            writeFileSync(join(runtime.artifacts, 'tab-geometry.json'), JSON.stringify(samples, null, 2))
            expect(geometry.tab).toBe(geometry.header)
            expect(geometry.feet).toEqual([geometry.header, geometry.header])
          }
          if (mode === 'floating') {
            await page.mouse.move(400, 300)
            const bounds = (await tabs.last().boundingBox())!
            await page.screenshot({
              path: join(runtime.artifacts, `tab-curves-${theme}-${size.width}.png`),
              clip: { x: bounds.x - 20, y: bounds.y, width: bounds.width + 40, height: bounds.height + 8 },
            })
            await page.screenshot({
              path: join(runtime.artifacts, `tab-workspace-${theme}-${size.width}.png`),
            })
          }
        }
      }
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test(`empty workspace collapses after restore and project switches in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    const preferences = () => JSON.parse(readFileSync(preferencesPath, 'utf8'))
    writeFileSync(preferencesPath, JSON.stringify({ ...preferences(), theme }))
    const desktop = new DesktopSession(runtime, testInfo, { preserveNavigation: true })
    try {
      let page = await desktop.launch()
      const skip = page.getByTestId('landing-skip')
      if (await skip.isVisible()) await skip.click()
      const projects: { name: string; id: string }[] = []
      for (const name of [`${PROJECT_NAME}-空页签`, `${PROJECT_NAME}-空页签切换`]) {
        if (projects.length === 0) {
          await page.getByTestId('activity-home').click()
          await page.getByTestId('home-project-create-top').click()
        } else {
          await page.getByTestId('project-navigation-selector').click()
          await page.getByTestId('project-menu-create').click()
        }
        const dialog = page.getByTestId('project-new-modal')
        await dialog.getByTestId('project-create-name').fill(name)
        await dialog.getByTestId('project-create').click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(() => {
          const id = preferences().lastLocation?.projectId
          return typeof id === 'string' && id !== projects.at(-1)?.id
        }).toBe(true)
        projects.push({ name, id: preferences().lastLocation.projectId })
      }
      await desktop.close()
      for (const [full, size] of [
        [false, WORKSPACE_WINDOW_SIZE],
        [true, WORKSPACE_WINDOW_MINIMUM],
      ] as const) {
        const saved = preferences()
        writeFileSync(preferencesPath, JSON.stringify({
          ...saved,
          projectLayouts: {
            ...saved.projectLayouts,
            ...Object.fromEntries(projects.map(({ id }) => [
              id, { ...DEFAULT_PROJECT_LAYOUT, open: true, full },
            ])),
          },
        }))
        page = await desktop.launch()
        await expect(page.getByTestId('project-workspace')).toBeVisible()
        const content = page.getByTestId('workspace-content')
        await expect(content).toBeHidden()
        await page.getByTestId('composer-input').fill(DRAFT)
        await page.getByTestId('workspace-open').click()
        await expect(content.getByRole('tab', { name: /^新标签页/ })).toBeVisible()
        await content.getByRole('button', { name: '关闭 新标签页', exact: true }).click()
        await expect(content).toBeHidden()
        await expect(page.getByTestId('composer-input')).toHaveValue(DRAFT)
        await desktop.app!.evaluate(({ BrowserWindow }, dimensions) => {
          BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height)
        }, size)
        for (const project of projects) {
          await page.getByTestId('project-navigation-selector').click()
          await projectOption(page, project.name).click()
          await expect(page.getByTestId('project-workspace')).toBeVisible()
          await expect(content).toBeHidden()
          await expect(page.getByTestId('workspace-open')).toBeVisible()
          await expect.poll(() => preferences().projectLayouts[project.id].open).toBe(false)
        }
        await page.screenshot({
          path: join(runtime.artifacts, `empty-workspace-${theme}-${size.width}.png`),
        })
        desktop.assertNoPageErrors()
        await desktop.close()
      }
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test(`entering floating mode creates only a missing workspace tab in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(
      preferencesPath,
      JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme })
    )
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await page.getByTestId('activity-home').click()
      await page.getByTestId('home-project-create-top').click()
      const dialog = page.getByTestId('project-new-modal')
      await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
      await dialog.getByTestId('project-create').click()
      await expect(dialog).toHaveCount(0)
      const closeNotification = page.getByRole('button', { name: '关闭通知', exact: true })
      if (await closeNotification.isVisible()) await closeNotification.click()
      const content = page.getByTestId('workspace-content')
      const conversation = page.getByTestId('workspace-conversation')
      const input = page.getByTestId('composer-input')
      const newTab = content.getByRole('tab', { name: /^新标签页/ })
      const closeTab = content.getByRole('button', { name: '关闭 新标签页', exact: true })
      await input.fill(DRAFT)
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await desktop.app!.evaluate(({ BrowserWindow }, dimensions) => {
          BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height)
        }, size)
        await expect(content).toBeHidden()
        await page.getByTestId('workspace-conversation-menu').click()
        await page.getByRole('menuitem', { name: '进入悬浮模式', exact: true }).click()
        await expect(conversation).toHaveAttribute('data-mode', 'floating')
        await expect(newTab).toHaveCount(1)
        await expect(newTab).toHaveAttribute('aria-selected', 'true')
        await expect(input).toHaveValue(DRAFT)
        await page.screenshot({ path: join(runtime.artifacts, `floating-new-tab-${theme}-${size.width}.png`) })
        const taskTab = content.getByTestId('workspace-task-tab')
        await taskTab.click()
        await expect(taskTab).toHaveAttribute('role', 'tab')
        await expect(taskTab).toHaveAttribute('aria-selected', 'true')
        await expect(taskTab).toHaveAttribute('data-state', 'active')
        await expect(newTab).toHaveAttribute('aria-selected', 'false')
        await expect(conversation).toHaveAttribute('data-mode', 'tab')
        await expect(input).toHaveValue(DRAFT)
        await page.screenshot({
          path: join(runtime.artifacts, `task-tab-active-${theme}-${size.width}.png`),
        })
        await newTab.focus()
        await page.keyboard.press('Enter')
        await expect(taskTab).toHaveAttribute('aria-selected', 'false')
        await expect(newTab).toHaveAttribute('aria-selected', 'true')
        await expect(conversation).toHaveAttribute('data-mode', 'floating')
        await taskTab.focus()
        await page.keyboard.press('Enter')
        await expect(taskTab).toHaveAttribute('aria-selected', 'true')
        await newTab.click()
        await expect(newTab).toHaveAttribute('aria-selected', 'true')
        await expect(conversation).toHaveAttribute('data-floating-active', 'false')
        await expect(page.getByTestId('workspace-conversation-menu')).toHaveAttribute('aria-expanded', 'false')
        for (const action of ['退出悬浮模式', '进入悬浮模式', '退出悬浮模式']) {
          await input.click()
          await expect(page.getByTestId('workspace-conversation-menu')).toBeVisible()
          await page.getByTestId('workspace-conversation-menu').click()
          await page.getByRole('menuitem', { name: action, exact: true }).click()
          await expect(newTab).toHaveCount(1)
          await expect(newTab).toHaveAttribute('aria-selected', 'true')
          await expect(input).toHaveValue(DRAFT)
        }
        await closeTab.click()
        await expect(content).toBeHidden()
      }
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })

  test(`workspace divider follows the pointer before and after swapping panels in ${theme}`, async ({}, testInfo) => {
    const runtime = createRuntime(testInfo)
    const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
    writeFileSync(
      preferencesPath,
      JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme })
    )
    const desktop = new DesktopSession(runtime, testInfo)
    try {
      const page = await desktop.launch()
      await page.getByTestId('activity-home').click()
      await page.getByTestId('home-project-create-top').click()
      const dialog = page.getByTestId('project-new-modal')
      await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
      await dialog.getByTestId('project-create').click()
      await expect(dialog).toHaveCount(0)
      const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
      if (await notificationClose.isVisible()) await notificationClose.click()
      await page.getByTestId('workspace-open').click()
      const content = page.getByTestId('workspace-content')
      const conversation = page.getByTestId('workspace-conversation')
      const handle = page
        .getByTestId('workspace-floating-area')
        .locator(':scope > .vds-resizable-split > .vds-resizable-split__handle')
      const input = page.getByTestId('composer-input')
      await input.fill(DRAFT)
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await desktop.app!.evaluate(({ BrowserWindow }, dimensions) => {
          BrowserWindow.getAllWindows()[0].setSize(dimensions.width, dimensions.height)
        }, size)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width)
        const host = (await page.getByTestId('workspace-floating-area').boundingBox())!
        const divider = (await handle.boundingBox())!
        await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
        await page.mouse.down()
        await page.mouse.move(host.x + host.width / 2, divider.y + divider.height / 2, { steps: 8 })
        await page.mouse.up()
        for (const swapped of [false, true, false]) {
          const contentBeforeSwap = (await content.boundingBox())!
          const conversationBeforeSwap = (await conversation.boundingBox())!
          if (contentBeforeSwap.x < conversationBeforeSwap.x !== swapped) {
            await page.getByTestId('workspace-conversation-menu').click()
            await page
              .getByRole('menuitem', { name: swapped ? '移至右侧面板' : '移至左侧面板' })
              .click()
            expect(
              Math.abs((await content.boundingBox())!.width - contentBeforeSwap.width)
            ).toBeLessThan(2)
          }
          expect((await content.boundingBox())!.x < (await conversation.boundingBox())!.x).toBe(
            swapped
          )
          for (const delta of [48, -48]) {
            const before = (await handle.boundingBox())!
            const contentWidth = (await content.boundingBox())!.width
            const conversationWidth = (await conversation.boundingBox())!.width
            const startX = before.x + before.width / 2
            const startY = before.y + before.height / 2
            await page.mouse.move(startX, startY)
            await page.mouse.down()
            await page.mouse.move(startX + delta, startY, { steps: 8 })
            await page.mouse.up()
            const after = (await handle.boundingBox())!
            expect(
              Math.abs(after.x - before.x - delta),
              JSON.stringify({
                size,
                swapped,
                delta,
                before,
                after,
                contentWidth,
                conversationWidth,
              })
            ).toBeLessThan(2)
            expect(
              Math.abs(
                (await content.boundingBox())!.width - contentWidth - (swapped ? delta : -delta)
              )
            ).toBeLessThan(2)
            expect(
              Math.abs(
                (await conversation.boundingBox())!.width -
                  conversationWidth -
                  (swapped ? -delta : delta)
              )
            ).toBeLessThan(2)
          }
          await expect(input).toHaveValue(DRAFT)
          await page.screenshot({
            path: join(
              runtime.artifacts,
              `divider-${size.width}-${swapped ? 'swapped' : 'normal'}.png`
            ),
          })
        }
      }
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
test('new workspace tab chooses existing project surfaces without adding another tab', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notificationClose.isVisible()) await notificationClose.click()
    await page.getByTestId('project-library').click()

    const content = page.getByTestId('workspace-content')
    await content.getByTestId('workspace-new-tab').click()
    const blank = content.getByTestId('project-new-tab')
    await expect(blank).toBeVisible()
    await expect(content.getByRole('tab', { name: '新标签页' })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: join(runtime.artifacts, 'new-project-tab.png') })

    await desktop.app!.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
    }, WORKSPACE_WINDOW_MINIMUM)
    const navigationTabs = content.getByRole('tablist', { name: '打开的资料', exact: true }).getByRole('tab')
    const initialTabCount = await navigationTabs.count()
    const filesChoice = blank.getByRole('button', { name: '项目文件' })
    await filesChoice.hover()
    await expect(filesChoice).toHaveCSS('border-radius', '8px')
    const divider = await filesChoice.locator('..').evaluate(element => {
      const style = getComputedStyle(element, '::after')
      return {left: style.left, right: style.right}
    })
    expect(divider).toEqual({left: '16px', right: '16px'})
    await expect(filesChoice).toBeInViewport()
    await expect(blank.getByRole('button', { name: '项目资源管理器' })).toBeInViewport()
    await page.screenshot({ path: join(runtime.artifacts, 'new-project-tab-minimum.png') })
    await filesChoice.focus()
    await page.keyboard.press('Enter')
    const projectFilesTab = content.getByRole('tab', { name: '项目文件' })
    await expect(projectFilesTab).toHaveAttribute('aria-selected', 'true')
    await expect(projectFilesTab.locator('svg.lucide-folders')).toHaveCSS('width', '16px')
    const tabBounds = (await projectFilesTab.boundingBox())!
    const contentBounds = (await content.boundingBox())!
    expect(tabBounds.x).toBeGreaterThan(contentBounds.x)
    expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(contentBounds.x + contentBounds.width)
    await expect(content.getByTestId('project-library-content')).toBeVisible()
    await expect(content.getByTestId('material-list').getByRole('status')).toHaveCount(0)
    const library = content.getByTestId('project-library-content')
    const assertSearch = async (name: string): Promise<void> => {
      const inline = library.getByRole('searchbox', { name, exact: true })
      if (await inline.isVisible()) await expect(inline).toBeVisible()
      else {
        const trigger = library.getByRole('button', { name, exact: true })
        await expect(trigger).toBeVisible()
        await trigger.click()
        await expect(page.getByRole('searchbox', { name, exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(trigger).toBeFocused()
      }
    }
    await expect(library.getByRole('button', { name: '项目资源管理器' })).toBeVisible()
    await assertSearch('搜索文件')
    await expect(library.getByRole('tab', { name: '资料' })).toHaveAttribute('aria-selected', 'true')
    const toolbar = library.getByRole('tablist').locator('..')
    await expect(toolbar).toHaveCSS('flex-wrap', 'nowrap')
    await assertSearch('搜索文件')
    await expect(library.getByRole('tabpanel').getByRole('searchbox')).toHaveCount(0)
    await library.getByRole('tab', { name: '任务产物' }).click()
    await assertSearch('搜索任务或产物文件')
    await expect(library.getByRole('tabpanel').getByRole('searchbox')).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'project-outputs-tab.png') })
    await library.getByRole('tab', { name: '文献' }).click()
    await expect(library.getByRole('tab', { name: '文献' })).toHaveAttribute('aria-selected', 'true')
    await assertSearch('搜索标题、作者、年份')
    const paperGroup = toolbar.getByRole('button', { name: '文献分类', exact: true })
    await expect(paperGroup).toHaveCSS('height', '32px')
    await expect(paperGroup).toHaveCSS('padding-right', '16px')
    await expect(paperGroup.locator('svg.lucide-folder')).toHaveCount(0)
    await expect(toolbar.getByRole('button', { name: '添加文献' })).toBeVisible()
    const literatureTable = library.locator('.lit-table')
    await expect(literatureTable).toHaveCSS('border-top-width', '1px')
    await expect(literatureTable.locator('.lit-column-head')).toHaveText([
      '标题', '作者', '期刊', '年份', '标签'
    ])
    await page.screenshot({ path: join(runtime.artifacts, 'project-literature-tab.png') })
    await library.getByRole('tab', { name: '资料' }).click()
    // Reusing an existing surface retains the blank tab, without adding a duplicate.
    await expect(content.getByRole('tab', { name: '新标签页' })).toHaveCount(1)
    await expect(content.getByRole('tab', { name: '新标签页' })).toHaveAttribute('aria-selected', 'false')
    await expect(content.getByRole('tab', { name: '项目文件', exact: true })).toHaveCount(1)
    await expect(navigationTabs).toHaveCount(initialTabCount)
    await desktop.app!.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
    }, WORKSPACE_WINDOW_SIZE)
    const materialToolbar = library.getByTestId('project-library-toolbar-actions')
    const newMaterial = materialToolbar.getByRole('button', { name: '新建资料' })
    const refreshLibrary = materialToolbar.getByRole('button', { name: '刷新资料库' })
    await expect(newMaterial).toBeVisible()
    await expect(refreshLibrary).toBeVisible()
    expect((await newMaterial.boundingBox())!.x).toBeLessThan((await refreshLibrary.boundingBox())!.x)
    expect((await refreshLibrary.boundingBox())!.x).toBeLessThan(
      (await library.getByRole('button', { name: '项目资源管理器' }).boundingBox())!.x
    )
    await page.screenshot({ path: join(runtime.artifacts, 'project-files-tab.png') })
    await library.getByRole('button', { name: '项目资源管理器' }).click()
    await expect(content.getByRole('tab', { name: '项目资源管理器' })).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('workspace-full').click()
    const taskTab = page.getByTestId('workspace-task-tab')
    await expect(taskTab).toHaveAttribute('aria-selected', 'false')
    await expect(taskTab.locator('svg.lucide-message-circle')).toHaveCSS('width', '16px')
    await expect(taskTab.locator('[data-slot="navigation-tab-divider"]')).toBeVisible()
    await page.getByTestId('workspace-full').click()
    await content.getByRole('tab', { name: '项目文件' }).click()

    await content.getByTestId('workspace-new-tab').click()
    await content.getByTestId('project-new-tab').getByRole('button', { name: '项目资源管理器' }).click()
    await expect(content.getByRole('tab', { name: '项目资源管理器' })).toHaveAttribute('aria-selected', 'true')
    await expect(content.getByTestId('project-explorer')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'project-explorer-tab.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('new workspace tab choices remain readable in dark theme', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, 'renderer-preferences.json')
  writeFileSync(
    preferencesPath,
    JSON.stringify({ ...JSON.parse(readFileSync(preferencesPath, 'utf8')), theme: 'dark' })
  )
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(dialog).toHaveCount(0)
    const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notificationClose.isVisible()) await notificationClose.click()
    await page.getByTestId('project-library').click()
    await page.getByTestId('workspace-content').getByTestId('workspace-new-tab').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('project-new-tab')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'new-project-tab-dark.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('task overview keeps empty groups, keyboard focus and task ownership across workspace tabs', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    const navigation = page.getByTestId('project-navigation')
    const content = page.getByTestId('workspace-floating-area')
    await expect(navigation).toBeVisible()
    for (const expanded of [false, true, false]) {
      const archiveToggle = page.getByTestId('project-archive-toggle')
      if ((await archiveToggle.getAttribute('aria-expanded')) !== String(expanded)) {
        await archiveToggle.click()
      }
      const navigationBounds = await navigation.boundingBox()
      const contentBounds = await content.boundingBox()
      const archiveBounds = await page.getByTestId('project-archives').boundingBox()
      expect(navigationBounds).not.toBeNull()
      expect(contentBounds).not.toBeNull()
      expect(archiveBounds).not.toBeNull()
      expect(navigationBounds!.x + navigationBounds!.width).toBe(contentBounds!.x)
      expect(archiveBounds!.x + archiveBounds!.width).toBe(contentBounds!.x)
    }
    const overview = page.getByTestId('task-overview')
    const notificationClose = page.getByRole('button', { name: '关闭通知', exact: true })
    if (await notificationClose.isVisible()) await notificationClose.click()
    const toggle = page.getByTestId('task-overview-toggle')
    await toggle.click()
    await expect(overview).toBeVisible()
    await expect(overview.getByText('暂无', { exact: true })).toHaveCount(3)
    await expect(overview.getByTestId('task-overview-references')).toBeVisible()
    await expect(page.getByTestId('task-overview-directory')).toHaveCount(0)
    const artifacts = overview.getByRole('button', { name: '产物', exact: true })
    await artifacts.click()
    await expect(artifacts).toHaveAttribute('aria-expanded', 'false')
    await expect(overview.getByTestId('session-artifacts-body')).not.toBeVisible()
    await artifacts.click()
    await expect(overview.getByText('暂无', { exact: true })).toHaveCount(3)
    for (const kind of ['file', 'external-resource', 'web-app', 'tool', 'web'])
      await expect(overview.getByTestId(`overview-sources-${kind}-trigger`)).toHaveCount(0)
    await expect.poll(async () => Math.round((await overview.boundingBox())!.width)).toBe(240)
    await toggle.focus()
      await toggle.press('Enter')
    await expect(overview).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await desktop.app!.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
    }, WORKSPACE_WINDOW_MINIMUM)
    await toggle.click()
    const bounds = await overview.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    expect(bounds!.height).toBeLessThanOrEqual(615)
    await page.screenshot({ path: join(runtime.artifacts, 'task-overview-minimum.png') })
    await toggle.focus()
      await toggle.press('Enter')
    await page.getByTestId('composer-input').fill(DRAFT)
    await page.getByTestId('project-library').click()
    for (const action of ['library', 'new-tab']) {
      if (action === 'new-tab')
        await page.getByRole('button', { name: '新标签页', exact: true }).click()
      await expect(toggle).toHaveCount(1)
      await toggle.click()
      await expect(overview.getByText('暂无', { exact: true })).toHaveCount(3)
      await toggle.focus()
      await toggle.press('Enter')
    }
    await page.getByTestId('workspace-full').click()
    await expect(toggle).toHaveCount(0)
    await page.getByTestId('workspace-task-tab').click()
    await expect(page.getByTestId('composer-input')).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'task-overview-empty.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})

test('conversation pin, workspace toggle and task tabs share one conversation', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const desktop = new DesktopSession(runtime, testInfo)
  try {
    const page = await desktop.launch()
    await page.getByTestId('activity-home').click()
    await page.getByTestId('home-project-create-top').click()
    const dialog = page.getByTestId('project-new-modal')
    await dialog.getByTestId('project-create-name').fill(PROJECT_NAME)
    await dialog.getByTestId('project-create').click()
    await expect(page.getByTestId('project-workspace')).toBeVisible()
    const conversation = page.getByTestId('workspace-conversation')
    const toggle = page.getByTestId('workspace-open')
    const input = page.getByTestId('composer-input')
    await input.fill(DRAFT)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const actions = page.getByTestId('workspace-conversation-menu')
    await actions.click()
    await expect(page.getByRole('menuitem', { name: '移至右侧面板' })).toHaveCount(0)
    await page.screenshot({ path: join(runtime.artifacts, 'conversation-menu-collapsed.png') })
    await page.keyboard.press('Escape')
    await expect(actions).toBeFocused()
    await toggle.click()
    await expect(page.getByTestId('workspace-content')).toBeVisible()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await page.getByTestId('project-library').click()
    await page.screenshot({ path: join(runtime.artifacts, 'split.png') })
    await actions.click()
    await expect(page.getByRole('menuitem', { name: '移至右侧面板' })).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'conversation-menu-expanded.png') })
    await page.getByRole('menuitem', { name: '移至右侧面板' }).click()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    expect((await conversation.boundingBox())!.x).toBeGreaterThan(
      (await page.getByTestId('workspace-content').boundingBox())!.x
    )
    await actions.click()
    await page.getByRole('menuitem', { name: '进入悬浮模式' }).click()
    await expect(conversation).toHaveAttribute('data-mode', 'floating')
    await input.focus()
    // Drag the compact input anchor; expanded content may extend above it.
    await expect(page.getByTestId('floating-conversation-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(conversation.getByTestId('workspace-open')).toHaveCount(0)
    await expect(page.getByTestId('workspace-close')).toBeVisible()
    await expect(actions).toHaveAttribute('aria-label', '任务操作')
    await expect(input).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'floating.png') })
    const area = await page.getByTestId('workspace-floating-area').boundingBox()
    const original = await conversation.boundingBox()
    expect(area).not.toBeNull()
    expect(original).not.toBeNull()
    const dragHandle = page.getByTestId('workspace-conversation-menu')
    const handle = await dragHandle.boundingBox()
    expect(handle).not.toBeNull()
    const startX = handle!.x + handle!.width / 2
    const startY = handle!.y + handle!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(area!.x + 20, area!.y + 20, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await conversation.boundingBox())!.y).toBeLessThan(original!.y - 50)
    const moved = await conversation.boundingBox()
    expect(moved!.x).toBeLessThan(original!.x - 100)
    expect(moved!.y).toBeLessThan(original!.y - 50)
    await expect(input).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'dragged.png') })
    // Drag beyond the workspace through the current six-dot handle.
    const movedHandle = (await dragHandle.boundingBox())!
    await page.mouse.move(movedHandle.x + movedHandle.width / 2, movedHandle.y + movedHandle.height / 2)
    await page.mouse.down()
    await page.mouse.move(area!.x - 100, area!.y - 100, { steps: 8 })
    await page.mouse.up()
    const clamped = (await conversation.boundingBox())!
    expect(clamped.x).toBeGreaterThanOrEqual(area!.x - 1)
    expect(clamped.y).toBeGreaterThanOrEqual(area!.y - 1)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(area!.x + area!.width + 1)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(area!.y + area!.height + 1)
    await expect(input).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'drag-boundary.png') })
    await input.focus()
    await page.getByTestId('floating-conversation-toggle').click()
    await expect(page.getByTestId('ai-stream')).toBeVisible()
    const expandedSurface = conversation.getByTestId('floating-conversation-surface')
    const afterFull = await expandedSurface.boundingBox()
    expect(afterFull).not.toBeNull()
    await page.getByTestId('floating-conversation-toggle').click()
    await expect(page.getByTestId('ai-stream')).toBeHidden()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue(DRAFT)
    await expect(page.getByTestId('floating-conversation-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    const collapsed = await conversation.boundingBox()
    expect(collapsed!.height).toBeLessThan(afterFull!.height)
    expect(collapsed!.width).toBeCloseTo(afterFull!.width, 0)
    await page.screenshot({ path: join(runtime.artifacts, 'conversation-collapsed.png') })
    await page.getByTestId('workspace-minimize-conversation').click()
    await expect(conversation).toBeHidden()
    await expect(page.getByTestId('workspace-restore-conversation')).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'conversation-minimized.png') })
    await page.getByTestId('workspace-restore-conversation').click()
    await expect(page.getByTestId('ai-stream')).toBeHidden()
    await expect(input).toBeVisible()
    await input.focus()
    await page.getByTestId('floating-conversation-toggle').focus()
    await page.getByTestId('floating-conversation-toggle').press('Enter')
    await expect(page.getByTestId('ai-stream')).toBeVisible()
    await expect(page.getByTestId('floating-conversation-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect
      .poll(async () => (await expandedSurface.boundingBox())!.height)
      .toBeCloseTo(afterFull!.height, 0)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue(DRAFT)
    await actions.click()
    await page.getByRole('menuitem', { name: '退出悬浮模式', exact: true }).click()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await expect(page.getByTestId('workspace-task-tab')).toHaveCount(0)
    await expect(page.getByTestId('workspace-content').locator(':scope > div')).toBeVisible()
    await expect(input).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'conversation-docked.png') })
    await page.getByRole('tab', { name: '项目文件', exact: true }).click()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await expect(page.getByTestId('workspace-content').locator(':scope > div')).toBeVisible()
    await page.getByTestId('workspace-close').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('workspace-content')).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(page.getByTestId('workspace-content')).toBeVisible()
    await expect(input).toHaveValue(DRAFT)
    desktop.assertNoPageErrors()
    await actions.click()
    await page.getByRole('menuitem', { name: '进入悬浮模式' }).click()
    await page.getByTestId('workspace-close').click()
    await expect(conversation).toHaveAttribute('data-mode', 'split')
    await expect(conversation.getByTestId('workspace-open')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(page.getByTestId('workspace-content')).toBeHidden()
    await expect(input).toHaveValue(DRAFT)
    await page.screenshot({ path: join(runtime.artifacts, 'workspace-collapsed-and-docked.png') })
  } catch (error) {
    await desktop.page?.screenshot({ path: join(runtime.artifacts, 'failure.png') })
    throw error
  } finally {
    await desktop.attachArtifacts()
  }
})
