import type { Page } from '@playwright/test'

const MARKDOWN_MODE_OPTIONS = {
  source: 'markdown-open-source',
  edit: 'markdown-open-editor',
  preview: 'markdown-open-preview',
} as const

export async function openMarkdownModes(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="markdown-mode-select"]:visible').first()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}

export async function selectMarkdownMode(page: Page, mode: keyof typeof MARKDOWN_MODE_OPTIONS): Promise<void> {
  await openMarkdownModes(page)
  await page.getByTestId(MARKDOWN_MODE_OPTIONS[mode]).click()
}
