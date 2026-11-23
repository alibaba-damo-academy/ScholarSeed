import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite'
import { renderConfig } from '../../../../test-helpers/render.ts'
import { RENDERER_OPTIMIZE_DEPS } from '../../../../../renderer.ts'
import { build } from 'esbuild'
import {
  PLUGIN_MESSAGE_CHANNEL,
  PLUGIN_FRAME_START_TIMEOUT_MS,
  PLUGIN_GESTURE_TTL_MS,
  PLUGIN_MAX_PLOT_BYTES,
} from '../../../../plugins.ts'
import { createPreviewSession } from './preview.ts'
import type { PluginScenario } from '../../../../plugins.ts'
import { renderFixture, renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const createServer = (config: InlineConfig) =>
  createViteServer(
    renderConfig({
      ...config,
      optimizeDeps: RENDERER_OPTIMIZE_DEPS,
    })
  )

test(
  'fixed OpenUI layout renders two inputs through the Desktop renderer without a frame',
  { timeout: 180_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const target = new URL(
      '/components/business/plugin.render.fixture.html?mode=fixed-openui',
      fixture.url
    )
    for (const current of ['15 days', '21 days']) {
      target.searchParams.set('current', current)
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'ready')
      await expect(page.getByText('Previous', { exact: true })).toBeVisible()
      await expect(page.getByText('Current', { exact: true })).toBeVisible()
      await expect(page.getByText('10 days', { exact: true })).toBeVisible()
      await expect(page.getByText(current, { exact: true })).toBeVisible()
      await expect(page.locator('iframe')).toHaveCount(0)
    }
  }
)

