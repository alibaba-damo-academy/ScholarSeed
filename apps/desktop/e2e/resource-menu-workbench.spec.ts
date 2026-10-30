import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession, enterWorkbenchShell } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { createReadyProject } from './fixtures/projects'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => {
  skipQuarantined(testInfo)
})

const PROJECT_NAME = '目录菜单回归'
const DIRECTORY_PATH = 'resources/目录'
const EXISTING_NAME = '已有文档.md'
const EXISTING_CONTENT = '# 保留已有内容\n'
const DOCUMENT_NAME = '新建文档'
const FOLDER_NAME = '新建文件夹'
const PREFERENCES_FILE = 'renderer-preferences.json'
const INTERACTION_TIMEOUT_MS = 15_000

test('directory create menus preserve children through draft, commit, cancel and import', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  const preferencesPath = join(runtime.userData, PREFERENCES_FILE)
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'))
  writeFileSync(
    preferencesPath,
    JSON.stringify({
      ...preferences,
      onboarding: { seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])) },
    })
  )
  const desktop = new DesktopSession(runtime, testInfo, {
    nativeWindowLifecycle: true,
    preserveNavigation: true,
  })
  try {
    const page = await desktop.launch()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    await page.getByTestId('landing-skip').click()
    await expect(page.getByTestId('landing-dialog')).toHaveCount(0)
    const project = await createReadyProject(page, PROJECT_NAME)
    const directoryPath = join(project.root, DIRECTORY_PATH)
    mkdirSync(directoryPath, { recursive: true })
    writeFileSync(join(directoryPath, EXISTING_NAME), EXISTING_CONTENT)
    await page.reload()
    await enterWorkbenchShell(page)
    await page.getByTestId('topbar-project').click()
    await page.getByTestId(`project-menu-option-${PROJECT_NAME}`).click()
    await page.getByTestId('activity-resource').click()
    await page.getByTestId('resource-refresh').click()

    const directory = page.getByTestId(`tree-${DIRECTORY_PATH}`)
    const existing = page.getByTestId(`tree-${DIRECTORY_PATH}/${EXISTING_NAME}`)
    const create = page.getByTestId(`tree-create-${DIRECTORY_PATH}`)
    const input = page.getByTestId('resource-name-input')
    await directory.click()
    await expect(existing).toBeVisible()

    await create.click()
    await expect(existing).toBeVisible()
    await page.getByTestId(`tree-new-doc-${DIRECTORY_PATH}`).click()
    await expect(page.getByRole('dialog', { name: '新建md文档' })).toBeVisible()
    await expect(input).toBeVisible()
    await expect(input).toHaveCount(1)
    await expect(input).toHaveAttribute('maxlength', '20')
    await expect(existing).toBeVisible()
    await expect(create).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: join(runtime.artifacts, 'expanded-document-draft.png') })
    await input.fill(DOCUMENT_NAME)
    await input.press('Enter')
    const document = page.getByTestId(`tree-${DIRECTORY_PATH}/${DOCUMENT_NAME}.md`)
    await expect(document).toBeVisible()
    await expect(
      page.getByRole('tab', { name: `${DOCUMENT_NAME}.md`, exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(existing).toBeVisible()
    expect(readFileSync(join(directoryPath, `${DOCUMENT_NAME}.md`), 'utf8')).toBe('')

    await create.click()
    await page.getByTestId(`tree-new-folder-${DIRECTORY_PATH}`).click()
    await expect(page.getByRole('dialog', { name: '新建文件夹' })).toBeVisible()
    await expect(input).toBeVisible()
    await expect(existing).toBeVisible()
    await expect(document).toBeVisible()
    await page.screenshot({ path: join(runtime.artifacts, 'expanded-folder-draft.png') })
    await input.fill(FOLDER_NAME)
    await input.press('Enter')
    await expect(page.getByTestId(`tree-${DIRECTORY_PATH}/${FOLDER_NAME}`)).toBeVisible()
    await expect(page.getByTestId(`tree-${DIRECTORY_PATH}/${FOLDER_NAME}`)).toHaveClass(
      /is-selected/
    )
    await expect(page.getByRole('tab', { name: FOLDER_NAME, exact: true })).toHaveCount(0)
    expect(existsSync(join(directoryPath, FOLDER_NAME))).toBe(true)

    await directory.click()
    await expect(existing).toHaveCount(0)
    await create.click()
    await expect(existing).toHaveCount(0)
    await page.getByTestId(`tree-new-doc-${DIRECTORY_PATH}`).click()
    await expect(input).toBeVisible()
    await expect(existing).toBeVisible()
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(existing).toBeVisible()

    await create.focus()
    await page.keyboard.press('Enter')
    await page.getByTestId(`tree-new-folder-${DIRECTORY_PATH}`).focus()
    await page.keyboard.press('Enter')
    await expect(input).toBeVisible()
    await expect(existing).toBeVisible()
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(existing).toBeVisible()

    for (const expanded of [true, false]) {
      if (!expanded) await directory.click()
      await create.click()
      await page.getByTestId(`tree-import-${DIRECTORY_PATH}`).click()
      const dialog = page.getByTestId('resource-import-dialog')
      await expect(dialog).toBeVisible()
      if (expanded) await expect(existing).toBeVisible()
      else await expect(existing).toHaveCount(0)
      await page.screenshot({
        path: join(runtime.artifacts, `import-${expanded ? 'expanded' : 'collapsed'}.png`),
      })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    await directory.click()
    await expect(existing).toBeVisible()
    await expect(document).toBeVisible()
    expect(readFileSync(join(directoryPath, EXISTING_NAME), 'utf8')).toBe(EXISTING_CONTENT)
    await page.screenshot({ path: join(runtime.artifacts, 'directory-menu-complete.png') })
    desktop.assertNoPageErrors()
  } finally {
    await desktop.attachArtifacts()
  }
})
