const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const fs = require('node:fs/promises')
const { COPYFILE_FICLONE } = require('node:fs').constants
const path = require('node:path')
const net = require('node:net')
const { createRequire } = require('node:module')
const source = path.resolve(__dirname, '../../..')
const dependency = createRequire(path.join(source, 'apps/desktop/package.json'))
const { chromium, expect } = dependency('@playwright/test')
const uiZh = require(path.join(source, 'apps/desktop/src/localization/locales/zh/ui.json'))
let fixture
let server
let browser
let base

before(async () => {
  const work = path.join(source, 'work/ui-preview-tests')
  await fs.mkdir(work, { recursive: true })
  fixture = await fs.realpath(await fs.mkdtemp(path.join(work, 'source-')))
  await fs.cp(path.join(source, 'packages/ui'), path.join(fixture, 'packages/ui'), {
    recursive: true,
    mode: COPYFILE_FICLONE,
    filter: filename => !filename.split(path.sep).includes('node_modules'),
  })
  await fs.cp(path.join(source, 'apps/desktop/src'), path.join(fixture, 'apps/desktop/src'), {
    recursive: true,
    mode: COPYFILE_FICLONE,
    filter: filename => !filename.split(path.sep).includes('node_modules'),
  })
  await fs.copyFile(
    path.join(source, 'apps/desktop/package.json'),
    path.join(fixture, 'apps/desktop/package.json')
  )
  await fs.mkdir(path.join(fixture, 'apps/desktop/scripts/shared'), { recursive: true })
  await fs.copyFile(path.join(source, 'apps/desktop/scripts/shared/openui.mjs'),
    path.join(fixture, 'apps/desktop/scripts/shared/openui.mjs'))
  for (const name of await fs.readdir(path.join(source, 'apps/desktop'))) {
    if (/^tsconfig.*\.json$/.test(name))
      await fs.copyFile(
        path.join(source, 'apps/desktop', name),
        path.join(fixture, 'apps/desktop', name)
      )
  }
  await fs.symlink(
    path.join(source, 'apps/desktop/node_modules'),
    path.join(fixture, 'apps/desktop/node_modules'),
    'junction'
  )
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  server = await require(path.join(fixture, 'packages/ui/preview/server.cjs')).createPreview({ port })
  base = `http://127.0.0.1:${port}/`
  await fs.writeFile(
    path.join(fixture, 'packages/ui/preview/embedded.html'),
    `<!doctype html><html><body><div id="root"></div><script type="module" src="/embedded.jsx"></script></body></html>`
  )
  await fs.writeFile(
    path.join(fixture, 'packages/ui/preview/embedded.jsx'),
    `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Providers } from '../localization'
    import { ready } from './localization'
    import { Preview } from './page'
    import '../ui.css'
    function Host() {
      const [sample, setSample] = React.useState('Markdown')
      return <><button onClick={() => setSample('Markdown')}>Host Markdown</button><button onClick={() => setSample('BarChart')}>Host BarChart</button><button onClick={() => setSample('Plot')}>Host Plot</button><button onClick={() => setSample('CitationLink')}>Host CitationLink</button><Preview sample={sample} onOpenWebSource={url => {window.hostOpenedSource = url}} /></>
    }
    await ready
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.classList.add('dark')
    createRoot(document.getElementById('root')).render(<Providers><Host /></Providers>)
  `
  )
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await fs.rm(fixture, { recursive: true, force: true })
})

async function openPage() {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1050 },
  })
  const errors = []
  const remote = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.url().startsWith('http') && !request.url().startsWith(base))
      remote.push(request.url())
  })
  await page.goto(base)
  await expect(page.getByRole('heading', { name: '官方 UI 实时预览', exact: true })).toBeVisible({
    timeout: 30000,
  })
  return { page, errors, remote }
}

async function choose(page, name) {
  const canonical = await page
    .locator('nav [data-export]')
    .evaluateAll(
      (nodes, requested) =>
        nodes.find(
          (node) =>
            node.dataset.export === requested ||
            JSON.parse(node.dataset.aliases).includes(requested)
        )?.dataset.export,
      name
    )
  assert.ok(canonical, `missing official export: ${name}`)
  await page.locator(`nav [data-export="${canonical}"]`).click()
  await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', canonical)
  await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
}