test(
  'declarative content rejects a missing root without reporting an unavailable plugin',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const target = new URL(
      '/components/business/plugin.render.fixture.html?mode=declarative',
      fixture.url
    )
    const source = 'Conversation([TextContent("晚餐备选")])'
    target.searchParams.set('source', source)
    await page.goto(target.href)
    await expect(page.locator('[data-conversation-ui]')).toHaveAttribute(
      'data-error',
      'openui_description_invalid'
    )
    await expect(page.getByRole('alert')).toHaveText('这段对话内容无法显示。')

    target.searchParams.set('source', 'root = ' + source)
    await page.goto(target.href)
    await expect(page.getByText('晚餐备选')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
)

test(
  'explicit card copy requires authenticated trusted clicks, current revision and binding without replacing registered text',
  { timeout: 60_000 },
  async () => {
    const work = path.resolve(ROOT, '../../../../../work/ui-runtime-repair')
    await mkdir(work, { recursive: true })
    const directory = await mkdtemp(path.join(work, 'copy-container-'))
    const containerModule = path.join(directory, 'container.cjs')
    await build({
      entryPoints: [path.resolve(ROOT, '../../main/plugins.ts')],
      outfile: containerModule,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: [createRequire(import.meta.url).resolve('electron')],
      alias: { electron: createRequire(import.meta.url).resolve('electron') },
    })
    const { container } = createRequire(import.meta.url)(containerModule) as {
      container: (entry: string, lease: string) => string
    }
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: container('entry.js', lease!),
        })
      })
      await page.route('**/entry.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `
          document.getElementById('root').innerHTML='<button>Copy source</button><output></output>';
          const lease=new URL(location.href).searchParams.get('lease');
          let revision=0; let sequence=0;
          window.replies=[];
          window.send=(extra={},id='copy-'+(++sequence))=>parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease,requestId:id,revision,copyText:'source text',...extra},'*');
          addEventListener('message',event=>{
            if(event.data.state)revision=event.data.state.revision;
            if(event.data.requestId){window.replies.push(event.data);document.querySelector('output').textContent=event.data.error||'copied';}
          });
          document.querySelector('button').onclick=()=>{
            if(window.delay)setTimeout(()=>window.send(),window.delay);
            else{window.send(window.extra,window.sameId);if(window.duplicate)window.send(window.extra,window.sameId);}
          };
        `,
        })
      )
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=copy',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
      await page.evaluate('window.fixture.resolve()')
      await page.evaluate(() => {
        const host = window as unknown as {
          scholarseed: {
            deviceSkills: (request: {
              operation: string
            }) => Promise<{ status: number; body: string }>
          }
          fixture: { valid?: boolean }
        }
        host.fixture.valid = true
        const original = host.scholarseed.deviceSkills
        host.scholarseed.deviceSkills = async (request) => {
          const response = await original(request)
          if (request.operation === 'plugin-valid' && !host.fixture.valid)
            return { status: 410, body: '{}' }
          return response
        }
      })
      const guest = page.frameLocator('iframe')
      await expect(guest.getByRole('button', { name: 'Copy source' })).toBeVisible()
      const frame = page.frames().find((candidate) => candidate.url().includes('/guest.html'))!
      await frame.evaluate('window.send()')
      await expect(guest.locator('output')).toHaveText('plugin_copy_gesture_required')
      assert.deepEqual(await page.evaluate('window.fixture.copied'), [])
      await page.locator('body').click({ position: { x: 1, y: 1 } })
      await frame.evaluate('window.focus();document.querySelector("button").focus();window.send()')
      await expect(guest.locator('output')).toHaveText('plugin_copy_gesture_required')
      await frame.evaluate(
        `parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:new URL(location.href).searchParams.get('lease'),gesture:'init',secret:'f'.repeat(64)},'*');parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:new URL(location.href).searchParams.get('lease'),gesture:'proof',secret:'f'.repeat(64),sequence:999},'*');window.send()`
      )
      await expect(guest.locator('output')).toHaveText('plugin_copy_gesture_required')
      await frame.evaluate(
        'document.querySelector("button").dispatchEvent(new MouseEvent("click",{bubbles:true}))'
      )
      await expect(guest.locator('output')).toHaveText('plugin_copy_gesture_required')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect(guest.locator('output')).toHaveText('copied')
      assert.deepEqual(await page.evaluate('window.fixture.copied'), ['source text'])
      for (const key of ['Enter', 'Space']) {
        await guest.getByRole('button', { name: 'Copy source' }).press(key)
        await expect
          .poll(() => page.evaluate('window.fixture.copied.length'))
          .toBe(key === 'Enter' ? 2 : 3)
      }
      assert.equal(
        await frame.evaluate(
          'Array.from(document.scripts).some(script=>/[a-f0-9]{64}/.test(script.textContent))'
        ),
        false
      )
      assert.equal(await frame.evaluate('window.replies.some(reply=>"secret" in reply)'), false)
      await page.evaluate(`window.fixture.exports=[];window.fixture.exportResult={ok:true};
        window.scholarseed.saveFileCopy=async request=>{
          window.fixture.exports.push({name:request.suggestedName,svg:new TextDecoder().decode(request.bytes)});
          return window.fixture.exportResult;
        }`)
      await frame.evaluate(`window.originalSend=window.send;
        window.originalTimer=window.setTimeout;window.exportTimers=[];
        window.setTimeout=(callback,delay,...args)=>{window.exportTimers.push(delay);return window.originalTimer(callback,delay,...args)};
        window.chartSVG='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="16" height="100" fill="#888858"/><text>Mass (kg)</text></svg>';
        window.plot={svg:window.chartSVG.replace('<rect width="16" height="100" fill="#888858"/>','<rect width="640" height="300" fill="#faf8f4"/><svg><rect width="16" height="100" fill="#888858"/></svg>')};
        window.send=()=>window.plugin.exportPlot(window.plot).then(result=>{window.exportResult=result;document.querySelector('output').textContent=JSON.stringify(result)}).catch(error=>document.querySelector('output').textContent=error.message);`)
      await frame.evaluate('window.send()')
      await expect(guest.locator('output')).toHaveText('plot_export_gesture_required')
      assert.equal(await page.evaluate('window.fixture.exports.length'), 0)
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => frame.evaluate('window.exportResult?.ok')).toBe(true)
      const exported = (await page.evaluate('window.fixture.exports[0]')) as {
        name: string
        svg: string
      }
      assert.equal(exported.name, 'chart.svg')
      assert.doesNotMatch(exported.svg, /#faf8f4/)
      assert.match(exported.svg, /<rect width="16" height="100" fill="#888858"/)
      await page.evaluate('window.fixture.exportResult={ok:false,canceled:true}')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => frame.evaluate('window.exportResult?.canceled')).toBe(true)
      await page.evaluate(
        'window.fixture.exportResult={ok:false,error:"private filesystem detail"}'
      )
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect
        .poll(() => frame.evaluate('window.exportResult?.error'))
        .toBe('plot_export_save_failed')
      for (const svg of [
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.org/track.svg)"/></svg>',
      ]) {
        await frame.evaluate('window.plot.svg=' + JSON.stringify(svg))
        await guest.getByRole('button', { name: 'Copy source' }).click()
        await expect(guest.locator('output')).toHaveText('plot_export_invalid')
      }
      assert.equal(await page.evaluate('window.fixture.exports.length'), 3)
      await frame.evaluate(`window.plot.svg='x'.repeat(${PLUGIN_MAX_PLOT_BYTES})`)
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect(guest.locator('output')).toHaveText('plugin_request_limit')
      assert.equal(await page.evaluate('window.fixture.exports.length'), 3)
      await frame.evaluate('window.plot.svg=window.chartSVG')
      await page.evaluate('window.fixture.valid=false')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect(guest.locator('output')).toHaveText('plugin_instance_revoked')
      assert.equal(await page.evaluate('window.fixture.exports.length'), 3)
      await page.evaluate('window.fixture.valid=true')
      await frame.evaluate(
        `window.plot={model:{kind:'bar',x:0,y:[1],dataset:{columns:[{key:'name',label:'Method'},{key:'value',label:'Mass',unit:'kg'}],rows:[{id:'a',values:['A',2]}]}},width:1000,height:600,title:'Pinned chart',sources:['Private source'],version:'old-revision'}`
      )
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => page.evaluate('window.fixture.exports.length')).toBe(4)
      const legacy = await page.evaluate<string>('window.fixture.exports[3].svg')
      assert.match(legacy, /Pinned chart/)
      assert.doesNotMatch(legacy, /Private source|old-revision/)
      assert.doesNotMatch(legacy, /<rect width="100%" height="100%"/)
      assert.deepEqual(await frame.evaluate('window.exportTimers'), [])
      await page.evaluate(`window.fixture.images=[];
        window.scholarseed.writeClipboardImage=async bytes=>{window.fixture.images.push(bytes);return {ok:true}}`)
      await frame.evaluate(`window.plot={svg:window.chartSVG}; window.send=()=>window.plugin.copyPlot(window.plot)
        .then(result=>document.querySelector('output').textContent=String(result.ok))
        .catch(error=>document.querySelector('output').textContent=error.message)`)
      await frame.evaluate('window.send()')
      await expect(guest.locator('output')).toHaveText('plot_export_gesture_required')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => page.evaluate('window.fixture.images.length')).toBe(1)
      const pixels = await page.evaluate(`(async()=>{
        const bytes=window.fixture.images[0];
        const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        const canvas=document.createElement('canvas');
        canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        return {foreground:context.getImageData(8,8,1,1).data[3],background:context.getImageData(100,100,1,1).data[3],count:window.fixture.images.length};
      })()`)
      assert.deepEqual(pixels, { foreground: 255, background: 0, count: 1 })
      await frame.evaluate('window.send=window.originalSend;window.setTimeout=window.originalTimer')
      await frame.evaluate('window.extra={revision:99}')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect(guest.locator('output')).toHaveText('plugin_copy_unavailable')
      await frame.evaluate('window.send()')
      await expect(guest.locator('output')).toHaveText('plugin_copy_gesture_required')
      await frame.evaluate('window.extra={};window.duplicate=true;window.sameId="duplicate"')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => page.evaluate('window.fixture.copied.length')).toBe(4)
      await expect
        .poll(() =>
          frame.evaluate('window.replies.filter(reply=>reply.requestId==="duplicate").length')
        )
        .toBe(1)
      await frame.evaluate(
        'window.duplicate=false;window.sameId=undefined;window.delay=' +
          String(PLUGIN_GESTURE_TTL_MS + 100)
      )
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect
        .poll(() => frame.evaluate('window.replies.at(-1)?.error'))
        .toBe('plugin_copy_gesture_required')
      await frame.evaluate('window.delay=0')
      await page.evaluate('window.fixture.valid=false')
      await guest.getByRole('button', { name: 'Copy source' }).click()
      await expect(guest.locator('output')).toHaveText('plugin_instance_revoked')
      await frame.evaluate(
        'parent.postMessage({channel:"scholarseed:component",lease:new URL(location.href).searchParams.get("lease"),requestId:"undeclared",action:"open-results",values:{}},"*")'
      )
      await expect(guest.locator('output')).toHaveText('plugin_capability_undeclared')
      await frame.evaluate('window.send({lease:"old-lease"},"wrong-lease")')
      await frame.evaluate('window.send({},"barrier")')
      await expect
        .poll(() => frame.evaluate('window.replies.some(reply=>reply.requestId==="barrier")'))
        .toBe(true)
      assert.equal(
        await frame.evaluate('window.replies.some(reply=>reply.requestId==="wrong-lease")'),
        false
      )
      assert.equal(
        await page.evaluate(
          'window.fixture.requests.filter(request=>request.operation==="plugin-copy" && request.content).length'
        ),
        0
      )
      assert.deepEqual(await page.evaluate('window.fixture.copied'), Array(4).fill('source text'))
      await page.evaluate('window.fixture.revoke()')
      await expect(page.locator('iframe')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
test(
  'live frame themes follow host data attributes without remounting or losing local edits',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<meta charset="utf-8"><input aria-label="草稿"><script>addEventListener("message", event => { if(event.data.state) document.body.dataset.theme=event.data.state.theme })</script>',
        })
      )
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=readonly',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      const guest = page.frameLocator('iframe')
      await expect(guest.locator('body')).toHaveAttribute('data-theme', 'light')
      await guest.getByRole('textbox', { name: '草稿' }).fill('保留局部编辑')
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme
        }, theme)
        await expect(guest.locator('body')).toHaveAttribute('data-theme', theme)
        await expect(guest.getByRole('textbox', { name: '草稿' })).toHaveValue('保留局部编辑')
      }
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await expect(page.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
for (const mode of ['draft-preview', 'draft-boundary']) {
  test(
    `custom frame keeps field definitions separate from saved values in ${mode}`,
    {
      timeout: 60_000,
    },
    async () => {
      const server = await servers.create({
        cacheKey: 'plugin',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        const page = await browser.newPage()
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<meta charset="utf-8"><input aria-label="研究约束"><button>保存草稿</button><output></output>
            <script>
              const input = document.querySelector('input');
              const button = document.querySelector('button');
              const output = document.querySelector('output');
              let sequence = 0;
              addEventListener('message', ({ data: message }) => {
                if (!message.state) return;
                const { data, draft, revision } = message.state;
                output.textContent = data.fields.map(field => field.label).join(',') + ':' + revision;
                input.value = draft.fields?.notes ?? '';
              });
              button.onclick = () => parent.postMessage({
                channel: '${PLUGIN_MESSAGE_CHANNEL}', lease: '${lease}',
                requestId: 'draft-' + ++sequence, draft: { fields: { notes: input.value } }
              }, '*');
            </script>`,
          })
        })
        await page.goto(
          new URL(
            `/components/business/plugin.render.fixture.html?mode=${mode}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
        await page.evaluate('window.fixture.resolve()')
        const guest = page.frameLocator('iframe')
        const notes = guest.getByRole('textbox', { name: '研究约束' })
        await expect(guest.locator('output')).toHaveText('研究约束:0')
        for (const [index, value] of ['初稿', ''].entries()) {
          await notes.fill(value)
          await guest.getByRole('button', { name: '保存草稿' }).click()
          await expect(guest.locator('output')).toHaveText(`研究约束:${index + 1}`)
          await expect(notes).toHaveValue(value)
        }
        if (mode === 'draft-boundary') {
          assert.deepEqual(await page.evaluate('window.fixture.draft'), { fields: { notes: '' } })
        }
      } finally {
        await browser.close()
        await server.close()
      }
    }
  )
}

const REVIEW_PACKAGE = path.resolve(
  ROOT,
  '../../../../../skills/community/literature-review/components'
)
const PACKAGE_ROOT = path.resolve(REVIEW_PACKAGE, '../..')
const { buildOfficialUI } = createRequire(import.meta.url)(
  path.resolve(PACKAGE_ROOT, '../../packages/ui/build.cjs')
)
const BUILTIN_PACKAGES = [
  'agentic-search',
  'precise-literature-search',
  'literature-review',
  'research-idea-partner',
]
test(
  'authorization selection validation remains independent of button appearance',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const decision of ['authorize', 'reject']) {
        const page = await browser.newPage()
        await page.goto(
          new URL(
            '/components/business/plugin.render.fixture.html?mode=authorization',
            server.resolvedUrls!.local[0]
          ).href
        )
        const authorize = page.getByRole('button', { name: '确认授权', exact: true })
        const reject = page.getByRole('button', { name: '拒绝', exact: true })
        const selectAll = page.getByTestId('hil-subset-all-0')
        await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
        await expect(authorize).toBeEnabled()
        const toggle = page.getByTestId('hil-question-toggle')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await toggle.click()
        await expect(selectAll).toBeChecked()
        await selectAll.click()
        await expect(authorize).toBeDisabled()
        await expect(reject).toBeEnabled()
        await page.getByRole('checkbox', { name: '论文一', exact: true }).click()
        await expect(authorize).toBeEnabled()
        await expect(authorize).toHaveAttribute('type', 'button')
        await expect(reject).toHaveAttribute('type', 'button')
        await expect(reject).not.toHaveClass((await authorize.getAttribute('class')) ?? '')
        if (decision === 'reject') {
          await page.getByRole('checkbox', { name: '论文一', exact: true }).click()
          await expect(authorize).toBeDisabled()
          await expect(reject).toBeEnabled()
        }
        await (decision === 'authorize' ? authorize : reject).click()
        assert.deepEqual(await page.evaluate('window.fixture.requests.at(-1)'), {
          answers: {
            'precise-search-fulltext:fixture': decision === 'authorize' ? '一键授权' : '拒绝',
          },
          values: { selected_paper_ids: decision === 'authorize' ? ['one'] : [] },
        })
        await expect(authorize).toHaveCount(0)
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'isolated cards register text without clipboard access and replies copy persisted content without a frame',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<p>证据卡正文</p><button id="register">登记文本</button><output></output><script>
        let revision = 0;
        addEventListener('message', event => { if (event.data.state) revision = event.data.state.revision; if (event.data.requestId) document.querySelector('output').textContent = event.data.error || '已登记'; });
        document.querySelector('button').onclick = () => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',requestId:'copy-current',revision,copy:{text:'证据卡正文'}}, '*');
      </script>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=copy',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
      await page.evaluate('window.fixture.resolve()')
      const guest = page.frameLocator('iframe')
      await expect(guest.getByText('证据卡正文')).toBeVisible()
      await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect.poll(() => page.evaluate('window.fixture.copied.at(-1)')).toContain('阅读开始')
      const copiedBeforeRegistration = await page.evaluate<number>('window.fixture.copied.length')
      await guest.getByRole('button', { name: '登记文本' }).click()
      await expect(guest.locator('output')).toHaveText('已登记')
      assert.equal(await page.evaluate('window.fixture.copied.length'), copiedBeforeRegistration)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect
        .poll(() => page.evaluate('window.fixture.copied.at(-1)'))
        .toBe('阅读开始\n\n证据卡正文\n\n阅读结论')
      assert.equal(
        await page.evaluate('window.fixture.copied.length'),
        copiedBeforeRegistration + 1
      )
      await page.getByRole('button', { name: '切换卡片' }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect
        .poll(() => page.evaluate('window.fixture.copied.at(-1)'))
        .toBe('阅读开始\n\n证据卡正文\n\n阅读结论')
      assert.deepEqual(errors, [])
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=copy&clipboard-failed=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
      await page.evaluate('window.fixture.resolve()')
      await page.frameLocator('iframe').getByRole('button', { name: '登记文本' }).click()
      await expect(page.frameLocator('iframe').locator('output')).toHaveText('已登记')
      await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect(page.getByTestId('reply-copy-with-cards')).toHaveAttribute(
        'data-copy-status',
        'error'
      )
      assert.deepEqual(await page.evaluate('window.fixture.copied'), [])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'paged questions skip the current answer and retain earlier choices',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=pagination',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByText(/^1\. 选择阅读目标/)).toBeVisible()
      await expect(page.getByText(/^2\. 选择阅读深度/)).toHaveCount(0)
      const first = page.getByRole('radio', { name: '理解方法 关注假设和方法细节' })
      await expect(first).not.toBeChecked()
      await first.click()
      await expect(page.getByTestId('hil-question-confirm')).toHaveCount(0)
      await page.getByTestId('hil-question-next').click()
      await expect(page.getByTestId('hil-question-confirm')).toBeDisabled()
      await expect(page.getByTestId('hil-question-previous')).toBeVisible()
      await expect(first).toHaveCount(0)
      await page.getByRole('radio', { name: '深入阅读', exact: true }).click()
      await page.getByTestId('hil-question-skip').click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(await page.evaluate('window.fixture.requests.at(-1).answers'), {
        goal: '理解方法',
      })
      await expect(page.getByTestId('hil-question-next')).toHaveCount(0)
      await expect(page.getByTestId('hil-question-pages')).toHaveCount(0)
      await expect(page.getByText('深入阅读', { exact: true })).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'paged questions retain choices and supplements on return and submit the latest edits',
  { timeout: 60_000 },
  async (context) => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    context.after(async () => {
      await browser.close()
      await server.close()
    })
    const page = await browser.newPage()
    await page.goto(
      new URL(
        '/components/business/plugin.render.fixture.html?mode=pagination',
        server.resolvedUrls!.local[0]
      ).href
    )
    const previous = page.getByTestId('hil-question-previous')
    const next = page.getByTestId('hil-question-next')
    const firstText = page.getByTestId('hil-question-other-0')
    const secondText = page.getByTestId('hil-question-other-1')
    await expect(previous).toHaveCount(0)
    await page.getByTestId('hil-question-skip').click()
    await previous.click()
    await page.getByRole('radio', { name: '理解方法 关注假设和方法细节' }).click()
    await firstText.fill('保留方法细节')
    await next.click()
    await expect(page.getByTestId('hil-question-actions').getByRole('button')).toHaveText([
      '跳过',
      '上一项',
      '提交',
    ])
    await page.getByRole('radio', { name: '深入阅读', exact: true }).click()
    await secondText.fill('保留深度说明')
    await previous.focus()
    await page.keyboard.press('Enter')
    await expect(firstText).toHaveValue('保留方法细节')
    await expect(page.getByRole('radio', { name: '理解方法 关注假设和方法细节' })).toBeChecked()
    await expect(previous).toHaveCount(0)
    await page.getByRole('radio', { name: '复现实验', exact: true }).click()
    await firstText.fill('修改后的方法说明')
    await next.click()
    await expect(secondText).toHaveValue('保留深度说明')
    await expect(page.getByRole('radio', { name: '深入阅读', exact: true })).toBeChecked()
    await previous.click()
    await expect(firstText).toHaveValue('修改后的方法说明')
    await expect(page.getByRole('radio', { name: '复现实验', exact: true })).toBeChecked()
    await next.click()
    await page.getByTestId('hil-question-confirm').click()
    await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
    assert.deepEqual(await page.evaluate('window.fixture.requests.at(-1).answers'), {
      goal: '复现实验\n修改后的方法说明',
      depth: '深入阅读\n保留深度说明',
    })
    await expect(previous).toHaveCount(0)
  }
)
for (const changeScope of [false, true])
  test(
    `parent renders preserve local edits without weakening changed scope rejection: ${changeScope}`,
    { timeout: 60_000 },
    async () => {
      const server = await servers.create({
        cacheKey: 'plugin',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        const page = await browser.newPage()
        const submissionDiagnostics: string[] = []
        page.on('console', (message) => {
          if (message.text().startsWith('[plugin-submit]'))
            submissionDiagnostics.push(message.text())
        })
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<input aria-label="编辑"><button id="submit">确认编辑</button><button id="request">调用能力</button><output></output><p id="status"></p><script>
        const send = payload => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',...payload}, '*');
        addEventListener('message', event => {
          if (event.data.state) { document.querySelector('input').value = event.data.state.data.initial; document.querySelector('#status').textContent = event.data.state.status; }
          if (event.data.requestId) document.querySelector('output').textContent = event.data.error || event.data.result.value;
        });
        document.querySelector('#submit').onclick = () => send({action:'select', values:{value:document.querySelector('input').value}});
        document.querySelector('#request').onclick = () => send({requestId:'request-one',action:'select',values:{value:'completed'}});
      </script>`,
          })
        })
        await page.goto(
          new URL(
            '/components/business/plugin.render.fixture.html?mode=state-refresh',
            server.resolvedUrls!.local[0]
          ).href
        )
        const guest = page.frameLocator('iframe')
        await expect(guest.getByRole('textbox')).toHaveValue('original')
        await guest.getByRole('textbox').fill('edited')
        await guest.getByRole('button', { name: '调用能力' }).click()
        await expect
          .poll(() =>
            page.evaluate(
              'window.fixture.requests.filter(item => item.operation === "plugin-valid").length'
            )
          )
          .toBeGreaterThan(0)
        await page.getByRole('button', { name: '父级重绘' }).click()
        await expect(page.getByTestId('refresh')).toHaveText('1')
        await expect(guest.getByRole('textbox')).toHaveValue('edited')
        if (changeScope) {
          await page.getByRole('button', { name: '修改业务数据' }).click()
          await expect(guest.getByRole('textbox')).toHaveValue('changed')
        }
        await page.evaluate('window.fixture.resolve()')
        await expect(guest.locator('output')).toHaveText(
          changeScope ? 'plugin_card_scope_changed' : 'completed'
        )
        await guest.getByRole('button', { name: '确认编辑' }).click()
        await expect(page.getByTestId('selected')).toHaveText('true')
        assert.deepEqual(await page.evaluate('window.submittedValues'), {
          value: changeScope ? 'changed' : 'edited',
        })
        for (const stage of ['received', 'authorized', 'dispatched']) {
          assert.ok(
            submissionDiagnostics.some((message) => message.includes(`"stage":"${stage}"`)),
            stage
          )
        }
        assert.ok(
          submissionDiagnostics.every(
            (message) => !message.includes('edited') && !message.includes('original')
          )
        )
        await page.getByRole('button', { name: '更新状态' }).click()
        await expect(guest.locator('#status')).toHaveText('resolved')
      } finally {
        await browser.close()
        await server.close()
      }
    }
  )
