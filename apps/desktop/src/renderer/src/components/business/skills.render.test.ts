import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'
import type { DeviceSkillRequest } from '../../../../skills.ts'
import { WORKSPACE_WINDOW_MINIMUM } from '../../../../window.ts'
import { unzipSync, strFromU8 } from 'fflate'

type SkillTestWindow = Window & {
  failSkillLoad: boolean
  skillActions: unknown[]
  skillRequests: DeviceSkillRequest[]
  releaseSkillInstall: () => void
  releaseNextPage: () => void
  releaseConnectorInstall: () => void
  connectorRequests: { action: { operation: string } }[]
  removeResearchCategory: boolean
  holdSkillLists: boolean
  pendingSkillLists: Array<() => void>
  holdSkillToggles: boolean
  pendingSkillToggles: Array<(success: boolean) => void>
  changeSkillLanguage: (language: string) => Promise<unknown>
}

const servers = renderServers({ after })

test('skill use failures explain their cause, retain input and follow language changes', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    for (const scenario of [
      {
        failure: 'login_required',
        chinese: '请先登录书深，再使用技能“skill-0”开始任务。',
        english: 'Sign in to ScholarSeed before starting a task with skill “skill-0”.',
      },
      {
        failure: 'disabled',
        chinese: '技能“skill-0”已停用或运行状态未就绪。请在技能详情中检查启用状态和不可用原因。',
        english:
          'Skill “skill-0” is disabled or not ready to run. Check its enabled status and availability details.',
      },
      {
        failure: 'dependencies',
        chinese: '技能“skill-0”的依赖尚未就绪。请在技能详情中完成依赖准备后重试。',
        english:
          'Dependencies for skill “skill-0” are not ready. Review its details, prepare the dependencies, then try again.',
      },
      {
        failure: 'path',
        chinese:
          '技能“skill-0”的本地路径缺失或格式不受支持。请刷新技能库后重试；仍失败时请联系支持。',
        english:
          'Skill “skill-0” has no local path or its path format is unsupported. Refresh the skill library and try again; contact support if the problem persists.',
      },
    ]) {
      await page.goto(
        new URL('/__skills?useFailure=' + scenario.failure, server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await page.getByTestId('skill-view-skill-0').click()
      await page
        .getByTestId('skill-detail')
        .getByRole('button', { name: '使用技能', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('任务内容').fill('保留这段任务内容')
      await dialog.getByRole('button', { name: '带入新任务', exact: true }).click()
      await expect(page.getByText(scenario.chinese, { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: '带入新任务', exact: true }).click()
      await expect(page.getByText(scenario.chinese, { exact: true })).toHaveCount(1)
      await expect(dialog.getByRole('textbox')).toHaveValue('保留这段任务内容')
      await expect(dialog.getByRole('combobox')).toHaveText('Project one')
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as SkillTestWindow).skillActions),
        []
      )
      await page.evaluate(() => (window as unknown as SkillTestWindow).changeSkillLanguage('en'))
      await expect(page.getByText(scenario.english, { exact: true })).toBeVisible()
      await expect(page.getByText(scenario.chinese, { exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('textbox')).toHaveValue('保留这段任务内容')
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill task submission preserves Windows extended and UNC paths', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    for (const path of [
      String.raw`C:\Research Files\skills\skill-0\SKILL.md`,
      String.raw`\\?\C:\Research Files\skills\skill-0\SKILL.md`,
      String.raw`\\server\share\skills\skill-0\SKILL.md`,
      String.raw`\\?\UNC\server\share\skills\skill-0\SKILL.md`,
    ]) {
      const address = new URL('/__skills', server.resolvedUrls!.local[0])
      address.searchParams.set('usePath', path)
      await page.goto(address.href)
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await page.getByTestId('skill-view-skill-0').click()
      await page
        .getByTestId('skill-detail')
        .getByRole('button', { name: '使用技能', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('任务内容').fill('开始技能任务')
      await dialog.getByRole('button', { name: '带入新任务', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as SkillTestWindow).skillActions),
        [
          {
            projectId: 'project-one',
            submit: true,
            composerText: '开始技能任务',
            composerRefs: [
              { type: 'skill', id: 'skill-0', title: 'skill-0', path, version: undefined },
            ],
          },
        ]
      )
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skills overlay scrollbar preserves width across tabs and supports dragging and keyboard', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL('/__skills?marketData=1&scrollMarket=1', server.resolvedUrls!.local[0]).href
    )
    const list = page.getByTestId('skills-list')
    const bar = page.getByRole('scrollbar')
    await expect(bar).toBeVisible()
    assert.equal((await bar.boundingBox())!.width, 4)
    const width = await list.evaluate((element) => element.clientWidth)
    assert.equal(await list.evaluate((element) => (element as HTMLElement).offsetWidth), width)
    await bar.focus()
    await page.keyboard.press('End')
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.press('Home')
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0)
    const thumb = bar.locator('[data-scroll-thumb]')
    const box = (await thumb.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80)
    await page.mouse.up()
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.getByRole('tab', { name: '系统预置', exact: true }).click()
    await expect(page.getByTestId('skill-card-skill-0')).toBeVisible()
    assert.equal(await list.evaluate((element) => element.clientWidth), width)
    await expect(bar).toHaveCount(0)
    await page.getByRole('tab', { name: '技能广场', exact: true }).click()
    await expect(bar).toBeVisible()
    assert.equal(await list.evaluate((element) => element.clientWidth), width)
    await list.hover()
    await page.mouse.wheel(0, 200)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  } finally {
    await browser.close()
    await server.close()
  }
})

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = '/__skills_fixture.tsx'
const STORE = '\0skills-store'
const VIEWPORT = { width: 1280, height: 840 }
const TITLEBAR_DESIGN = { height: 32 }
const FIXTURE = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '/../../localization/engine'
import skills from '/../../localization/locales/zh/skills.json'
import ui from '/../../localization/locales/zh/ui.json'
import components from '/../../localization/locales/zh/components.json'
import englishSkills from '/../../localization/locales/en/skills.json'
import englishUi from '/../../localization/locales/en/ui.json'
import englishComponents from '/../../localization/locales/en/components.json'
import { Skills } from '/components/business/Skills'
import { skillsFeature } from '/features/skills/feature'
import { HomeHeader } from '/shell/Header'
import { ToastProvider, Toaster } from '/components/ui'
import '/styles.css'
const rows = Array.from({ length: location.search.includes('emptyUser') ? 5 : 30 }, (_, index) => ({
  name: 'skill-' + index, group: index < 5 && !location.search.includes('emptySystem') ? 'scholarseed' : 'user',
  description: 'A long skill description '.repeat(20), enabled: true,
  active: true, requires_login: false, toggleable: index >= 5, removable: index >= 5,
  path: '/skills/skill-' + index, dependency_status: 'ready',
  installationSource: index === 6 ? 'marketplace' : index === 8 ? 'unknown' : 'upload',
  labels: location.search.includes('classificationData') ? [{ slug: index % 2 ? 'analysis' : 'research', type: 'RECOMMENDED', displayName: index % 2 ? '数据分析' : '文献研究' }] : [], labelsStatus: 'ready',
}))
window.skillRequests = []
const useFailure = new URLSearchParams(location.search).get('useFailure')
const usePath = new URLSearchParams(location.search).get('usePath')
if (usePath) rows[0].path = usePath
if (useFailure === 'login_required') rows[0].unavailable_reason = 'login_required'
if (useFailure === 'disabled') rows[0].active = false
if (useFailure === 'dependencies') rows[0].dependency_status = 'missing'
if (useFailure === 'path') rows[0].path = 'relative/SKILL.md'
if (location.search.includes('pluginData')) {
  Object.assign(rows[0], { plugin: { id: 'fixture-plugin', version: '1.0.0' } })
  Object.assign(rows[1], { plugin: { id: 'disabled-plugin', version: '1.0.0' }, enabled: false })
}
if (location.search.includes('authoringData')) {
  rows[0].name = 'plugin-create'
  rows[5].name = 'plugin-create'
}
if (location.search.includes('disabledReason')) rows[5].unavailable_reason = '该技能已在书深中停用'
window.pendingSkillLists = []
window.pendingSkillToggles = []
if (location.search.includes('updateData')) {
  for (const index of [5, 6, 7]) Object.assign(rows[index], {
    enabled: index !== 5,
    hub: { source: 'clawhub', registry: 'https://hub.example', namespace: 'global', slug: 'skill-' + index, version: '1.0' },
    latestVersion: index === 7 ? null : '2.0', updateStatus: index === 7 ? 'unavailable' : 'available',
  })
}
window.skillActions = []
window.failSkillLoad = location.search.includes('failLoad')
window.failNextPage = location.search.includes('failMore')
const marketItem = { slug: 'market-paper', name: 'Paper tools', description: 'Find research papers', version: '1.0', moderation: 'unknown', downloads: location.search.includes('noDownloads') ? null : 1245, labels: location.search.includes('classificationData') ? [{ slug: 'research', type: 'RECOMMENDED', displayName: '文献研究' }] : [], labelsStatus: 'ready' }
const attribution = { authors: ['Declared author'], repository_name: 'deepseek-ai/deepseek-harness', repository_url: 'https://github.com/deepseek-ai/deepseek-harness', kind: 'imported', path: 'skills/papers', revision: 'abc123' }
marketItem.provider = 'Platform Admin'
if (location.search.includes('attributionData')) Object.assign(marketItem, { attribution, attributionStatus: 'ready', provider: 'Platform Admin' })
if (location.search.includes('attributionData')) Object.assign(rows[2], { attribution, attributionStatus: 'ready' })
if (location.search.includes('updateData')) for (const index of [5, 6, 7]) Object.assign(rows[index], { attribution, attributionStatus: 'ready' })
if (location.search.includes('attributionData')) marketItem.labels = [{ slug: 'research', type: 'RECOMMENDED', displayName: '科研工程与计算基础设施' }]
if (location.search.includes('blocked')) marketItem.moderation = 'blocked'
const marketPage = items => ({ status: 200, body: JSON.stringify({ items, total: 89, nextCursor: null, registry: location.search.includes('migratedMarket') ? 'https://scholarseed.damo.alibaba.com/skillhub' : 'http://hub.example', registryAliases: location.search.includes('migratedMarket') ? ['https://scholarseed.damo.alibaba.com/skillhub', 'http://120.26.99.45'] : ['http://hub.example'] }) })
if (location.search.includes('migratedMarket')) rows.push({ name: 'paper-local-name', group: 'user', description: 'Research', enabled: true, active: true, toggleable: true, removable: true, hub: { source: 'clawhub', registry: location.search.includes('differentPath') ? 'https://scholarseed.damo.alibaba.com/other' : 'http://120.26.99.45/', slug: 'market-paper', version: '0.9' } })
const connectors = [
  { id: 'zotero', name: 'Zotero', installed: false, authorized: false, enabled: false, methods: ['key'], transport: 'http', url: 'https://example.test/mcp', key_label: 'API Key', help_url: 'https://example.test/credentials', source_url: 'https://example.test/source', management_url: 'https://example.test/manage', tools: null },
  { id: 'github', name: 'GitHub', installed: true, method: 'key', authorized: location.search.includes('authorizedConnector'), enabled: false, methods: ['key', 'oauth'], transport: 'http', source_url: '', tools: location.search.includes('authorizedConnector') ? Array.from({length: 40}, (_, index) => ({name: index === 0 ? 'search_repository' : 'repository_tool_' + index, description: 'Search a repository with a long description to exercise internal scrolling.'})) : null },
]
if (location.search.includes('emptyConnectors')) for (const item of connectors) item.installed = false
if (location.search.includes('twoConnectors')) connectors[0].installed = true
window.connectorRequests = []
if (location.search.includes('longConnector')) connectors[1].name = 'QA_连续长名称_'.repeat(16)
window.scholarseed = { openExternal: async url => { window.skillActions.push(url) }, mcpSettings: async request => {
  if (request.operation === 'connectors') {
    if (location.search.includes('delayConnectors')) await new Promise(() => {})
    return { status: 200, body: JSON.stringify({ connectors }) }
  }
  if (request.operation === 'connector') {
    window.connectorRequests.push(request)
    const item = connectors.find(item => item.id === request.id)
    if (request.action.operation === 'login') item.attempt = { authorization_url: 'https://example.test/oauth', expires_at: Date.now() / 1000 + 600 }
    if (request.action.operation === 'cancel') delete item.attempt
    if (request.action.operation === 'toggle') item.enabled = request.action.enabled
    if (request.action.operation === 'install') {
      await new Promise(resolve => { window.releaseConnectorInstall = resolve })
      item.installed = true
    }
    return { status: 200, body: JSON.stringify(item) }
  }
}, deviceSkills: async request => {
  window.skillRequests.push(request)
  if (request.operation === 'marketplace-update') {
    if (location.search.includes('failUpdate') && request.name === 'skill-6') return { status: 502, body: '{}' }
    const row = rows.find(item => item.name === request.name)
    row.hub.version = request.version
    row.updateStatus = 'current'
    return { status: 200, body: JSON.stringify({ installed: { name: row.name } }) }
  }
  if (request.operation === 'marketplace-labels' && location.search.includes('delayLabels')) await new Promise(() => {})
  if (request.operation === 'marketplace-labels') return location.search.includes('failLabels')
    ? { status: 503, body: '{}' }
    : { status: 200, body: JSON.stringify({ labels: location.search.includes('standardLabels') ? ['文献与证据', '研究设计', '数据分析', '建模仿真', '实验执行', '学术写作', '科研工程', '流程编排'].map((displayName, index) => ({ slug: 'standard-' + index, type: 'RECOMMENDED', displayName })) : [
        ...window.removeResearchCategory ? [] : [{ slug: 'research', type: 'RECOMMENDED', displayName: '文献研究' }],
        { slug: 'analysis', type: 'RECOMMENDED', displayName: '数据分析' },
        ...location.search.includes('longLabels') ? Array.from({ length: 6 }, (_, index) => ({ slug: 'category-' + index, type: 'RECOMMENDED', displayName: 'Research Engineering and Computing Infrastructure ' + index })) : [],
        { slug: 'official', type: 'PRIVILEGED', displayName: '官方认证' },
      ] }) }
  if (request.operation === 'marketplace') {
    if (location.search.includes('delayInitialMarket')) await new Promise(() => {})
    if (window.failSkillLoad) return { status: 503, body: '{}' }
    if (request.label === 'analysis') return marketPage([])
    if (location.search.includes('paginate')) {
      if (request.query === 'missing') return marketPage([])
      if (request.cursor) {
        if (window.failNextPage) { window.failNextPage = false; return { status: 503, body: '{}' } }
        if (location.search.includes('delayMore')) await new Promise(resolve => { window.releaseNextPage = resolve })
        return marketPage([{ ...marketItem, slug: 'next-paper', name: 'Next paper' }])
      }
      const result = marketPage(Array.from({ length: 24 }, (_, index) => ({ ...marketItem, slug: 'market-' + index, name: 'Paper tools ' + index })))
      result.body = JSON.stringify({ ...JSON.parse(result.body), nextCursor: 'next' })
      return result
    }
    if (!location.search.includes('marketData')) return marketPage([])
    if (request.query === 'old') return new Promise(resolve => { window.releaseOldMarket = () => resolve(marketPage([{ ...marketItem, name: 'Stale result' }])) })
    return marketPage(request.query === 'missing' ? [] : location.search.includes('scrollMarket') ? Array.from({ length: 40 }, (_, index) => ({ ...marketItem, slug: 'market-' + index, name: 'Paper tools ' + index })) : [marketItem])
  }
  if (request.operation === 'marketplace-detail') {
    if (location.search.includes('delayDocument')) await new Promise(() => {})
    return { status: 200, body: JSON.stringify({ ...marketItem, document: '# Paper instructions\\n\\n' + 'Long documentation paragraph.\\n\\n'.repeat(100), registry: 'http://hub.example', provider: 'Test author' }) }
  }
  if (request.operation === 'marketplace-install') {
    if (location.search.includes('delayInstall')) await new Promise(resolve => { window.releaseSkillInstall = resolve })
    rows.push({ name: 'paper-local-name', group: 'user', description: 'Research', enabled: request.enabled ?? true, active: request.enabled ?? true, toggleable: true, removable: true, installationSource: 'marketplace', labels: marketItem.labels, labelsStatus: 'ready', attribution: marketItem.attribution, attributionStatus: marketItem.attributionStatus, hub: { source: 'clawhub', provider: 'Platform Admin', registry: 'http://hub.example', slug: request.slug, version: request.version } })
    return { status: 200, body: JSON.stringify({ installed: { name: 'paper-local-name' } }) }
  }
  if (request.operation === 'list' && window.failSkillLoad) return { status: 503, body: '{}' }
  if (request.operation === 'list' && location.search.includes('delayInitialLocal')) await new Promise(() => {})
  if (request.operation === 'list' && window.holdSkillLists) {
    const body = JSON.stringify({ skills: rows })
    await new Promise(resolve => window.pendingSkillLists.push(resolve))
    return { status: 200, body }
  }
  if (request.operation === 'toggle' && window.holdSkillToggles) {
    const success = await new Promise(resolve => window.pendingSkillToggles.push(resolve))
    if (!success) return { status: 503, body: '{}' }
  }
  if (request.operation === 'toggle') rows.find(row => row.name === request.name).enabled = request.enabled
  if (request.operation === 'delete') {
    if (location.search.includes('failDelete')) return { status: 500, body: '{}' }
    rows.splice(rows.findIndex(row => row.name === request.name), 1)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  }
  if (request.operation === 'upload-preview') return request.filename === 'bad.zip'
    ? { status: 422, body: JSON.stringify({ detail: { message: 'Invalid ZIP' } }) }
    : { status: 200, body: JSON.stringify({ preview: { name: 'uploaded-skill', description: 'Upload description', document: '# Uploaded instructions', provider: 'Upload author', version: '1.0', plugin: ['plugin.zip', 'invalid-plugin.zip'].includes(request.filename) } }) }
  if (request.operation === 'plugin-check') return request.filename === 'invalid-plugin.zip'
    ? { status: 200, body: JSON.stringify({ valid: false, sha256: 'invalid-digest', issues: [{ severity: 'error', path: '.scholarseed-plugin.json', message: 'invalid_plugin_fixture' }] }) }
    : { status: 200, body: JSON.stringify({ valid: true, candidate: 'upload-candidate', sha256: 'upload-digest', descriptor: { id: 'uploaded-skill', version: '1.0', capabilities: [], components: [] }, issues: [] }) }
  if (request.operation === 'plugin-confirm') return { status: 200, body: JSON.stringify({ installed: { name: 'uploaded-skill' }, enabled: true, receipt: {} }) }
  if (request.operation === 'upload') return { status: 200, body: JSON.stringify({ installed: { name: 'uploaded-skill' } }) }
  return { status: 200, body: JSON.stringify(request.operation === 'document'
    ? { document: '# Skill documentation' } : { skills: rows }) }
} }
const localization = createLocalization('zh', { zh: { skills, ui, components }, en: { skills: englishSkills, ui: englishUi, components: englishComponents } }, { report() {} })
window.changeSkillLanguage = language => localization.changeLanguage(language)
const Body = location.search.includes('center') ? skillsFeature().panels[0].render : Skills
createRoot(document.getElementById('root')).render(
  <I18nextProvider i18n={localization}><ToastProvider>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <HomeHeader title="技能中心" avoidWindowControls={false} />
      <div style={{ flex: 1, minHeight: 0, padding: 24, boxSizing: 'border-box' }}><Body /></div>
    </div>
  <Toaster /></ToastProvider></I18nextProvider>)
`

function fixture(): Plugin {
  return {
    name: 'skills-render-fixture',
    enforce: 'pre',
    resolveId(id, importer) {
      if (
        id === '../../store' &&
        [
          '/business/Skills.tsx',
          '/business/LoginPrompt.tsx',
          '/skills/feature.tsx',
          '/skills/Connectors.tsx',
        ].some((file) => importer?.endsWith(file))
      )
        return STORE
      if (id === ENTRY) return ENTRY
    },
    load(id) {
      if (id === STORE)
        return 'export const useApp = () => ({ state: { lang: "zh", backendReady: false, workbenchReturnProjectId: location.search.includes("returnConversation") ? "project-one" : null, projects: [{id: "project-one", name: "Project one"}, {id: "project-two", name: "Project two"}] }, set() {}, act: { selectProject(id) { window.skillActions.push(id) }, startDraft(seed) { window.skillActions.push(seed) }, openWorkbenchView(view) { window.skillActions.push(view) }, startPanelDraft() { window.skillActions.push("startPanelDraft") } } })'
      if (id === ENTRY) return FIXTURE
    },
    configureServer(server) {
      server.middlewares.use('/__skills', (_request, response, next) => {
        server
          .transformIndexHtml(
            '/__skills',
            '<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div><script type="module" src="' +
              ENTRY +
              '"></script></body></html>'
          )
          .then((html) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
          .catch(next)
      })
    },
  }
}

test(
  'search empties use the shared illustration and empty connector installs offer adding',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?center=1&emptyConnectors=1', server.resolvedUrls!.local[0]).href
      )
      for (const tab of ['技能广场', '系统预置', '我添加的']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.getByTestId('skills-search').fill('no-match-test')
        const empty = page.getByTestId('skills-empty')
        await expect(empty).toContainText('没有匹配的技能')
        await expect(empty.locator('img')).toHaveAttribute('src', /empty_img/)
        await expect(empty.locator('.vds-empty-state__title')).toHaveCSS('font-size', '14px')
        await expect(empty).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(empty.getByRole('button')).toHaveCount(0)
      }
      await page.getByRole('tab', { name: '连接器', exact: true }).click()
      for (const tab of ['市场', '我的']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.getByRole('searchbox', { name: '搜索连接器名称、说明' }).fill('no-match-test')
        const empty = page.getByTestId('connectors-empty')
        await expect(empty).toContainText('没有找到连接器')
        await expect(empty.locator('img')).toHaveAttribute('src', /empty_img/)
        await expect(empty.locator('.vds-empty-state__title')).toHaveCSS('font-size', '14px')
        await expect(empty).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(empty.getByRole('button')).toHaveCount(0)
      }
      await page.getByRole('searchbox', { name: '搜索连接器名称、说明' }).fill('')
      const empty = page.getByTestId('connectors-empty')
      await expect(empty).toContainText('暂无连接器')
      await expect(empty).toHaveCSS('background-color', 'rgb(244, 241, 235)')
      await expect(empty.locator('img')).toHaveCount(0)
      await expect(empty.getByRole('button', { name: '添加技能', exact: true })).toHaveCount(0)
      await empty.getByRole('button', { name: '添加连接器', exact: true }).click()
      await expect(page.getByTestId('custom-connector-dialog')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'mock update previews capture cards and details then discard isolated data',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?updateData=1&attributionData=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-tab-user').click()
      const card = page.getByTestId('skill-card-skill-6')
      await expect(card.getByTestId('skill-update-status-skill-6')).toHaveText('有更新')
      const nameBounds = await card
        .getByRole('heading', { name: 'skill-6', exact: true })
        .evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const bounds = range.getBoundingClientRect()
          return { x: bounds.x, width: bounds.width }
        })
      const tagBounds = (await card.getByTestId('skill-update-status-skill-6').boundingBox())!
      assert.equal(tagBounds.x - nameBounds.x - nameBounds.width, 8)
      const updateTag = card.getByTestId('skill-update-status-skill-6')
      await expect(updateTag).toHaveCSS('border-radius', '4px')
      await expect(updateTag).toHaveCSS('background-color', 'rgb(244, 253, 243)')
      await expect(updateTag).toHaveCSS('border-color', 'rgb(190, 240, 189)')
      await expect(updateTag).toHaveCSS('font-weight', '400')
      await card.hover()
      const directory = path.resolve(ROOT, '../../../../../tmp/test_snapshot/list-ui-mock')
      await card.screenshot({ path: path.join(directory, 'update-card.png') })
      await page.getByTestId('skill-more-skill-6').click()
      await expect(page.getByRole('menuitem', { name: '更新技能', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '使用技能', exact: true })).toBeVisible()
      await page.screenshot({ path: path.join(directory, 'update-menu.png') })
      await page.keyboard.press('Escape')
      await page.getByTestId('skill-view-skill-6').click()
      const detail = page.getByTestId('skill-detail')
      await expect(detail.getByTestId('skill-detail-update-status')).toHaveText('有更新')
      await expect(detail.getByTestId('skill-detail-update')).toBeEnabled()
      await detail.screenshot({ path: path.join(directory, 'update-detail.png') })
      await detail.getByTestId('skill-detail-update').click()
      await expect(detail.getByTestId('skill-detail-update-status')).toHaveCount(0)
      await expect(detail.getByTestId('skill-detail-update')).toHaveCount(0)
      await expect(card.getByTestId('skill-update-status-skill-6')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
      assert.equal(browser.isConnected(), false)
      assert.equal(server.httpServer?.listening, false)
    }
  }
)

test(
  'connector install opens authorization and OAuth keeps its presentation during an attempt',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?center=1', server.resolvedUrls!.local[0]).href)
      await page.getByRole('tab', { name: '连接器', exact: true }).click()
      await page.getByTestId('connector-install-zotero').click()
      await expect(page.locator('.vds-toast')).toHaveCount(0)
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseConnectorInstall())
      const auth = page.getByRole('dialog').last()
      await expect(auth.getByRole('heading')).toHaveText('授权 Zotero')
      await expect(page.locator('.vds-toast')).toContainText('Zotero 安装成功')
      await expect(page.getByTestId('connector-detail')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(auth.getByRole('radio')).toHaveCount(0)
      await expect(auth.getByRole('textbox', { name: 'API Key', exact: true })).toBeVisible()
      await auth.getByRole('button', { name: '取消', exact: true }).click()
      const detail = page.getByRole('dialog', { name: 'Zotero', exact: true })
      await expect(detail).toBeVisible()
      await page.mouse.click(10, 10)
      await expect(detail).toHaveCount(0)
      await page.getByRole('tab', { name: '我的', exact: true }).click()
      await page
        .getByTestId('connector-github')
        .getByRole('button', { name: '授权', exact: true })
        .click()
      await auth.getByRole('tab', { name: 'OAuth', exact: true }).click()
      const go = auth.getByRole('button', { name: '前往授权', exact: true })
      await expect(go.locator('svg.lucide-external-link')).toBeVisible()
      await go.click()
      await expect(auth.getByTestId('connector-oauth-panel')).toBeVisible()
      await expect(auth.getByTestId('connector-oauth-panel')).toHaveCSS(
        'background-color',
        'rgb(247, 247, 247)'
      )
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(auth.getByTestId('connector-oauth-panel')).toHaveCSS(
        'background-color',
        'rgb(40, 40, 40)'
      )
      await page.emulateMedia({ colorScheme: 'light' })
      await expect(auth.getByRole('button', { name: '重新打开授权页面', exact: true })).toHaveCount(
        0
      )
      await go.click()
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).connectorRequests.filter(
              (request) => request.action.operation === 'login'
            ).length
        ),
        1
      )
      await auth.getByRole('button', { name: '取消', exact: true }).click()
      await expect(auth).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'connector loading stays centered and auth badges remain after removing skill source badges',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?center=1&marketData=1', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByTestId('skills-refresh-marketplace')).toHaveCount(0)
      await expect(
        page.getByTestId('marketplace-card-market-paper').getByText('SkillHub', { exact: true })
      ).toHaveCount(0)
      await page.getByRole('banner').getByRole('tab', { name: '连接器', exact: true }).click()
      const badge = page.getByText('API Key / OAuth', { exact: true }).first()
      await expect(badge).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
      await expect(badge).toHaveCSS('border-radius', '4px')
      await expect(badge).toHaveCSS('height', '20px')
      await expect(badge).toHaveCSS('font-size', '10px')
      const connector = page.getByTestId('connector-github')
      const description = connector.locator('.vds-card__description')
      await expect(description).toHaveCSS('font-weight', '400')
      await expect(description).toHaveCSS(
        'color',
        await description.evaluate((element) => {
          const token = getComputedStyle(element).getPropertyValue('--vds-text-tertiary').trim()
          return `rgb(${token
            .slice(1)
            .match(/.{2}/g)!
            .map((channel) => parseInt(channel, 16))
            .join(', ')})`
        })
      )
      const geometry = await connector.evaluate((element) => {
        const header = element.querySelector('.vds-card__header')!.getBoundingClientRect()
        const description = element.querySelector('.vds-card__description')!.getBoundingClientRect()
        const title = element
          .querySelector('.vds-card__title')!
          .parentElement!.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          top: parseFloat(style.paddingTop),
          bottom: parseFloat(style.paddingBottom),
          gap: description.top - title.bottom,
          content: header.height,
        }
      })
      assert.equal(geometry.top, 12)
      assert.equal(geometry.bottom, 12)
      assert.equal(geometry.gap, 8)
      await expect(connector.locator('.vds-card__footer')).toHaveCSS('padding-top', '12px')
      await expect(connector.locator('..')).toHaveCSS('row-gap', '12px')
      const internalGap = await connector.evaluate((element) => {
        const header = element.querySelector('.vds-card__header')!.getBoundingClientRect()
        const footer = element.querySelector('.vds-card__footer')!.getBoundingClientRect()
        return footer.top - header.bottom
      })
      assert.equal(internalGap, 12)
      const check = connector.getByRole('img', { name: '已安装', exact: true })
      await expect(check.locator('.iconfont')).toHaveCSS('font-size', '12px')
      const install = page.getByTestId('connector-install-zotero')
      const checkBounds = (await check.boundingBox())!
      const installBounds = (await install.boundingBox())!
      const cardBounds = (await connector.boundingBox())!
      const otherBounds = (await page.getByTestId('connector-zotero').boundingBox())!
      assert.equal(
        checkBounds.y + checkBounds.height / 2 - cardBounds.y,
        installBounds.y + installBounds.height / 2 - otherBounds.y
      )
      assert.equal(
        cardBounds.x + cardBounds.width - checkBounds.x - checkBounds.width / 2,
        otherBounds.x + otherBounds.width - installBounds.x - installBounds.width / 2
      )
      await page.getByRole('tab', { name: '我的', exact: true }).click()
      await page.mouse.move(0, 0)
      const more = page.getByTestId('connector-more-github')
      await expect(more).toHaveCSS('visibility', 'visible')
      await expect(more).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await connector.hover()
      await expect(connector).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
      await more.hover()
      await expect(more).toHaveCSS('background-color', 'rgb(234, 230, 221)')
      await page.getByTestId('connector-more-github').click()
      await expect(
        page
          .getByRole('menuitem', { name: '使用连接器', exact: true })
          .locator('svg.lucide-message-circle')
      ).toHaveCount(1)
      await expect(
        page
          .getByRole('menuitem', { name: '删除连接器', exact: true })
          .locator('svg.lucide-trash-2')
      ).toHaveCount(1)
      await page.getByRole('menuitem', { name: '删除连接器', exact: true }).click()
      const removal = page.getByRole('alertdialog')
      await expect(removal.locator('.icon-fill-status-warning')).toBeVisible()
      await expect(removal.getByRole('button', { name: '删除', exact: true })).toHaveClass(
        /vds-button--danger/
      )
      await expect(removal.getByRole('button', { name: '确认', exact: true })).toHaveCount(0)
      await removal.getByRole('button', { name: '取消', exact: true }).click()
      await expect(removal).toHaveCount(0)
      await expect(connector).toBeVisible()
      await page.goto(
        new URL('/__skills?center=1&delayConnectors=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('banner').getByRole('tab', { name: '连接器', exact: true }).click()
      const loading = page.getByTestId('connectors-loading')
      await expect(loading).toBeVisible()
      await expect(loading.locator('.vds-spinner')).toHaveCount(1)
      await expect
        .poll(() =>
          loading.evaluate((element) => {
            const bounds = element
              .closest('[data-testid="connectors-list"]')!
              .getBoundingClientRect()
            const indicator = element.getBoundingClientRect()
            return Math.max(
              Math.abs(indicator.x + indicator.width / 2 - bounds.x - bounds.width / 2),
              Math.abs(indicator.y + indicator.height / 2 - bounds.y - bounds.height / 2)
            )
          })
        )
        .toBeLessThan(1)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'connector dialogs use regular weight and omit redundant explanatory headings',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?center=1', server.resolvedUrls!.local[0]).href, {
        waitUntil: 'domcontentloaded',
      })
      await page.getByRole('banner').getByRole('tab', { name: '连接器', exact: true }).click()
      await page.getByRole('button', { name: '查看 Zotero', exact: true }).click()
      const detail = page.getByTestId('connector-detail')
      await expect(detail.getByRole('heading', { name: 'MCP 服务' })).toHaveCount(0)
      await expect(detail.locator('dd').first()).toHaveCSS('font-weight', '400')
      await detail.getByRole('button', { name: '安装', exact: true }).click()
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseConnectorInstall())
      const authorization = page.getByRole('dialog').last()
      await expect(authorization).not.toContainText('凭据仅保存在本机后端私有存储中')
      await expect(authorization.getByRole('heading')).toHaveCSS('font-weight', '400')
      await expect(authorization.locator('label').first()).toHaveCSS('font-weight', '400')
      const notices = authorization.getByRole('status')
      await expect(notices).toHaveCount(1)
      await expect(notices).toContainText('API Key 需要个人资料库读取权限，连接时自动识别账号。')
      for (const notice of await notices.all()) {
        await expect(notice).toHaveCSS('font-weight', '400')
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test('plugin previews stay hidden while skill details and upload remain available', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(new URL('/__skills?center=1&pluginData=1', server.resolvedUrls!.local[0]).href)
    await page.getByRole('tab', { name: '系统预置', exact: true }).click()
    const card = page.getByTestId('skill-card-skill-0')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: '预览交互', exact: true })).toHaveCount(0)
    await expect(card.getByText('系统预置', { exact: true })).toHaveCount(0)
    await expect(
      page.getByTestId('skill-card-skill-1').getByRole('button', { name: '预览交互', exact: true })
    ).toHaveCount(0)
    await page.getByTestId('skill-view-skill-0').click()
    await expect(page.getByTestId('skill-detail')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('skills-add').click()
    await expect(page.getByRole('menuitem', { name: /通过书深创建/ })).toHaveCount(0)
    await expect(page.getByTestId('skill-add-modal')).toBeVisible()
    await expect(page.getByTestId('skill-upload-input')).toBeAttached()
    assert.equal(
      await page.evaluate(() =>
        (window as unknown as SkillTestWindow).skillRequests.some(
          (request) =>
            request.operation === 'plugin-preview-installed' && request.name === 'skill-0'
        )
      ),
      false
    )
  } finally {
    await browser.close()
    await server.close()
  }
})

test('plugin-create is hidden only in the system catalog', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills?authoringData=1', server.resolvedUrls!.local[0]).href)
    await page.getByRole('tab', { name: '系统预置', exact: true }).click()
    await expect(page.getByTestId('skill-card-skill-1')).toBeVisible()
    await expect(page.getByTestId('skill-card-plugin-create')).toHaveCount(0)
    await page.getByTestId('skills-search').fill('plugin-create')
    await expect(page.getByTestId('skill-card-plugin-create')).toHaveCount(0)
    await page.getByRole('tab', { name: '我添加的', exact: true }).click()
    await expect(page.getByTestId('skill-card-plugin-create')).toBeVisible()
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'initial skill loading centers one spinner and a visible label in the list',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      for (const source of ['Market', 'Local']) {
        await page.goto(
          new URL(
            `/__skills?center=1&delayInitial${source}=1&delayLabels=1`,
            server.resolvedUrls!.local[0]
          ).href
        )
        if (source === 'Local') await page.getByTestId('skills-tab-scholarseed').click()
        const loading = page.getByTestId('skills-loading')
        await expect(loading).toBeVisible()
        await expect(loading).toContainText('正在加载技能…')
        await expect(loading.locator('.vds-spinner')).toHaveCount(1)
        if (source === 'Market') {
          const categoryLoading = page
            .getByRole('status')
            .filter({ hasText: '正在获取 SkillHub 分类' })
          await expect(categoryLoading).toBeVisible()
          const category = await page.getByTestId('skills-classification-all').boundingBox()
          const label = await categoryLoading.boundingBox()
          assert.ok(category && label)
          assert.ok(Math.abs(category.y + category.height / 2 - label.y - label.height / 2) < 1)
          assert.ok(label.x > category.x + category.width)
          for (const property of ['font-size', 'font-weight', 'color']) {
            const expected = await loading
              .getByText('正在加载技能…', { exact: true })
              .evaluate(
                (element, name) => getComputedStyle(element).getPropertyValue(name),
                property
              )
            await expect(categoryLoading).toHaveCSS(property, expected)
          }
          const refresh = page.getByTestId('skills-refresh-marketplace')
          await expect(refresh).toHaveCount(0)
        }
        await expect(page.getByTestId('skills-list').getByRole('status')).toHaveCount(1)
        const bounds = await page.getByTestId('skills-list').boundingBox()
        const indicator = await loading.boundingBox()
        assert.ok(bounds && indicator)
        const center = (await page.getByTestId('skill-center').boundingBox())!
        const bottomPadding = await page
          .getByTestId('skill-center')
          .evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom))
        assert.ok(Math.abs(bounds.y + bounds.height - center.y - center.height + bottomPadding) < 1)
        assert.ok(Math.abs(indicator.x + indicator.width / 2 - bounds.x - bounds.width / 2) < 1)
        assert.ok(Math.abs(indicator.y + indicator.height / 2 - bounds.y - bounds.height / 2) < 1)
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test('connector search empties center their image and label within the full list viewport', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills?center=1', server.resolvedUrls!.local[0]).href)
    await page.getByRole('tab', { name: '连接器', exact: true }).click()
    for (const viewport of [VIEWPORT, WORKSPACE_WINDOW_MINIMUM]) {
      await page.setViewportSize(viewport)
      for (const tab of ['市场', '我的']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.getByRole('searchbox', { name: '搜索连接器名称、说明' }).fill('missing')
        const empty = page.getByTestId('connectors-empty')
        await expect(empty).toContainText('没有找到连接器')
        const list = (await page.getByTestId('connectors-list').boundingBox())!
        const image = (await empty.locator('img').boundingBox())!
        const label = (await empty.locator('.vds-empty-state__title').boundingBox())!
        assert.ok(
          Math.abs((image.y + label.y + label.height) / 2 - list.y - list.height / 2) < 1,
          `${tab} connector empty must be vertically centered`
        )
        assert.ok(Math.abs(image.x + image.width / 2 - list.x - list.width / 2) < 1)
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill-center search empties center their image and label within the full list viewport', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills?center=1&marketData=1', server.resolvedUrls!.local[0]).href)
    for (const viewport of [VIEWPORT, WORKSPACE_WINDOW_MINIMUM]) {
      await page.setViewportSize(viewport)
      for (const tab of ['技能广场', '系统预置', '我添加的']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.getByTestId('skills-search').fill('missing')
        const empty = page.getByTestId('skills-empty')
        await expect(empty).toContainText('没有匹配的技能')
        const list = (await page.getByTestId('skills-list').boundingBox())!
        const image = (await empty.locator('img').boundingBox())!
        const label = (await empty.locator('.vds-empty-state__title').boundingBox())!
        assert.ok(
          Math.abs((image.y + label.y + label.height) / 2 - list.y - list.height / 2) < 1,
          `${tab} image and title must be vertically centered`
        )
        assert.ok(Math.abs(image.x + image.width / 2 - list.x - list.width / 2) < 1)
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'skill tabs separate catalogue refresh, system inventory and all installed updates',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?updateData=1', server.resolvedUrls!.local[0]).href)
      await expect(page.getByTestId('skills-refresh-marketplace')).toHaveCount(0)
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0)
      await page.getByTestId('skills-tab-user').click()
      await expect(page.locator('[data-testid^="skill-use-"]')).toHaveCount(0)
      await expect(page.getByTestId('skills-update-all')).toHaveText('一键更新')
      await expect(page.getByRole('button', { name: '重试检查', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('skills-update-all')).toHaveClass(/vds-button--tertiary/)
      await expect(page.getByTestId('skills-update-all')).toBeEnabled()
      await expect(page.getByTestId('skill-update-status-skill-7')).toHaveCount(0)
      await page.getByTestId('skill-view-skill-6').click()
      const updateDetail = page.getByTestId('skill-detail')
      await expect(updateDetail.getByTestId('skill-detail-update-status')).toHaveText('有更新')
      await expect(updateDetail.getByRole('button', { name: '更新', exact: true })).toBeEnabled()
      await updateDetail.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.getByTestId('skill-update-status-skill-5')).toHaveText('有更新')
      const pending = page.getByTestId('skill-pending-source-skill-5')
      await expect(pending).toHaveCount(0)
      const installedCard = page.getByTestId('skill-card-skill-5')
      await expect(installedCard.getByText('GitHub', { exact: true })).toHaveCount(0)
      await expect(installedCard.getByText('@deepseek-ai', { exact: true })).toHaveCount(0)
      await expect(installedCard.locator('.vds-card__footer')).toHaveCount(1)
      await expect(installedCard.getByTestId('skill-source-skill-5')).toHaveText('用户上传')
      await installedCard.hover()
      await page.getByTestId('skill-more-skill-5').click()
      await expect(page.getByRole('menuitem', { name: '更新技能', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '使用技能', exact: true })).toBeVisible()
      await page.getByTestId('skill-update-skill-5').click()
      await expect(page.getByTestId('skill-update-status-skill-5')).toHaveCount(0)
      await expect(page.getByTestId('skill-toggle-skill-5')).not.toBeChecked()
      await expect(page.getByTestId('skills-update-all')).toHaveText('一键更新')
      await expect(page.getByTestId('skills-update-all')).toBeEnabled()
      await page.getByPlaceholder('搜索技能名称').fill('skill-5')
      await page.getByTestId('skills-update-all').click()
      await expect(page.getByTestId('skills-update-all')).toHaveCount(0)
      const names = await page.evaluate(() =>
        (window as unknown as SkillTestWindow).skillRequests
          .filter((item) => item.operation === 'marketplace-update')
          .map((item) => (item.operation === 'marketplace-update' ? item.name : ''))
      )
      assert.deepEqual(names, ['skill-5', 'skill-6'])
      await page.goto(
        new URL('/__skills?updateData=1&failUpdate=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-tab-user').click()
      await page.getByTestId('skills-update-all').click()
      await expect(page.getByText('更新完成：成功 1 项，失败 1 项', { exact: true })).toBeVisible()
      await page.getByTestId('skill-card-skill-6').hover()
      await page.getByTestId('skill-more-skill-6').click()
      await expect(page.getByTestId('skill-update-skill-6')).toBeEnabled()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skill deletion follows the confirmed dialog and stays silent on success',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      const remove = async () => {
        await page.getByTestId('skill-card-skill-5').hover()
        await page.getByTestId('skill-more-skill-5').click()
        await page.getByTestId('skill-remove-skill-5').click()
      }
      await remove()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog.getByRole('heading')).toHaveText('删除技能')
      await expect(dialog).toContainText('确定删除“skill-5”吗？')
      await expect(dialog).not.toContainText('所有项目')
      await expect(page.getByTestId('skill-remove-ok')).toHaveCSS(
        'background-color',
        await page.evaluate(() => {
          const probe = document.createElement('span')
          probe.style.backgroundColor = 'var(--vds-error-bg-default)'
          document.body.append(probe)
          const color = getComputedStyle(probe).backgroundColor
          probe.remove()
          return color
        })
      )
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.getByTestId('skill-toggle-skill-5')).toHaveAttribute('aria-checked', 'true')
      await remove()
      await dialog.getByRole('button', { name: '确定删除', exact: true }).dblclick()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('skill-card-skill-5')).toHaveCount(0)
      await expect(page.getByText('技能已删除，已从可用技能中移除。')).toHaveCount(0)
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'delete'
            ).length
        ),
        1
      )
      await page.goto(new URL('/__skills?failDelete=1', server.resolvedUrls!.local[0]).href)
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      await remove()
      await dialog.getByRole('button', { name: '确定删除', exact: true }).click()
      await expect(dialog).toBeVisible()
      await expect(page.getByTestId('skill-card-skill-5')).toHaveCount(1)
      await expect(page.getByText('删除失败，请重试。')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'market details omit generic warnings without hiding blocked installation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?marketData=1', server.resolvedUrls!.local[0]).href)
      await page.getByTestId('marketplace-card-market-paper').click()
      await expect(page.getByTestId('skill-document')).toContainText('Paper instructions')
      await expect(page.getByTestId('skill-document').getByRole('note')).toHaveCount(0)
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '安装', exact: true })
      ).toBeEnabled()
      await page.goto(
        new URL('/__skills?marketData=1&blocked=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('marketplace-card-market-paper').click()
      await expect(page.getByTestId('skill-document').getByRole('note')).toContainText('已禁止安装')
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '安装', exact: true })
      ).toBeDisabled()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skill marketplace return restores the project and conversation surface',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?center=1&returnConversation=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-return-conversation').click()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as SkillTestWindow).skillActions),
        ['project-one', 'resource']
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'standard skill classifications fit supported windows without horizontal overflow',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?standardLabels=1', server.resolvedUrls!.local[0]).href)
      const categories = page.getByRole('group', { name: '科研分类' })
      const buttons = categories.getByRole('button')
      await expect(buttons).toHaveCount(9)
      await expect(buttons.first()).toHaveCSS('font-weight', '400')
      for (const viewport of [VIEWPORT, WORKSPACE_WINDOW_MINIMUM]) {
        await page.setViewportSize(viewport)
        const scroll = page.getByTestId('skills-classification-scroll')
        assert.equal(
          await scroll.evaluate((element) => element.scrollWidth > element.clientWidth),
          false
        )
        const rows = await buttons.evaluateAll((items) =>
          items.map((item) => item.getBoundingClientRect().top)
        )
        assert.equal(new Set(rows).size, 1)
        const container = await scroll.boundingBox()
        const last = await buttons.last().boundingBox()
        assert.ok(container && last && last.x + last.width <= container.x + container.width)
      }
      await buttons.last().click()
      await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'classification filters collapse overflow and expand into rows at minimum width',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: WORKSPACE_WINDOW_MINIMUM })
      await page.goto(
        new URL(
          '/__skills?marketData=1&classificationData=1&longLabels=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      const categories = page.getByRole('group', { name: '科研分类' })
      const buttons = categories.getByRole('button')
      const more = page.getByTestId('skills-classification-more')
      await expect(more).toHaveText('更多')
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      assert.notEqual(
        await more
          .locator('.iconfont')
          .evaluate((element) => getComputedStyle(element, '::before').content),
        'none'
      )
      const rows = await buttons.evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().top)
      )
      assert.equal(new Set(rows).size, 1)
      await expect(categories).toHaveCSS('border-top-width', '0px')
      const narrowCount = await buttons.count()
      await page.setViewportSize(VIEWPORT)
      await expect.poll(() => buttons.count()).toBeGreaterThanOrEqual(narrowCount)
      await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
      await expect(buttons).toHaveCount(narrowCount)
      await buttons.first().click()
      await page.keyboard.press('ArrowLeft')
      await expect(buttons.last()).toBeFocused()
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await more.click()
      await buttons.first().click()
      const scroll = page.getByTestId('skills-classification-scroll')
      assert.equal(
        await scroll.evaluate((element) => element.scrollWidth > element.clientWidth),
        false
      )
      const tabs = await page.getByRole('tablist', { name: '技能分类' }).boundingBox()
      const filters = await categories.boundingBox()
      await expect(page.getByTestId('skills-classification-divider')).toHaveCount(0)
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      const card = await page.getByTestId('marketplace-card-market-paper').boundingBox()
      assert.ok(tabs && filters && card)
      assert.ok(tabs.y + tabs.height <= filters.y)
      assert.ok(filters.y + filters.height <= card.y)
      await more.click()
      await expect(more).toHaveText('收起')
      await expect(buttons).toHaveCount(9)
      assert.ok(
        new Set(
          await buttons.evaluateAll((items) =>
            items.map((item) => item.getBoundingClientRect().top)
          )
        ).size > 1
      )
      await expect(buttons.nth(1)).toHaveCSS('border-radius', '8px')
      await expect(buttons.nth(1)).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
      await buttons.last().click()
      await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true')
      await more.click()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await more.click()
      await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true')
      await buttons.first().click()
      await page.keyboard.press('ArrowLeft')
      await expect(buttons.last()).toBeFocused()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'system skills omit classifications without inheriting or clearing other tabs filters',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&classificationData=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-classification-analysis').click()
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByRole('group', { name: '科研分类' })).toHaveCount(0)
      await expect(page.getByTestId('skills-classification-scroll')).toHaveCount(0)
      await expect(page.getByTestId('skills-classification-divider')).toHaveCount(0)
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(5)
      await page.getByTestId('skills-search').fill('skill-0')
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(1)
      await expect(page.getByTestId('skill-card-skill-0')).toBeVisible()
      await page.getByTestId('skills-tab-user').click()
      await expect(page.getByTestId('skills-classification-scroll')).toHaveCount(0)
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(25)
      await page.getByTestId('skills-tab-marketplace').click()
      await expect(page.getByTestId('skills-classification-analysis')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(page.getByTestId('marketplace-card-market-paper')).toHaveCount(0)
      await page.goto(new URL('/__skills?failLabels=1', server.resolvedUrls!.local[0]).href)
      await expect(page.getByRole('alert')).toContainText('分类加载失败')
      await expect(
        page.getByTestId('skills-page').getByText('分类加载失败，请重试。', { exact: true })
      ).toHaveCount(0)
      await expect(
        page.locator('.vds-toast').getByText('分类加载失败，请重试。', { exact: true })
      ).toBeVisible()
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByTestId('skills-page').getByRole('alert')).toHaveCount(0)
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(5)
      await page.goto(
        new URL('/__skills?classificationData=1&emptySystem=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-classification-analysis').click()
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByTestId('skills-empty')).toContainText('还没有技能')
      await expect(
        page.getByTestId('skills-empty').getByRole('button', { name: '刷新' })
      ).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'remote categories filter only the market and recover from removed labels after cache expiry',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&classificationData=1', server.resolvedUrls!.local[0]).href
      )
      const categories = page.getByRole('group', { name: '科研分类' })
      await expect(categories.getByRole('button')).toHaveCount(3)
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      await expect(
        page.getByTestId('marketplace-card-market-paper').getByText('文献研究')
      ).toHaveCount(0)
      await page.getByTestId('skills-classification-analysis').click()
      await expect(page.getByTestId('marketplace-card-market-paper')).toHaveCount(0)
      await expect(page.getByTestId('skills-empty')).toContainText('没有匹配的技能')
      await page.getByTestId('skills-classification-research').click()
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      await page.getByTestId('skills-tab-user').click()
      await expect(page.getByTestId('skills-classification-scroll')).toHaveCount(0)
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(25)
      await page.evaluate(() => {
        const state = window as unknown as SkillTestWindow
        state.removeResearchCategory = true
        state.failSkillLoad = true
      })
      const requests = () =>
        page.evaluate(() =>
          (window as unknown as SkillTestWindow).skillRequests.filter(
            (request) =>
              request.operation === 'marketplace' || request.operation === 'marketplace-labels'
          )
        )
      const cachedRequests = await requests()
      await page.getByTestId('skills-tab-marketplace').click()
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      await expect(page.getByTestId('skills-load-error')).toHaveCount(0)
      assert.deepEqual(await requests(), cachedRequests)
      await page.getByTestId('skills-search').fill('paper')
      await expect(page.getByTestId('skills-load-error')).toBeVisible()
      await page.evaluate(() => {
        ;(window as unknown as SkillTestWindow).failSkillLoad = false
      })
      await page.getByTestId('skills-load-error').getByRole('button').click()
      await expect(page.getByTestId('skills-classification-research')).toHaveCount(0)
      await expect(page.getByTestId('skills-classification-all')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      await page.getByTestId('skills-tab-user').click()
      await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(25)
      await page.goto(
        new URL('/__skills?marketData=1&failLabels=1', server.resolvedUrls!.local[0]).href
      )
      await expect(page.getByRole('alert')).toContainText('分类加载失败')
      await expect(page.getByTestId('skills-page').getByRole('alert')).toHaveCount(0)
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skill center keeps navigation in the header and contextual actions in the page and aligns connector cards',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?center=1&marketData=1', server.resolvedUrls!.local[0]).href
      )
      const header = page.getByRole('banner')
      await expect(header.getByRole('tablist', { name: '技能与连接器' })).toBeVisible()
      await expect(header.getByRole('heading', { name: '技能中心' })).toHaveCSS(
        'position',
        'absolute'
      )
      const skillsTab = header.getByRole('tab', { name: '技能', exact: true })
      await expect(skillsTab.locator('svg.lucide-hammer')).toBeVisible()
      const connectorsTab = header.getByRole('tab', { name: '连接器', exact: true })
      const skillsTabBounds = await skillsTab.boundingBox()
      const connectorsTabBounds = await connectorsTab.boundingBox()
      assert.ok(skillsTabBounds && connectorsTabBounds)
      assert.equal(connectorsTabBounds.x - skillsTabBounds.x - skillsTabBounds.width, 8)
      assert.equal(skillsTabBounds?.height, TITLEBAR_DESIGN.height)
      assert.equal(connectorsTabBounds?.height, TITLEBAR_DESIGN.height)
      await expect(skillsTab).toHaveCSS('font-size', '14px')
      await expect(connectorsTab).toHaveCSS('font-weight', '400')
      await expect(skillsTab).toHaveCSS('font-weight', '500')
      await expect(skillsTab).toHaveCSS('gap', '6px')
      await expect(skillsTab).toHaveCSS('border-radius', '8px')
      await expect(skillsTab).toHaveCSS('padding-left', '8px')
      await expect(skillsTab).toHaveCSS('padding-right', '12px')
      await expect(
        page.getByTestId('skill-center').getByRole('tablist', { name: '技能与连接器' })
      ).toHaveCount(0)
      const skillBounds = await page.getByTestId('marketplace-card-market-paper').boundingBox()
      const centerBounds = await page.getByTestId('skill-center').boundingBox()
      const listBounds = await page.getByTestId('skills-list').boundingBox()
      assert.ok(centerBounds && listBounds)
      assert.equal(listBounds.x + listBounds.width, centerBounds.x + centerBounds.width)
      await header.getByRole('tab', { name: '连接器', exact: true }).click()
      const connectorsPage = page.getByTestId('connectors-page')
      const connectorSearch = connectorsPage.getByRole('searchbox', {
        name: '搜索连接器名称、说明',
      })
      const addConnector = connectorsPage.getByRole('button', {
        name: '添加连接器',
        exact: true,
      })
      await expect(connectorSearch).toBeVisible()
      await expect(addConnector).toBeVisible()
      await expect(header.getByRole('searchbox', { name: '搜索连接器名称、说明' })).toHaveCount(0)
      await expect(header.getByRole('button', { name: '添加连接器', exact: true })).toHaveCount(0)
      const headerBounds = await header.boundingBox()
      assert.ok(headerBounds)
      for (const action of [connectorSearch, addConnector]) {
        const actionBounds = await action.boundingBox()
        assert.ok(actionBounds)
        assert.ok(actionBounds.y >= headerBounds.y + headerBounds.height)
      }
      await expect(header.getByTestId('skills-search')).toHaveCount(0)
      const card = page.getByTestId('connector-zotero')
      await expect(page.getByText(/\d+ 个连接器/)).toHaveCount(0)
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0)
      const connectorBounds = await card.boundingBox()
      assert.ok(skillBounds && connectorBounds)
      assert.equal(connectorBounds.width, skillBounds.width)
      assert.ok(await card.evaluate((element) => element.scrollHeight <= element.clientHeight))
      const install = card.getByTestId('connector-install-zotero')
      await expect(install.locator('.icon-line-operation-add')).toBeVisible()
      await expect(install).toHaveText('')
      await expect(
        page.getByTestId('connector-github').getByRole('img', { name: '已安装' })
      ).toBeVisible()
      await install.click()
      await expect(install).toHaveAttribute('data-loading', 'true')
      await expect(install).toBeDisabled()
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseConnectorInstall())
      await expect(card.getByRole('img', { name: '已安装' })).toBeVisible()
      await expect(page.getByRole('dialog').last().getByRole('heading')).toHaveText('授权 Zotero')
      await page
        .getByRole('dialog')
        .last()
        .getByRole('button', { name: '取消', exact: true })
        .click()
      await connectorSearch.fill('Zotero')
      const connectorDetail = page.getByRole('dialog', { name: 'Zotero' })
      await expect(connectorDetail).toBeVisible()
      assert.equal((await connectorDetail.boundingBox())?.width, 512)
      await expect(connectorDetail.getByTestId('detail-version-icon')).toHaveCSS('width', '14px')
      await expect(connectorDetail.getByTestId('detail-version-icon')).toHaveCSS('height', '14px')
      await expect(connectorDetail.locator('dt').first()).toHaveCSS('font-size', '12px')
      await expect(connectorDetail.locator('dd').first()).toHaveCSS('font-size', '14px')
      await expect(connectorDetail.locator('details, [data-state="closed"][hidden]')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '返回连接器' })).toHaveCount(0)
      await expect(addConnector).toBeVisible()
      await expect(card).toBeAttached()
      await expect(
        connectorDetail.getByRole('button', { name: '前往授权', exact: true })
      ).toHaveCount(1)
      await expect(connectorDetail.getByRole('switch')).toBeDisabled()
      await expect(
        connectorDetail.getByTestId('connector-detail-preference').getByRole('switch')
      ).toBeVisible()
      await expect(
        connectorDetail.getByRole('button', { name: '前往授权', exact: true })
      ).toHaveClass(/vds-button--primary/)
      await connectorDetail.getByTestId('connector-enable-hint-zotero').hover()
      await expect(page.getByRole('tooltip')).toHaveText('授权后可启用连接器')
      await connectorDetail.getByRole('heading', { name: 'Zotero', exact: true }).hover()
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await expect(connectorDetail.getByText('查看实现来源', { exact: true })).toHaveCount(0)
      await expect(
        connectorDetail.getByText('前往服务商管理授权／API Key', { exact: true })
      ).toHaveCount(0)
      await expect(
        connectorDetail.getByRole('button', { name: '前往查看', exact: true })
      ).toHaveCount(0)
      await expect(
        connectorDetail.getByRole('button', { name: '删除连接器', exact: true })
      ).toHaveCount(0)
      await expect(connectorDetail.getByRole('heading', { name: '工具', exact: true })).toHaveCount(
        0
      )
      await expect(
        connectorDetail.getByRole('button', { name: '复制地址', exact: true })
      ).toBeVisible()
      await expect(connectorDetail.locator('dl')).not.toContainText('版本')
      await expect(
        connectorDetail.locator('dd').filter({ hasText: 'https://example.test/mcp' })
      ).toHaveCount(1)
      await expect(
        connectorDetail.getByRole('button', { name: '前往授权', exact: true })
      ).toHaveCount(1)
      await connectorDetail.getByRole('button', { name: '前往授权', exact: true }).click()
      const authorization = page.getByRole('dialog').last()
      await expect(authorization).not.toContainText('凭据仅保存在本机后端私有存储中')
      await expect(authorization.getByRole('heading')).toHaveCSS('font-weight', '400')
      await expect(authorization.locator('label').first()).toHaveCSS('font-weight', '400')
      await expect(
        authorization.getByRole('button', { name: '获取 API Key', exact: true })
      ).toHaveClass(/vds-button--link/)
      await expect(authorization.locator('input[aria-label="API Key"]')).toBeVisible()
      await expect(authorization.getByRole('tablist')).toHaveCount(0)
      const credential = authorization.locator('input[aria-label="API Key"]')
      const submitAuthorization = authorization.getByRole('button', {
        name: '连接',
        exact: true,
      })
      await expect(credential).toHaveAttribute('required', '')
      await expect(credential).toHaveAttribute('placeholder', '请输入 API Key')
      await expect(authorization.getByLabel('资料库 ID', { exact: false })).toHaveCount(0)
      await expect(authorization.getByRole('button', { name: '手动填写资料库 ID' })).toHaveCount(0)
      await expect(authorization.getByRole('combobox')).toHaveCount(0)
      await expect(submitAuthorization).toBeDisabled()
      await credential.fill('test-only-key')
      await expect(submitAuthorization).toBeEnabled()
      await expect(authorization.getByRole('button', { name: '取消', exact: true })).toHaveClass(
        /vds-button--outline/
      )
      await authorization.getByRole('button', { name: '清空 API Key', exact: true }).click()
      await expect(credential).toHaveValue('')
      await expect(submitAuthorization).toBeDisabled()
      await expect(connectorDetail).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(1)
      const authorizationLayer = await authorization.evaluate((element) =>
        Number(getComputedStyle(element).zIndex)
      )
      const overlayLayer = await authorization.evaluate((element) =>
        Number(getComputedStyle(element.previousElementSibling!).zIndex)
      )
      assert.ok(authorizationLayer > overlayLayer)
      await page.keyboard.press('Escape')
      await expect(connectorDetail).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(connectorDetail).toHaveCount(0)
      await expect(card.getByRole('button', { name: '查看 Zotero' })).toBeFocused()
      await expect(card).toBeVisible()
      await expect(connectorSearch).toHaveValue('Zotero')
      await card.getByRole('button', { name: '查看 Zotero' }).click()
      await connectorDetail.getByRole('button', { name: '取消', exact: true }).click()
      await expect(card.getByRole('button', { name: '查看 Zotero' })).toBeFocused()
      await page.getByRole('tab', { name: '我的', exact: true }).click()
      await expect(card.getByRole('button', { name: '授权', exact: true })).toBeVisible()
      await expect(card.getByRole('switch')).toHaveCount(0)
      await card.hover()
      await card.getByTestId('connector-more-zotero').click()
      await expect(page.getByRole('menuitem', { name: '授权', exact: true })).toHaveCount(0)
      await expect(page.getByRole('menuitem', { name: '删除连接器', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await card.getByRole('button', { name: '授权', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await header.getByRole('tab', { name: '技能', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('skills-page').getByTestId('skills-search')).toBeVisible()
      await expect(header.getByTestId('skills-search')).toHaveCount(0)
      await expect(connectorsPage).toHaveCount(0)
      await expect(header.getByRole('searchbox', { name: '搜索连接器名称、说明' })).toHaveCount(0)
      await page.goto(new URL('/__skills?marketData=1', server.resolvedUrls!.local[0]).href)
      await expect(header.getByRole('heading', { name: '技能中心' })).toHaveCSS(
        'position',
        'static'
      )
      await page.goto(
        new URL(
          '/__skills?center=1&marketData=1&authorizedConnector=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await header.getByRole('tab', { name: '连接器', exact: true }).click()
      await page
        .getByTestId('connector-github')
        .getByRole('button', { name: '查看 GitHub' })
        .click()
      const authorizedDetail = page.getByRole('dialog', { name: 'GitHub', exact: true })
      await expect(authorizedDetail.getByTestId('connector-tools')).toBeVisible()
      await expect(authorizedDetail.getByTestId('connector-tool').first()).toContainText(
        'search_repository'
      )
      await expect(authorizedDetail.locator('details')).toHaveCount(0)
      const toolRegion = authorizedDetail.getByTestId('connector-tools')
      const tools = authorizedDetail.getByTestId('connector-tools-content')
      await expect(tools.getByTestId('connector-tool')).toHaveCount(5)
      await expect(authorizedDetail.getByText('当前授权：', { exact: false })).toHaveCount(0)
      await expect(tools.getByTestId('connector-tool').first()).toHaveCSS(
        'text-overflow',
        'ellipsis'
      )
      const toolBounds = (await tools.boundingBox())!
      for (const entry of await tools.getByTestId('connector-tool').all()) {
        const entryBounds = (await entry.boundingBox())!
        assert.ok(Math.abs(entryBounds.width - toolBounds.width) < 1)
      }
      await expect(tools.getByTestId('connector-tool').first()).toHaveCSS('white-space', 'nowrap')
      await expect(toolRegion.getByRole('button', { name: '上一页' })).toBeDisabled()
      await expect(toolRegion.getByRole('button', { name: '下一页' })).toHaveClass(
        /vds-button--ghostIcon/
      )
      await tools.getByTestId('connector-tool').first().hover()
      await expect(page.getByRole('tooltip')).toContainText('search_repository')
      await expect(page.getByRole('tooltip')).toContainText('Search a repository')
      await toolRegion.getByRole('heading').hover()
      await toolRegion.getByRole('button', { name: '下一页' }).click()
      await expect(tools.getByTestId('connector-tool').first()).toContainText('repository_tool_5')
      await toolRegion.getByRole('button', { name: '上一页' }).click()
      await expect(tools.getByTestId('connector-tool').first()).toContainText('search_repository')
      const revoke = authorizedDetail.getByRole('button', { name: '撤销授权', exact: true })
      await expect(revoke).toHaveClass(/vds-button--danger/)
      assert.equal(
        await revoke.evaluate((element) => element.closest('.vds-dialog__footer') !== null),
        true
      )
      await revoke.click()
      const confirmation = page.getByRole('alertdialog')
      const confirmationOverlay = await confirmation.evaluate((element) =>
        Number(getComputedStyle(element.previousElementSibling!).zIndex)
      )
      assert.ok(
        confirmationOverlay >
          (await authorizedDetail.evaluate((element) => Number(getComputedStyle(element).zIndex)))
      )
      await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toHaveClass(
        /vds-button--outline/
      )
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await authorizedDetail.getByRole('button', { name: '更换授权', exact: true }).click()
      const storedAuthorization = page.getByRole('dialog').last()
      const storedCredential = storedAuthorization.locator('input[type="password"]')
      await expect(storedCredential).toHaveValue('')
      await expect(storedCredential).toHaveAttribute('placeholder', '••••••')
      await storedAuthorization.getByRole('button', { name: '清空 API Key', exact: true }).click()
      await expect(storedCredential).toHaveValue('')
      await expect(storedCredential).not.toHaveAttribute('placeholder', '••••••')
      await storedAuthorization.getByRole('button', { name: '取消', exact: true }).click()
      await expect(authorizedDetail.getByRole('switch')).toBeEnabled()
      await authorizedDetail.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('tab', { name: '我的', exact: true }).click()
      const githubCard = page.getByTestId('connector-github')
      await expect(githubCard.getByRole('switch')).toBeEnabled()
      await githubCard.getByRole('switch').click()
      await expect(githubCard.getByRole('switch')).toBeChecked()
      await githubCard.hover()
      await githubCard.getByTestId('connector-more-github').click()
      await page.getByRole('menuitem', { name: '使用连接器', exact: true }).click()
      const useDialog = page.getByTestId('connector-use-dialog')
      await useDialog.getByLabel('任务内容').fill('使用 GitHub 检索代码')
      await useDialog.getByRole('button', { name: '带入新任务' }).click()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { skillActions: unknown[] }).skillActions),
        [{ submit: true, projectId: 'project-one', composerText: '使用 GitHub 检索代码' }]
      )
      await page.goto(
        new URL(
          '/__skills?center=1&authorizedConnector=1&longConnector=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await header.getByRole('tab', { name: '连接器', exact: true }).click()
      await page
        .getByTestId('connector-github')
        .getByRole('button', { name: /^查看 / })
        .click()
      const longDetail = page.getByTestId('connector-detail')
      const title = longDetail.getByRole('heading', { level: 2 })
      const ellipsis = title.locator('[data-slot="ellipsis-text"]')
      for (const width of [VIEWPORT.width, WORKSPACE_WINDOW_MINIMUM.width]) {
        await page.setViewportSize({ width, height: 800 })
        const titleBounds = (await title.boundingBox())!
        const preferenceBounds = (await longDetail
          .getByTestId('connector-detail-preference')
          .boundingBox())!
        assert.ok(titleBounds.x + titleBounds.width <= preferenceBounds.x)
        await expect(ellipsis).toHaveCSS('text-overflow', 'ellipsis')
        assert.ok(await ellipsis.evaluate((element) => element.scrollWidth > element.clientWidth))
      }
      await longDetail.getByRole('switch').focus()
      await page.keyboard.press('Shift+Tab')
      await expect(ellipsis).toBeFocused()
      await expect(page.getByRole('tooltip')).toContainText('QA_连续长名称_'.repeat(16))
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'custom connector capsule switches back from empty JSON and preserves valid fields',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?center=1', server.resolvedUrls!.local[0]).href)
      await page.getByRole('tab', { name: '连接器', exact: true }).click()
      await page.getByRole('button', { name: '添加连接器', exact: true }).click()
      const dialog = page.getByRole('dialog')
      const modes = dialog.getByRole('tablist', { name: '配置方式' })
      await expect(modes).toHaveCSS(
        'width',
        await dialog.locator('[data-testid="custom-editor-body"]').evaluate((element) => {
          const style = getComputedStyle(element)
          return `${element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`
        })
      )
      await expect(
        dialog.getByTestId('custom-connector-hint').locator('.icon-fill-status-tips')
      ).toBeVisible()
      await dialog.getByRole('tab', { name: 'STDIO', exact: true }).click()
      await dialog.getByRole('button', { name: '添加参数', exact: true }).click()
      await dialog.getByRole('button', { name: '添加参数', exact: true }).click()
      await dialog.getByLabel('参数 1', { exact: true }).fill('first')
      await dialog.getByLabel('参数 2', { exact: true }).fill('second')
      const removeArgument = dialog.getByRole('button', { name: '删除参数 1', exact: true })
      await expect(removeArgument.locator('svg.lucide-trash-2')).toBeVisible()
      const argument = (await dialog.getByLabel('参数 1', { exact: true }).boundingBox())!
      const remove = (await removeArgument.boundingBox())!
      assert.ok(remove.y + remove.height <= argument.y, JSON.stringify({ remove, argument }))
      assert.ok(Math.abs(remove.x + remove.width - argument.x - argument.width) < 1)
      await removeArgument.click()
      await expect(dialog.getByLabel('参数 1', { exact: true })).toHaveValue('second')
      await expect(dialog.getByLabel('参数 2', { exact: true })).toHaveCount(0)
      await dialog.getByRole('button', { name: '删除参数 1', exact: true }).click()
      await expect(dialog.getByLabel('参数 1', { exact: true })).toHaveCount(0)
      await dialog.getByRole('tab', { name: 'HTTP', exact: true }).click()
      await dialog.getByRole('button', { name: '添加字段', exact: true }).click()
      const field = dialog.getByTestId('custom-connector-field').first()
      await expect(
        field.getByRole('button', { name: '删除字段 1', exact: true }).locator('svg.lucide-trash-2')
      ).toBeVisible()
      await field.getByRole('button', { name: '删除字段 1', exact: true }).click()
      await expect(field).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '预览配置' })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '取消' })).toHaveClass(/vds-button--outline/)
      await expect(dialog.getByPlaceholder('请输入连接器名称')).toHaveAttribute('required', '')
      await modes.getByRole('tab', { name: 'JSON', exact: true }).click()
      await expect(dialog.getByLabel('MCP JSON 配置', { exact: false })).toHaveValue('')
      await modes.getByRole('tab', { name: '表单', exact: true }).click()
      await expect(dialog.getByLabel('连接器名称', { exact: false })).toBeVisible()
      await dialog.getByLabel('连接器名称', { exact: false }).fill('Research')
      await dialog.getByLabel('服务地址', { exact: false }).fill('https://example.test/mcp')
      await expect(dialog.getByRole('button', { name: '预览配置' })).toBeEnabled()
      await modes.getByRole('tab', { name: 'JSON', exact: true }).click()
      await expect(dialog.getByLabel('MCP JSON 配置', { exact: false })).toHaveValue(/Research/)
      await modes.getByRole('tab', { name: '表单', exact: true }).click()
      await expect(dialog.getByLabel('连接器名称', { exact: false })).toHaveValue('Research')
      await expect(dialog.getByLabel('服务地址', { exact: false })).toHaveValue(
        'https://example.test/mcp'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'uninstalled market details hide activation and installed skills expose use and activation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?marketData=1', server.resolvedUrls!.local[0]).href)
      const install = page
        .getByTestId('marketplace-card-market-paper')
        .getByRole('button', { name: '安装', exact: true })
      await expect(install.locator('.icon-line-operation-add')).toBeVisible()
      await expect(install).toHaveText('')
      await page.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      const toggle = page.getByTestId('skill-detail').getByRole('switch')
      await expect(page.getByTestId('skill-downloads')).toHaveCount(0)
      await expect(page.getByTestId('skill-detail').getByTestId('detail-version-icon')).toHaveCSS(
        'width',
        '14px'
      )
      await expect(page.getByTestId('skill-detail').getByTestId('detail-version-icon')).toHaveCSS(
        'height',
        '14px'
      )
      await expect(page.getByTestId('skill-detail')).not.toContainText('1,245')
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '安装', exact: true })
      ).toBeVisible()
      await expect(toggle).toHaveCount(0)
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter((request) =>
              ['toggle', 'marketplace-install'].includes(request.operation)
            ).length
        ),
        0
      )
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      await expect(toggle).toHaveCount(0)
      await page.getByTestId('skill-detail').getByTestId('marketplace-install-market-paper').click()
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '使用', exact: true })
      ).toBeEnabled()
      await expect(toggle).toHaveCount(1)
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '使用', exact: true })
      ).toHaveClass(/vds-button--primary/)
      const installs = await page.evaluate(() =>
        (window as unknown as SkillTestWindow).skillRequests.filter(
          (request) => request.operation === 'marketplace-install'
        )
      )
      assert.equal(installs.length, 1)
      assert.notEqual(installs[0].enabled, false)
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'toggle'
            ).length
        ),
        0
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'folder upload packages nested resources before preview and installation',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(ROOT, '../../../node_modules/skill-upload-'))
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      await mkdir(path.join(directory, 'references'))
      await writeFile(path.join(directory, 'SKILL.md'), '# Folder skill')
      await writeFile(path.join(directory, 'references/guide.md'), 'Nested evidence')
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
      await page.getByTestId('skills-add').click()
      await expect(page.getByTestId('skill-add-modal')).toBeVisible()
      await page
        .getByTestId('skill-add-modal')
        .getByRole('button', { name: '选择文件', exact: true })
        .click()
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('menuitem', { name: '选择文件夹', exact: true }).click(),
      ])
      await chooser.setFiles(directory)
      await expect(page.getByTestId('skill-install')).toBeEnabled()
      const request = await page.evaluate(() => {
        const requests = (window as unknown as SkillTestWindow).skillRequests
        const preview = requests.filter((item) => item.operation === 'upload-preview').at(-1)
        if (!preview || preview.operation !== 'upload-preview') throw new Error('Missing preview')
        return { filename: preview.filename, bytes: Array.from(preview.bytes) }
      })
      assert.equal(request.filename, `${path.basename(directory)}.zip`)
      const entries = unzipSync(new Uint8Array(request.bytes))
      assert.equal(strFromU8(entries['references/guide.md']), 'Nested evidence')
      await page.getByTestId('skill-install').click()
      await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('upload separates ordinary ZIPs from declared card plugins', { timeout: 60_000 }, async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
    await page.getByTestId('skills-add').click()
    const input = page.getByTestId('skill-upload-input')
    for (const filename of ['bad.zip', 'plugin.zip', 'plain.zip']) {
      await input.setInputFiles({
        name: filename,
        mimeType: 'application/zip',
        buffer: Buffer.from('upload fixture'),
      })
      if (filename === 'bad.zip')
        await expect(page.getByTestId('skill-upload-error')).toContainText('Invalid ZIP')
      await expect(page.getByRole('button', { name: '检查插件', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('skill-upload-preview')).toHaveCount(0)
      await expect(page.getByTestId('skill-add-modal')).not.toContainText('Upload description')
      await expect(page.getByTestId('skill-add-modal')).not.toContainText('Uploaded instructions')
      await expect(page.getByTestId('skill-add-modal')).not.toContainText('Upload author')
      if (filename === 'bad.zip') await expect(page.getByTestId('skill-install')).toBeDisabled()
      else await expect(page.getByTestId('skill-install')).toBeEnabled()
    }
    await page.getByTestId('skill-install').click()
    await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
    const operations = await page.evaluate(() =>
      (window as unknown as SkillTestWindow).skillRequests.map((request) => request.operation)
    )
    assert.equal(operations.includes('plugin-check'), false)
    assert.equal(operations.filter((operation) => operation === 'upload').length, 1)
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'plugin upload checks on install and requires consent without a skill preview',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
      await page.getByTestId('skills-add').click()
      await page.getByTestId('skill-upload-input').setInputFiles({
        name: 'invalid-plugin.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('invalid plugin fixture'),
      })
      await expect(page.getByTestId('skill-install')).toBeEnabled()
      for (const attempt of [1, 2]) {
        await page.getByTestId('skill-install').click()
        await expect(page.getByTestId('plugin-report')).toContainText('invalid_plugin_fixture')
        await expect(page.getByTestId('skill-install')).toBeEnabled()
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as SkillTestWindow).skillRequests.filter(
                  (request) => request.operation === 'plugin-check'
                ).length
            )
          )
          .toBe(attempt)
      }
      await page.getByTestId('skill-upload-input').setInputFiles({
        name: 'plugin.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('plugin fixture'),
      })
      await expect(page.getByTestId('skill-install')).toBeEnabled()
      await expect(page.getByTestId('skill-upload-preview')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '检查插件', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('plugin-report')).toHaveCount(0)
      await page.getByTestId('skill-install').click()
      await expect(page.getByTestId('plugin-report')).toBeVisible()
      await expect(page.getByTestId('skill-add-modal')).not.toContainText('Upload description')
      let operations = await page.evaluate(() =>
        (window as unknown as SkillTestWindow).skillRequests.map((request) => request.operation)
      )
      assert.equal(operations.filter((operation) => operation === 'plugin-check').length, 3)
      assert.equal(operations.includes('plugin-confirm'), false)
      assert.equal(operations.includes('upload'), false)
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
      operations = await page.evaluate(() =>
        (window as unknown as SkillTestWindow).skillRequests.map((request) => request.operation)
      )
      assert.equal(operations.filter((operation) => operation === 'plugin-confirm').length, 1)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'upload keeps metadata internal before confirmation and errors remain retryable',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
      await page.getByTestId('skills-add').click()
      const input = page.getByTestId('skill-upload-input')
      const uploadDialog = page.getByTestId('skill-add-modal')
      await expect(uploadDialog).toHaveCSS('width', '512px')
      const dropzone = uploadDialog.getByRole('button', { name: '选择文件', exact: true })
      await expect(dropzone).toHaveCSS('min-height', '178px')
      await expect(dropzone).toHaveCSS('height', '178px')
      await expect(dropzone.locator('svg.lucide-upload')).toBeVisible()
      await expect(
        uploadDialog.getByText('支持 SKILL.md、.zip 或包含 SKILL.md 的文件夹', { exact: true })
      ).toBeVisible()
      await expect(
        uploadDialog.getByRole('button', { name: '选择文件夹', exact: true })
      ).toHaveCount(0)
      await expect(page.getByTestId('skill-upload-directory')).toHaveAttribute(
        'webkitdirectory',
        ''
      )
      await page.mouse.move(0, 0)
      const defaultBackground = await dropzone.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      )
      await dropzone.hover()
      await expect
        .poll(() => dropzone.evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(defaultBackground)
      await input.setInputFiles({
        name: 'bad.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('broken'),
      })
      await expect(page.getByTestId('skill-upload-error')).toContainText('Invalid ZIP')
      await expect(page.getByTestId('skill-upload-file').locator('img')).toHaveAttribute(
        'src',
        /fill-file-zip/
      )
      await expect(page.getByTestId('skill-upload-file').getByRole('button')).toHaveCount(1)
      await expect(
        page
          .getByTestId('skill-upload-file')
          .getByRole('button', { name: '重新选择文件', exact: true })
      ).toBeVisible()
      await expect(page.getByTestId('skill-install')).toBeDisabled()
      await input.setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('test'),
      })
      await expect(page.getByTestId('skill-upload-preview')).toHaveCount(0)
      await expect(page.getByTestId('skill-install')).toBeEnabled()
      await expect(uploadDialog).not.toContainText('Uploaded instructions')
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'upload'
            ).length
        ),
        0
      )
      await page.getByTestId('skill-install').click()
      await expect(page.getByTestId('skill-add-modal')).toHaveCount(0)
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'upload'
            ).length
        ),
        1
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'marketplace card keeps an icon-only loading state and prevents duplicate installs',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&delayInstall=1', server.resolvedUrls!.local[0]).href
      )
      const card = page.getByTestId('marketplace-card-market-paper')
      const install = card.getByTestId('marketplace-install-market-paper')
      await expect(install).toHaveCSS('width', '26px')
      await expect(install).toHaveCSS('height', '26px')
      await expect(install.locator('.iconfont')).toHaveCSS('font-size', '12px')
      await expect(install.locator('.iconfont')).toHaveCSS('font-weight', '400')
      await expect(card.getByText('SkillHub', { exact: true })).toHaveCount(0)
      await expect(card.locator('.vds-card__description')).toHaveCSS('font-weight', '400')
      await expect(card.locator('.vds-card__description')).toHaveCSS('color', 'rgb(109, 109, 109)')
      const initialBounds = await install.boundingBox()
      await install.focus()
      await page.keyboard.press('Enter')
      await expect(install).toHaveAttribute('data-loading', 'true')
      await expect(install).toBeDisabled()
      await expect(install).toHaveText('')
      assert.deepEqual(await install.boundingBox(), initialBounds)
      await expect(page.getByTestId('skill-detail')).toHaveCount(0)
      await page.keyboard.press('Enter')
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'marketplace-install'
            ).length
        ),
        1
      )
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseSkillInstall())
      await expect(card.getByRole('img', { name: '已安装', exact: true })).toBeVisible()
      await expect(install.locator('.icon-line-operation-select')).toBeVisible()
      await expect(install.locator('.icon-line-operation-select')).toHaveCSS('font-size', '12px')
      await expect(card.getByRole('button', { name: '已安装', exact: true })).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'marketplace revisits reuse lists and labels after tabs and remounts',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?center=1&marketData=1', server.resolvedUrls!.local[0]).href
      )
      const card = page.getByTestId('marketplace-card-market-paper')
      await expect(card).toBeVisible()
      await expect(page.getByTestId('skills-classification-research')).toBeVisible()
      const requests = () =>
        page.evaluate(() =>
          (window as unknown as SkillTestWindow).skillRequests.filter(
            (request) =>
              request.operation === 'marketplace' || request.operation === 'marketplace-labels'
          )
        )
      const initial = await requests()
      await page.getByTestId('skills-tab-scholarseed').click()
      await page.getByTestId('skills-tab-marketplace').click()
      await expect(card).toBeVisible()
      assert.deepEqual(await requests(), initial)
      await page.getByRole('banner').getByRole('tab', { name: '连接器', exact: true }).click()
      await expect(card).toHaveCount(0)
      await page.getByRole('banner').getByRole('tab', { name: '技能', exact: true }).click()
      await expect(card).toBeVisible()
      assert.deepEqual(await requests(), initial)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'marketplace loads the next page on scroll with a single flight and stops at the end',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&paginate=1&delayMore=1', server.resolvedUrls!.local[0]).href
      )
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(24)
      await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0)
      const list = page.getByTestId('skills-list')
      const header = await page.getByTestId('skills-search').boundingBox()
      await list.hover()
      await page.mouse.wheel(0, 5000)
      const nextPageRequests = () =>
        page.evaluate(
          () =>
            (window as unknown as SkillTestWindow).skillRequests.filter(
              (request) => request.operation === 'marketplace' && request.cursor === 'next'
            ).length
        )
      await expect.poll(nextPageRequests).toBe(1)
      await expect(page.getByTestId('marketplace-pagination').getByRole('status')).toBeVisible()
      await expect(page.getByTestId('marketplace-pagination')).toHaveCSS('padding-top', '12px')
      await page.mouse.wheel(0, 5000)
      assert.equal(await nextPageRequests(), 1)
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseNextPage())
      await expect(page.getByTestId('marketplace-card-next-paper')).toBeVisible()
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(25)
      await expect(page.getByTestId('marketplace-pagination')).toHaveCount(0)
      await page.mouse.wheel(0, 5000)
      assert.equal(await nextPageRequests(), 1)
      assert.deepEqual(await page.getByTestId('skills-search').boundingBox(), header)
      await page.goto(
        new URL('/__skills?marketData=1&paginate=1&failMore=1', server.resolvedUrls!.local[0]).href
      )
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(24)
      await list.hover()
      await page.mouse.wheel(0, 5000)
      await expect(page.getByTestId('skills-load-error')).toBeVisible()
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(24)
      assert.equal(await nextPageRequests(), 1)
      await page.mouse.wheel(0, 5000)
      assert.equal(await nextPageRequests(), 1)
      await page.getByTestId('skills-load-error').getByRole('button', { name: '重试' }).click()
      await expect(page.getByTestId('marketplace-card-next-paper')).toBeAttached()
      assert.equal(await nextPageRequests(), 2)
      await page.goto(
        new URL('/__skills?marketData=1&paginate=1&delayMore=1', server.resolvedUrls!.local[0]).href
      )
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(24)
      await list.hover()
      await page.mouse.wheel(0, 5000)
      await expect.poll(nextPageRequests).toBe(1)
      await page.getByTestId('skills-search').fill('missing')
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await page.evaluate(() => (window as unknown as SkillTestWindow).releaseNextPage())
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await expect(page.locator('[data-testid^="marketplace-card-"]')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'marketplace details omit download metadata when counts are unknown',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&noDownloads=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      await expect(page.getByTestId('skill-downloads')).toHaveCount(0)
      await expect(page.getByTestId('skill-detail')).not.toContainText('下载')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'market source hints are static and detail attribution stays hidden after installation',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&attributionData=1', server.resolvedUrls!.local[0]).href
      )
      const card = page.getByTestId('marketplace-card-market-paper')
      const link = card.getByText('@deepseek-ai', { exact: true })
      await expect(card.getByText('GitHub', { exact: true })).toBeVisible()
      const footerBounds = await card.locator('.vds-card__footer').boundingBox()
      const badgeBounds = await card.getByText('GitHub', { exact: true }).boundingBox()
      assert.ok(footerBounds && badgeBounds)
      assert.ok(Math.abs(badgeBounds.x - footerBounds.x) < 1)
      await expect(page.getByText('89 个技能', { exact: true })).toHaveCount(0)
      await expect(card.getByRole('link')).toHaveCount(0)
      await expect(link).toHaveCount(0)
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as SkillTestWindow).skillActions),
        []
      )
      await expect(card).not.toContainText('科研工程与计算基础设施')
      await expect(card).not.toContainText('Platform Admin')
      await card.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      await expect(page.getByTestId('skill-detail-author')).toHaveText('@deepseek-ai')
      await expect(
        page.getByTestId('skill-detail').getByText('GitHub', { exact: true })
      ).toBeVisible()
      await expect(page.getByTestId('skill-detail')).not.toContainText('SkillHub')
      await expect(page.getByTestId('skill-document').locator('h1')).toHaveCSS('font-size', '16px')
      await expect(page.getByTestId('skill-document').locator('.md')).toHaveCSS('font-size', '12px')
      await page.mouse.click(10, 10)
      await expect(page.getByTestId('skill-detail')).toHaveCount(0)
      await card.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      await expect(page.getByTestId('skill-detail')).not.toContainText('Declared author')
      await expect(page.getByTestId('skill-detail')).not.toContainText('科研工程与计算基础设施')
      await expect(page.getByTestId('skill-detail').getByRole('link')).toHaveCount(0)
      await expect(page.getByTestId('skill-detail')).not.toContainText('skills/papers')
      await expect(page.getByTestId('skill-detail')).not.toContainText('abc123')
      await expect(page.getByTestId('skill-detail').getByTestId('skill-labels')).toHaveCount(0)
      await page.getByTestId('skill-detail').getByTestId('marketplace-install-market-paper').click()
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '使用', exact: true })
      ).toBeEnabled()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.getByTestId('skills-tab-user').click()
      const installed = page.getByTestId('skill-card-paper-local-name')
      await expect(installed.getByText('@deepseek-ai', { exact: true })).toHaveCount(0)
      await expect(installed.getByRole('link')).toHaveCount(0)
      await expect(installed).not.toContainText('Platform Admin')
      await expect(installed.getByTestId('skill-source-paper-local-name')).toHaveText('GitHub')
      await installed.getByTestId('skill-view-paper-local-name').click()
      await expect(
        page.getByTestId('skill-detail').getByText('GitHub', { exact: true })
      ).toBeVisible()
      await expect(page.getByTestId('skill-detail')).not.toContainText('SkillHub')
      await page.goto(new URL('/__skills?marketData=1', server.resolvedUrls!.local[0]).href)
      const withoutRegistration = page.getByTestId('marketplace-card-market-paper')
      await expect(withoutRegistration.locator('.vds-card__footer')).toHaveCount(0)
      await expect(withoutRegistration).not.toContainText('Platform Admin')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'anonymous marketplace opens details, installs, preserves provenance and discards late searches',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills?marketData=1', server.resolvedUrls!.local[0]).href)
      await expect(page.getByRole('tab')).toHaveCount(3)
      await expect(page.getByTestId('marketplace-card-market-paper')).toBeVisible()
      await page.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
      await expect(page.getByTestId('skill-document')).toContainText('Paper instructions')
      await expect(page.getByTestId('skill-detail')).not.toContainText(
        '来自第三方的技能可能包含脚本'
      )
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(page.getByTestId('skills-search')).toHaveCount(1)
      await expect(page.getByTestId('skills-tab-marketplace')).toHaveCount(1)
      const detailBox = await page.getByTestId('skill-detail').boundingBox()
      assert.ok(detailBox && detailBox.width <= VIEWPORT.width / 2)
      await expect(
        page.getByTestId('skill-detail').getByTestId('marketplace-install-market-paper')
      ).toBeInViewport()
      await page.getByTestId('skill-detail').getByTestId('marketplace-install-market-paper').click()
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '使用', exact: true })
      ).toBeEnabled()
      await page.keyboard.press('Escape')
      await page.getByTestId('skills-tab-user').click()
      await expect(page.getByTestId('skill-card-paper-local-name')).toBeVisible()
      await page.getByTestId('skills-tab-marketplace').click()
      await page.getByTestId('marketplace-card-market-paper').hover()
      await expect(
        page.getByTestId('marketplace-card-market-paper').getByRole('img', { name: '已安装' })
      ).toBeVisible()
      await page.getByTestId('skills-search').fill('old')
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { releaseOldMarket?: unknown }).releaseOldMarket ===
          'function'
      )
      await page.getByTestId('skills-search').fill('missing')
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await page.evaluate(() =>
        (window as unknown as { releaseOldMarket: () => void }).releaseOldMarket()
      )
      await expect(page.getByText('Stale result', { exact: true })).toHaveCount(0)
      await expect(page.getByTestId('skills-empty')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'the known registry move preserves installed state without merging other base paths',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      for (const differentPath of [false, true]) {
        await page.goto(
          new URL(
            '/__skills?marketData=1&migratedMarket=1' + (differentPath ? '&differentPath=1' : ''),
            server.resolvedUrls!.local[0]
          ).href
        )
        const card = page.getByTestId('marketplace-card-market-paper')
        await expect(card).toBeVisible()
        if (differentPath) {
          await expect(card.getByRole('button', { name: '安装', exact: true })).toBeEnabled()
        } else {
          await expect(card.getByRole('img', { name: '已安装', exact: true })).toBeVisible()
          await page.getByRole('button', { name: '查看 Paper tools 的详情' }).click()
          await expect(
            page.getByTestId('skill-detail').getByRole('button', { name: '使用', exact: true })
          ).toBeEnabled()
          const requests = await page.evaluate(
            () =>
              (window as unknown as { skillRequests: Array<{ operation: string }> }).skillRequests
          )
          assert.equal(
            requests.filter((request) => request.operation === 'marketplace-install').length,
            0
          )
        }
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skill cards show installation sources without exposing authors or taxonomy',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL(
          '/__skills?marketData=1&classificationData=1&attributionData=1&updateData=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      const marketCard = page.getByTestId('marketplace-card-market-paper')
      await expect(marketCard).toBeVisible()
      await expect(marketCard.getByText('SkillHub', { exact: true })).toHaveCount(0)
      await expect(marketCard.getByTestId('skill-labels')).toHaveCount(0)
      await expect(marketCard.getByText('@deepseek-ai', { exact: true })).toHaveCount(0)
      await expect(marketCard.getByRole('link')).toHaveCount(0)
      await page.getByTestId('skills-classification-research').click()
      await expect(page.getByTestId('skills-classification-research')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      for (const [tab, name] of [
        ['scholarseed', 'skill-0'],
        ['user', 'skill-6'],
      ]) {
        await page.getByTestId(`skills-tab-${tab}`).click()
        await expect(page.getByTestId('skills-classification-scroll')).toHaveCount(0)
        const card = page.getByTestId(`skill-card-${name}`)
        await expect(card).toBeVisible()
        await expect(card.getByText(/^(系统预置|我添加的)$/)).toHaveCount(0)
        await expect(card.getByTestId('skill-labels')).toHaveCount(0)
        if (tab === 'scholarseed') {
          const sourced = (await page.getByTestId('skill-card-skill-2').boundingBox())!
          const compact = (await page.getByTestId('skill-card-skill-3').boundingBox())!
          const aligned = (await card.boundingBox())!
          assert.equal(aligned.height, sourced.height)
          assert.equal(compact.height, sourced.height)
          await expect(card.getByText('官方', { exact: true })).toBeVisible()
          await expect(card.getByText('GitHub', { exact: true })).toHaveCount(0)
          await expect(
            card.getByText(/未关联 SkillHub|原始来源未提供|原始来源暂不可用/)
          ).toHaveCount(0)
          await expect(card.locator('.vds-card__footer')).toHaveCount(1)
          await expect(page.getByTestId('skill-card-skill-2').getByRole('link')).toHaveCount(0)
        } else {
          await expect(card.getByText('GitHub', { exact: true })).toBeVisible()
          await expect(card.getByText('@deepseek-ai', { exact: true })).toHaveCount(0)
          await expect(
            page.getByTestId('skill-card-skill-8').getByText('原始来源未提供', { exact: true })
          ).toHaveCount(0)
        }
      }
      await expect(page.getByTestId('skill-update-status-skill-6')).toBeVisible()
      await expect(page.getByTestId('skill-toggle-skill-6')).toBeVisible()
      const updateAll = page.getByTestId('skills-update-all')
      await expect(updateAll.locator('svg.lucide-rotate-cw')).toBeVisible()
      await expect(updateAll).toHaveCSS('height', '32px')
      await expect(updateAll.locator('svg')).toHaveCSS('width', '14px')
      await expect(updateAll.locator('svg')).toHaveCSS('height', '14px')
      await expect(updateAll.locator('.vds-badge')).toHaveCount(0)
      await page.getByTestId('skills-tab-marketplace').click()
      await expect(page.getByTestId('skills-classification-scroll')).toBeVisible()
      await expect(page.getByTestId('skills-classification-divider')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'marketplace uses the existing skill card geometry and detail dialog',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(
        new URL('/__skills?marketData=1&scrollMarket=1', server.resolvedUrls!.local[0]).href
      )
      await page.getByTestId('skills-search').fill('paper')
      const trigger = page.getByRole('button', { name: '查看 Paper tools 20 的详情' })
      await trigger.scrollIntoViewIfNeeded()
      const list = page.getByTestId('skills-list')
      const scroll = await list.evaluate((element) => element.scrollTop)
      assert.ok(scroll > 0)
      const first = await page.getByTestId('marketplace-card-market-0').boundingBox()
      const second = await page.getByTestId('marketplace-card-market-1').boundingBox()
      const third = await page.getByTestId('marketplace-card-market-2').boundingBox()
      assert.ok(
        first &&
          second &&
          third &&
          Math.abs(first.y - second.y) < 1 &&
          Math.abs(second.y - third.y) < 1 &&
          third.x > second.x
      )
      const marketHeight = first.height
      await expect(
        page.getByTestId('marketplace-card-market-0').locator('.vds-card__footer')
      ).toHaveCount(0)
      await trigger.click()
      await expect(page.getByTestId('skill-document')).toContainText('Paper instructions')
      const marketplaceDialog = await page.getByTestId('skill-detail').boundingBox()
      const documentMetrics = await page.getByTestId('skill-document').evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }))
      assert.ok(documentMetrics.height > 0 && documentMetrics.scrollHeight > documentMetrics.height)
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '安装', exact: true })
      ).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('skills-search')).toHaveValue('paper')
      await expect(trigger).toBeFocused()
      assert.equal(await list.evaluate((element) => element.scrollTop), scroll)
      await page.getByTestId('skills-tab-scholarseed').click()
      await expect(page.getByTestId('skill-card-skill-0')).toBeVisible()
      const localBox = await page.getByTestId('skill-card-skill-0').boundingBox()
      assert.ok(localBox && localBox.height >= marketHeight)
      await expect(page.getByTestId('skill-card-skill-0').locator('.vds-card__footer')).toHaveCount(
        1
      )
      assert.ok(localBox)
      await page.getByTestId('skill-view-skill-0').click()
      const localDialog = await page.getByTestId('skill-detail').boundingBox()
      assert.equal(localDialog?.width, marketplaceDialog?.width)
      assert.equal(localDialog?.height, marketplaceDialog?.height)
      await page.keyboard.press('Escape')
      await page.getByTestId('skills-tab-user').click()
      await expect(page.getByTestId('skill-card-skill-5')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skills catalog uses compact cards, isolated tab searches and a scrolling list',
  { timeout: 60_000 },
  async () => {
    const server = await servers.create({
      configFile: false,
      root: ROOT,
      plugins: [fixture(), react()],
      cacheKey: 'skills',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage({ viewport: VIEWPORT })
      await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
      await expect(page.getByRole('tab')).toHaveCount(3)
      await expect(page.getByRole('tab', { name: '技能广场', exact: true })).toBeVisible()
      await expect(page.getByTestId('skills-page').getByTestId('skills-search')).toBeVisible()
      await expect(
        page.locator('[data-home-header-actions] [data-testid="skills-search"]')
      ).toHaveCount(0)
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await page.getByTestId('skills-add').click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(page.getByTestId('skills-add').locator('[class*="switch-arrow"]')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.goto(new URL('/__skills?failLoad=1', server.resolvedUrls!.local[0]).href)
      const loadError = page.getByTestId('skills-load-error')
      await expect(loadError).toContainText('技能广场加载失败')
      await expect(page.getByTestId('skills-empty')).toHaveCount(0)
      await expect(page.getByRole('status', { name: '技能加载失败，请重试。' })).toHaveCount(0)
      await page.evaluate(() => {
        ;(window as unknown as { failSkillLoad: boolean }).failSkillLoad = false
      })
      await loadError.getByRole('button', { name: '重试' }).click()
      await expect(loadError).toHaveCount(0)
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('[data-skill-group]')).toHaveCount(0)
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await expect(loadError).toContainText('技能加载失败，请重试。')
      const listBox = await page.getByTestId('skills-list').boundingBox()
      const errorBox = await loadError.boundingBox()
      assert.ok(listBox && errorBox)
      assert.ok(Math.abs(errorBox.x + errorBox.width / 2 - (listBox.x + listBox.width / 2)) < 2)
      assert.ok(Math.abs(errorBox.y + errorBox.height / 2 - (listBox.y + listBox.height / 2)) < 2)
      await loadError.getByRole('button', { name: '重试' }).click()
      await expect(page.getByTestId('skill-card-skill-0')).toBeVisible()
      await expect(page.getByPlaceholder('搜索技能名称')).toBeVisible()
      await expect(page.getByTestId('skills-add-card')).toHaveCount(0)
      await expect(page.locator('[data-skill-group="scholarseed"]')).toHaveCount(5)
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(0)
      const addBeforeSearch = await page.getByTestId('skills-add').boundingBox()
      await page.getByTestId('skills-search').fill('skill-5')
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await expect(page.locator('[data-skill-group]')).toHaveCount(0)
      const searchBox = await page.getByTestId('skills-search').boundingBox()
      const clear = page.getByRole('button', { name: '清空搜索', exact: true })
      const clearBox = await clear.boundingBox()
      assert.ok(searchBox && clearBox)
      assert.ok(
        clearBox.x >= searchBox.x && clearBox.x + clearBox.width <= searchBox.x + searchBox.width
      )
      assert.ok(
        clearBox.y >= searchBox.y && clearBox.y + clearBox.height <= searchBox.y + searchBox.height
      )
      assert.deepEqual(await page.getByTestId('skills-add').boundingBox(), addBeforeSearch)
      await clear.click()
      await expect(page.getByTestId('skills-search')).toHaveValue('')
      await expect(page.getByTestId('skills-search')).toBeFocused()
      await expect(clear).toHaveCount(0)
      const card = page.getByTestId('skill-card-skill-0')
      const box = await card.boundingBox()
      assert.ok(box)
      assert.ok(box.width > 390 && box.width < 430)
      const footer = (await card.locator('.vds-card__footer').boundingBox())!
      const description = (await card.locator('.vds-card__description').boundingBox())!
      assert.ok(footer.y >= description.y + description.height)
      await expect(card.getByText('官方', { exact: true })).toBeVisible()
      await page.mouse.move(0, 0)
      await expect(card.getByTestId('skill-more-skill-0')).toBeVisible()
      await expect(card.getByTestId('skill-more-skill-0')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      )
      await card.hover()
      await expect(card).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
      await expect(card.getByTestId('skill-more-skill-0')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      )
      await card.getByTestId('skill-more-skill-0').hover()
      await expect(card.getByTestId('skill-more-skill-0')).toHaveCSS(
        'background-color',
        'rgb(234, 230, 221)'
      )
      await page.getByTestId('skill-view-skill-0').click()
      await expect(page.getByTestId('skill-detail')).toBeVisible()
      const detailBounds = await page.getByTestId('skill-detail').boundingBox()
      assert.ok(detailBounds)
      assert.equal(Math.round(detailBounds.width), 512)
      assert.equal(Math.round(detailBounds.height), 560)
      assert.equal(Math.round(detailBounds.x + detailBounds.width / 2), VIEWPORT.width / 2)
      assert.equal(Math.round(detailBounds.y + detailBounds.height / 2), VIEWPORT.height / 2)
      await expect(
        page.getByTestId('skill-detail').getByRole('heading', { name: 'skill-0', exact: true })
      ).toHaveCSS('font-size', '16px')
      await expect(page.getByTestId('skill-detail').locator('.vds-dialog__description')).toHaveCSS(
        'font-size',
        '12px'
      )
      await expect(
        page.getByTestId('skill-detail').getByRole('button', { name: '使用技能', exact: true })
      ).toBeVisible()
      await expect(
        page.getByTestId('skill-detail').getByText('在任务中启用', { exact: true })
      ).toBeVisible()
      await page
        .getByTestId('skill-detail')
        .getByRole('button', { name: '使用技能', exact: true })
        .click()
      await expect(page.getByRole('heading', { name: '使用 skill-0' })).toBeVisible()
      await expect(page.getByTestId('skill-detail')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.getByTestId('skill-view-skill-0').focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('skill-detail')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      await expect(page.locator('[data-skill-group="scholarseed"]')).toHaveCount(0)
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(25)
      await page.getByTestId('skills-search').fill('skill-6')
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(1)
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await expect(page.getByTestId('skills-search')).toHaveValue('')
      await expect(page.locator('[data-skill-group="scholarseed"]')).toHaveCount(5)
      await page.getByTestId('skills-search').fill('skill-1')
      await expect(page.locator('[data-skill-group="scholarseed"]')).toHaveCount(1)
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      await expect(page.getByTestId('skills-search')).toHaveValue('skill-6')
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(1)
      await page.getByRole('button', { name: '清空搜索', exact: true }).click()
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(25)
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await expect(page.getByTestId('skills-search')).toHaveValue('skill-1')
      await page.getByRole('button', { name: '清空搜索', exact: true }).click()
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      await expect(page.getByTestId('skills-search')).toHaveValue('')
      const userCard = page.getByTestId('skill-card-skill-5')
      const more = page.getByTestId('skill-more-skill-5')
      await page.mouse.move(0, 0)
      await expect(more).toHaveCSS('visibility', 'visible')
      await expect(more).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await userCard.hover()
      await expect(more).toHaveCSS('visibility', 'visible')
      await more.hover()
      await expect(more).toHaveCSS('background-color', 'rgb(234, 230, 221)')
      await expect(userCard.getByRole('button', { name: '使用', exact: true })).toHaveCount(0)
      await page.getByTestId('skill-view-skill-5').click()
      await page
        .getByTestId('skill-detail')
        .getByRole('button', { name: '使用技能', exact: true })
        .click()
      const tryDialog = page.getByRole('dialog')
      await expect(tryDialog.getByRole('heading', { name: '使用 skill-5' })).toBeVisible()
      await expect(tryDialog.getByRole('button', { name: '带入新任务' })).toBeDisabled()
      await expect(tryDialog.getByRole('textbox')).toHaveAttribute('required', '')
      await expect(tryDialog.getByRole('textbox')).toHaveValue('')
      await expect(tryDialog.getByRole('textbox')).toHaveAttribute(
        'placeholder',
        '你想用这个技能完成什么任务？可以简单描述你的需求、相关背景，以及期望得到的结果。'
      )
      await tryDialog.getByRole('textbox').fill('   ')
      await expect(tryDialog.getByRole('button', { name: '带入新任务' })).toBeDisabled()
      await tryDialog.getByLabel('任务内容').fill('整理参考文献')
      await tryDialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { skillActions: unknown[] }).skillActions),
        []
      )
      await userCard.hover()
      await page.getByTestId('skill-view-skill-5').click()
      await page
        .getByTestId('skill-detail')
        .getByRole('button', { name: '使用技能', exact: true })
        .click()
      await expect(tryDialog.getByLabel('任务内容')).toHaveValue('')
      await expect(tryDialog.getByRole('button', { name: '带入新任务' })).toBeDisabled()
      await tryDialog.getByLabel('任务内容').fill('不要带入其他技能的任务')
      await page.keyboard.press('Escape')
      await page.getByTestId('skill-more-skill-6').click()
      await page.getByTestId('skill-use-skill-6').click()
      await expect(tryDialog.getByRole('heading', { name: '使用 skill-6' })).toBeVisible()
      await expect(tryDialog.getByLabel('任务内容')).toHaveValue('')
      await expect(tryDialog.getByRole('button', { name: '带入新任务' })).toBeDisabled()
      await page.keyboard.press('Escape')
      await page.getByTestId('skill-more-skill-5').click()
      await page.getByTestId('skill-use-skill-5').click()
      await tryDialog.getByLabel('在哪个项目中开始').click()
      await page.getByRole('option', { name: 'Project two' }).click()
      await tryDialog.getByLabel('任务内容').fill('核对文献格式')
      await tryDialog.getByRole('button', { name: '带入新任务' }).click()
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { skillActions: unknown[] }).skillActions),
        [
          {
            projectId: 'project-two',
            submit: true,
            composerText: '核对文献格式',
            composerRefs: [
              {
                type: 'skill',
                id: 'skill-5',
                title: 'skill-5',
                path: '/skills/skill-5',
                version: undefined,
              },
            ],
          },
        ]
      )
      await userCard.hover()
      await more.click()
      await expect(page.getByRole('menuitem', { name: '删除技能', exact: true })).toBeVisible()
      await expect(page.getByTestId('skill-detail')).toHaveCount(0)
      await page.getByTestId('skill-remove-skill-5').click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByTestId('skill-toggle-skill-5').click()
      await expect(page.getByTestId('skill-detail')).toHaveCount(0)
      const scroll = page.getByTestId('skills-list')
      const before = await page.getByTestId('skills-search').boundingBox()
      await scroll.hover()
      await page.mouse.wheel(0, 1200)
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      assert.deepEqual(await page.getByTestId('skills-search').boundingBox(), before)
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await expect(page.locator('[data-skill-group="scholarseed"]')).toHaveCount(5)
      await expect(page.locator('[data-skill-group="user"]')).toHaveCount(0)
      await page.goto(new URL('/__skills?emptyUser=1', server.resolvedUrls!.local[0]).href)
      await page.getByRole('tab', { name: '我添加的', exact: true }).click()
      const userEmpty = page.getByTestId('skills-empty')
      await expect(userEmpty).toContainText('暂无技能')
      await expect(userEmpty.locator('svg.lucide-hammer')).toBeVisible()
      await expect(userEmpty.getByText('添加技能后，可以在这里查看和管理。')).toHaveCount(0)
      await expect(userEmpty.getByRole('button', { name: '添加技能' })).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const tabs = document.querySelector('[role="tablist"][aria-label="技能分类"]')
            const empty = document.querySelector('[data-testid="skills-empty"]')
            if (!tabs || !empty) return false
            const tabsBox = tabs.getBoundingClientRect()
            const emptyBox = empty.getBoundingClientRect()
            return (
              emptyBox.y > tabsBox.y + tabsBox.height &&
              emptyBox.y < tabsBox.y + tabsBox.height + 40 &&
              emptyBox.height >= 200 &&
              emptyBox.width >= 800 &&
              emptyBox.height < 300
            )
          })
        )
        .toBe(true)
      await expect(userEmpty).toHaveCSS('background-color', 'rgb(244, 241, 235)')
      await expect(userEmpty.locator('.vds-empty-state__icon')).toHaveCSS(
        'background-color',
        'rgb(234, 230, 221)'
      )
      await expect(userEmpty.getByText('暂无技能', { exact: true })).toHaveCSS(
        'color',
        'rgb(39, 39, 39)'
      )
      await userEmpty.getByRole('button', { name: '添加技能' }).click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'system UI report without cards confirms an update without plugin activation or preview',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/skills.render.fixture.html?uiReport=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('button', { name: '确认更新系统 UI', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '对话交互预览', exact: true })).toHaveCount(0)
      await expect(
        page.getByRole('button', { name: '确认更新系统 UI', exact: true }).locator('..')
      ).not.toContainText('0')
      await expect(page.getByText('系统 UI 依赖：', { exact: false })).toBeVisible()
      await expect(page.getByRole('button', { name: '仅安装，不启用', exact: true })).toHaveCount(0)
      await page.evaluate(() => {
        ;(
          window as unknown as { catalogFixture: { respond: (result: unknown) => void } }
        ).catalogFixture.respond({
          status: 200,
          body: JSON.stringify({ installed: { id: 'official-ui' } }),
        })
      })
      await page.getByRole('button', { name: '确认更新系统 UI', exact: true }).click()
      await expect
        .poll(() => page.evaluate('window.catalogFixture.completed'))
        .toEqual([{ namespace: 'skills', key: 'plugin.uiUpdated' }])
      const requests = (await page.evaluate('window.catalogFixture.requests')) as {
        operation: string
        grants: string[]
      }[]
      assert.deepEqual(
        requests.map((request) => request.operation),
        ['plugin-confirm']
      )
      assert.deepEqual(requests[0].grants, [])
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)

test(
  'catalog failure is not empty and retry preserves the previous successful list',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await server.listen()
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      page.on('pageerror', (error) => console.error(error.stack))
      await page.route(/\/api\/(?!.*\.(?:ts|tsx|js)(?:\?|$))/, (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      )
      await page.goto(
        new URL('/components/business/skills.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await page.getByRole('tab', { name: '系统预置', exact: true }).click()
      await expect(page.getByTestId('skills-load-error')).toContainText('技能加载失败，请重试。')
      await expect(page.getByTestId('skills-empty')).toHaveCount(0)
      const rows = [
        {
          name: 'precise-literature-search',
          group: 'scholarseed',
          enabled: true,
          toggleable: true,
          description: 'Precise search',
        },
      ]
      await page.evaluate(
        (rows) =>
          (
            window as unknown as { catalogFixture: { respond: (result: unknown) => void } }
          ).catalogFixture.respond({ status: 200, body: JSON.stringify({ skills: rows }) }),
        rows
      )
      await page.getByTestId('skills-load-retry').click()
      await expect(page.getByTestId('skill-card-precise-literature-search')).toBeVisible()
      await expect(page.getByTestId('skills-load-error')).toHaveCount(0)
      await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            catalogFixture: { respond: (result: unknown) => void; refresh: () => void }
          }
        ).catalogFixture
        fixture.respond({ status: 503, body: '{}' })
        fixture.refresh()
      })
      await expect(page.getByTestId('skill-card-precise-literature-search')).toBeVisible()
      await expect(page.getByTestId('skills-load-error')).toHaveCount(0)
      await expect(page.getByTestId('skills-empty')).toHaveCount(0)
      await page.evaluate(() =>
        (
          window as unknown as { catalogFixture: { respond: (result: unknown) => void } }
        ).catalogFixture.respond({ status: 200, body: '{"skills":[]}' })
      )
      await page.evaluate(() =>
        (window as unknown as { catalogFixture: { refresh: () => void } }).catalogFixture.refresh()
      )
      await expect(page.getByTestId('skills-empty')).toBeVisible()
      await expect(page.getByTestId('skills-load-error')).toHaveCount(0)
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)
test('installed skill and connector card actions share a centerline and an eight-pixel gap', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL(
        '/__skills?center=1&authorizedConnector=1&twoConnectors=1',
        server.resolvedUrls!.local[0]
      ).href
    )
    for (const group of ['scholarseed', 'user']) {
      await page.getByTestId(`skills-tab-${group}`).click()
      const card = page.locator(`[data-skill-group="${group}"]`).first()
      const more = card.getByRole('button', { name: /更多操作/ })
      await expect(more).toBeVisible()
      const menu = (await more.boundingBox())!
      const action = (await card.getByRole('switch').boundingBox())!
      assert.equal(action.x - menu.x - menu.width, 8)
      assert.ok(Math.abs(action.y + action.height / 2 - menu.y - menu.height / 2) < 1)
    }
    await page.getByRole('tab', { name: '连接器', exact: true }).click()
    await page.getByRole('tab', { name: '我的', exact: true }).click()
    for (const id of ['zotero', 'github']) {
      const card = page.getByTestId(`connector-${id}`)
      const more = card.getByTestId(`connector-more-${id}`)
      await expect(more).toBeVisible()
      const menu = (await more.boundingBox())!
      const action = (await (
        id === 'zotero'
          ? card.getByRole('button', { name: '授权', exact: true })
          : card.getByRole('switch')
      ).boundingBox())!
      assert.equal(action.x - menu.x - menu.width, 8)
      assert.ok(Math.abs(action.y + action.height / 2 - menu.y - menu.height / 2) < 1)
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill cards omit unavailable reason copy while retaining activation controls', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills?disabledReason=1', server.resolvedUrls!.local[0]).href)
    await page.getByTestId('skills-tab-user').click()
    const card = page.getByTestId('skill-card-skill-5')
    await expect(card.getByTestId('skill-toggle-skill-5')).toBeChecked()
    await expect(card).not.toContainText('该技能已在书深中停用')
    await card.getByTestId('skill-toggle-skill-5').click()
    await expect(card.getByTestId('skill-toggle-skill-5')).not.toBeChecked()
    await expect(card).not.toContainText('该技能已在书深中停用')
  } finally {
    await browser.close()
    await server.close()
  }
})

test('installed cards retain two columns and show accurate source footers with aligned actions', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL(
        '/__skills?center=1&attributionData=1&authorizedConnector=1&twoConnectors=1',
        server.resolvedUrls!.local[0]
      ).href
    )
    for (const tab of ['scholarseed', 'user']) {
      await page.getByTestId(`skills-tab-${tab}`).click()
      const cards = page.locator(`[data-skill-group="${tab}"]`)
      await expect(cards.nth(2)).toBeVisible()
      await expect
        .poll(() =>
          cards.evaluateAll((elements) => {
            if (elements.length < 3) return false
            const [first, second, third] = elements
              .slice(0, 3)
              .map((element) => element.getBoundingClientRect())
            return first.y === second.y && first.x === third.x && third.y > first.y
          })
        )
        .toBe(true)
      await expect
        .poll(() =>
          cards.evaluateAll(
            (elements) =>
              elements.length >= 3 &&
              elements.every(
                (element) => element.querySelectorAll('.vds-card__footer').length === 1
              )
          )
        )
        .toBe(true)
      await expect(cards.first().locator('.vds-card__footer')).toHaveCSS(
        'border-top-style',
        'solid'
      )
      await expect(
        cards
          .first()
          .getByTestId(tab === 'scholarseed' ? 'skill-source-skill-0' : 'skill-source-skill-5')
      ).toHaveText(tab === 'scholarseed' ? '官方' : '用户上传')
      if (tab === 'user') {
        await expect(page.getByTestId('skill-source-skill-6')).toHaveText('GitHub')
        await expect(page.getByTestId('skill-source-skill-8')).toHaveText('本地添加')
      }
      const more = cards.first().getByRole('button', { name: /更多操作/ })
      await expect(more.locator('svg.lucide-ellipsis')).toBeVisible()
      const menu = (await more.boundingBox())!
      const toggle = (await cards.first().getByRole('switch').boundingBox())!
      assert.ok(menu.x + menu.width < toggle.x)
      assert.ok(Math.abs(menu.y + menu.height / 2 - toggle.y - toggle.height / 2) < 1)
    }
    await page.getByRole('tab', { name: '连接器', exact: true }).click()
    await page.getByRole('tab', { name: '我的', exact: true }).click()
    const offsets = []
    for (const id of ['zotero', 'github']) {
      const card = page.getByTestId(`connector-${id}`)
      await expect(card).toBeVisible()
      await expect(card.locator('.vds-card__footer')).toHaveCount(1)
      await expect(card.locator('.vds-card__footer')).toHaveText(
        id === 'zotero' ? 'API Key' : '已授权'
      )
      const bounds = (await card.boundingBox())!
      const action = (await (
        id === 'zotero'
          ? card.getByRole('button', { name: '授权', exact: true })
          : card.getByRole('switch')
      ).boundingBox())!
      offsets.push(bounds.x + bounds.width - action.x - action.width)
    }
    assert.ok(Math.abs(offsets[0] - offsets[1]) < 1)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill center form dialog headers align titles and close buttons like skill details', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL(
        '/__skills?center=1&authorizedConnector=1&twoConnectors=1',
        server.resolvedUrls!.local[0]
      ).href
    )
    const checkHeader = async (): Promise<void> => {
      const dialog = page.getByRole('dialog').last()
      await expect(dialog).toBeVisible()
      const title = dialog.locator('.vds-dialog__title')
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      await expect(title).toHaveCSS('font-size', '16px')
      await expect(title).toHaveCSS('font-weight', '400')
      await expect(title).toHaveCSS('line-height', '24px')
      await expect(close).toHaveCSS('top', '12px')
      await expect(close).toHaveCSS('right', '8px')
      const titleBox = (await title.boundingBox())!
      const closeBox = (await close.boundingBox())!
      assert.ok(Math.abs(titleBox.y + titleBox.height / 2 - closeBox.y - closeBox.height / 2) < 1)
      assert.ok(titleBox.x + titleBox.width <= closeBox.x - 4)
      await close.click()
    }
    await page.getByRole('button', { name: '添加技能', exact: true }).click()
    await checkHeader()
    await page.getByTestId('skills-tab-scholarseed').click()
    await page.getByTestId('skill-more-skill-0').click()
    await page.getByRole('menuitem', { name: '使用技能', exact: true }).click()
    await checkHeader()
    await page.getByRole('tab', { name: '连接器', exact: true }).click()
    await page.getByRole('tab', { name: '我的', exact: true }).click()
    await page
      .getByTestId('connector-zotero')
      .getByRole('button', { name: '授权', exact: true })
      .click()
    await checkHeader()
    await page.getByTestId('connector-more-github').click()
    await page.getByRole('menuitem', { name: '使用连接器', exact: true }).click()
    await checkHeader()
    await page.getByRole('button', { name: '添加连接器', exact: true }).click()
    await checkHeader()
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill and connector details leave 4px between the switch and close button at an 8px inset', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL('/__skills?center=1&authorizedConnector=1', server.resolvedUrls!.local[0]).href
    )
    await page.getByTestId('skills-tab-scholarseed').click()
    await page.getByTestId('skill-view-skill-0').click()
    for (const id of ['skill-detail', 'connector-detail']) {
      const dialog = page.getByTestId(id)
      await expect(dialog).toBeVisible()
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      await expect(close).toHaveCSS('right', '8px')
      const toggleBounds = (await dialog.getByRole('switch').boundingBox())!
      const closeBounds = (await close.boundingBox())!
      assert.ok(
        Math.abs(closeBounds.x - toggleBounds.x - toggleBounds.width - 4) < 1,
        JSON.stringify({ id, closeBounds, toggleBounds })
      )
      assert.ok(
        Math.abs(
          closeBounds.y + closeBounds.height / 2 - toggleBounds.y - toggleBounds.height / 2
        ) < 1
      )
      await close.click()
      if (id === 'skill-detail') {
        await page.getByRole('tab', { name: '连接器', exact: true }).click()
        await page.getByRole('tab', { name: '我的', exact: true }).click()
        await page
          .getByTestId('connector-github')
          .getByRole('button', { name: '查看 GitHub', exact: true })
          .click()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill toggles preserve mounted content through stale refreshes and failed background loads', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(new URL('/__skills', server.resolvedUrls!.local[0]).href)
    await page.getByTestId('skills-tab-user').click()
    const toggle = page.getByTestId('skill-toggle-skill-5')
    await expect(toggle).toBeChecked()
    const card = await page.getByTestId('skill-card-skill-5').elementHandle()
    await page.evaluate(() => {
      const state = window as unknown as SkillTestWindow
      state.holdSkillLists = true
      state.holdSkillToggles = true
    })
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await page.evaluate(() => window.dispatchEvent(new Event('scholarseed:skill-catalog-changed')))
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as SkillTestWindow).pendingSkillLists.length)
      )
      .toBe(1)
    await expect(page.getByTestId('skills-loading')).toHaveCount(0)
    assert.equal(await card!.evaluate((element) => element.isConnected), true)
    await page.evaluate(() => (window as unknown as SkillTestWindow).pendingSkillLists.shift()!())
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeDisabled()
    await page.evaluate(() =>
      (window as unknown as SkillTestWindow).pendingSkillToggles.shift()!(true)
    )
    await expect(toggle).toBeEnabled()
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as SkillTestWindow).pendingSkillLists.length)
      )
      .toBe(1)
    await expect(toggle).not.toBeChecked()
    await page.evaluate(() => (window as unknown as SkillTestWindow).pendingSkillLists.shift()!())
    await expect(toggle).not.toBeChecked()
    await page.evaluate(() => {
      const state = window as unknown as SkillTestWindow
      state.holdSkillLists = false
      state.failSkillLoad = true
      window.dispatchEvent(new Event('scholarseed:skill-catalog-changed'))
    })
    await expect(page.getByText('技能加载失败，请重试。', { exact: true })).toBeVisible()
    await expect(page.getByTestId('skills-load-error')).toHaveCount(0)
    await expect(page.getByTestId('skills-loading')).toHaveCount(0)
    assert.equal(await card!.evaluate((element) => element.isConnected), true)
    await toggle.click()
    await expect(toggle).toBeChecked()
    await page.getByTestId('skill-toggle-skill-6').click()
    await expect(page.getByTestId('skill-toggle-skill-6')).not.toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as SkillTestWindow).pendingSkillToggles.length)
      )
      .toBe(2)
    await page.evaluate(() => {
      const state = window as unknown as SkillTestWindow
      state.pendingSkillToggles.shift()!(false)
      state.pendingSkillToggles.shift()!(true)
    })
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(page.getByTestId('skill-toggle-skill-6')).not.toBeChecked()
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill category edges strictly match the card grid with an overlay scrollbar', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL(
        '/__skills?center=1&marketData=1&scrollMarket=1&standardLabels=1',
        server.resolvedUrls!.local[0]
      ).href
    )
    await expect(page.getByRole('scrollbar')).toBeVisible()
    assert.equal(
      await page
        .getByTestId('skills-list')
        .evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth),
      0
    )
    for (const viewport of [VIEWPORT, WORKSPACE_WINDOW_MINIMUM]) {
      await page.setViewportSize(viewport)
      const cards = page.locator('[data-testid^="marketplace-card-"]')
      await expect(cards.first()).toBeVisible()
      await expect
        .poll(async () => {
          const first = (await cards.first().boundingBox())!
          const grid = (await cards.first().locator('..').boundingBox())!
          const categories = (await page.getByTestId('skills-classification-scroll').boundingBox())!
          return Math.max(
            Math.abs(first.x - categories.x),
            Math.abs(grid.x + grid.width - categories.x - categories.width)
          )
        })
        .toBeLessThan(1)
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('skill document loading centers a spinner and original-text label', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [fixture(), react()],
    cacheKey: 'skills',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(
      new URL('/__skills?marketData=1&delayDocument=1', server.resolvedUrls!.local[0]).href
    )
    await page
      .getByTestId('marketplace-card-market-paper')
      .getByRole('button', { name: '查看 Paper tools 的详情' })
      .click()
    const document = page.getByTestId('skill-document')
    const status = document.getByRole('status')
    await expect(status).toHaveText('正在加载原文')
    await expect(status.locator('.vds-spinner')).toBeVisible()
    const container = (await document.boundingBox())!
    const loading = (await status.boundingBox())!
    assert.ok(Math.abs(loading.x + loading.width / 2 - container.x - container.width / 2) < 1)
    assert.ok(Math.abs(loading.y + loading.height / 2 - container.y - container.height / 2) < 1)
    await page.mouse.click(10, 10)
    await expect(page.getByTestId('skill-detail')).toHaveCount(0)
  } finally {
    await browser.close()
    await server.close()
  }
})
