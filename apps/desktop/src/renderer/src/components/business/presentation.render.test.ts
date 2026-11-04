import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test(
  'project choices and tag headers preserve alignment and intrinsic tag width',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [
        {
          name: 'presentation-fixture',
          enforce: 'pre',
          configureServer(server) {
            server.middlewares.use('/__presentation', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html')
              response.end(
                await server.transformIndexHtml(
                  '/__presentation',
                  '<div id="root"></div><script type="module" src="/__probe.tsx"></script>'
                )
              )
            })
          },
          resolveId(source) {
            if (source === '/__probe.tsx') return source
            if (/(?:^|\/)store(?:\.tsx)?$/.test(source)) return '\0presentation-store'
            if (source === '../workbench/workspace') return '\0presentation-workspace'
          },
          load(id) {
            if (id === '\0presentation-store')
              return 'export const useApp = () => ({set: () => {}})'
            if (id === '\0presentation-workspace')
              return 'export const useWorkspaceController = () => ({pageTabsInLeaf: () => []})'
            if (id !== '/__probe.tsx') return
            return `import React, {useCallback,useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {I18nextProvider} from 'react-i18next';
          import {createLocalization} from '/../../localization/engine';
          import {resources} from '/../../localization/resources';
          import {NewTab} from '/features/project/NewTab';
          import {RowTags,TagFilter} from '/features/literature/Tags';
          import {TagPicker} from '/features/literature/Tags';
          import {LibraryAction,LibraryFilter,LibraryToolbar,LibraryToolbarTarget,LIBRARY_TABLE_CLASS as LIBRARY_TABLE_HEADER_CLASS} from '/components/business/Library';
          import {Groups} from '/features/literature/Groups';
          import {ToastProvider,Table,TableHeader,TableRow,TableHead,TableBody,TableCell,Button} from '/components/ui';
          import '/styles.css';
          const item={id:'paper',tags:[{id:'first',name:'一二三四五六七八九十'},...Array.from({length:12},(_,index)=>({id:'tag-'+index,name:'标签'+index}))]};
          function ToolbarFixture(){
            const [target,setTarget]=useState(null);
            return <div data-testid="toolbar-fixture" style={{width:160}}><div ref={setTarget}/><LibraryToolbarTarget.Provider value={target}><LibraryToolbar query="" onQuery={()=>{}} placeholder="搜索文献" refreshing={false} onRefresh={()=>{}}><LibraryAction label="添加测试文献"/></LibraryToolbar></LibraryToolbarTarget.Provider></div>;
          }
          function Fixture(){
            const [width,setWidth]=useState(110);
            const measure=useCallback((_id,next)=>setWidth(next),[]);
            return <><div style={{height:240}}><NewTab tabId="new"/></div><div className="lit-page"><div className="lit-table-head" style={{gridTemplateColumns:width+'px'}}><span className="lit-column-head"><TagFilter/></span></div><div className="lit-row group/literature" style={{gridTemplateColumns:width+'px'}}><RowTags item={item} onUpdated={()=>{}} onMinimumWidth={measure}/></div></div><div data-testid="resource-filter" style={{width:180}}><LibraryFilter label="类型" value="" options={[]} onChange={()=>{}}/></div><div data-testid="empty-picker"><TagPicker tags={[]} linked={new Set()} onToggle={()=>{}} onCreate={async()=>{}}/></div><div className="group/library-toolbar" data-compact="true"><LibraryAction label="添加文献"/></div><Groups projectId="project" collections={[{id:'parent',name:'分组1'},{id:'child',name:'子分组',parent_id:'parent'}]} value="parent" onValueChange={()=>{}} onCollectionsChange={()=>{}} onReload={()=>{}}/></>;
          }
          createRoot(document.getElementById('root')).render(<I18nextProvider i18n={createLocalization('zh',resources)}><ToastProvider><Fixture/><ToolbarFixture/><Table density="compact" className={LIBRARY_TABLE_HEADER_CLASS} data-testid="shared-header"><TableHeader><TableRow><TableHead>名称</TableHead><TableHead><LibraryFilter label="来源" value="" options={[]} onChange={()=>{}}/></TableHead></TableRow></TableHeader><TableBody>{['一级','二级'].map(name=><TableRow key={name}><TableCell><Button variant="ghost">{name}</Button></TableCell><TableCell>过程产物</TableCell></TableRow>)}</TableBody></Table></ToastProvider></I18nextProvider>);`
          },
        },
        react(),
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
      page.on('pageerror', (error) => process.stderr.write(error.stack + '\n'))
      page.on('console', (message) => {
        if (message.type() === 'error') process.stderr.write(message.text() + '\n')
      })
      await page.goto(new URL('/__presentation', server.resolvedUrls!.local[0]).href, {
        waitUntil: 'domcontentloaded',
      })
      const choice = page.getByRole('button', { name: '项目文件', exact: true })
      await choice.waitFor({ state: 'visible' })
      page.setDefaultTimeout(5000)
      await choice.hover()
      await expect(choice).toHaveCSS('border-radius', '8px')
      const alignment = await choice.evaluate((element) => {
        const parent = element.parentElement!
        const bounds = parent.getBoundingClientRect()
        const divider = getComputedStyle(parent, '::after')
        const icons = element.querySelectorAll('svg')
        return {
          left: bounds.left + parseFloat(divider.left) - icons[0].getBoundingClientRect().left,
          right: bounds.right - parseFloat(divider.right) - icons[1].getBoundingClientRect().right,
        }
      })
      assert.ok(Math.abs(alignment.left) < 1 && Math.abs(alignment.right) < 1)
      const filter = page.getByRole('button', { name: '筛选标签', exact: true })
      const filterBounds = (await filter.boundingBox())!
      const headBounds = (await filter.locator('..').boundingBox())!
      assert.equal(filterBounds.x - headBounds.x, 8)
      const filterIcon = (await filter.locator('svg').boundingBox())!
      const resourceFilter = page.getByRole('button', { name: '类型', exact: true })
      const resourceBounds = (await resourceFilter.boundingBox())!
      assert.equal(resourceBounds.height, filterBounds.height)
      const resourceIcon = (await resourceFilter.locator('svg').boundingBox())!
      assert.equal(resourceIcon.width, filterIcon.width)
      for (const control of [filter, resourceFilter]) {
        const textGap = await control.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          const textNode = walker.nextNode()!
          const range = document.createRange()
          range.selectNodeContents(textNode)
          return (
            element.querySelector('svg')!.getBoundingClientRect().left -
            range.getBoundingClientRect().right
          )
        })
        assert.equal(textGap, 8)
      }
      const tags = page.getByTestId('literature-row-tags')
      await expect
        .poll(() => tags.evaluate((element) => element.clientWidth >= element.scrollWidth))
        .toBe(true)
      const text = tags.locator('.vds-tag > span').first()
      await expect
        .poll(() => text.evaluate((element) => element.clientWidth >= element.scrollWidth))
        .toBe(true)
      const chip = tags.locator('.vds-tag').first()
      const close = chip.getByRole('button', { name: '移除标签', exact: true, includeHidden: true })
      await expect(close).toHaveCSS('display', 'none')
      const before = (await chip.boundingBox())!.width
      await tags.hover()
      await expect(tags.getByRole('button', { name: '移除标签', exact: true })).toBeVisible()
      assert.ok((await chip.boundingBox())!.width > before)
      await page.getByTestId('resource-filter').hover()
      await expect(close).toHaveCSS('display', 'none')
      assert.equal((await chip.boundingBox())!.width, before)
      await expect(tags.getByText('+12', { exact: true })).toBeVisible()
      await expect(tags.locator('.vds-badge')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await tags.getByText('+12', { exact: true }).hover()
      await expect(tags.locator('.vds-badge')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(page.getByTestId('shared-header').locator('thead')).toHaveCSS('height', '42px')
      const table = page.getByTestId('shared-header')
      const colors = await table.evaluate((element) => {
        const resolve = (token: string) => {
          const probe = document.createElement('span')
          probe.style.color = `var(${token})`
          element.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        return {
          primary: resolve('--vds-text-primary'),
          tertiary: resolve('--vds-text-tertiary'),
        }
      })
      for (const cell of await table.locator('th, td, td button').all()) {
        await expect(cell).toHaveCSS('font-weight', '400')
      }
      for (const cell of await table.locator('thead th').all()) {
        await expect(cell).toHaveCSS('color', colors.tertiary)
      }
      const label = await table.locator('thead th').nth(1).locator('button span').boundingBox()
      await expect(table.locator('thead th').nth(1).locator('button')).toHaveCSS(
        'padding-left',
        '8px'
      )
      const cell = await table
        .locator('tbody tr')
        .first()
        .locator('td')
        .nth(1)
        .evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          return range.getBoundingClientRect().x
        })
      assert.ok(label && Math.abs(label.x - cell) < 1, JSON.stringify({ label, cell }))
      for (const row of await table.locator('tbody tr').all()) {
        await expect(row.locator(':scope > :first-child')).toHaveCSS('color', colors.primary)
        await expect(row.locator(':scope > :nth-child(2)')).toHaveCSS('color', colors.tertiary)
      }
      await page.getByTestId('empty-picker').getByRole('button').click()
      const empty = page.getByTestId('literature-tag-picker').getByText('暂无标签', { exact: true })
      await expect(empty).toBeVisible()
      await expect(empty).toHaveCSS('text-align', 'center')
      const emptySpacing = await empty.evaluate((element) => {
        const style = getComputedStyle(element)
        return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) }
      })
      assert.ok(emptySpacing.top >= 16)
      assert.equal(emptySpacing.top, emptySpacing.bottom)
      await page.keyboard.press('Escape')
      const toolbar = page.getByTestId('toolbar-fixture')
      const search = toolbar.getByRole('button', { name: '搜索文献', exact: true })
      const refresh = toolbar.getByRole('button', { name: '刷新资料库', exact: true })
      await expect(search).toHaveCSS(
        'color',
        await refresh.evaluate((element) => getComputedStyle(element).color)
      )
      const toolbarAction = toolbar.getByRole('button', { name: '添加测试文献', exact: true })
      for (const width of [100, 400, 100, 400]) {
        await toolbar.evaluate((element, next) => {
          element.style.width = next + 'px'
        }, width)
        await expect
          .poll(() => toolbar.locator('[data-compact]').getAttribute('data-compact'))
          .toBe(width === 100 ? 'true' : 'false')
        if (width === 100) {
          const bounds = (await toolbarAction.boundingBox())!
          assert.equal(bounds.width, bounds.height)
        }
      }
      const action = page.getByRole('button', { name: '添加文献', exact: true })
      const actionBounds = (await action.boundingBox())!
      assert.equal(actionBounds.width, actionBounds.height)
      await page.getByRole('button', { name: '文献分类', exact: true }).click()
      const group = page.getByTestId('literature-group-row').first()
      await group.hover()
      for (const button of await group.getByRole('button').all()) {
        await button.hover()
        const appearance = await button.evaluate((element) => {
          const icon = element.querySelector('svg')!
          const bounds = element.getBoundingClientRect()
          const iconBounds = icon.getBoundingClientRect()
          const probe = document.createElement('span')
          probe.style.color = 'var(--vds-icon-outline-default)'
          probe.style.backgroundColor = 'var(--vds-bg-white-hover-transparent)'
          element.append(probe)
          const expected = getComputedStyle(probe)
          const result = {
            offsetX: iconBounds.x + iconBounds.width / 2 - bounds.x - bounds.width / 2,
            offsetY: iconBounds.y + iconBounds.height / 2 - bounds.y - bounds.height / 2,
            color: getComputedStyle(icon).color,
            background: getComputedStyle(element).backgroundColor,
            expectedColor: expected.color,
            expectedBackground: expected.backgroundColor,
          }
          probe.remove()
          return result
        })
        assert.ok(Math.abs(appearance.offsetX) < 1 && Math.abs(appearance.offsetY) < 1)
        assert.equal(appearance.color, appearance.expectedColor)
        await expect(button).toHaveCSS('background-color', appearance.expectedBackground)
      }
      await group.getByRole('button', { name: '在分组1下新建子分组' }).hover()
      await expect(page.getByRole('tooltip').filter({ hasText: '新增分组' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1040, height: 660 })
      await expect
        .poll(() => tags.evaluate((element) => element.clientWidth >= element.scrollWidth))
        .toBe(true)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