test(
  'preview validates before resolving and retries the same retained answer',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{feedback:'keep scope'}},'*')">提交范围</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installed&fail-validation=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe'), await page.locator('body').innerText()).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '提交范围' }).click()
      await expect(page.getByTestId('hil-card'))
        .toHaveAttribute('data-hil-state', 'failed')
        .catch(async (error) => {
          throw new Error(
            `${String(error)}\nRequests: ${JSON.stringify(await page.evaluate('window.fixture.requests'))}`
          )
        })
      await expect(page.getByTestId('hil-card')).toContainText('component.output_schema')
      await page.frameLocator('iframe').getByRole('button', { name: '提交范围' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-validate").map(request => request.values)'
        ),
        [{ feedback: 'keep scope' }, { feedback: 'keep scope' }]
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'revision-pinned public resources use the isolated frame and persist selection under StrictMode',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['one']}},'*')">选择论文</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=external-public',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await expect(page.getByTestId('external-selection')).toHaveText('true')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").at(-1).values'
        ),
        { selected_paper_ids: ['one'] }
      )
      assert.equal(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-open")[0].reference.fingerprint'
        ),
        'ui-release-one'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'hosted presentation retains pinned binding and restores subset draft before edits',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=external-native',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.getByTestId('hil-subset-paper-0-one')).toBeChecked()
      await expect(page.getByTestId('hil-subset-paper-0-two')).not.toBeChecked()
      await expect(page.locator('iframe')).toHaveCount(0)
      await page.getByTestId('hil-subset-paper-0-two').click()
      await expect(page.getByTestId('hil-subset-paper-0-two')).toBeChecked()
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").at(-1).values'
        ),
        { selected_paper_ids: ['one', 'two'] }
      )
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.find(request => request.operation === "plugin-open").reference'
        ),
        {
          plugin: 'host',
          component: 'literature.selection',
          fingerprint: 'ui-release-one',
          binding: 'fixed-public-binding',
        }
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

