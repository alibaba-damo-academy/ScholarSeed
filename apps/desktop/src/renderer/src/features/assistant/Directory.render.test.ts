import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('directory snapshot retries, preserves empty directories and opens the exact immutable member', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'), {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  let requests = 0
  await page.route('**/api/serve/sessions/fixture/artifacts/directory/entries', (route) => {
    requests += 1
    return requests === 1
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: {
            artifact_id: 'directory',
            kind: 'directory',
            sha256: 'manifest-revision',
            version: 1,
            total_size: 3,
            entries: [
              { path: 'empty', kind: 'directory' },
              {
                path: 'nested/中文 #1.pdf',
                kind: 'file',
                sha256: 'member-revision',
                size: 3,
                media_type: 'application/pdf',
              },
            ],
          },
        })
  })
  await page.goto(`${fixture.url}features/assistant/Directory.render.fixture.html`)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('无法读取')
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await expect(dialog.getByText('empty/', { exact: true })).toBeVisible()
  await expect(dialog).toContainText('manifest-revision')
  await expect(dialog).toContainText('源目录后续修改或删除不会改变此版本')
  await dialog.getByRole('button', { name: 'nested/中文 #1.pdf', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  assert.deepEqual(JSON.parse(await page.getByTestId('opened').innerText()), {
    sessionId: 'fixture',
    artifactId: 'directory',
    memberPath: 'nested/中文 #1.pdf',
    path: 'nested/中文 #1.pdf',
    title: '中文 #1.pdf',
    revisionId: 'member-revision',
    mediaType: 'application/pdf',
    size: 3,
  })
  assert.equal(requests, 2)
})
