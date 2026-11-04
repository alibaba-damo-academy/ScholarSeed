import { openAccountSettings } from './fixtures/menu'
import { selectMarkdownMode } from './fixtures/markdown'
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ONBOARDING_GROUPS } from '../src/onboarding'
import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { createReadyProject, openProjectFile, openProjectMenu } from './fixtures/projects'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = '自动保存红点回归'
const DOCUMENT_NAME = '自动保存验证'
const DOCUMENT_FILE = `${DOCUMENT_NAME}.md`
const CODE_FILE = 'source.txt'
const ORIGINAL_TEXT = 'BASELINE'
const EDIT_TEXT = '123'
const PREFERENCES_FILE = 'renderer-preferences.json'
const SHORTCUT = process.platform === 'darwin' ? 'Meta' : 'Control'
const INTERACTION_TIMEOUT_MS = 15_000
const NARROW_VIEWPORT = { width: 900, height: 700 }

async function setAutoSave(page: Page, enabled: boolean): Promise<void> {
  await openAccountSettings(page)
  await page.getByTestId('account-settings-nav-files').click()
  const toggle = page.getByTestId('file-version-auto-save')
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
}

async function expectIndicators(page: Page, file: string, visible: boolean): Promise<void> {
  const count = visible ? 1 : 0
  await expect(page.getByTestId(`explorer-select-dirty-resources/${file}`)).toHaveCount(0)
  await expect(
    page.getByRole('tab').filter({ hasText: file }).locator('[data-slot="navigation-tab-dirty"]')
  ).toHaveCount(count)
  await expect(page.locator('[data-testid$="save-dirty"]:visible')).toHaveCount(file === CODE_FILE ? count : 0)
}