let publicServer: ViteDevServer | undefined
let officialResources: string | undefined
after(async () => {
  await publicServer?.close()
  if (officialResources) await rm(officialResources, { recursive: true, force: true })
})

async function loadOfficialRuntime(page: Page): Promise<void> {
  if (!officialResources) {
    officialResources = await mkdtemp(path.join(os.tmpdir(), 'official-preview-'))
    await buildOfficialUI(officialResources)
  }
  await page.route('http://plugin.test/__ui__/**', (route) => {
    const asset = new URL(route.request().url()).pathname.slice('/__ui__/'.length)
    return route.fulfill({
      body: readFileSync(path.join(officialResources!, asset)),
      contentType: asset.endsWith('.js')
        ? 'text/javascript'
        : asset.endsWith('.css')
          ? 'text/css'
          : 'font/woff2',
    })
  })
  await page.addScriptTag({ url: 'http://plugin.test/__ui__/ui.js' })
}

async function openPackagedScenario(
  page: Page,
  name: string,
  id: string,
  variant?: string
): Promise<void> {
  page.on('pageerror', (error) => console.error(`${name}/${id}: ${error.stack}`))
  const directory = path.join(PACKAGE_ROOT, name)
  const descriptor = JSON.parse(
    readFileSync(path.join(directory, '.scholarseed-plugin.json'), 'utf8')
  )
  const component = descriptor.components.find((entry: { id: string }) => entry.id === id)
  const scenario = JSON.parse(
    readFileSync(path.join(directory, component.preview), 'utf8')
  ) as PluginScenario
  const selected = scenario.cases?.find((entry) => entry.label === variant)
  const session = createPreviewSession({
    ...scenario,
    ...selected,
    responses: { ...scenario.responses, ...selected?.responses },
  })
  await page.exposeFunction('previewRequest', (action: string, values: Record<string, unknown>) => {
    const response = session.execute(action, values)
    if (response.state === 'failed') throw new Error(String(response.data.error))
    return response.data.result
  })
  if (component.public) {
    if (!publicServer) {
      publicServer = await servers.create({
        cacheKey: 'plugin',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await publicServer.listen()
    }
    await page.addInitScript(
      ({ data, slot, question }) => {
        const calls: { action: string; values: Record<string, unknown> }[] = []
        Object.assign(window, {
          previewCalls: calls,
          publicFixture: {
            slot,
            data: {
              ...data,
              ...(question ? { options: question.options, multiSelect: question.multiSelect } : {}),
            },
            request(action: string, values: Record<string, unknown>) {
              calls.push({ action, values })
              return (
                window as unknown as {
                  previewRequest: (
                    action: string,
                    values: Record<string, unknown>
                  ) => Promise<unknown>
                }
              ).previewRequest(action, values)
            },
          },
        })
      },
      {
        data: { ...scenario.data, ...selected?.data },
        slot: component.slot,
        question: scenario.interaction?.questions[0],
      }
    )
    await page.goto(
      new URL(
        '/components/business/plugin.render.fixture.html?mode=public',
        publicServer.resolvedUrls!.local[0]
      ).href
    )
    return
  }
  if (descriptor.ui && !officialResources) {
    officialResources = await mkdtemp(path.join(os.tmpdir(), 'official-selection-'))
    await buildOfficialUI(officialResources)
  }
  await page.route('http://plugin.test/**', (route) => {
    const asset = new URL(route.request().url()).pathname.slice(1)
    return route.fulfill(
      asset
        ? {
            body: readFileSync(
              asset.startsWith('__ui__/')
                ? path.join(officialResources!, asset.slice('__ui__/'.length))
                : path.join(directory, asset)
            ),
            contentType: asset.endsWith('.js') ? 'text/javascript' : 'text/css',
          }
        : { body: '<div id="root"></div>', contentType: 'text/html' }
    )
  })
  await page.goto('http://plugin.test/')
  await page.evaluate(
    ({ data, slot }) => {
      let listener: ((state: unknown) => void) | undefined
      const state = { data, slot, language: 'zh', status: 'pending' }
      const calls: { action: string; values: Record<string, unknown> }[] = []
      Object.assign(window, {
        previewCalls: calls,
        plugin: {
          onState(callback: (state: unknown) => void) {
            listener = callback
            listener(state)
          },
          async request(action: string, values: Record<string, unknown> = {}) {
            calls.push({ action, values })
            const result = await (
              window as unknown as {
                previewRequest: (
                  action: string,
                  values: Record<string, unknown>
                ) => Promise<unknown>
              }
            ).previewRequest(action, values)
            listener?.({ ...state, status: 'resolved' })
            return result
          },
          submit() {},
          async setCopyContent(content: unknown) {
            Object.assign(window, { previewCopy: content })
            return { saved: true }
          },
        },
      })
    },
    { data: { ...scenario.data, ...selected?.data }, slot: component.slot }
  )
  await loadOfficialRuntime(page)
  await page.addScriptTag({ url: `http://plugin.test/${component.entry}` })
}

test(
  'packaged result details retain focus through asynchronous menu and admission',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(page, 'agentic-search', 'details')
      const row = page.getByTestId('search-paper-sample-0')
      await row.click()
      await expect(row).toHaveAttribute('data-active', 'true')
      await row.getByRole('checkbox').check()
      await page.getByTestId('join-library-trigger').first().click()
      await expect(page.getByRole('menuitem', { name: '直接加入', exact: true })).toBeVisible()
      await expect(row).toHaveAttribute('data-active', 'true')
      await page.getByRole('menuitem', { name: '直接加入', exact: true }).click()
      await expect(page.getByTestId('literature-joined').first()).toBeVisible()
      await expect(row).toHaveAttribute('data-active', 'true')
    } finally {
      await browser.close()
    }
  }
)

