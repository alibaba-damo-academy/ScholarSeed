import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect, type Locator } from '@playwright/test'
import { createServer } from 'vite'

import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')

async function inside(control: Locator, viewport: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const bounds = await control.boundingBox()
      const container = await viewport.boundingBox()
      return (
        !!bounds &&
        !!container &&
        bounds.x >= container.x &&
        bounds.x + bounds.width <= container.x + container.width &&
        bounds.y >= container.y &&
        bounds.y + bounds.height <= container.y + container.height
      )
    })
    .toBe(true)
}

test(
  'project toolbar keeps search and explorer reachable across category and width changes',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
      create: (config) =>
        createServer({
          ...config,
          plugins: [
            {
              name: 'project-toolbar-fixture',
              enforce: 'pre',
              configureServer(server) {
                server.middlewares.use('/__project', async (_request, response) => {
                  response.setHeader('Content-Type', 'text/html')
                  response.end(
                    await server.transformIndexHtml(
                      '/__project',
                      '<div id="root"></div><script type="module" src="/__toolbar.tsx"></script>'
                    )
                  )
                })
              },
              resolveId(source) {
                if (source === '/__toolbar.tsx') return source
                if (source === '../../store') return '\0toolbar-store'
                if (source === '../../app/composition') return '\0toolbar-composition'
                if (source === '../workbench/workspace') return '\0toolbar-workspace'
              },
              load(id) {
                if (id === '\0toolbar-store')
                  return `import {useState} from 'react';
            export function useApp(){const [state,setState]=useState({activeTab:'files',tabs:[{id:'files',kind:'library'}]});return {state,set:patch=>setState(current=>({...current,...(typeof patch==='function'?patch(current):patch)}))}}`
                if (id === '\0toolbar-workspace')
                  return `export const useWorkspaceController=()=>({pageTabsInLeaf:()=>[],tabLocation:()=>({leafId:'leaf'}),openPageTab:()=>true})`
                if (id === '\0toolbar-composition')
                  return `import React from 'react';import {Viewer} from '/__toolbar.tsx';
            export const featureRegistry={viewers:{get:()=>({render:({active,path})=>React.createElement(Viewer,{active,category:path})})}}`
                if (id !== '/__toolbar.tsx') return
                return `import React,{useContext,useEffect,useState} from 'react';
            import {createRoot} from 'react-dom/client';
            import {createPortal} from 'react-dom';
            import {I18nextProvider} from 'react-i18next';
            import {createLocalization} from '/../../localization/engine';
            import {resources} from '/../../localization/resources';
            import {Library} from '/features/project/Library';
            import {Groups} from '/features/literature/Groups';
            import {LibraryToolbar,LibraryAction,LibrarySelectionChange,LibraryToolbarTarget} from '/components/business/Library';
            import {Button} from '/components/ui';
            import '/styles.css';
            export function Viewer({active,category}){
              const [query,setQuery]=useState('');const [selected,setSelected]=useState(false);
              const target=useContext(LibraryToolbarTarget);const onSelection=useContext(LibrarySelectionChange);
              useEffect(()=>{if(active)onSelection?.(selected);return()=>{if(active)onSelection?.(false)}},[active,selected,onSelection]);
              return <><output data-testid={category+'-query'}>{query}</output>
                {selected?(target&&createPortal(<Button onClick={()=>setSelected(false)}>取消多选</Button>,target)):
                <LibraryToolbar searchVisible query={query} onQuery={setQuery} placeholder="搜索项目文件" refreshing={false} onRefresh={()=>{}} leading={category==='literature'?<Groups projectId="project" collections={[]} value="all" onValueChange={()=>{}} onCollectionsChange={()=>{}} onReload={()=>{}}/>:undefined}>
                  <LibraryAction label="添加项目文件或文献" onClick={()=>setSelected(true)}/>
                </LibraryToolbar>}</>
            }
            createRoot(document.getElementById('root')).render(<I18nextProvider i18n={createLocalization('zh',resources)}>
              <div data-testid="pane" style={{width:300,height:240}}><Library tabId="files"/></div>
              <div data-testid="standalone"><LibraryToolbar query="" onQuery={()=>{}} placeholder="独立搜索" refreshing onRefresh={()=>{}}/></div>
            </I18nextProvider>);`
              },
            },
            ...(config.plugins ?? []),
          ],
        }),
    })
    context.after(fixture.close)
    const page = await fixture.page(context)
    page.on('pageerror', (error) => process.stderr.write(error.stack + '\n'))
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(message.text() + '\n')
    })
    page.setDefaultTimeout(5000)
    await page.goto(new URL('/__project', fixture.url).href)
    const pane = page.getByTestId('pane')
    const viewport = pane.getByTestId('project-library-toolbar-actions')
    const refresh = pane.getByRole('button', { name: '刷新资料库', exact: true })
    const explorer = pane.getByTestId('project-library-explorer')
    const categorySelect = pane.getByRole('combobox', { name: '文件分类', exact: true })
    await expect(categorySelect).toBeVisible()
    for (const [label, category] of [
      ['资料', 'materials'],
      ['文献', 'literature'],
      ['任务产物', 'outputs'],
    ]) {
      await categorySelect.click()
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect(refresh).toHaveCount(0)
      await expect(explorer).toHaveAccessibleName('项目资源管理器')
      const search = pane.getByRole('button', { name: '搜索项目文件', exact: true })
      const input = page.getByRole('searchbox', { name: '搜索项目文件', exact: true })
      const add = pane.getByRole('button', { name: '添加项目文件或文献', exact: true })
      const addLabel = add.locator('[data-library-action-label]')
      const explorerLabel = explorer.locator('[data-library-action-label]')
      for (const width of [300, 360, 480, 900, 260, 300]) {
        await pane.evaluate((element, next) => {
          element.style.width = `${next}px`
        }, width)
        await inside(search, viewport)
        await inside(explorer, viewport)
        await expect(add).toBeInViewport({ ratio: 1 })
        await expect(explorer.locator('svg')).toBeVisible()
        await expect
          .poll(async () => (await explorerLabel.isVisible()) === (await addLabel.isVisible()))
          .toBe(true)
        if (width <= 300) await expect(explorerLabel).toBeHidden()
        if (width === 900) await expect(explorerLabel).toBeVisible()
        const explorerBounds = (await explorer.boundingBox())!
        const searchBounds = (await search.boundingBox())!
        assert.ok(
          Math.abs(
            explorerBounds.y +
              explorerBounds.height / 2 -
              (searchBounds.y + searchBounds.height / 2)
          ) < 2
        )
        if (!(await explorerLabel.isVisible())) {
          const addBounds = (await add.boundingBox())!
          const divider = (await pane
            .getByTestId('project-library-explorer-divider')
            .boundingBox())!
          assert.equal(explorerBounds.width, explorerBounds.height)
          assert.equal(explorerBounds.width, addBounds.width)
          assert.ok(
            Math.abs(
              divider.x -
                addBounds.x -
                addBounds.width -
                (explorerBounds.x - divider.x - divider.width)
            ) < 1
          )
        }
        if (category === 'literature') {
          const filter = pane.getByRole('button', { name: '文献分类', exact: true })
          await inside(filter, viewport)
          const navigation = width === 900 ? pane.getByRole('tablist') : categorySelect
          const navigationBounds = (await navigation.boundingBox())!
          const filterBounds = (await filter.boundingBox())!
          assert.ok(Math.abs(filterBounds.x - navigationBounds.x - navigationBounds.width - 4) < 2)
        }
        if (width === 900) {
          await expect(categorySelect).toHaveCount(0)
          await expect(pane.getByRole('tab', { name: label, exact: true })).toBeVisible()
          await expect(addLabel).toBeVisible()
          await expect(input).toHaveCount(0)
          await search.click()
          await expect(input).toBeFocused()
          await expect(search).toHaveCount(0)
          await inside(input, viewport)
          await expect(addLabel).toBeHidden()
          await expect(explorerLabel).toBeHidden()
          await input.fill(category)
          await page.keyboard.press('Tab')
          await expect(add).toBeFocused()
          await expect(input).toHaveCount(0)
          await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await expect(search).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
          await search.click()
          await expect(input).toBeFocused()
          await expect(input).toHaveValue(category)
          await page.keyboard.press('Escape')
          await expect(search).toBeFocused()
          await expect(input).toHaveCount(0)
        } else {
          await inside(categorySelect, viewport)
          const categoryBounds = (await categorySelect.boundingBox())!
          assert.ok(
            Math.abs(
              categoryBounds.y +
                categoryBounds.height / 2 -
                (searchBounds.y + searchBounds.height / 2)
            ) < 2,
            JSON.stringify({ width, category, categoryBounds, searchBounds })
          )
        }
      }
      await search.click()
      await input.fill(category)
      await expect(search).toHaveCount(0)
      await expect(pane.getByTestId(`${category}-query`)).toHaveText(category)
      await explorer.focus()
      await expect(explorer).toBeFocused()
      await expect(input).toHaveCount(0)
      await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(search).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
      await add.click()
      await expect(explorer).toHaveCount(0)
      await expect(refresh).toHaveCount(0)
      await pane.getByRole('button', { name: '取消多选', exact: true }).click()
      await inside(search, viewport)
      await inside(explorer, viewport)
    }
    await expect(
      page.getByTestId('standalone').getByRole('button', { name: '刷新资料库' })
    ).toBeDisabled()
    assert.equal(await refresh.count(), 0)
  }
)
