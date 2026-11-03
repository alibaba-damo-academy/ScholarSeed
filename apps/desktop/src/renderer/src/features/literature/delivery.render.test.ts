import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '/delivery-probe.tsx'
const scenario = JSON.parse(
  readFileSync(
    path.resolve(
      ROOT,
      '../../../../../skills/community/precise-literature-search/components/delivery.json'
    ),
    'utf8'
  )
)
const plugin: Plugin = {
  name: 'delivery-probe',
  resolveId(source) {
    return source === ENTRY ? ENTRY : null
  },
  async load(id) {
    if (id !== ENTRY) return null
    return (
      await transformWithEsbuild(
        `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import {createLocalization} from '/../../localization/engine'
      import {resources} from '/../../localization/resources'
      import {PluginInteraction} from '/components/business/Frame'
      import {PublicComponentsContext} from '/components/business/publicComponents'
      import {literaturePublicComponents} from '/features/literature/Component'
      import {cardRequest} from '/features/literature/operations'
      import {CARD_CAPABILITIES, CARD_ALLOWED_OPERATIONS} from '/features/literature/ports'
      import {Button} from '/components/ui'
      import '/styles.css'
      const scenario = ${JSON.stringify(scenario)}
      const globalScope = new URLSearchParams(location.search).has('global')
      const batch = {...scenario.state.batch, project_id:globalScope?'':scenario.state.batch.project_id, papers: Array.from({length:globalScope?20:18}, (_, index) => ({...scenario.state.batch.papers[0], paper_id:String(index)}))}
      window.deliveryCalls = []
      window.folderCalls = 0
      window.folderProjects = []
      window.leaseValid = true
      window.revocations = new Set()
      const denied = new URLSearchParams(location.search).has('denied')
      const mount = {
        fingerprint:'pinned-plugin',
        descriptor:{capabilities:['literature.read','literature.write','navigation.open'],components:[{
          id:'delivery',slot:'display.literature-delivery',public:true,
          actions:CARD_ALLOWED_OPERATIONS['literature-delivery'].filter(action=>!denied || action!=='save').map(id=>({id,capability:CARD_CAPABILITIES[id]}))
        }]},
        frames:{delivery:{lease:'delivery-lease',url:'about:blank'}},scenarios:{}
      }
      window.scholarseed = {
        deviceSkills:async request => ({status:request.operation==='plugin-valid' && !window.leaseValid?410:200,body:JSON.stringify(mount)}),
        onPluginRevoked:callback=>{window.revocations.add(callback); return ()=>window.revocations.delete(callback)}
      }
      const components = new Map(literaturePublicComponents.map(component=>[component.slot,component]))
      const ports = {
        projectId:globalScope?undefined:'sample-project', projectName:globalScope?undefined:'样例项目',
        projects:[{id:'sample-project',name:'样例项目'},{id:'other-project',name:'另一个项目'}],
        delivery:async () => {
          if (new URLSearchParams(location.search).has('scope-error')) throw new Error('plugin_card_scope_changed')
          if (new URLSearchParams(location.search).has('load-error')) throw new Error('network_error')
          return batch
        },
        collections:async () => [],
        folders:async (parent,offset,projectId) => {window.folderCalls++; window.folderProjects.push(projectId); return {resourceRoot:'', nodes:parent?[]:Array.from({length:30},(_, index)=>({path:'papers-'+index,name:'papers-'+index,kind:'dir'})), total:parent?0:30, offset:0}},
        pickDirectory:async () => window.pickerCanceled?{ok:false,canceled:true}:{ok:true,ticket:'selected-directory',label:'/test-output'},
        cancel:async () => {window.deliveryCalls.push('cancel'); return batch},
        save:async choice => {window.deliveryCalls.push(choice); return {ok:true,value:{...batch,state:'saved'}}},
      }
      function App() {
        const [scope,setScope] = useState(0)
        window.changeScope = ()=>setScope(scope+1)
        return <I18nextProvider i18n={createLocalization('zh',resources,{escapeValue:false})}>
          <Button onClick={()=>setScope(scope+1)}>切换卡片</Button>
          <div data-testid="card-boundary" style={{height:180,overflow:'hidden'}}>
            <PublicComponentsContext.Provider value={components}>
              <PluginInteraction reference={{plugin:'precise-literature-search',fingerprint:'pinned-plugin',component:'delivery',binding:'binding'}}
                data={{...scenario.data,scope,context:{projectId:ports.projectId,projectName:ports.projectName,projects:ports.projects}}} status="resolved" onAction={()=>undefined}
                onRequest={async(action,values,capability,authorize)=>{await authorize(); return cardRequest(ports)(action,values)}} />
            </PublicComponentsContext.Provider>
          </div>
        </I18nextProvider>
      }
      createRoot(document.getElementById('root')).render(<App />)
    `,
        'delivery-probe.tsx',
        { loader: 'tsx', jsx: 'automatic', tsconfigRaw: {} }
      )
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__delivery', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__delivery',
          `<div id="root"></div><script type="module" src="${ENTRY}"></script>`
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('host delivery escapes the card boundary and retains long-list, cancel, focus and save behavior', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'delivery',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.resolvedUrls!.local[0]}__delivery`)
    const trigger = page.getByRole('button', { name: '选择保存位置', exact: true })
    await trigger.click()
    const dialog = page.getByTestId('literature-delivery-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('card-boundary').getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('literature-delivery-card')).toHaveCount(1)
    await expect(page.locator('iframe')).toHaveCount(0)
    await expect(page.getByTestId('literature-delivery-footer')).toBeInViewport()
    await page.getByRole('button', { name: 'papers-29', exact: true }).click()
    await expect(page.getByTestId('delivery-project-folder')).toContainText('papers-29')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await page.getByRole('button', { name: '稍后保存', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await trigger.click()
    await page.getByRole('button', { name: 'papers-29', exact: true }).click()
    await page.getByRole('button', { name: '保存全文', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const calls = await page.evaluate(
      () => (window as unknown as { deliveryCalls: unknown[] }).deliveryCalls
    )
    assert.deepEqual(calls.slice(0, 2), ['cancel', 'cancel'])
    assert.equal((calls[2] as { parent: string }).parent, 'papers-29')
    await trigger.click()
    await page.evaluate(() => {
      ;(window as unknown as { leaseValid: boolean }).leaseValid = false
    })
    await page.getByRole('button', { name: '保存全文', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('保存操作未完成')
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { deliveryCalls: unknown[] }).deliveryCalls.length
      ),
      3
    )
    await page.evaluate(() => {
      ;(window as unknown as { revocations: Set<(lease: string) => void> }).revocations.forEach(
        (callback) => callback('delivery-lease')
      )
    })
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('card-boundary').getByRole('alert')).toBeVisible()
    assert.deepEqual(errors, [])

    await page.goto(`${server.resolvedUrls!.local[0]}__delivery?denied`)
    await trigger.click()
    await page.getByRole('button', { name: '保存全文', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('保存操作未完成')
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { deliveryCalls: unknown[] }).deliveryCalls),
      []
    )
    await page.evaluate(() => (window as unknown as { changeScope: () => void }).changeScope())
    await expect(dialog).toHaveCount(0)
    await page.goto(`${server.resolvedUrls!.local[0]}__delivery?global`)
    await trigger.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('已获取 20 篇全文')
    await expect(page.getByTestId('delivery-project-folder')).toHaveCount(0)
    assert.equal(
      await page.evaluate(() => (window as unknown as { folderCalls: number }).folderCalls),
      0
    )
    await expect(page.getByRole('button', { name: '保存全文', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('checkbox')).toHaveAccessibleName(
      '确保加入全局文献库（已有全文复用，删除后重新入库）'
    )
    await page.evaluate(() => {
      ;(window as unknown as { pickerCanceled: boolean }).pickerCanceled = true
    })
    await page.getByRole('button', { name: '选择本地文件夹…', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存全文', exact: true })).toBeDisabled()
    await page.evaluate(() => {
      ;(window as unknown as { pickerCanceled: boolean }).pickerCanceled = false
    })
    await page.getByRole('button', { name: '选择本地文件夹…', exact: true }).click()
    await expect(dialog).toContainText('/test-output')
    await page.getByRole('button', { name: '保存全文', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const globalCalls = await page.evaluate(
      () =>
        (window as unknown as { deliveryCalls: { target: string; ticket: string }[] }).deliveryCalls
    )
    assert.equal(globalCalls[0].target, 'directory')
    assert.equal(globalCalls[0].ticket, 'selected-directory')
    await trigger.click()
    await page.getByTestId('delivery-target-project').click()
    await page.getByRole('option', { name: '样例项目', exact: true }).click()
    await page.getByRole('button', { name: 'papers-29', exact: true }).click()
    await page.getByTestId('delivery-target-project').click()
    await page.getByRole('option', { name: '另一个项目', exact: true }).click()
    await expect(page.getByTestId('delivery-project-folder')).toHaveText('资料库 /')
    await expect(dialog.getByRole('checkbox')).toHaveAccessibleName(/另一个项目/)
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    const folderName = page.getByRole('textbox', { name: '新文件夹名称', exact: true })
    await expect(folderName).toHaveCount(1)
    await folderName.fill('../invalid')
    await folderName.press('Enter')
    await expect(page.getByRole('button', { name: '保存全文', exact: true })).toBeDisabled()
    await folderName.fill('验收目录')
    await folderName.press('Enter')
    await expect(page.getByTestId('delivery-project-folder')).toHaveText('资料库 /验收目录')
    await page.getByRole('button', { name: '保存全文', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const selectedChoice = await page.evaluate(() =>
      (window as unknown as { deliveryCalls: Record<string, unknown>[] }).deliveryCalls.at(-1)
    )
    assert.equal(selectedChoice?.project_id, 'other-project')
    assert.equal(selectedChoice?.parent, '验收目录')
    assert.equal(selectedChoice?.target, 'project')
    assert.ok(
      await page.evaluate(() =>
        (window as unknown as { folderProjects: string[] }).folderProjects.includes('other-project')
      )
    )
    for (const [query, message] of [
      ['scope-error', '全文交付与当前会话的项目归属不一致'],
      ['load-error', '无法读取全文交付信息'],
    ]) {
      await page.goto(`${server.resolvedUrls!.local[0]}__delivery?${query}`)
      await trigger.click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('literature-delivery-card')).toContainText(message)
    }
  } finally {
    await browser.close()
  }
})