test('preset examples apply on click, validate and hot update without discarding drafts', async () => {
  const file = path.join(fixture, 'packages/ui/preview/examples.mjs')
  const original = await fs.readFile(file, 'utf8')
  const { page } = await openPage()
  try {
    await choose(page, 'Markdown')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    await editor.fill(JSON.stringify({ text: 'My draft', math: true }))
    await fs.writeFile(
      file,
      `export const examples = { Markdown: [
      { id: 'first', label: 'Example one', data: { text: 'First example', math: true } },
      { id: 'second', label: 'Example two', data: { text: 'Second example', math: true } },
      { id: 'invalid', label: 'Invalid example', data: { text: 5 } }
    ] }`
    )
    const group = page.getByRole('group', { name: '预置示例' })
    await expect(group.getByRole('button', { name: 'Example one' })).toBeVisible()
    await expect(page.getByTestId('preview-component')).toContainText('My draft')
    await group.getByRole('button', { name: 'Example one' }).click()
    await expect(page.getByTestId('preview-component')).toContainText('First example')
    await expect(group.getByRole('button', { name: 'Example one' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await editor.fill(JSON.stringify({ text: 'Edited draft', math: true }))
    await expect(group.getByRole('button', { name: 'Example one' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await group.getByRole('button', { name: 'Example two' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('preview-component')).toContainText('Second example')
    await group.getByRole('button', { name: 'Invalid example' }).click()
    await expect(page.getByTestId('preview-data-state')).toContainText('未应用')
    await expect(page.getByTestId('preview-component')).toContainText('Second example')
  } finally {
    await fs.writeFile(file, original)
    await page.close()
  }
})

test('file groups keep two columns and show permitted import actions', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'ArtifactGroup')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const data = JSON.parse(await editor.inputValue())
    const original = data.items[0]
    const setCount = async (count) => {
      data.items = Array.from({ length: count }, (_, index) => ({
        ...original,
        artifact_id: `file-${index}`,
        title: `项目 ${index}`,
        kind: index < 3 ? 'file' : 'directory',
      }))
      await editor.fill(JSON.stringify(data))
    }
    await setCount(4)
    const regular = page.getByTestId('artifact-group').locator('[data-artifact-card]').first()
    await regular.hover()
    await expect(regular.getByTestId('artifact-import-resources')).toBeVisible()
    await expect(regular.getByTestId('artifact-import-resources')).toBeEnabled()
    await setCount(5)
    const group = page.getByTestId('artifact-group')
    const cards = group.locator('[data-artifact-card]')
    await expect(cards).toHaveCount(5)
    await expect(group.locator('[data-artifact-kind="directory"]')).toHaveCount(2)
    await expect(cards.first().getByTestId('artifact-import-resources')).toBeVisible()
    await cards.first().getByTestId('artifact-import-resources').click()
    await expect(page.getByTestId('preview-feedback')).toContainText('import')
    await cards.first().getByTestId('artifact-more-actions').click()
    await page.getByRole('menuitem', { name: '在右侧标签页打开', exact: true }).click()
    await expect(page.getByTestId('preview-feedback')).toContainText('preview')
    const first = await cards.nth(0).boundingBox()
    const second = await cards.nth(1).boundingBox()
    const third = await cards.nth(2).boundingBox()
    const fifth = await cards.nth(4).boundingBox()
    assert.equal(first.y, second.y)
    assert.ok(third.y > first.y)
    assert.ok(Math.abs(fifth.width - first.width) < 1)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('PDF first-page previews join the image block but delegate full-file opening', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'ArtifactGroup')
    await page
      .getByRole('group', { name: '预置示例' })
      .getByRole('button', { name: 'PDF 与图片共用预览组', exact: true })
      .click()
    const preview = page.getByTestId('preview-component')
    const group = preview.getByTestId('artifact-image-group')
    await expect(group).toHaveCount(1)
    await expect(preview.getByTestId('artifact-group')).toHaveCount(0)
    await expect(group.getByRole('img')).toHaveCount(3)
    await expect(group.getByRole('img', { name: 'PDF 首页（示例）', exact: true })).toHaveCSS(
      'object-fit',
      'contain'
    )
    await expect(group.getByRole('img', { name: '示例图片 1', exact: true })).toHaveCSS(
      'object-fit',
      'cover'
    )
    await group.getByRole('button', { name: 'PDF 首页（示例）', exact: true }).click()
    await expect(page.getByTestId('preview-feedback')).toContainText('preview')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await group.getByRole('button', { name: '示例图片 1', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const position = (index) => new RegExp('^' + uiZh.imagePreview.position
      .replace('{{index}}', String(index)).replace('{{count}}', '2')
      .split('{{zoom}}').map(RegExp.escape).join('\\d+') + '$')
    await expect(dialog.locator('output')).toHaveText(position(1))
    await expect(dialog.getByRole('img', { name: '示例图片 1', exact: true })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator('output')).toHaveText(position(2))
    await expect(dialog.getByRole('img', { name: '示例图片 3', exact: true })).toBeVisible()
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('artifact groups consolidate separated items and preserve first-kind and within-kind order', async () => {
  const { page } = await openPage()
  try {
    await choose(page, 'ArtifactGroup')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const data = JSON.parse(await editor.inputValue())
    const original = data.items[0]
    const images = Array.from({ length: 4 }, (_, index) => ({
      ...original,
      artifact_id: `image-${index}`,
      kind: 'image',
      name: `image-${index}.svg`,
      path: `image-${index}.svg`,
      media_type: 'image/svg+xml',
      title: `图片 ${index}`,
      image_url:
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/%3E',
    }))
    const files = Array.from({ length: 5 }, (_, index) => ({
      ...original,
      artifact_id: `file-${index}`,
      kind: index < 3 ? 'file' : 'directory',
    }))
    data.items = [images[0], files[0], images[1], ...files.slice(1), ...images.slice(2)]
    await editor.fill(JSON.stringify(data))
    await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
    const preview = page.getByTestId('preview-component')
    await expect(preview.getByTestId('artifact-image-group')).toHaveCount(1)
    await expect(preview.getByTestId('artifact-group')).toHaveCount(1)
    await expect(
      preview.getByTestId('artifact-group').locator('[data-artifact-kind="directory"]')
    ).toHaveCount(2)
    assert.equal(
      await preview
        .locator('[data-testid="artifact-image-group"], [data-testid="artifact-group"]')
        .first()
        .getAttribute('data-testid'),
      'artifact-image-group'
    )
    data.items = [files[0], images[0], ...files.slice(1), ...images.slice(1)]
    await editor.fill(JSON.stringify(data))
    await expect(preview.getByTestId('artifact-image-group')).toHaveCount(1)
    await expect(preview.getByTestId('artifact-group')).toHaveCount(1)
    assert.equal(
      await preview
        .locator('[data-testid="artifact-image-group"], [data-testid="artifact-group"]')
        .first()
        .getAttribute('data-testid'),
      'artifact-group'
    )
  } finally {
    await page.close()
  }
})

test('file, search and review receipts preserve their preview and keyboard behavior', async () => {
  const { page, errors } = await openPage()
  try {
    for (const name of ['Artifact', 'Results', 'Review']) {
      await choose(page, name)
      const receipt = page.getByTestId('preview-component').locator('[data-artifact-receipt]')
      await expect(receipt).toBeVisible()
      const preview = page.getByTestId('preview-component').getByTestId('receipt-preview')
      if (name === 'Review') {
        await expect(preview).toBeVisible()
        const viewport = await preview.evaluate((el) => ({
          height: el.clientHeight,
          content: el.scrollHeight,
        }))
        assert.ok(viewport.content > viewport.height)
        await receipt.getByTestId('artifact-more-actions').click()
        await page.getByTestId('receipt-toggle').click()
        await expect(preview).toHaveCount(0)
        await receipt.getByTestId('artifact-more-actions').click()
        await page.getByTestId('receipt-toggle').click()
        await expect(preview).toBeVisible()
      } else if (name === 'Results') {
        await expect(preview).toBeVisible()
        await expect(receipt.getByTestId('artifact-more-actions')).toHaveCount(0)
      } else {
        await expect(preview).toHaveCount(0)
      }
      await expect(receipt.getByTestId('artifact-open')).toBeVisible()
      if (name === 'Artifact')
        await expect(receipt.getByTestId('artifact-open-default')).toHaveCount(0)
      else await expect(receipt.getByTestId('artifact-open-default')).toBeVisible()
      if (name === 'Artifact') {
        await expect(receipt.getByTestId('artifact-more-actions')).toBeVisible()
      }
      if (name !== 'Artifact') {
        await receipt.getByTestId('artifact-open').focus()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('preview-host-detail')).toBeVisible()
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('research results use a receipt and preserve full payloads for host-side details', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'Results')
    const preview = page.getByTestId('preview-component')
    const open = preview.getByTestId('artifact-open')
    await expect(preview.getByTestId('literature-preview-toggle')).toHaveCount(0)
    await expect(open).toBeVisible()
    await expect(preview.getByRole('button', { name: /打开文献/ })).toHaveCount(0)
    await preview.getByTestId('artifact-open-default').click()
    await expect(page.getByTestId('preview-feedback')).toContainText('open-results')
    await expect(page.getByTestId('preview-host-detail')).toBeVisible()
    await page.getByRole('button', { name: '对话展示', exact: true }).click()
    for (const label of [
      '检索结果：3 篇',
      '结果较多：40 篇',
      '部分结果',
      '没有结果',
      '来源失败',
      '执行受阻',
      '结果无效',
    ]) {
      await page
        .getByRole('group', { name: '预置示例' })
        .getByRole('button', { name: label, exact: true })
        .click()
      await expect(preview.getByTestId('literature-preview-toggle')).toHaveCount(0)
      await expect(preview.getByRole('button', { name: /打开文献/ })).toHaveCount(0)
      await expect(open).toBeVisible()
      await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
      if (label === '结果较多：40 篇') {
        const data = JSON.parse(
          await page.getByRole('textbox', { name: '数据 JSON', exact: true }).inputValue()
        )
        assert.equal(data.content.papers.length, 40)
        assert.equal(data.content.retained, 40)
        const list = preview.getByTestId('receipt-preview')
        await expect(list.getByRole('listitem')).toHaveCount(40)
        const firstRow = list.getByRole('listitem').first()
        await expect(firstRow).toHaveText(data.content.papers[0].title)
        await expect(firstRow.locator('span')).toHaveCSS('font-weight', '400')
        await expect(firstRow.locator('.lucide-book-open-text')).toBeVisible()
        await expect(open.locator('.lucide-book-open-text')).toBeVisible()
        const heights = await list.evaluate((element) => {
          const rows = element.querySelectorAll('li')
          return {
            viewport: element.clientHeight,
            fiveRows: rows[4].offsetTop + rows[4].offsetHeight - rows[0].offsetTop,
          }
        })
        assert.equal(heights.viewport, heights.fiveRows)
        const fade = (edge) => list.evaluate((element, side) =>
          getComputedStyle(element).getPropertyValue(`--preview-fade-${side}`).trim(), edge)
        assert.equal(await fade('top'), '0px')
        assert.notEqual(await fade('bottom'), '0px')
        await list.focus()
        await page.keyboard.press('End')
        await expect.poll(() => fade('bottom')).toBe('0px')
        assert.notEqual(await fade('top'), '0px')
        await page.keyboard.press('Home')
        await expect.poll(() => fade('top')).toBe('0px')
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('only results and review switch between conversation receipts and shared host-detail previews', async () => {
  const { page, errors, remote } = await openPage()
  try {
    for (const name of ['Results', 'Review']) {
      await choose(page, name)
      const editor = page.getByRole('textbox', {
        name: '数据 JSON',
        exact: true,
      })
      const data = JSON.parse(await editor.inputValue())
      const sidebar = page.getByRole('button', {
        name: '侧窗展示',
        exact: true,
      })
      await expect(sidebar).toHaveAttribute('aria-pressed', 'false')
      await sidebar.click()
      const details = page.getByTestId('preview-host-detail')
      await expect(details).toBeVisible()
      await expect(details).toContainText('模拟宿主')
      const title = `${name} 侧窗 JSON 更新`
      if (name === 'Results') data.content.papers[0].title = title
      else data.content.title = title
      await editor.fill(JSON.stringify(data))
      await expect(details).toContainText(title)
      await editor.fill('{')
      await expect(details).toContainText(title)
      await editor.fill(JSON.stringify(data))
      if (name === 'Results') {
        await page.setViewportSize({ width: 1040, height: 660 })
        await expect(details).toBeVisible()
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.setViewportSize({ width: 1600, height: 1050 })
      }
      await page.getByRole('button', { name: '对话展示', exact: true }).click()
      await expect(details).toHaveCount(0)
      await expect(editor).toHaveValue(JSON.stringify(data))
      await page.getByTestId('preview-component').getByTestId('artifact-open').click()
      await expect(details).toBeVisible()
      await expect(details).toBeFocused()
      await page.getByRole('button', { name: '返回对话展示', exact: true }).click()
      await expect(sidebar).toBeFocused()
    }
    for (const name of ['Artifact', 'ArtifactGroup', 'Markdown', 'Tabulation']) {
      await choose(page, name)
      await expect(page.getByRole('button', { name: '侧窗展示', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('preview-host-detail')).toHaveCount(0)
    }
    await choose(page, 'Artifact')
    const artifact = page.getByTestId('preview-component')
    await expect(artifact.locator('[data-artifact-receipt]')).toHaveCount(1)
    await expect(artifact.getByTestId('artifact-more-actions')).toBeVisible()
    await expect(artifact.getByTestId('artifact-open')).toBeVisible()
    assert.deepEqual(errors, [])
    assert.deepEqual(remote, [])
  } finally {
    await page.close()
  }
})

test('document examples render file types and states, image groups and real review bibliographies', async () => {
  const { page, errors, remote } = await openPage()
  try {
    await choose(page, 'Artifact')
    for (const label of [
      '一页简报.md',
      'main.tex',
      'references.bib',
      '文献综述-初稿.docx',
      '一页简报.pdf',
      '研究对照表.xlsx',
      'effect_sizes.csv',
      '组会汇报.pptx',
      'effect_size.py',
      'BasicProofs.lean',
      '检索结果.zip',
      'embeddings.parquet',
    ]) {
      await page
        .getByRole('group', { name: '预置示例' })
        .getByRole('button', { name: label, exact: true })
        .click()
      await expect(page.getByTestId('preview-component')).toContainText(label)
      await expect(page.getByTestId('artifact-open')).toContainText(label)
    }
    await page.getByRole('button', { name: '无导入权限', exact: true }).click()
    await page.getByTestId('artifact-open').hover()
    await expect(page.getByTestId('artifact-import-resources')).toHaveCount(0)
    await page.getByRole('button', { name: '文件已删除', exact: true }).click()
    await page.getByTestId('artifact-more-actions').click()
    await expect(
      page.getByTestId('artifact-dropdown-menu').getByText('复制路径', { exact: true })
    ).toBeDisabled()
    await page.keyboard.press('Escape')
    await choose(page, 'ArtifactGroup')
    await page.getByRole('button', { name: '12 种文件类型', exact: true }).click()
    await expect(page.locator('[data-artifact-receipt]')).toHaveCount(11)
    await expect(page.getByTestId('artifact-image-group').getByRole('img')).toHaveCount(1)
    await expect(page.getByTestId('artifact-image-group').getByRole('img')).toHaveAttribute(
      'alt',
      '一页简报.pdf'
    )
    await page.getByRole('button', { name: '10 张图片：横向滚动', exact: true }).click()
    await expect(
      page.getByTestId('artifact-image-group').getByRole('button', { name: /^示例图片 \d+$/ })
    ).toHaveCount(10)
    const imageActions = page.getByTestId('artifact-image-group')
      .getByRole('button', { name: /的更多操作/ }).first()
    await imageActions.focus()
    await imageActions.press('Enter')
    await expect(page.getByRole('menuitem', { name: '加入当前对话' })).toBeVisible()
    await expect(page.getByTestId('artifact-dropdown-save-as')).toBeVisible()
    await page.keyboard.press('Escape')
    await choose(page, 'Review')
    for (const label of [
      'Agent 综述：六篇公开文献',
      '七节大纲：待全文核验',
      '局部综述：仅三篇摘要',
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.getByRole('button', { name: '侧窗展示', exact: true }).click()
      const detail = page.getByTestId('preview-host-detail')
      await expect(detail).toContainText('非真实任务执行结果')
      await expect(detail).toContainText('全文')
      await expect(detail).not.toContainText('无法读取')
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(remote, [])
  } finally {
    await page.close()
  }
})

test('Markdown presets remain ordinary content and render math, tables, citations, code, linked images and Mermaid', async () => {
  const { page, errors, remote } = await openPage()
  try {
    await choose(page, 'Markdown')
    const component = page.getByTestId('preview-component')
    const select = (label) =>
      page
        .getByRole('group', { name: '预置示例' })
        .getByRole('button', { name: label, exact: true })
        .click()
    await select('行内公式、上下标与单位')
    await expect(component.locator('.katex').first()).toBeVisible()
    await expect(component).toContainText('Unicode 原样显示')
    await select('Markdown 表格：普通与宽表')
    await expect(component.getByRole('table')).toHaveCount(2)
    await select('Markdown 表格：引用与缺失值')
    await expect(component.getByRole('table')).toHaveCount(1)
    await expect(component.getByRole('button', { name: '3 个来源', exact: true })).toBeVisible()
    await expect(component.getByRole('table')).toContainText('—')
    await select('正文引用：网页、PDF 与本地文件')
    await expect(component.getByRole('button', { name: '7 个来源', exact: true })).toBeVisible()
    await component.getByRole('button', { name: /Noy & Zhang 2023/ }).hover()
    await expect(page.getByLabel('引用预览', { exact: true })).toContainText('Noy & Zhang 2023.pdf')
    await page.mouse.move(0, 0)
    await page.keyboard.press('Escape')
    await select('代码片段、终端命令与输出')
    await expect(component.getByTestId('conversation-code')).toHaveCount(4)
    await select('图片链接：SVG 与热力图')
    await expect(component.getByRole('img')).toHaveCount(2)
    assert.equal(
      await component
        .getByRole('img')
        .evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)),
      true
    )
    await select('Mermaid：正常与失败兜底')
    await expect(component.getByTestId('conversation-diagram').first().getByRole('img')).toBeVisible()
    await expect(component).toContainText('flowchart LR')
    await select('综合正文：公式、表格、引用、代码与图片')
    await expect(component.getByRole('table')).toHaveCount(3)
    await expect(component.getByRole('img', { name: /^(Violin plot|Correlation heatmap)：仅为合成展示图$/ })).toHaveCount(2)
    await expect(component.getByTestId('conversation-diagram').getByRole('img')).toBeVisible()
    await expect(component.getByRole('button', { name: '7 个来源', exact: true })).toBeVisible()
    const text = JSON.parse(
      await page.getByRole('textbox', { name: '数据 JSON', exact: true }).inputValue()
    ).text
    assert.ok(text.includes('```mermaid'))
    await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
    assert.deepEqual(errors, [])
    assert.deepEqual(remote, [])
  } finally {
    await page.close()
  }
})

test('citation badges follow actual origin rather than bibliography, extension or a local-file default', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'CitationLink')
    for (const [preset, kind, label] of [
      ['文献来源', 'literature', '文献'],
      ['文件来源', 'file', '文件'],
      ['资料库来源', 'resource', '资料库'],
      ['会话附件来源', 'attachment', '附件'],
      ['文件选区来源', 'selection', '文件选区'],
      ['受管全文来源', 'managed_fulltext', '文件'],
      ['未知来源', 'unregistered', '未知来源'],
    ]) {
      await page.getByRole('group', { name: '预置示例' }).getByRole('button', { name: preset, exact: true }).click()
      await page.getByTestId('preview-component').getByRole('button').first().hover()
      const preview = page.getByLabel('引用预览', { exact: true })
      const sourceTag = preview.locator(`[title="${kind}"]`)
      if (kind === 'literature') {
        await expect(preview.getByText('示例作者 · 2026', { exact: true })).toBeVisible()
        await expect(preview.locator('[data-citation-excerpt]')).toHaveText([
          '合成摘录：研究先区分了任务类型，再比较完成时间。',
          '合成摘录：不同任务的完成率应分别报告。',
          '合成摘录：效率指标与质量指标应结合解读。',
        ])
      } else if (kind === 'file') {
        await expect(preview.getByText('示例作者 · 2026', { exact: true })).toHaveCount(0)
      }
      await expect(sourceTag).toHaveText(label)
      await expect(sourceTag).toHaveCSS('height', '20px')
      await expect(sourceTag).toHaveCSS('border-radius', '4px')
      await expect(sourceTag).toHaveCSS('font-size', '10px')
      await expect(sourceTag).toHaveCSS('line-height', '16px')
      await expect(sourceTag).toHaveCSS('padding-left', '6px')
      await expect(sourceTag).toHaveCSS('padding-right', '6px')
      await expect(sourceTag).toHaveCSS('color', 'rgb(76, 76, 76)')
      await expect(sourceTag).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.03)')
      await expect(sourceTag).toHaveCSS('border-top-width', '0px')
      await expect(sourceTag).toHaveCSS('box-shadow', /rgb\(223, 223, 223\) 0px 0px 0px 1px inset$/)
      await expect(preview).not.toContainText('本地文件')
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('file citation groups show the first filename, remaining count, bounded source navigation and selected opening', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'CitationLink')
    await page.getByRole('button', { name: '同类型多个文件', exact: true }).click()
    const marker = page.getByTestId('preview-component').getByRole('button').first()
    await expect(marker).toHaveText('阅读笔记.md+2')
    await marker.hover()
    const preview = page.getByLabel('引用预览', { exact: true })
    await expect(preview).toContainText('3 个来源')
    await expect(preview).not.toContainText('共引用 3 处')
    await expect(preview.getByText('3 个来源', { exact: true })).toHaveCSS('font-size', '12px')
    await expect(preview.getByRole('button', { name: '阅读笔记.md', exact: true })).toHaveCSS('font-weight', '500')
    await expect(preview.getByRole('button', { name: '上一个来源', exact: true })).toBeDisabled()
    await preview.getByRole('button', { name: '下一个来源', exact: true }).click()
    await expect(preview.getByRole('button', { name: '研究记录.md', exact: true })).toBeVisible()
    await preview.getByRole('button', { name: '研究记录.md', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(preview.getByRole('button', { name: '分析结果.md', exact: true })).toBeVisible()
    await expect(preview.getByRole('button', { name: '下一个来源', exact: true })).toBeDisabled()
    await page.keyboard.press('ArrowLeft')
    await preview.getByRole('button', { name: '研究记录.md', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await expect(page.getByTestId('preview-feedback')).toContainText('研究记录.md')
    await expect(marker).toHaveText('阅读笔记.md+2')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('web citation groups show the first domain and open the selected page', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'CitationLink')
    await page.getByRole('button', { name: '多个网页', exact: true }).click()
    const marker = page.getByTestId('preview-component').getByRole('button')
    await expect(marker).toHaveText('example+2')
    await marker.hover()
    const preview = page.getByLabel('网页来源预览', { exact: true })
    await expect(preview.getByRole('button')).toHaveCount(3)
    await preview.getByRole('button', { name: /合成数据网页/ }).click()
    await expect(page.getByTestId('preview-feedback')).toContainText('https://example.net/data')
    await expect(preview).toHaveCount(0)
    await expect(marker).toHaveText('example+2')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('Markdown merges same-type references across prose only within their paragraph', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'Markdown')
    await page.getByRole('button', { name: '同段落同类型引用合并', exact: true }).click()
    const component = page.getByTestId('preview-component')
    const first = component.locator('p').filter({ hasText: '第一段' })
    await expect(first).toContainText('保留中间正文')
    await expect(first).toContainText('后续文件')
    await expect(first.getByRole('button')).toHaveCount(2)
    const marker = first.getByRole('button', { name: '查看引用：阅读笔记.md', exact: true })
    await expect(marker).toHaveText('阅读笔记.md+2')
    const literature = first.getByRole('button', { name: '查看引用：文献库记录.pdf', exact: true })
    await expect(literature).toHaveText('文献库记录.pdf')
    const second = component.locator('p').filter({ hasText: '第二段' })
    await expect(second.getByRole('button')).toHaveCount(1)
    const single = second.getByRole('button', { name: '查看引用：研究记录.md', exact: true })
    await expect(single).toHaveText('研究记录.md')
    assert.equal(await literature.getAttribute('class'), await marker.getAttribute('class'))
    assert.equal(await single.getAttribute('class'), await marker.getAttribute('class'))
    await marker.hover()
    await expect(page.getByLabel('引用预览', { exact: true })).toContainText('共引用 4 处')
    await page.mouse.move(0, 0)
    await expect(page.getByLabel('引用预览', { exact: true })).toBeHidden()
    await single.hover()
    await expect(page.getByLabel('引用预览', { exact: true })).toContainText('研究记录.md')
    await single.click()
    await expect(page.getByTestId('preview-feedback')).toContainText('研究记录.md')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('citation directory shows one PDF title with separate paged excerpts', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'CitationSources')
    await page.getByRole('button', { name: '同一 PDF 多处引用', exact: true }).click()
    await page.getByRole('button', { name: '1 个来源', exact: true }).click()
    const entry = page.locator('[data-citation-source-entry]')
    await expect(entry).toHaveCount(1)
    await expect(entry.locator('[data-citation-source-title]')).toHaveText(
      '任务边界与效率（合成文献）.pdf'
    )
    await expect(entry.locator('[data-citation-source-title]')).toHaveCSS('font-weight', '500')
    await expect(entry.locator('[data-citation-source-title]')).toHaveCSS('font-size', '14px')
    await expect(entry.getByText('示例作者 · 2026', { exact: true })).toHaveCSS('font-size', '12px')
    await expect(entry.locator('[data-citation-excerpt]').first()).toHaveCSS('line-height', '18px')
    await expect(entry.getByText('第 3 页', { exact: true })).toHaveCSS('font-size', '10px')
    await expect(entry.locator('blockquote')).toHaveText([
      /第\s*3\s*页.*任务类型/s,
      /第\s*4\s*页.*完成率/s,
      /第\s*5\s*页.*质量指标/s,
    ])
    await entry.locator('blockquote').nth(1).getByRole('button').click()
    await expect(page.getByTestId('preview-feedback')).toContainText('sample-paper-page-4')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('citation presets distinguish web, literature and local files while the directory uses source icons', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'CitationLink')
    for (const [label, title, icon] of [
      ['网页来源', 'example', 'web'],
      ['文献来源', 'example', 'paper'],
      ['文件来源', '阅读笔记', 'file'],
    ]) {
      await page
        .getByRole('group', { name: '预置示例' })
        .getByRole('button', { name: label, exact: true })
        .click()
      const marker = page.getByTestId('preview-component').getByRole('button').first()
      await expect(marker).toContainText(title)
      if (icon === 'web') {
        await expect(marker).toHaveCSS('height', '22px')
        await expect(marker).toHaveCSS('font-size', '12px')
        await expect(marker.locator('[data-citation-icon="web"]')).toHaveCSS('width', '12px')
        await expect(marker).not.toContainText('合成研究网页')
        await marker.hover()
        const preview = page.getByLabel('网页来源预览', { exact: true })
        await expect(preview).toContainText('example.org')
        await expect(preview).toContainText('合成研究网页')
        await expect(preview.locator('[data-citation-source-title]')).toHaveCSS('font-weight', '600')
        await expect(preview.locator('[data-citation-source-title]')).toHaveCSS('-webkit-line-clamp', 'none')
        const header = preview.getByRole('button').locator('span').first()
        await expect(header.getByText('网页', { exact: true })).toHaveCSS('height', '20px')
        const domainBounds = await header.locator('[data-citation-source-domain]').boundingBox()
        const tagBounds = await header.getByText('网页', { exact: true }).boundingBox()
        assert.ok(tagBounds.x >= domainBounds.x + domainBounds.width)
        await expect(preview.getByRole('button')).toHaveCount(1)
        await expect(preview).not.toContainText('搜索来源')
        await preview.getByRole('button').click()
        await expect(preview).toHaveCount(0)
        await page.getByTestId('preview-feedback').getByRole('button').click()
        await expect(page.getByTestId('preview-feedback')).toHaveCount(0)
        await marker.focus()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('preview-feedback')).toContainText('https://example.org/research')
        await expect(page.getByLabel('网页来源预览', { exact: true })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(marker).toBeFocused()
      } else {
        await expect(marker.locator(`[data-citation-icon="${icon}"]`)).toHaveCount(1)
        await marker.hover()
        const preview = page.getByLabel('引用预览', { exact: true })
        await expect(preview).toContainText(icon === 'paper' ? '合成文献' : '阅读笔记.md')
        await expect(preview.locator('[data-citation-excerpt]')).toHaveCSS('-webkit-line-clamp', 'none')
        await expect(preview.getByRole('button')).toHaveCount(1)
        await expect(preview).toContainText('合成摘录')
        await preview.getByRole('button').click()
        await expect(preview).toHaveCount(0)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByTestId('preview-feedback')).toContainText('onOpen')
      }
      await page.mouse.move(0, 0)
      await page.keyboard.press('Escape')
    }
    await choose(page, 'CitationSources')
    await page.getByRole('button', { name: '网页、文献与本地文件', exact: true }).click()
    const trigger = page.getByRole('button', { name: '4 个来源', exact: true })
    await expect(trigger.locator('[data-citation-source-icons] > span')).toHaveCount(4)
    await trigger.hover()
    const directory = page.locator('[data-citation-source-panel]')
    await expect(directory).toHaveCount(0)
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(trigger.locator('.lucide-chevron-down')).toHaveCount(1)
    await page.mouse.move(0, 0)
    await expect(directory).toBeVisible()
    await expect(directory.getByRole('tablist')).toHaveCount(0)
    const list = directory.getByRole('list', { name: '4 个来源', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await expect(list.getByRole('button', { name: /阅读笔记.md/ })).toBeVisible()
    await expect(list.getByRole('button', { name: /合成标准网页/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(directory).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(directory).toBeVisible()
    await trigger.click()
    await expect(directory).toHaveCount(0)
    await trigger.press('Enter')
    await expect(directory).toBeVisible()
    await list.getByRole('button', { name: /合成标准网页/ }).click()
    await expect(directory).toHaveCount(0)
    await expect(page.getByTestId('preview-feedback')).toContainText('https://example.org/standard')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('image blocks use large, adjacent and scrollable layouts at the confirmed counts', async () => {
  const { page } = await openPage()
  try {
    await choose(page, 'ArtifactGroup')
    for (const count of [1, 2, 3, 4]) {
      await page
        .getByRole('group', { name: '预置示例' })
        .getByRole('button', { name: `${count} 张图片`, exact: true })
        .click()
      const group = page.getByTestId('artifact-image-group')
      const first = group.getByRole('button', {
        name: '示例图片 1',
        exact: true,
      })
      const firstBounds = await first.boundingBox()
      assert.ok(firstBounds)
      if (count === 1) assert.ok(firstBounds.height < firstBounds.width)
      if (count > 1) {
        const secondBounds = await group
          .getByRole('button', { name: '示例图片 2', exact: true })
          .boundingBox()
        assert.ok(secondBounds.x > firstBounds.x)
        assert.equal(secondBounds.y, firstBounds.y)
      }
      if (count === 4) {
        const viewport = group.locator('[data-slot="conversation-images-viewport"]')
        await viewport.hover()
        await page.mouse.wheel(500, 0)
        await expect
          .poll(() => viewport.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0)
        await group.getByRole('button', { name: '示例图片 4', exact: true }).click()
        await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('示例图片 4')
        await page.keyboard.press('Escape')
      }
    }
  } finally {
    await page.close()
  }
})

test('general chart gallery renders every original chart preset with its own renderer and JSON schema', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'Plot')
    const presets = await page.evaluate(async () => {
      const { previewEntries } = await import('/page.jsx')
      const { examples } = await import('/examples.mjs')
      const { contracts } = await import('/catalog.mjs')
      const { registeredExamples } = await import('/samples/registered.mjs')
      const { groupedPreviewExamples, previewExamples } = await import('/native.mjs')
      const registered = registeredExamples(previewEntries)
      const routed = previewExamples(previewEntries, examples, contracts)
      const presets = Object.fromEntries(previewEntries.map(entry => [entry.name,
        [...(registered[entry.name] ?? []), ...(routed[entry.name] ?? [])],
      ]))
      return groupedPreviewExamples(previewEntries, presets, 'Plot', contracts.Plot.previewGroup)
    })
    assert.equal(new Set(presets.map(preset => preset.sample)).size, 21)
    const picker = page.getByRole('combobox', { name: '预置示例', exact: true })
    const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
    for (const preset of presets) {
      await picker.click()
      await page.locator(`[role="option"][data-preview-id="${preset.id}"]`).click()
      await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', preset.sample)
      await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
      assert.deepEqual(JSON.parse(await editor.inputValue()), preset.data, preset.id)
      const component = page.getByTestId('preview-component')
      await expect(component).toBeVisible()
      await expect(component.getByText('plugin.loading', { exact: true })).toHaveCount(0)
      await expect(component.getByRole('alert')).toHaveCount(0)
      if (preset.sample === 'Table') await expect(component.getByRole('table')).toBeVisible()
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      await expect(picker).toBeVisible()
    }
    await page.setViewportSize({ width: 860, height: 900 })
    await expect(page.getByTestId('preview-component').getByRole('table')).toBeVisible()
    const answer = await page.getByTestId('preview-answer').boundingBox()
    assert.ok(answer.height > 200, JSON.stringify({ answer, layout: await page.evaluate(() => {
      const answer = document.querySelector('[data-testid="preview-answer"]')
      return { sample: answer.dataset.sample, text: answer.innerText.slice(0, 100),
        main: answer.parentElement.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight] }
    }) }))
    await page.reload()
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'Table')
    await expect(page.getByTestId('preview-component').getByRole('table')).toBeVisible()
    await expect(picker).toBeVisible()
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('documented presets apply from visible controls and update each official component', async () => {
  const { page, errors } = await openPage()
  try {
    const examples = await page.evaluate(async () => {
      const { examples } = await import('/examples.mjs')
      const { previewEntries } = await import('/page.jsx')
      const { previewExamples } = await import('/native.mjs')
      const { contracts } = await import('/catalog.mjs')
      return previewExamples(previewEntries, examples, contracts)
    })
    const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
    for (const [name, presets] of Object.entries(examples)) {
      await choose(page, name)
      for (const preset of presets) {
        if (name === 'Plot') {
          await page.getByRole('combobox', { name: '预置示例', exact: true }).click()
          await page.locator(`[role="option"][data-preview-id="Plot/${preset.id}"]`).click()
        } else {
          await page
            .getByRole('group', { name: '预置示例' })
            .getByRole('button', { name: preset.label, exact: true })
            .click()
        }
        await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
        assert.deepEqual(JSON.parse(await editor.inputValue()), preset.data, `${name}/${preset.id}`)
        await expect(page.getByTestId('preview-component')).toBeVisible()
        await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
        if (preset.data.model) {
          const figure = page.getByTestId('conversation-plot').locator('[role="img"][tabindex="0"]')
          await expect(figure, `${name}/${preset.id}`).toBeVisible()
          await expect(figure.locator('svg')).not.toHaveCount(0)
        }
        if (name === 'Formula' && preset.id !== 'parse-error')
          await expect(page.getByTestId('formula-render').locator('.katex')).toHaveCount(1)
        if (name === 'Diagram' && preset.id === 'search-flow')
          await expect(page.getByTestId('conversation-diagram').getByRole('img')).toBeVisible()
        if (name === 'Formula' && preset.id === 'parse-error')
          await expect(page.getByTestId('conversation-formula').getByRole('status')).toContainText(
            '公式有误'
          )
        if (name === 'Formula' && preset.id === 'matrix-long') {
          const scroller = page.getByTestId('formula-render')
          assert.ok(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth))
        }
        if (name === 'Diagram' && preset.id === 'invalid-flow')
          await expect(page.getByTestId('conversation-diagram').getByRole('alert')).toBeVisible()
      }
    }
    await choose(page, 'Formula')
    await editor.fill(JSON.stringify({ source: 'x^2 + 1' }))
    await expect(page.getByTestId('formula-render').locator('.katex')).toHaveCount(1)
    await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('editing a preset source hot-updates the buttons without discarding JSON drafts', async () => {
  const file = path.join(fixture, 'packages/ui/preview/samples/content.mjs')
  const original = await fs.readFile(file, 'utf8')
  const { page } = await openPage()
  try {
    await choose(page, 'Formula')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const draft = JSON.stringify({ source: 'x + y' })
    await editor.fill(draft)
    await fs.writeFile(file, original.replace('双重差分模型与变量说明', '热更新后的公式示例'))
    await expect(page.getByRole('group', { name: '预置示例' })).toContainText('热更新后的公式示例')
    await expect(editor).toHaveValue(draft)
  } finally {
    await fs.writeFile(file, original)
    await page.close()
  }
})

test('embedded citation delegates the original URL to its host and closes its preview', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(base + 'embedded.html')
    await page.getByRole('button', { name: 'Host CitationLink', exact: true }).click()
    await page.getByRole('button', { name: '网页来源', exact: true }).click()
    await page.getByTestId('preview-component').getByRole('button').hover()
    await page.getByLabel('网页来源预览', { exact: true }).getByRole('button').click()
    assert.equal(await page.evaluate(() => window.hostOpenedSource), 'https://example.org/research')
    await expect(page.getByLabel('网页来源预览', { exact: true })).toHaveCount(0)
  } finally {
    await page.close()
  }
})

test('embedded preview follows host selection without taking over navigation, theme or standalone drafts', async () => {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1050 },
  })
  try {
    await page.goto(base + 'embedded.html#host-state')
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'Markdown')
    await expect(page.locator('nav')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '官方 UI 实时预览', exact: true })).toHaveCount(
      0
    )
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
    const editorDialog = await page.getByRole('dialog').boundingBox()
    const editorArea = await page
      .getByRole('textbox', { name: '数据 JSON', exact: true })
      .boundingBox()
    assert.ok(editorDialog.width >= 1000)
    assert.ok(editorDialog.height >= 800)
    assert.ok(editorArea.height >= 500)
    await page
      .getByRole('textbox', { name: '数据 JSON', exact: true })
      .fill(JSON.stringify({ text: 'Embedded draft stays here', math: true }))
    await expect(page.getByTestId('preview-component')).toContainText('Embedded draft stays here')
    await page.getByRole('textbox', { name: '数据 JSON', exact: true }).fill('{')
    await expect(page.getByTestId('preview-data-state')).toContainText('未应用')
    await expect(page.getByTestId('preview-component')).toContainText('Embedded draft stays here')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Host BarChart', exact: true }).click()
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'BarChart')
    await expect(page.getByRole('group', { name: '预置示例' })).toBeVisible()
    await page.getByRole('group', { name: '预置示例', exact: true })
      .getByRole('button', { name: /^大规模：/ }).click()
    await expect(page.getByTestId('conversation-plot').getByTestId('plot-header')).toContainText('大规模')
    await expect(page.getByRole('button', { name: '恢复默认数据', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Host Plot', exact: true }).click()
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'Plot')
    await expect(page.getByRole('group', { name: '预置示例' })).toBeVisible()
    await page.getByRole('button', { name: 'Host Markdown', exact: true }).click()
    await expect(page.getByTestId('preview-component')).toContainText('Embedded draft stays here')
    assert.equal(new URL(page.url()).hash, '#host-state')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem('scholarseed.ui.live-preview.v1')),
      null
    )
    await page.reload()
    await expect(page.getByTestId('preview-component')).toContainText('Embedded draft stays here')
    await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
  } finally {
    await page.close()
  }
})

test('every public preview export is discovered while internal utilities retain their explicit contracts', async () => {
  const { page, errors, remote } = await openPage()
  try {
    const { names, groups } = await page.evaluate(async () => {
      const { previewEntries } = await import('/page.jsx')
      const { internal } = await import('/inventory.js')
      return { names: [...previewEntries, ...internal].flatMap(entry => [entry.name, ...entry.aliases]).sort(),
        groups: previewEntries.map(entry => entry.group) }
    })
    assert.ok(!names.includes('Form'))
    assert.ok(!names.includes('Message'))
    assert.ok(!names.includes('Choices'))
    for (const name of ['CodeBlock', 'Separator', 'Citation', 'Artifact/reference'])
      assert.ok(!names.includes(name), `${name} must not be discoverable`)
    assert.ok(names.includes('Artifact'))
    assert.ok(names.includes('BarChart/stacked'))
    assert.deepEqual([...new Set(groups)].sort(), ['正文与富内容', '图表', '产物与工作台', '基础组件'].sort())
    const listed = await page
      .locator('nav [data-export]')
      .evaluateAll((nodes) =>
        nodes.flatMap((node) => [node.dataset.export, ...JSON.parse(node.dataset.aliases)]).sort()
      )
    const { contracts } = await import('./catalog.mjs')
    const internal = names.filter((name) => contracts[name]?.internal)
    assert.deepEqual(internal, ['ArtifactDestination', 'Details', 'FileFormatIcon'])
    const visible = names.filter((name) => !internal.includes(name))
    assert.deepEqual(listed, visible)
    for (const name of visible) {
      await choose(page, name)
      await expect(page.getByTestId('preview-missing-contract')).toHaveCount(0)
      await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      await expect(page.getByTestId('preview-data-error')).toHaveCount(0)
      if (await page.getByTestId('preview-component').locator('[data-conversation-ui]').count())
        await expect(page.getByTestId('preview-component').locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'ready')
      const data = JSON.parse(
        await page.getByRole('textbox', { name: '数据 JSON', exact: true }).inputValue()
      )
      if (data.model) await expect(page.getByTestId('conversation-plot')).toBeVisible()
      if (name === 'Diagram')
        await expect(page.getByRole('img', { name: data.title, exact: true })).toBeVisible()
      if (name === 'Results')
        assert.notEqual(
          await page.evaluate(
            async ({ filename, content }) => (await import(filename)).parseResult(content),
            {
              filename:
                '/@fs/' +
                path
                  .join(fixture, 'apps/desktop/src/renderer/src/features/literature/Summary.tsx')
                  .split(path.sep)
                  .join('/'),
              content: data.content,
            }
          ),
          null
        )
      if (name === 'Review')
        assert.notEqual(
          await page.evaluate(
            async ({ filename, content }) => (await import(filename)).parseReview(content),
            {
              filename:
                '/@fs/' +
                path
                  .join(fixture, 'apps/desktop/src/renderer/src/features/literature/projection.ts')
                  .split(path.sep)
                  .join('/'),
              content: data.content,
            }
          ),
          null
        )
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(remote, [])
  } finally {
    await page.close()
  }
})

test('JSON edits apply immediately; invalid drafts and last valid data survive theme, navigation and reload', async () => {
  const { page, errors } = await openPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  try {
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const original = await editor.inputValue()
    const data = JSON.parse(original)
    data.labels[0] = '用户材料'
    data.series[0].props.category = '用户直接编辑的标题'
    await editor.fill(JSON.stringify(data, null, 2))
    await expect(page.getByTestId('preview-component')).toContainText('用户直接编辑的标题')
    await expect(page.getByTestId('preview-component').getByRole('img')).toContainText('用户材料')
    await page.getByRole('button', { name: '切换浅深主题', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const broken = { ...data, labels: 'not an array' }
    await editor.fill(JSON.stringify(broken))
    await expect(page.getByTestId('preview-data-error')).toContainText('labels')
    await expect(page.getByTestId('preview-component')).toContainText('用户直接编辑的标题')
    await editor.fill('{ invalid')
    await expect(page.getByTestId('preview-data-state')).toContainText('未应用')
    await choose(page, 'DataTable')
    await page.getByRole('button', { name: '预览 分组柱状图', exact: true }).click()
    await expect(editor).toHaveValue('{ invalid')
    await page.reload()
    await expect(editor).toHaveValue('{ invalid')
    await expect(page.getByTestId('preview-component')).toContainText('用户直接编辑的标题')
    await page.getByRole('button', { name: '恢复默认数据', exact: true }).click()
    await expect(editor).toHaveValue(original)
    assert.deepEqual(errors, [])
    assert.deepEqual(consoleErrors, [])
  } finally {
    await page.close()
  }
})

test('formula source-only JSON, mathematical notes and escaped complex LaTeX update the official renderer', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'Formula')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const formula = page.getByTestId('conversation-formula')
    await editor.fill(JSON.stringify({ source: String.raw`$$\frac{19}{24}$$` }))
    await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
    await expect(formula.locator('.katex')).toHaveCount(1)
    await expect(formula.getByTestId('formula-caption')).toHaveCount(0)
    await expect(formula.getByTestId('formula-notes')).toHaveCount(0)
    const toolbar = formula.getByTestId('formula-toolbar')
    await formula.hover()
    await expect(toolbar.getByRole('tablist')).toBeAttached()
    await expect(toolbar.getByRole('tab', { name: '公式', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(toolbar.getByRole('tab', { name: 'LaTeX', exact: true })).toHaveAttribute('aria-selected', 'false')
    await toolbar.getByRole('tab', { name: 'LaTeX', exact: true }).click()
    await expect(toolbar.getByRole('tab', { name: 'LaTeX', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(formula.getByRole('tabpanel')).toContainText(String.raw`$$\frac{19}{24}$$`)
    await toolbar.getByRole('tab', { name: '公式', exact: true }).click()
    await expect(toolbar.getByRole('tab', { name: '公式', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(toolbar.getByRole('button', { name: '复制' })).toHaveAttribute(
      'aria-label',
      '复制'
    )
    const source = String.raw`$$\ln y_{it} = \alpha_i + \lambda_t + \sum_{k=-K,\;k\neq -1}^{L}\beta_k\,\mathbf{1}\!\left[t-E_i=k\right]+X_{it}'\gamma+\varepsilon_{it}$$`
    const data = {
      source,
      notes: String.raw`$\hat{\beta}$ 无量纲；$$\frac{19}{24}$$ 非数学核验。`,
    }
    await editor.fill(JSON.stringify(data, null, 2))
    await expect(formula.getByTestId('formula-notes').locator('.katex')).toHaveCount(2)
    await expect(formula.getByTestId('formula-render').locator('.katex')).toHaveCount(1)
    await expect(formula.getByRole('status')).toHaveCount(0)
    await editor.fill(JSON.stringify(data).replace('\\\\alpha', '\\alpha'))
    await expect(page.getByTestId('preview-data-state')).toContainText('未应用')
    await expect(formula.getByTestId('formula-render').locator('.katex')).toHaveCount(1)
    await editor.fill(JSON.stringify(data))
    await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('diagram uses one framed toolbar for figure, source, copy and failure', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'Markdown')
    await page.getByRole('textbox', { name: '数据 JSON', exact: true }).fill(JSON.stringify({ text: '```mermaid\nflowchart LR\n A[输入] --> B[核对]\n```', math: true }))
    const diagram = page.getByTestId('conversation-diagram')
    await expect(diagram.getByRole('img')).toBeVisible()
    await diagram.hover()
    await expect(diagram.getByTestId('diagram-toolbar').getByRole('tablist')).toBeVisible()
    await diagram.getByRole('tab', { name: '源码', exact: true }).click()
    await expect(diagram.getByRole('tab', { name: '源码', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const source = diagram.getByTestId('conversation-code').locator('code')
    await expect(source).toContainText('flowchart')
    await expect(diagram.getByRole('button', { name: '复制' })).toBeVisible()
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    await editor.fill(JSON.stringify({ text: '```mermaid\nnot a diagram\n```', math: true }))
    await expect(diagram.getByRole('alert')).toContainText('原始源码已保留')
    await expect(source).toHaveText('not a diagram')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('wide tables and long formulas scroll inside the answer instead of widening its grid track', async () => {
  const { page, errors } = await openPage()
  try {
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    await choose(page, 'Formula')
    await editor.fill(
      JSON.stringify({
        source: Array.from({ length: 100 }, (_, index) => `x_{${index}}`).join('+'),
      })
    )
    const formula = page.getByTestId('formula-render')
    assert.ok(await formula.evaluate((element) => element.scrollWidth > element.clientWidth))
    const effect = await page.getByRole('main', { name: '对话效果' }).boundingBox()
    const bounds = await formula.boundingBox()
    assert.ok(bounds.x + bounds.width <= effect.x + effect.width)
    await formula.evaluate((element) => {
      element.scrollLeft = 200
    })
    assert.ok(await formula.evaluate((element) => element.scrollLeft > 0))
    await choose(page, 'Tabulation')
    const columns = Array.from({ length: 18 }, (_, index) => ({
      key: `field-${index}`,
      label: `指标 ${index}`,
      unit: index === 1 ? '%' : undefined,
    }))
    const rows = Array.from({ length: 24 }, (_, row) => ({
      id: `row-${row}`,
      values: columns.map((column, index) =>
        index === 0 ? `研究 ${row}` : index === 1 ? null : row + index
      ),
    }))
    const data = {
      dataset: { columns, rows },
      notes: '— 表示未提供，不代表 0。',
      sources: [
        {
          number: 1,
          kind: 'searched',
          title: '研究原文',
          url: 'https://example.invalid/paper',
          site: 'example.invalid',
        },
      ],
      citations: [{ rowId: 'row-0', columnKey: 'field-2', sourceNumber: 1 }],
    }
    await editor.fill(JSON.stringify(data))
    const table = page.getByTestId('conversation-table')
    await expect(table.getByText(data.notes, { exact: true })).toBeVisible()
    await expect(table.locator('tbody')).not.toContainText(data.notes)
    assert.equal(JSON.parse(await editor.inputValue()).notes, data.notes)
    await expect(table.locator('thead')).toContainText('指标 1 (%)')
    assert.equal(
      await table
        .locator('th')
        .first()
        .evaluate((element) => getComputedStyle(element).fontWeight),
      '400'
    )
    const scroll = table.getByTestId('table-scroll')
    assert.ok(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth))
    const tableBounds = await scroll.boundingBox()
    assert.ok(tableBounds.x + tableBounds.width <= effect.x + effect.width)
    const first = table.locator('tbody tr').first().locator('td').first()
    const rowBackground = await first.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    const headerBackground = await table
      .locator('thead th')
      .last()
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    assert.notEqual(rowBackground, headerBackground)
    const resolvedFill = (token) =>
      first.evaluate((element, name) => {
        const probe = element.ownerDocument.createElement('span')
        probe.style.backgroundColor = `var(${name})`
        element.append(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      }, token)
    assert.equal(rowBackground, await resolvedFill('--vds-fill-2'))
    assert.equal(headerBackground, await resolvedFill('--vds-fill-4'))
    const before = await first.boundingBox()
    const headerBefore = await table.locator('thead th').first().boundingBox()
    await scroll.evaluate((element) => {
      element.scrollLeft = 200
      element.scrollTop = 120
    })
    const after = await first.boundingBox()
    const headerAfter = await table.locator('thead th').first().boundingBox()
    assert.ok(Math.abs(before.x - after.x) < 2)
    assert.ok(Math.abs(headerBefore.y - headerAfter.y) < 2)
    await scroll.evaluate((element) => {
      element.scrollLeft = 0
      element.scrollTop = 0
    })
    await table
      .locator('tbody tr')
      .first()
      .getByRole('button', { name: /研究原文/ })
      .hover()
    const sourcePreview = page.getByLabel('网页来源预览', { exact: true })
    await expect(sourcePreview.getByRole('button')).toHaveCount(1)
    const sourceCard = sourcePreview.getByRole('button', { name: /研究原文/ })
    await expect(sourceCard).toBeVisible()
    await expect(sourceCard.locator('[data-citation-source-domain]')).toHaveText('example.invalid')
    await expect(sourceCard.locator('[data-citation-source-title]')).toHaveText('研究原文')
    await sourceCard.click()
    await expect(page.getByLabel('模拟反馈详情', { exact: true })).toHaveText(
      `Tabulation / openWebSource：${JSON.stringify([data.sources[0].url])}（仅模拟）`
    )
    await expect(sourcePreview).toHaveCount(0)
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('the Tabulation vertical scrollbar stays below the sticky header', async () => {
  const { page } = await openPage()
  try {
    await page.setViewportSize({ width: 1200, height: 650 })
    await choose(page, 'Tabulation')
    const table = page.getByTestId('conversation-table')
    const header = table.locator('thead th').first()
    const verticalBar = table.locator('[role="scrollbar"][aria-orientation="vertical"]')
    await expect(verticalBar).toBeVisible()
    const track = await verticalBar.boundingBox()
    const headerBefore = await header.boundingBox()
    assert.ok(Math.abs(track.y - (headerBefore.y + headerBefore.height)) < 2)
    await verticalBar.press('End')
    await expect(verticalBar).toHaveCSS('outline-style', 'none')
    const widths = await table.getByTestId('table-scroll').evaluate((viewport) => ({
      visible: viewport.clientWidth,
      outer: viewport.offsetWidth,
      table: viewport.querySelector('table').offsetWidth,
    }))
    assert.equal(widths.visible, widths.outer)
    assert.equal(widths.table, widths.visible)
    await expect.poll(async () => {
      const thumb = await verticalBar.locator('[data-scroll-thumb]').boundingBox()
      return Math.abs(thumb.y + thumb.height - (track.y + track.height))
    }).toBeLessThan(2)
    const headerAfter = await header.boundingBox()
    assert.ok(Math.abs(headerAfter.y - headerBefore.y) < 2)
  } finally {
    await page.close()
  }
})

test('code uses the existing highlighter beyond python and withdrawn image entries stay absent', async () => {
  const { page, errors } = await openPage()
  try {
    for (const name of ['Images', 'ImageThumbnail', 'ImageView', 'Code', 'Diagram'])
      await expect(page.getByRole('button', { name: `预览 ${name}`, exact: true })).toHaveCount(0)
    await choose(page, 'Markdown')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    await editor.fill(
      JSON.stringify({
        text: '```c++\n#include <iostream>\nint main() { std::cout << "ok"; return 0; }\n```',
        math: true,
      })
    )
    await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
    const code = page.getByTestId('preview-component').getByTestId('conversation-code')
    await expect(code).toContainText('c++')
    assert.ok((await code.locator('[data-code-line] span[class]').count()) > 0)
    await editor.fill(
      JSON.stringify({
        text: '```custom-language\n<script>literal()</script>\n```',
        math: true,
      })
    )
    await expect(code.locator('pre')).toHaveText('<script>literal()</script>')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('registered preview labels and scale presets remain selectable and preserve original measurements', async () => {
  const { page, errors } = await openPage()
  try {
    const labels = await page.locator('nav [data-export]').allTextContents()
    for (const label of labels) assert.match(label, /[\u3400-\u9fff]/)
    await expect(page.getByRole('button', { name: '预览 平滑面积图', exact: true })).toBeVisible()
    const names = await page.evaluate(async () => {
      const { previewEntries } = await import('/page.jsx')
      return previewEntries.filter(entry => entry.native).map(entry => entry.name)
    })
    for (const name of names) {
      await choose(page, name)
      if (name === 'Separator') continue
      const counts = []
      for (const scale of ['小规模', '中等规模', '大规模']) {
        await page.getByRole('group', { name: '预置示例', exact: true })
          .getByRole('button', { name: new RegExp(`^${scale}：`) }).click()
        await expect(page.getByTestId('preview-data-state')).toContainText('已应用')
        const data = JSON.parse(await page.getByRole('textbox', { name: '数据 JSON', exact: true }).inputValue())
        counts.push(data.labels?.length ?? data.datasets?.[0].props.points.length
          ?? data.columns?.[0].props.data.length ?? data.tags?.length
          ?? data.text?.length ?? data.codeString?.length ?? data.label?.length)
        if (data.title) {
          const plot = page.getByTestId('conversation-plot')
          await expect(plot.getByTestId('plot-header')).toContainText(scale)
          await plot.getByTestId('plot-header').hover()
          await plot.getByRole('tab', { name: '查看原始数据', exact: true }).click()
          const expected = data.datasets ? data.datasets.reduce((sum, series) => sum + series.props.points.length, 0) : data.labels.length
          await expect(plot.getByRole('row')).toHaveCount(expected + 1)
          await plot.getByRole('tab', { name: '查看图形', exact: true }).click()
        }
        await expect(page.getByTestId('preview-render-error')).toHaveCount(0)
      }
      assert.ok(counts[0] < counts[1] && counts[1] < counts[2], name)
    }
    await choose(page, 'AreaChart/natural')
    await page.getByRole('textbox', { name: '查找对话卡片', exact: true }).fill('平滑面积')
    await expect(page.locator('nav [data-export]')).toHaveCount(1)
    await expect(page.getByRole('heading', { name: '平滑面积图', exact: true })).toBeVisible()
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('registered OpenUI charts share the original plot frame and preserve every variant', async () => {
  const { page, errors } = await openPage()
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const entries = await page.evaluate(async () => {
      const { previewEntries } = await import('/page.jsx')
      return previewEntries.filter(entry => entry.native && entry.group === '图表' && entry.component !== 'Table')
        .map(entry => entry.name)
    })
    assert.ok(entries.includes('AreaChart/natural'))
    assert.ok(entries.includes('HorizontalBarChart/stacked'))
    for (const name of entries) {
      await choose(page, name)
      const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
      const data = JSON.parse(await editor.inputValue())
      data.title = `${name} original measurements`
      await editor.fill(JSON.stringify(data))
      const plot = page.getByTestId('conversation-plot')
      await expect(plot.getByTestId('plot-header')).toContainText(data.title)
      const figure = plot.getByRole('tabpanel', { name: '查看图形', exact: true })
      await expect(figure).toBeVisible()
      const colors = await figure.locator('[stroke^="var(--vds-chart-series-"], [fill^="var(--vds-chart-series-"], [style*="var(--vds-chart-series-"]').count()
      assert.ok(colors > 0, `${name} uses the shared chart palette`)
      await plot.getByTestId('plot-header').hover()
      await plot.getByRole('tab', { name: '查看原始数据', exact: true }).click()
      await expect(plot.getByRole('table')).toBeVisible()
      await expect(plot.getByRole('checkbox')).toHaveCount(0)
      const copy = plot.getByTestId('plot-header').getByRole('button')
      await copy.click()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      assert.ok(copied.includes('\t'), name)
      await plot.getByRole('tab', { name: '查看图形', exact: true }).click()
      await expect(figure).toBeVisible()
    }
    await choose(page, 'AreaChart/natural')
    const plot = page.getByTestId('conversation-plot')
    await page.getByRole('button', { name: '切换浅深主题', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(plot.getByTestId('plot-header')).toBeVisible()
    const figure = plot.getByRole('tab', { name: '查看图形', exact: true })
    await figure.focus()
    await page.keyboard.press('ArrowRight')
    await expect(plot.getByRole('table')).toBeVisible()
    await page.setViewportSize({ width: 1040, height: 660 })
    await expect(plot.getByTestId('plot-header')).toBeVisible()
    const box = await plot.boundingBox()
    assert.ok(box.x + box.width <= 1040)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('named charts share an integrated header, view tabs and explanation without enlargement', async () => {
  const { page, errors } = await openPage()
  try {
    const names = ['BarChart', 'GroupedBarChart', 'StackedBarChart', 'LineChart', 'ScatterChart', 'PieChart', 'DonutChart', 'Histogram', 'BoxPlot', 'Heatmap']
    await choose(page, 'Plot')
    for (const name of names) {
      const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
      const data = await page.evaluate(async (component) => {
        const { contracts } = await import('/catalog.mjs')
        const { generate } = await import('/schema.mjs')
        const { rules } = await import('/rules.mjs')
        return generate(contracts[component].schema, component, rules)
      }, name)
      data.notes = '统计口径保持独立，不跨研究直接比较。'
      await editor.fill(JSON.stringify(data))
      const plot = page.getByTestId('conversation-plot')
      await expect(plot.getByTestId('plot-notes')).toHaveText(data.notes)
      await expect(plot.getByTestId('plot-header')).toContainText(data.title)
      await plot.hover()
      await plot.getByRole('tab', { name: '查看原始数据', exact: true }).click()
      await expect(plot.getByRole('table')).toBeVisible()
      await expect(plot.getByRole('checkbox')).toHaveCount(0)
      const row = plot.getByRole('row').nth(1)
      await row.focus()
      await page.keyboard.press('Enter')
      await expect(row).toHaveAttribute('aria-selected', 'true')
      await expect(plot.getByTestId('plot-notes')).toBeVisible()
      await plot.getByRole('tab', { name: '查看图形', exact: true }).click()
      await expect(plot.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('nonempty categories separate shared foundations and preserve aliases, search and editable drafts', async () => {
  const { page, errors } = await openPage()
  try {
    const categories = ['正文与富内容', '图表', '产物与工作台', '基础组件']
    assert.deepEqual(
      await page
        .locator('nav [data-category]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.category)),
      categories
    )
    const counts = await page.evaluate(async () => {
      const { previewEntries } = await import('/page.jsx')
      return Object.fromEntries(previewEntries.map(entry => [entry.group,
        previewEntries.filter(candidate => candidate.group === entry.group).length]))
    })
    assert.deepEqual(await page.locator('nav [data-category]').evaluateAll(nodes =>
      nodes.map(node => node.querySelectorAll('[data-export]').length)), categories.map(category => counts[category]))
    const foundations = page.locator('nav [data-category="基础组件"]')
    assert.deepEqual(
      await foundations
        .locator('[data-export]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.export)),
      [
        'Artifact',
        'CitationLink',
        'CitationSources',
        'DataTable',
        'FileMenuItems',
        'Plot',
      ]
    )
    for (const name of ['DataTable', 'CitationSources', 'Artifact']) {
      await choose(page, name)
      await expect(page.getByRole('textbox', { name: '数据 JSON', exact: true })).toBeVisible()
    }
    await expect(
      page.getByRole('button', { name: '预览 ArtifactMenuItems', exact: true })
    ).toHaveCount(0)
    await choose(page, 'FileMenuItems')
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    const draft = JSON.parse(await editor.inputValue())
    draft.canSaveAs = false
    const json = JSON.stringify(draft, null, 2)
    await editor.fill(json)
    await page.evaluate(() => {
      const key = 'scholarseed.ui.live-preview.v1'
      const legacy = JSON.parse(sessionStorage.getItem(key))
      legacy.records.ArtifactMenuItems = legacy.records.FileMenuItems
      delete legacy.records.FileMenuItems
      legacy.selected = 'ArtifactMenuItems'
      sessionStorage.setItem(key, JSON.stringify(legacy))
    })
    await page.goto(base + '#ArtifactMenuItems')
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'FileMenuItems')
    await expect(editor).toHaveValue(json)
    await page.getByRole('textbox', { name: '查找对话卡片' }).fill('ArtifactMenuItems')
    await expect(page.locator('nav [data-export]')).toHaveCount(1)
    await expect(page.locator('nav [data-export]')).toHaveAttribute('data-export', 'FileMenuItems')
    await page.getByRole('textbox', { name: '查找对话卡片' }).fill('')
    draft.canSaveAs = true
    await editor.fill(JSON.stringify(draft))
    await page.reload()
    await expect(editor).toHaveValue(JSON.stringify(draft))
    await page.setViewportSize({ width: 700, height: 850 })
    await page.getByRole('combobox', { name: '选择对话卡片' }).click()
    assert.deepEqual(
      await page
        .getByRole('listbox')
        .getByRole('group')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      categories
    )
    await expect(page.getByRole('option')).toHaveCount(Object.values(counts).reduce((total, count) => total + count, 0))
    await page.getByRole('option', { name: '分组柱状图', exact: true }).click()
    await expect(page.getByTestId('preview-answer')).toHaveAttribute('data-sample', 'BarChart')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('native content, theme and JSON editor remain available at narrow widths', async () => {
  const { page, errors } = await openPage()
  try {
    await choose(page, 'TagBlock')
    await expect(page.getByRole('heading', { name: '标签组', exact: true })).toBeVisible()
    const editor = page.getByRole('textbox', { name: '数据 JSON', exact: true })
    const tags = JSON.parse(await editor.inputValue())
    tags.tags = ['更新后的研究标签']
    await editor.fill(JSON.stringify(tags))
    await expect(page.getByTestId('preview-component').getByText(tags.tags[0], { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '切换浅深主题', exact: true }).click()
    await expect(page.getByTestId('preview-component').getByText(tags.tags[0], { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 900, height: 700 })
    await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
    const dialogBounds = await page.getByRole('dialog').boundingBox()
    assert.ok(dialogBounds.x >= 16 && dialogBounds.y >= 16)
    assert.ok(dialogBounds.width <= 868 && dialogBounds.height <= 668)
    assert.ok(
      (await page.getByRole('textbox', { name: '数据 JSON', exact: true }).boundingBox()).height >=
        292
    )
    await expect(
      page.getByRole('dialog').getByRole('textbox', { name: '数据 JSON', exact: true })
    ).toBeVisible()
    await page.getByRole('dialog').getByText('数据 JSON', { exact: true }).click()
    await expect(
      page.getByRole('dialog').getByRole('textbox', { name: '数据 JSON', exact: true })
    ).toBeFocused()
    await page.keyboard.press('Escape')
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('editing official source and adding an export updates automatically without regenerating preview code', async () => {
  const { page, errors } = await openPage()
  try {
    const editor = page.getByRole('textbox', {
      name: '数据 JSON',
      exact: true,
    })
    await choose(page, 'TextContent')
    const data = JSON.parse(await editor.inputValue())
    data.text = '保持当前 JSON 草稿'
    await editor.fill(JSON.stringify(data))
    if (process.env.PREVIEW_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PREVIEW_EVIDENCE_DIR, { recursive: true })
      await page.screenshot({
        path: path.join(process.env.PREVIEW_EVIDENCE_DIR, 'hmr-before.png'),
      })
    }
    const filename = path.join(
      fixture,
      'packages/ui/library.tsx'
    )
    const original = await fs.readFile(filename, 'utf8')
    assert.ok(original.includes("String(props.text ?? '')"))
    await fs.writeFile(filename, original.replace("String(props.text ?? '')", '"HMR 源码改动：" + String(props.text ?? "")'))
    await expect(page.getByTestId('preview-component')).toContainText(
      'HMR 源码改动：保持当前 JSON 草稿',
      { timeout: 30000 }
    )
    await expect(editor).toHaveValue(JSON.stringify(data))
    if (process.env.PREVIEW_EVIDENCE_DIR)
      await page.screenshot({
        path: path.join(process.env.PREVIEW_EVIDENCE_DIR, 'hmr-after.png'),
      })
    const exports = path.join(fixture, 'packages/ui/conversation.ts')
    await fs.appendFile(exports, '\nexport function NewlyDiscoveredCard() { return null }\n')
    await expect(
      page.getByRole('button', {
        name: '预览 NewlyDiscoveredCard',
        exact: true,
      })
    ).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: '预览 NewlyDiscoveredCard', exact: true }).click()
    await expect(page.getByTestId('preview-missing-contract')).toContainText('NewlyDiscoveredCard')
    const count = await page.locator('nav [data-export]').count()
    await fs.appendFile(
      exports,
      "\nexport { FileMenuItems as NewlyDiscoveredAlias } from '../../apps/desktop/src/renderer/src/components/business/Artifact'\n"
    )
    await expect(page.locator('nav [data-export=FileMenuItems]')).toHaveAttribute(
      'data-aliases',
      /NewlyDiscoveredAlias/
    )
    await expect(page.locator('nav [data-export]')).toHaveCount(count)
    await page.getByRole('textbox', { name: '查找对话卡片' }).fill('NewlyDiscoveredAlias')
    await expect(page.locator('nav [data-export]')).toHaveCount(1)
    await expect(page.locator('nav [data-export]')).toHaveAttribute('data-export', 'FileMenuItems')
    await page.getByRole('textbox', { name: '查找对话卡片' }).fill('')
    if (process.env.PREVIEW_EVIDENCE_DIR)
      await page.screenshot({
        path: path.join(process.env.PREVIEW_EVIDENCE_DIR, 'discovery-added.png'),
      })
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