test(
  'native review receipt opens its result page with outline, citations, checks and exact body identity',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const errors: string[] = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      context.diagnostic(error.message)
    })
    await page.goto(
      new URL('/components/business/review.render.fixture.html?mode=native-review', fixture.url)
        .href
    )
    await expect(page.getByRole('button', { name: '加载原生综述样例', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '加载原生综述样例', exact: true }).click()
    const inline = page.getByTestId('review-inline')
    await expect(inline.getByText('综述核对', { exact: true })).toBeVisible()
    await expect(inline.getByTestId('artifact-more-actions')).toHaveCount(0)
    await expect(inline.getByTestId('receipt-preview')).toHaveCount(0)
    await expect(inline.getByRole('button')).toHaveCount(2)
    await expect(page.getByTestId('review-native-detail')).toHaveCount(0)
    await inline.getByTestId('artifact-open').click()
    const detail = page.getByTestId('review-native-detail').getByTestId('literature-review-card')
    await expect(detail).toBeVisible()
    await expect(detail.getByText('1. 问题与评估设置', { exact: true })).toBeVisible()
    const descriptions = detail.locator('blockquote')
    const citations = descriptions.first()
    await expect(citations).not.toContainText('\\cite{')
    await expect(citations).toContainText('界定上下文长度与信息位置。')
    await expect(citations).toContainText('保留 $x^2$。')
    await expect(citations).toContainText('missing-key（来源不可用）')
    await expect(citations).toContainText('样例：无可打开来源（来源不可用）')
    await expect(descriptions.nth(1)).toHaveText('比较位置敏感性及改进方法。')
    const inlineSource = citations.getByRole('button', { name: '样例：上下文评测方法' })
    await expect(inlineSource).toHaveCount(2)
    const numberedSource = citations.getByRole('button', { name: '7. 样例：长上下文信息利用' })
    await expect(numberedSource).toHaveText('7')
    await inlineSource.first().press('Enter')
    await expect(page.getByTestId('review-web-target')).toHaveText(
      'https://example.org/review-paper'
    )
    await expect(page.getByRole('radio')).toHaveCount(0)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    const evidence = detail.getByRole('table', { name: '文献引用情况' })
    await expect(
      evidence.getByRole('columnheader', { name: '引用文献', exact: true })
    ).toBeVisible()
    await expect(evidence.getByRole('columnheader', { name: '引用方式' })).toBeVisible()
    const fulltext = evidence.getByRole('row', { name: /样例：长上下文信息利用/ })
    const abstract = evidence.getByRole('row', { name: /样例：上下文评测方法/ })
    await expect(
      fulltext.getByRole('button', { name: '7. 样例：长上下文信息利用', exact: true })
    ).toBeVisible()
    await expect(fulltext.getByText('全文引用', { exact: true })).toBeVisible()
    await expect(abstract.getByText('摘要引用', { exact: true })).toBeVisible()
    await abstract.getByRole('button', { name: '引用依据说明' }).focus()
    await expect(page.getByRole('tooltip')).toContainText(
      '样例限制：仅获得摘要，不用于支持具体实验数值。'
    )
    await expect(page.getByRole('tooltip')).toContainText('已提取 0 个字符')
    await expect(page.getByRole('tooltip')).toContainText('不等于已阅读全文')
    await expect(detail.getByText('样例：一篇论文只有摘要证据，需要补读全文。')).toBeVisible()
    await abstract.getByRole('button', { name: '样例：上下文评测方法' }).click()
    await expect(page.getByTestId('review-web-target')).toHaveText(
      'https://example.org/review-paper'
    )
    await page.route('**/api/v1/literatures/review-test-item*', (route) =>
      route.fulfill({ status: 404 })
    )
    const libraryRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/v1/literatures/review-test-item'
    )
    await numberedSource.click()
    await libraryRequest
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await detail.getByRole('button', { name: '打开正文', exact: true }).click()
    const target = JSON.parse(
      (await page.getByTestId('review-artifact-target').textContent()) || 'null'
    )
    assert.equal(target.artifactId, 'sample-body')
    assert.equal(target.sessionId, 'plugin-preview')
    assert.equal(target.path, 'sample-review/06_output/survey.md')
    assert.deepEqual(errors, [])
  }
)

