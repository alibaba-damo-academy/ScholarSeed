import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect } from '@playwright/test'
import { createServer } from 'vite'
import { renderFixture } from '../../../../test-helpers/render.ts'

for (const theme of ['light', 'dark'])
  test(
    `message center truncates long names within padding, reveals full text and clears completed rows (${theme})`,
    { timeout: 60_000 },
    async (context) => {
      const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)), {
        create: (config) =>
          createServer({
            ...config,
            plugins: [
              {
                name: 'task-center-view-boundaries',
                enforce: 'pre',
                resolveId(source, importer) {
                  if (
                    importer?.endsWith('/business/Tasks.tsx') &&
                    ['../../store', '../../app/connection'].includes(source)
                  )
                    return '\0task-center-view-boundary'
                },
                load(id) {
                  if (id === '\0task-center-view-boundary')
                    return `
                      import { useSyncExternalStore } from 'react'
                      let state = { taskMessageDismissals: {} }
                      const listeners = new Set()
                      const publish = next => { state = next; for (const listener of listeners) listener() }
                      let release
                      const probe = { hold: false, failed: false, pending: 0,
                        release: () => release?.(),
                      }
                      window.taskStoreProbe = probe
                      const act = { noticeResource() {},
                        async clearTaskMessages(taskMessageDismissals) {
                          probe.pending++
                          if (probe.hold) await new Promise(resolve => { release = resolve })
                          if (!probe.failed) publish({ ...state, taskMessageDismissals })
                          probe.pending--
                        }
                      }
                      export const useApp = () => ({
                        state: useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => state),
                        act,
                        set: patch => publish({ ...state, ...(typeof patch === 'function' ? patch(state) : patch) }),
                      })
                      export const useStartup = () => ({ phase: 'ready', generation: 1 })
                    `
                },
              },
              ...(config.plugins ?? []),
            ],
          }),
      })
      context.after(() => fixture.close())
      const page = await fixture.page(context)
      await page.setViewportSize({ width: theme === 'light' ? 360 : 520, height: 720 })
      const url = new URL('/components/business/tasks.render.fixture.html', fixture.url)
      url.searchParams.set('theme', theme)
      await page.goto(url.href)
      const center = page.getByTestId('task-center')
      const clear = page.getByRole('button', { name: '一键清除', exact: true })
      await expect(clear).toBeVisible()
      const row = center.locator('article').first()
      const filename = row.getByTestId('task-source-name').first()
      await expect(filename).toBeVisible()
      const bounds = await filename.evaluate((element) => {
        const card = element.closest('article')!
        const text = element.getBoundingClientRect()
        const outer = card.getBoundingClientRect()
        const style = getComputedStyle(card)
        return {
          left: text.left - outer.left,
          right: outer.right - text.right,
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
          overflowing: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow,
        }
      })
      assert.equal(bounds.overflowing, true)
      assert.equal(bounds.ellipsis, 'ellipsis')
      assert.ok(Math.abs(bounds.left - bounds.paddingLeft) < 1)
      assert.ok(Math.abs(bounds.right - bounds.paddingRight) < 1)
      await filename.hover()
      await expect(page.getByRole('tooltip')).toContainText((await filename.textContent()) ?? '')
      assert.ok(
        await page
          .getByRole('tooltip')
          .evaluate(
            (element) =>
              Number(getComputedStyle(element).zIndex) >
              Number(
                getComputedStyle(
                  document.querySelector('[data-testid="task-center"]')!.parentElement!
                ).zIndex
              )
          )
      )
      await page.mouse.move(0, 0)
      await clear.focus()
      await expect(page.getByRole('tooltip')).toContainText('一键清除')
      await page.evaluate(() => {
        Reflect.get(window, 'taskStoreProbe').hold = true
      })
      await clear.press('Enter')
      await expect(center.locator('article')).toHaveCount(3)
      await expect(clear).toBeDisabled()
      await page.evaluate(() => Reflect.get(window, 'taskStoreProbe').release())
      await expect(center.locator('article')).toHaveCount(2)
      await expect(center.getByText('进行中', { exact: true })).toBeVisible()
      await expect(center.getByText('失败', { exact: true })).toBeVisible()
      await expect(clear).toBeDisabled()
      await page.evaluate(() => Reflect.get(window, 'taskSourceProbe').upload())
      await expect(center.locator('article')).toHaveCount(3)
      await expect(center.getByText('已完成', { exact: true })).toHaveCount(1)
      await page.evaluate(() => {
        Reflect.get(window, 'taskStoreProbe').failed = true
      })
      await clear.click()
      await expect(center.locator('article')).toHaveCount(3)
      await page.evaluate(() => Reflect.get(window, 'taskStoreProbe').release())
      await expect(clear).toBeEnabled()
      await expect(center.locator('article')).toHaveCount(3)
    }
  )
