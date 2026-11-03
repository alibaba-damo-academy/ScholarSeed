const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { chromium, expect } = desktopRequire('@playwright/test')
const { buildOfficialUI } = require('./build.cjs')
const manifest = require('./manifest.json')

let directory
let browser
before(async () => {
  const work = path.resolve(__dirname, '../../work/ui-sdk')
  await fs.mkdir(work, { recursive: true })
  directory = await fs.mkdtemp(path.join(work, 'resources-'))
  await buildOfficialUI(directory)
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

const component = `
const ui = window.scholarseedUI;
const h = ui.React.createElement;
let listener;
const state = {language:'zh', status:'pending', data:{}, draft:{}};
window.fixture = {actions:[], saves:[], publish: patch => {Object.assign(state,patch); listener(state)}};
window.plugin = {
  onState(callback) {listener=callback; callback(state); return () => {listener=undefined}},
  async save(values) {window.fixture.saves.push(values); state.draft=values; listener(state); return {state:values,revision:1}},
  submit(action,values) {window.fixture.actions.push({action,values}); state.status='resolved'; listener(state)}
};
function Card({state}) {
  const [text,setText] = ui.React.useState(state.draft.text || '');
  const [open,setOpen] = ui.React.useState(false);
  return h(ui.Card,null,
    h(ui.CardHeader,null,h(ui.CardTitle,null,'组合卡片')),
    h(ui.CardContent,null,
      h(ui.Textarea,{label:'研究问题',value:text,onChange:event=>setText(event.target.value)}),
      h(ui.DropdownMenu,null,
        h(ui.DropdownMenuTrigger,{asChild:true},h(ui.Button,null,'操作')),
        h(ui.DropdownMenuContent,null,
          h(ui.DropdownMenuSub,null,
            h(ui.DropdownMenuSubTrigger,{openOnHover:true},'更多'),
            h(ui.DropdownMenuSubContent,null,
              h(ui.DropdownMenuItem,{onSelect:()=>setOpen(true)},'检查草稿')))))),
      h(ui.Dialog,{open,onOpenChange:setOpen},
        h(ui.DialogContent,{'aria-label':'草稿详情'},
          h(ui.DialogTitle,null,'草稿详情'),
          h(ui.DialogDescription,null,text),
          h(ui.DialogClose,{asChild:true},h(ui.Button,null,'返回')))),
      h(ui.CardFooter,null,
        h(ui.Button,{onClick:()=>window.plugin.save({text})},'保存草稿'),
        h(ui.Button,{disabled:state.status!=='pending',onClick:()=>window.plugin.submit('confirm',{text})},state.status==='resolved'?'已确认':'确认')));
}
ui.mount(state=>h(Card,{state}));
`

test('published controls compose inside an opaque sandbox with nested menus, dialogs, drafts and confirmation', async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('http://sdk.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1)
      if (!name) return route.fulfill({ contentType: 'text/html', body: '<iframe title="Plugin" sandbox="allow-scripts" src="/frame" width="1000" height="700"></iframe>' })
      if (name === 'frame') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div id="root"></div><script src="/ui.js"></script><script src="/component.js"></script>' })
      if (name === 'component.js') return route.fulfill({ contentType: 'text/javascript', body: component })
      return route.fulfill({ body: await fs.readFile(path.join(directory, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2' })
    })
    await page.goto('http://sdk.test/')
    const frame = page.frameLocator('iframe')
    await expect(frame.getByRole('heading', { name: '组合卡片' })).toBeVisible()
    const context = page.frames().find(value => value.url().endsWith('/frame'))
    assert.deepEqual(await context.evaluate(() => Object.keys(window.scholarseedUI).filter(name => !['version', 'compatibility'].includes(name)).sort()), [...manifest.exports].sort())
    assert.equal(await context.evaluate(() => { try { return !!parent.document.body } catch { return false } }), false)
    await frame.getByRole('textbox', { name: '研究问题' }).fill('保留我的科研问题')
    await frame.getByRole('button', { name: '保存草稿' }).click()
    assert.deepEqual(await context.evaluate(() => window.fixture.saves), [{ text: '保留我的科研问题' }])
    await frame.getByRole('button', { name: '操作' }).click()
    await frame.getByRole('menuitem', { name: '更多' }).hover()
    await frame.getByRole('menuitem', { name: '检查草稿' }).click()
    await expect(frame.getByRole('dialog')).toBeVisible()
    await expect(frame.getByRole('dialog').getByText('保留我的科研问题')).toBeVisible()
    await frame.getByRole('button', { name: '返回', exact: true }).click()
    await expect(frame.getByRole('dialog')).toHaveCount(0)
    await expect(frame.getByRole('textbox', { name: '研究问题' })).toHaveValue('保留我的科研问题')
    await frame.getByRole('button', { name: '确认', exact: true }).click()
    await expect(frame.getByRole('button', { name: '已确认' })).toBeDisabled()
    assert.deepEqual(await context.evaluate(() => window.fixture.actions), [{ action: 'confirm', values: { text: '保留我的科研问题' } }])
    assert.deepEqual(errors, [])
  } catch (error) {
    throw new Error(`Page errors: ${JSON.stringify(errors)}`, { cause: error })
  } finally { await page.close() }
})