test('precise search publishes current previews without retired download and delivery cards', () => {
  const descriptor = JSON.parse(
    readFileSync(
      path.join(PACKAGE_ROOT, 'precise-literature-search', '.scholarseed-plugin.json'),
      'utf8'
    )
  )
  const ids = descriptor.components.map((component: { id: string }) => component.id)
  assert.ok(ids.includes('results'))
  assert.ok(ids.includes('details'))
  assert.ok(!ids.includes('downloads'))
  assert.ok(!ids.includes('delivery'))
})

for (const name of BUILTIN_PACKAGES) {
  test(
    `${name} renders every packaged preview without runtime errors`,
    { timeout: 60_000 },
    async () => {
      const directory = path.join(PACKAGE_ROOT, name)
      const descriptor = JSON.parse(
        readFileSync(path.join(directory, '.scholarseed-plugin.json'), 'utf8')
      )
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        for (const component of descriptor.components) {
          const page = await browser.newPage()
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          await openPackagedScenario(page, name, component.id)
          if (component.public && component.slot === 'literature.selection') {
            await expect(page.locator('iframe')).toHaveCount(0)
            await expect(page.getByRole('checkbox').first()).toBeVisible()
            await expect(page.locator('#root')).not.toBeEmpty()
          } else await expect(page.locator('#root')).not.toBeEmpty()
          assert.deepEqual(errors, [], `${name}/${component.id}`)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    }
  )
}

test(
  'preview HIL failure can retry but unknown and stale outcomes cannot resubmit',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'choose',values:{answers:['继续检索']}},'*')">继续检索</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=interaction',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await page.getByRole('button', { name: '失败重试', exact: true }).click()
      await expect
        .poll(async () => {
          assert.deepEqual(errors, [])
          return page.locator('iframe').count()
        })
        .toBe(1)
      await page.frameLocator('iframe').getByRole('button', { name: '继续检索' }).click()
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
      await expect(page.getByText('sample_failure', { exact: false })).toBeVisible()
      await expect(page.getByTestId('hil-retry')).toHaveCount(0)
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByText('继续检索', { exact: true })).toBeVisible()
      for (const name of ['结果未知', '请求过期']) {
        await page.getByRole('button', { name, exact: true }).click()
        await page.frameLocator('iframe').getByRole('button', { name: '继续检索' }).click()
        await page.getByRole('button', { name: '确认', exact: true }).click()
        await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0)
        await expect(page.getByTestId('hil-retry')).toHaveCount(0)
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'cancelled preview responses retain cancellation semantics including after failed retry',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const mode of ['action-cancel', 'action-cancel-retry']) {
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{}},'*')">取消阅读</button><p id="status"></p><script>addEventListener('message', event => { if (event.data.state) document.getElementById('status').textContent = event.data.state.status; })</script>`,
          })
        })
        await page.goto(
          new URL(
            `/components/business/plugin.render.fixture.html?mode=${mode}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
        await page.evaluate('window.fixture.resolve()')
        await expect(page.frameLocator('iframe').locator('#status')).toHaveText('pending')
        await page.frameLocator('iframe').getByRole('button', { name: '取消阅读' }).click()
        await expect.poll(() => errors).toEqual([])
        if (mode === 'action-cancel-retry') {
          await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
          await expect(page.getByText(/sample_failure/)).toBeVisible()
          await page.getByTestId('hil-retry').click()
        }
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'cancelled')
        await expect(page.frameLocator('iframe').locator('#status')).toHaveText('cancelled')
        await expect(page.getByTestId('hil-retry')).toHaveCount(0)
        await expect(page.getByText(/plugin_preview_failed/)).toHaveCount(0)
        await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
        await page.getByRole('button', { name: '重置预览', exact: true }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'pending')
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'a live receipt keeps the already-ready plugin frame and its read-only state',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, { create: createServer })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.route('**/guest.html?*', (route) => {
      const lease = new URL(route.request().url()).searchParams.get('lease')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<button>Submit</button><output></output><script>
          const send = payload => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',...payload}, '*');
          send({phase:'document'});
          send({phase:'ready'});
          addEventListener('message', ({data:{state}}) => {
            if (!state) return;
            document.querySelector('output').textContent = JSON.stringify([state.status,state.draft]);
            document.querySelector('button').disabled = state.status !== 'pending';
          });
          document.querySelector('button').onclick = () => send({action:'select',values:{edgeId:'citation-2'}});
        </script>`,
      })
    })
    await page.goto(
      new URL('/components/business/plugin.render.fixture.html?mode=live-receipt', fixture.url).href
    )
    await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
    await page.evaluate('window.fixture.resolve()')
    const frame = page.locator('iframe')
    const guest = frame.contentFrame()
    await expect(guest.locator('output')).toContainText('pending')
    const initial = await frame.elementHandle()
    await guest.getByRole('button', { name: 'Submit' }).click()
    await expect(guest.locator('output')).toHaveText(
      '["resolved",{"edgeId":"citation-2","visible":false}]'
    )
    await expect(guest.getByRole('button', { name: 'Submit' })).toBeDisabled()
    // The guest sends its startup phases only once.
    await page.waitForTimeout(PLUGIN_FRAME_START_TIMEOUT_MS + 500)
    await expect(guest.locator('output')).toContainText('resolved')
    assert.ok(await frame.evaluate((element, before) => element === before, initial))
  }
)