for (const theme of ['light', 'dark'] as const) {
  test(`auto-save indicators preserve edits, saving and manual mode in ${theme}`, async ({}, testInfo) => {
    skipQuarantined(testInfo)
    const runtime = createRuntime(testInfo)
    writeFileSync(
      join(runtime.userData, PREFERENCES_FILE),
      JSON.stringify({
        language: 'zh',
        theme,
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
      const project = await createReadyProject(page, PROJECT_NAME)
      const resources = join(project.root, 'resources')
      mkdirSync(resources, { recursive: true })
      writeFileSync(join(resources, CODE_FILE), ORIGINAL_TEXT)
      writeFileSync(join(resources, DOCUMENT_FILE), '')
      await page.reload()
      await openProjectMenu(page)
      await page.getByTestId(`project-menu-option-${project.name}`).click()
      await openProjectFile(page, `resources/${DOCUMENT_FILE}`)
      await selectMarkdownMode(page, 'edit')
      const editor = page.locator('[data-testid="markdown-visual-editor"]:visible .ProseMirror')
      const save = page.getByTestId('markdown-save')
      const header = page.locator('.vds-markdown-header:visible')
      await expect(editor).toBeVisible()
      await setAutoSave(page, true)
      await editor.click()
      await page.keyboard.type(ORIGINAL_TEXT)
      await expect(editor).toContainText(ORIGINAL_TEXT)
      await expect(save).toHaveCount(0)
      await expectIndicators(page, DOCUMENT_FILE, false)
      expect(readFileSync(join(resources, DOCUMENT_FILE), 'utf8')).toBe('')
      await page.screenshot({ path: join(runtime.artifacts, 'autosave-edit-no-dots.png') })
      await page.getByTestId('project-navigation-selector').focus()
      await expect(header).toHaveAttribute('data-save-state', 'clean')
      await expect
        .poll(() => readFileSync(join(resources, DOCUMENT_FILE), 'utf8'))
        .toContain(ORIGINAL_TEXT)
      const savedText = readFileSync(join(resources, DOCUMENT_FILE), 'utf8')
      await page.getByRole('button', { name: '版本历史', exact: true }).click()
      await expect(page.getByText('共 2 个版本', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭版本历史' }).click()

      await editor.click()
      await page.keyboard.press(`${SHORTCUT}+End`)
      await page.keyboard.type(EDIT_TEXT)
      await expect(save).toHaveCount(0)
      for (let remaining = EDIT_TEXT.length; remaining > 0; remaining -= 1) {
        await page.keyboard.press('Backspace')
      }
      await expect(header).toHaveAttribute('data-save-state', 'clean')
      await expectIndicators(page, DOCUMENT_FILE, false)
      await page.getByRole('button', { name: `关闭 ${DOCUMENT_FILE}`, exact: true }).click()
      await openProjectFile(page, `resources/${DOCUMENT_FILE}`)
      await selectMarkdownMode(page, 'edit')
      await expect(editor).toHaveText(ORIGINAL_TEXT)
      expect(readFileSync(join(resources, DOCUMENT_FILE), 'utf8')).toBe(savedText)
      await page.getByRole('button', { name: '版本历史', exact: true }).click()
      await expect(page.getByText('共 2 个版本', { exact: true })).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, 'no-change-version-history.png') })
      await page.getByRole('button', { name: '关闭版本历史' }).click()

      await setAutoSave(page, false)
      await editor.click()
      await page.keyboard.press(`${SHORTCUT}+End`)
      await page.keyboard.type(EDIT_TEXT)
      await expectIndicators(page, DOCUMENT_FILE, true)
      await page.screenshot({ path: join(runtime.artifacts, 'manual-edit-three-dots.png') })
      await selectMarkdownMode(page, 'source')
      const source = page
        .locator('[data-testid="document-editor"]:visible')
        .getByTestId('monaco-editor')
        .contentFrame()
      await expect(source.locator('.view-lines')).toContainText(EDIT_TEXT)
      await expectIndicators(page, DOCUMENT_FILE, true)
      await selectMarkdownMode(page, 'edit')
      await expect(editor).toContainText(EDIT_TEXT)
      await setAutoSave(page, true)
      await expectIndicators(page, DOCUMENT_FILE, false)
      await expect(header).toHaveAttribute('data-save-state', 'clean')
      await expect
        .poll(() => readFileSync(join(resources, DOCUMENT_FILE), 'utf8'))
        .toContain(EDIT_TEXT)
      await editor.click()
      await page.keyboard.press(`${SHORTCUT}+End`)
      await page.keyboard.type(EDIT_TEXT)
      await expect(save).toHaveCount(0)
      await expectIndicators(page, DOCUMENT_FILE, false)
      await page.getByTestId('project-navigation-selector').focus()
      await expect
        .poll(() => readFileSync(join(resources, DOCUMENT_FILE), 'utf8'))
        .toContain(EDIT_TEXT)

      await openProjectFile(page, `resources/${CODE_FILE}`)
      const codeEditor = page
        .locator('[data-testid="document-editor"]:visible')
        .getByTestId('monaco-editor')
        .contentFrame()
      await expect(codeEditor.locator('.view-lines')).toContainText(ORIGINAL_TEXT)
      await codeEditor.locator('textarea').first().press(`${SHORTCUT}+End`)
      await page.keyboard.type(EDIT_TEXT)
      await expect(page.locator('[data-testid="source-document-save"]:visible')).toBeEnabled()
      await expectIndicators(page, CODE_FILE, false)
      await page.setViewportSize(NARROW_VIEWPORT)
      await page.screenshot({ path: join(runtime.artifacts, 'code-autosave-no-dots-narrow.png') })
      await setAutoSave(page, false)
      await codeEditor.locator('textarea').first().press(`${SHORTCUT}+End`)
      await page.keyboard.type(EDIT_TEXT)
      await expectIndicators(page, CODE_FILE, true)
      await page.getByRole('button', { name: `关闭 ${CODE_FILE}`, exact: true }).click()
      await expect(page.getByTestId('document-close-dialog')).toBeVisible()
      await page.screenshot({ path: join(runtime.artifacts, 'manual-close-protects-edits.png') })
      await page.getByTestId('document-close-save').click()
      await expect(page.getByTestId('document-close-dialog')).toHaveCount(0)
      await expect.poll(() => readFileSync(join(resources, CODE_FILE), 'utf8')).toContain(EDIT_TEXT)
      desktop.assertNoPageErrors()
    } finally {
      await desktop.attachArtifacts()
    }
  })
}