test(
  'historical custom components restore the submitted state without allowing mutations',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, { create: createServer })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.route('**/guest.html?*', (route) => {
      const lease = new URL(route.request().url()).searchParams.get('lease')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<p id="values"></p><button>Attempt changes</button><output></output><script>
          const send = payload => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',...payload}, '*');
          addEventListener('message', event => {
            const { state, error } = event.data;
            if (state) document.querySelector('#values').textContent = JSON.stringify([state.status, state.data.title, state.draft]);
            if (error) document.querySelector('output').textContent += error + ' ';
            if (event.data.requestId === 'copy' && event.data.result) document.querySelector('output').textContent += 'copy acknowledged';
          });
          document.querySelector('button').onclick = () => {
            send({ requestId: 'draft', draft: { edgeId: 'changed' } });
            send({ requestId: 'request', action: 'select', values: { edgeId: 'changed' } });
            send({ action: 'select', values: { edgeId: 'changed' } });
            send({ requestId: 'copy', copy: { text: 'archive' }, revision: 0 });
          };
        </script>`,
      })
    })
    await page.goto(
      new URL('/components/business/plugin.render.fixture.html?mode=history', fixture.url).href
    )
    await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
    await page.evaluate('window.fixture.resolve()')
    const guest = page.frameLocator('iframe')
    await expect(guest.locator('#values')).toHaveText(
      '["resolved","Bound graph",{"edgeId":"citation-2","visible":false}]'
    )
    await guest.getByRole('button', { name: 'Attempt changes' }).click()
    await expect(guest.locator('output')).toHaveText(
      'plugin_draft_unavailable plugin_card_read_only copy acknowledged'
    )
    assert.equal(
      await page.evaluate(
        'window.fixture.requests.some(call => ["plugin-draft", "plugin-call", "plugin-copy"].includes(call.operation))'
      ),
      false
    )
  }
)

test(
  'generated installation card does not offer interaction preview',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation',
          server.resolvedUrls!.local[0]
        ).href
      )
      const card = page.getByTestId('plugin-installation-card')
      await expect(card.getByRole('button', { name: '对话交互预览', exact: true })).toHaveCount(0)
      await expect(card.getByRole('button', { name: '暂不安装', exact: true })).toBeVisible()
      await expect(card.getByRole('button', { name: '安装到书深', exact: true })).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'generated plugin installation card returns only the host receipt',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      const review = page.getByTestId('skill-add-modal')
      await expect(
        review.getByRole('heading', { name: 'generated-plugin', exact: true })
      ).toBeVisible()
      await expect(review).toContainText('版本 1.0.0')
      await expect(review).toContainText('Generated description')
      const document = review.getByRole('region', { name: '技能正文', exact: true })
      await expect(document.getByRole('heading', { name: 'Generated instructions' })).toBeVisible()
      await expect(document).not.toContainText('name: generated-plugin')
      await expect(review.getByTestId('plugin-report')).toHaveCount(0)
      await expect(review).not.toContainText(/a{64}|interaction\.answer|只安装可信来源/)
      await review.getByRole('button', { name: '取消', exact: true }).click()
      await expect(review).toHaveCount(0)
      assert.equal(
        await page.evaluate(
          'window.fixture.requests.some((call) => call.operation === "plugin-confirm")'
        ),
        false
      )
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      await review.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByRole('status')).toHaveText('安装成功')
      const calls = (await page.evaluate('window.fixture.requests')) as Array<
        Record<string, unknown>
      >
      assert.deepEqual(
        calls.filter((call) => call.operation === 'plugin-confirm'),
        [
          {
            operation: 'plugin-confirm',
            candidate: 'candidate',
            sha256: 'a'.repeat(64),
            confirmed: true,
            grants: ['interaction.answer'],
            enable: true,
            update: false,
          },
        ]
      )
      const response = calls.find((call) => call.answers) as { answers: Record<string, string> }
      assert.deepEqual(JSON.parse(response.answers.question), {
        name: 'generated-plugin',
        version: '1.0.0',
        enabled: true,
        sha256: 'a'.repeat(64),
      })
      await expect(page.getByTestId('hil-retry')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skipped installation remains actionable and failed installation can retry without another answer',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation&fail-install=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('status')).toContainText('尚未安装')
      await page.getByRole('button', { name: '生成包目录', exact: true }).click()
      await page.getByRole('button', { name: '暂不安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('已跳过安装')
      await expect(page.getByText('已取消任务', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('安装失败')
      await page.getByRole('button', { name: '重试安装', exact: true }).click()
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('安装成功')
      await expect(page.getByText('安装目录', { exact: false })).toBeVisible()
      const calls = (await page.evaluate('window.fixture.requests')) as Array<
        Record<string, unknown>
      >
      assert.equal(calls.filter((call) => call.cancelled).length, 1)
      assert.equal(calls.filter((call) => call.answers).length, 0)
      assert.equal(calls.filter((call) => call.operation === 'plugin-confirm').length, 2)
      assert.ok(
        calls.some((call) => call.operation === 'plugin-delivery' && call.action === 'directory')
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'preview action confirmation can retry a failed response without resetting input',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=action-retry',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
      await page.getByTestId('hil-retry').click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByRole('button', { name: '确认选择', exact: true })).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'StrictMode replay keeps the owner lease live through selection and confirmation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'fixture-lease',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
        })
      )
      await page.goto(
        new URL('/components/business/plugin.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('status')).toHaveText('resolved')
      assert.deepEqual(await page.evaluate('window.fixture.released'), [])
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)

test(
  'fixed binding survives catalog changes and generic component submission resolves the waiting request',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{method:'evidence'}},'*')">使用方法</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=generic',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('scholarseed:skill-catalog-changed', { detail: { name: 'fixture' } })
        )
      )
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '使用方法' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(
        await page.evaluate('window.fixture.requests.filter(request => request.answers)'),
        [
          {
            answers: {
              question: JSON.stringify({ action: 'select', values: { method: 'evidence' } }),
            },
          },
        ]
      )
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.find(request => request.operation === "plugin-open").reference'
        ),
        {
          plugin: 'fixture',
          component: 'selection',
          fingerprint: 'fixture',
          binding: 'fixed-binding',
        }
      )
      assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0'])
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'public component persists its selection and restores the same binding after remount',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=public-bound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await page.getByRole('radio', { name: '方法二', exact: true }).check()
      await expect(page.getByTestId('public-selection')).toHaveText('方法二')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").map(request=>({values:request.values,revision:request.expected_revision}))'
        ),
        [{ values: { answers: ['方法二'] }, revision: 0 }]
      )
      await page.getByRole('textbox', { name: '说明' }).fill('保留科研范围')
      await expect
        .poll(() =>
          page.evaluate(
            'window.fixture.requests.filter(request => request.operation === "plugin-draft").length'
          )
        )
        .toBe(2)
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").at(-1).values'
        ),
        { answers: ['方法二'], text: '保留科研范围' }
      )
      await page.getByRole('button', { name: '重新挂载' }).click()
      await page.getByRole('button', { name: '重新挂载' }).click()
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(4)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.getByRole('radio', { name: '方法二', exact: true })).toBeChecked()
      await expect(page.getByTestId('public-selection')).toHaveText('方法二')
      await expect(page.getByRole('textbox', { name: '说明' })).toHaveValue('保留科研范围')
      await expect(page.locator('iframe')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'legacy host-v1 selection is unavailable without modifying its saved data or replaying actions',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=legacy-bound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('checkbox')).toHaveCount(0)
      assert.deepEqual(await page.evaluate('window.fixture.draft'), { selected_paper_ids: ['one'] })
      assert.deepEqual(await page.evaluate('window.fixture.requests'), [])
      await page.getByRole('button', { name: '重新挂载', exact: true }).click()
      await page.getByRole('button', { name: '重新挂载', exact: true }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      assert.deepEqual(await page.evaluate('window.fixture.draft'), { selected_paper_ids: ['one'] })
      assert.deepEqual(await page.evaluate('window.fixture.requests'), [])
      await expect(page.locator('iframe')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'legacy host-v1 preview without an existing binding cannot render a selection fallback',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=legacy-unbound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('checkbox')).toHaveCount(0)
      await expect(page.locator('iframe')).toHaveCount(0)
      assert.deepEqual(await page.evaluate('window.fixture.requests'), [])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'read-only preview exposes local details without a pretend confirmation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      cacheKey: 'plugin',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<output></output><details><summary>Paper</summary><p>Evidence</p></details><script>
            addEventListener("message", ({data}) => {
              if (!data.state) return
              document.querySelector("output").textContent = data.state.status
            })
          </script>`,
        })
      )
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=readonly',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.frameLocator('iframe').locator('output')).toHaveText('resolved')
      await page.frameLocator('iframe').getByText('Paper', { exact: true }).click()
      await expect(page.frameLocator('iframe').getByText('Evidence')).toBeVisible()
      await expect(page.getByRole('button', { name: '确认选择', exact: true })).toHaveCount(0)
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await page.getByRole('button', { name: '重置预览' }).click()
      await expect(page.frameLocator('iframe').getByText('Evidence')).toBeHidden()
      await page.getByRole('button', { name: '开关预览' }).click()
      await expect.poll(() => page.evaluate('window.fixture.released.length')).toBe(2)
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)

for (const mode of ['installed', 'candidate']) {
  test(
    `${mode} preview owns StrictMode generations, late completion and actual close`,
    { timeout: 60_000 },
    async () => {
      const server = await servers.create({
        cacheKey: 'plugin',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
        const page = await browser.newPage()
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
          })
        })
        await page.goto(
          new URL(
            `/components/business/plugin.render.fixture.html?mode=${mode}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
        await page.evaluate('window.fixture.resolve()')
        await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
        assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0'])
        await page.getByRole('button', { name: '重置预览' }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'pending')
        await page.evaluate('window.fixture.revoke()')
        await expect(page.getByRole('alert')).toBeVisible()
        await page.getByRole('button', { name: '开关预览' }).click()
        assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0', 'lease-1'])
        await page.getByRole('button', { name: '开关预览' }).click()
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(4)
        await page.getByRole('button', { name: '开关预览' }).click()
        await page.evaluate('window.fixture.resolve()')
        await expect.poll(() => page.evaluate('window.fixture.released.length')).toBe(4)
        await expect(page.locator('iframe')).toHaveCount(0)
      } finally {
        await browser?.close()
        await server.close()
      }
    }
  )
}
