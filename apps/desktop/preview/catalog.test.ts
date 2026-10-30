import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { MAIN_VIEWS, SETTINGS_PAGES, sanitizeNavigationLocation } from '../src/navigation.ts'
import { PREVIEW_CATALOG, previewLaunchUrl } from './catalog.ts'
import { PREVIEW_CONVERSATION } from './conversation.ts'

test('workspace layout scene reuses the existing resource target and panel host', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-resource')!
  const scene = page.scenarios.find(scene => scene.id === 'project-layout-states')!
  assert.ok(page.target)
  assert.deepEqual(page.host, { kind: 'panel', key: 'resource-tree' })
  assert.deepEqual(scene.states, ['split', 'moved-right', 'moved-left', 'reloaded', 'narrow'])
  assert.equal(scene.simulation, undefined)
})

test('shared content read scenes cover every reviewed code, image and Office target without replacing generic requirements', () => {
  for (const kind of ['markdown', 'pdf', 'code', 'image', 'office']) {
    const page = PREVIEW_CATALOG.find(page => page.id === `viewer-${kind}`)!
    assert.deepEqual(page.scenarios[0].states, ['loading', 'loaded', 'error'])
    assert.equal(page.target?.target?.kind, 'document')
    for (const [suffix, mode] of [['pending', 'delayed'], ['failed', 'failed'], ['retry', 'fail-once']]) {
      assert.equal(page.scenarios.find(scene => scene.id === `viewer-${kind}-${suffix}`)?.simulation?.contentRead?.mode, mode)
    }
    assert.ok(page.scenarios.find(scene => scene.id === `viewer-${kind}-failed`)?.states.includes('recovered'))
  }
})

test('directory browsing scenes preserve generic requirements and register independent policies on their real owners', () => {
  const listing = PREVIEW_CATALOG.find(page => page.id === 'viewer-material-list')!
  const explorer = PREVIEW_CATALOG.find(page => page.id === 'viewer-explorer')!
  for (const page of [listing, explorer]) {
    assert.deepEqual(page.scenarios[0].states, ['loading', 'loaded', 'error'])
    assert.equal(page.scenarios.find(scene => scene.id === 'browsing-empty')?.simulation?.browsing?.seed, 'empty')
    assert.equal(page.scenarios.find(scene => scene.id === 'browsing-paged')?.simulation?.browsing?.seed, 'paged')
  }
  assert.equal(listing.scenarios.find(scene => scene.id === 'browsing-listing-failed')?.simulation?.browsing?.listingRead, 'failed')
  assert.equal(explorer.scenarios.find(scene => scene.id === 'browsing-explorer-failed')?.simulation?.browsing?.explorerRead, 'failed')
  assert.equal(explorer.scenarios.find(scene => scene.id === 'browsing-more-pending')?.simulation?.browsing?.explorerMore, 'delayed')
  assert.equal(explorer.scenarios.find(scene => scene.id === 'browsing-more-failed')?.simulation?.browsing?.explorerMore, 'fail-once')
  assert.ok(explorer.scenarios.find(scene => scene.id === 'browsing-more-pending')!.states.includes('superseded'))
})

test('every implemented renderer surface has a real target or explicit reuse host without enabling native browser navigation', () => {
  for (const page of PREVIEW_CATALOG.filter(page => page.implementation === 'surface')) assert.ok(page.target || page.host || page.launch, page.id)
  for (const pageId of ['page-browser', 'viewer-browser']) {
    const page = PREVIEW_CATALOG.find(page => page.id === pageId)!
    assert.equal(page.target, null)
    assert.equal(page.availability, 'hidden')
    assert.deepEqual(page.host, { kind: 'browser' })
    assert.equal(page.scenarios.length, 7)
    assert.ok(page.scenarios.every(scene => scene.simulation?.browser?.surface))
    const required = page.scenarios[0]
    assert.ok(required.states.includes('loading'))
    assert.ok(required.states.includes('error'))
    assert.ok(page.scenarios.find(scene => scene.id.endsWith('-pending'))!.states.includes('request-pending'))
    assert.ok(page.scenarios.every(scene => scene.limitations.some(limit => limit.includes('不启用生产'))))
  }
})

test('literature catalogue preserves empty requirements and declares library, detail and write policies', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-literature')!
  assert.ok(page.scenarios.some(scene => scene.id === 'literature-states'))
  assert.ok(page.scenarios.some(scene => scene.id === 'literature-browse'))
  const policies = page.scenarios.flatMap(scene => scene.simulation?.literature ? [scene.simulation.literature] : [])
  assert.equal(policies.length, 7)
  assert.ok(policies.every(policy => policy.seed === 'sample'))
  for (const field of ['read', 'detail'] as const) {
    assert.ok(policies.some(policy => policy[field] === 'delayed'))
    assert.ok(policies.some(policy => policy[field] === 'failed'))
  }
  assert.ok(policies.some(policy => policy.write === 'delayed'))
  assert.ok(policies.some(policy => policy.write === 'fail-once'))
})

test('conversation catalog declares flow and transport policies independently of the service scene identifier', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')!
  assert.deepEqual(page.scenarios.map(scene => scene.simulation?.conversation), [
    { mode: 'streaming' }, { mode: 'tools' }, { mode: 'approval' },
    { mode: 'streaming', stream: 'interruptible' },
    { mode: 'failure', disconnectAfterDeltas: 1, reconnectDelayMs: PREVIEW_CONVERSATION.reconnectDelayMs },
    { mode: 'chat', submission: 'delayed' },
    { mode: 'tools', tool: 'delayed' },
    { mode: 'tools', tool: 'failed' },
    { mode: 'approval', approvalResume: 'delayed' },
  ])
  assert.ok(page.scenarios.find(scene => scene.id === 'conversation-recovery')!.limitations.some(text => text.includes('账本继续推进')))
})

test('archives policies follow remote project settings and scoped task navigation without restoring retired tabs', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-archives')!
  assert.equal(page.target?.settingsPage, 'archives')
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['settings-archives-states', 'settings-archives-empty', 'settings-archives-read-pending', 'settings-archives-read-failed', 'settings-archives-write-pending', 'settings-archives-write-failed', 'settings-archives-required', 'settings-archives-project-read-pending', 'settings-archives-project-read-failed'])
  const tasks = PREVIEW_CATALOG.find(candidate => candidate.id === 'page-resource')!.scenarios.filter(scene => scene.simulation?.archives)
  assert.deepEqual(tasks.map(scene => scene.id), ['project-archives-states', 'project-archives-empty', 'project-archives-read-pending', 'project-archives-read-failed', 'project-archives-history-pending', 'project-archives-history-failed', 'project-archives-history-empty', 'project-archives-write-pending', 'project-archives-write-failed'])
  assert.ok(page.scenarios.every(scene => !scene.states.some(state => ['details', 'readonly', 'tree'].includes(state))))
  const policies = [...page.scenarios, ...tasks].flatMap(scene => scene.simulation?.archives ? [scene.simulation.archives] : [])
  assert.equal(policies.length, 18)
  assert.ok(policies.some(policy => policy.seed === 'empty'))
  for (const field of ['read', 'history', 'write'] as const) assert.ok(policies.some(policy => policy[field] === 'delayed'))
  assert.ok(policies.some(policy => policy.history === 'empty'))
  assert.ok(policies.some(policy => policy.write === 'fail-once'))
  assert.ok(page.entryInstructions?.some(instruction => instruction.includes('任务') && instruction.includes('项目')))
  const requirement = page.scenarios.find(scene => scene.id === 'settings-archives-required')!
  assert.deepEqual(requirement.simulation?.archives, { seed: 'sample', read: 'normal', projectRead: 'failed', history: 'normal', write: 'delayed' })
  assert.deepEqual(requirement.states, ['project-read-error', 'project-read-retried', 'project-read-recovered', 'project-single-restore-busy'])
  assert.ok(requirement.limitations.some(limit => limit.includes('控制台') && limit.includes('次数')))
})

test('catalog accounts for every production navigation and settings key', () => {
  assert.deepEqual(PREVIEW_CATALOG.filter(page => page.category === 'page').map(page => page.entry), [...MAIN_VIEWS])
  assert.deepEqual(PREVIEW_CATALOG.filter(page => page.category === 'settings').map(page => page.entry), [...SETTINGS_PAGES])
})

test('developer scenarios use isolated account capability and explicit read/write policies without real credentials', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-developer')!
  assert.equal(page.target?.settingsPage, 'developer')
  assert.equal(page.scenarios.length, 6)
  assert.ok(page.scenarios.every(scene => scene.simulation?.account === 'ready'))
  assert.deepEqual(page.scenarios.map(scene => scene.simulation?.developer), [
    { read: 'sample', write: 'normal' }, { read: 'empty', write: 'normal' },
    { read: 'delayed', write: 'normal' }, { read: 'failed', write: 'normal' },
    { read: 'sample', write: 'delayed' }, { read: 'sample', write: 'fail-once' },
  ])
  assert.ok(page.scenarios[0].limitations.some(limit => limit.includes('不签发真实凭据')))
})

test('catalog targets round-trip through production navigation validation without claiming verified coverage', () => {
  assert.equal(new Set(PREVIEW_CATALOG.map(page => page.id)).size, PREVIEW_CATALOG.length)
  for (const page of PREVIEW_CATALOG) {
    assert.ok(existsSync(fileURLToPath(new URL(`../${page.source}`, import.meta.url))), page.source)
    assert.ok(page.owner && page.entry && page.title)
    assert.ok(page.requirementSource.startsWith('本次 Goal：'), page.id)
    assert.ok(page.scenarios.length > 0, page.id)
    if (page.target) assert.deepEqual(sanitizeNavigationLocation(page.target), page.target, page.id)
    if (page.availability !== 'pending') assert.equal(page.target, null, page.id)
    for (const scenario of page.scenarios) {
      assert.equal(scenario.status, 'unverified', scenario.id)
      assert.ok(scenario.states.length && scenario.expected.length && scenario.limitations.length, scenario.id)
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(PREVIEW_CATALOG)), PREVIEW_CATALOG)
})

test('aliases and historical placeholders remain inventoried without claiming independent implemented pages', () => {
  assert.deepEqual(PREVIEW_CATALOG.filter(page => page.implementation === 'placeholder').map(page => page.id), ['page-writing'])
  const aliases = PREVIEW_CATALOG.filter(page => page.implementation === 'alias')
  assert.deepEqual(aliases.map(page => page.id), ['settings-model-settings'])
  assert.equal(aliases[0].aliasOf, 'settings-models')
  assert.equal(PREVIEW_CATALOG.find(page => page.id === aliases[0].aliasOf)?.implementation, 'surface')
  for (const page of PREVIEW_CATALOG.filter(page => page.implementation !== 'surface')) {
    assert.equal(page.target, null, page.id)
    assert.equal(page.availability, 'hidden', page.id)
  }
})

test('settings with hidden navigation cannot claim ordinary reachable navigation targets', () => {
  for (const key of ['account', 'preferences', 'skills', 'permissions', 'shortcuts', 'browser']) {
    const page = PREVIEW_CATALOG.find(page => page.id === `settings-${key}`)!
    assert.equal(page.implementation, 'surface')
    assert.equal(page.availability, 'hidden')
    assert.equal(page.target, null)
    assert.deepEqual(page.host, { kind: 'settings', page: key })
  }
})

test('conversation catalog includes streaming, tools, approval, cancellation and recovery expectations', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-conversation')!
  assert.deepEqual(page.scenarios.map(scenario => scenario.id), ['conversation-stream', 'conversation-tool', 'conversation-approval', 'conversation-cancel', 'conversation-recovery', 'conversation-submit-pending', 'conversation-tool-running', 'conversation-tool-failed', 'conversation-approval-resume'])
  assert.ok(page.scenarios.find(scenario => scenario.id === 'conversation-approval')!.states.includes('rejected'))
  assert.equal(PREVIEW_CATALOG.find(page => page.id === 'surface-approval')!.scenarios[0], page.scenarios.find(scenario => scenario.id === 'conversation-approval'))
})

test('permission scenarios disclose unavailable snapshots, bounded loading and persistent query failure', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-permissions')!
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['settings-permissions-states', 'settings-permissions-pending', 'settings-permissions-failed'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [{ permissions: 'normal' }, { permissions: 'delayed' }, { permissions: 'failed' }])
  assert.ok(page.scenarios.every(scene => scene.limitations.some(text => text.includes('原生'))))
})

test('account scenarios declare only isolated read-only profile policies without claiming real authentication', () => {
  const account = PREVIEW_CATALOG.find(page => page.id === 'settings-account')!
  assert.deepEqual(account.scenarios.map(scene => scene.id), ['settings-account-states', 'settings-account-ready', 'settings-account-pending', 'settings-account-failed', 'settings-account-anonymous'])
  assert.deepEqual(account.scenarios.map(scene => scene.simulation), [{ account: 'no-base' }, { account: 'ready' }, { account: 'delayed' }, { account: 'failed' }, { account: 'anonymous' }])
  assert.ok(account.scenarios.every(scene => scene.limitations.some(text => text.includes('真实账号'))))
})

test('notification and about entries describe only public controls and preserve native and hidden-guide gaps', () => {
  const notifications = PREVIEW_CATALOG.find(page => page.id === 'settings-notifications')!
  const about = PREVIEW_CATALOG.find(page => page.id === 'settings-about')!
  assert.ok(notifications.entryInstructions?.some(text => text.includes('声音')))
  assert.ok(notifications.scenarios[0].limitations.some(text => text.includes('原生')))
  assert.ok(about.entryInstructions?.some(text => text.includes('外链')))
  assert.ok(about.scenarios[0].limitations.some(text => text.includes('引导') && text.includes('隐藏')))
  assert.ok(about.scenarios[0].limitations.some(text => text.includes('更新')))
})

test('retired MCP settings are absent from the preview catalog', () => {
  assert.equal(PREVIEW_CATALOG.some(page => page.id === 'settings-mcp'), false)
  assert.equal(SETTINGS_PAGES.some(page => String(page) === 'mcp'), false)
})

test('model connection scenarios expose only isolated read policies through the real settings page', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-models')!
  assert.equal(page.target?.settingsPage, 'models')
  assert.equal(page.host, undefined)
  assert.ok(page.entryInstructions?.length)
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['settings-models-states', 'settings-models-empty', 'settings-models-pending', 'settings-models-failed'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [
    { modelProfiles: { read: 'sample' } }, { modelProfiles: { read: 'empty' } },
    { modelProfiles: { read: 'delayed' } }, { modelProfiles: { read: 'failed' } },
  ])
  assert.ok(page.scenarios.every(scene => scene.limitations.some(text => text.includes('凭据') && text.includes('推理'))))
})

test('storage scenes preserve effective roots and disclose virtual directory selection', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-storage')!
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['settings-storage-states', 'settings-storage-save-pending', 'settings-storage-save-failed', 'settings-storage-home-read-pending', 'settings-storage-workspace-read-pending', 'settings-storage-home-read-failed', 'settings-storage-workspace-read-failed', 'settings-storage-both-read-failed', 'settings-storage-read-required'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation?.storage), [
    { write: 'normal' }, { write: 'delayed' }, { write: 'fail-once' },
    { write: 'normal', homeRead: 'delayed' }, { write: 'normal', workspaceRead: 'delayed' },
    { write: 'normal', homeRead: 'failed' }, { write: 'normal', workspaceRead: 'failed' },
    { write: 'normal', homeRead: 'failed', workspaceRead: 'failed' },
    { write: 'normal', homeRead: 'failed', workspaceRead: 'delayed' },
  ])
  assert.ok(page.scenarios[0].expected.some(text => text.includes('生效根') && text.includes('保持不变')))
  assert.ok(page.scenarios[0].limitations.some(text => text.includes('读取') && text.includes('独立场景')))
  assert.deepEqual(page.scenarios[8].states, ['loading', 'error', 'recovered'])
  assert.ok(page.scenarios[8].limitations.some(text => text.includes('原生') && text.includes('真实失败注入')))
})

test('file policy scenes declare automatic configuration saves without claiming history cleanup', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'settings-files')!
  assert.equal(page.target?.settingsPage, 'files')
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['settings-files-states', 'settings-files-save-pending', 'settings-files-save-failed'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [{ fileSettings: { write: 'normal' } }, { fileSettings: { write: 'delayed' } }, { fileSettings: { write: 'fail-once' } }])
  assert.ok(page.scenarios.every(scene => scene.limitations.some(text => text.includes('清理') && text.includes('读取异常'))))
})

test('primary browsing scenes preserve generic state gaps and expose resources only through its real registered module', () => {
  for (const view of ['home', 'projects', 'resource', 'literature', 'skills']) {
    const page = PREVIEW_CATALOG.find(page => page.id === `page-${view}`)!
    assert.ok(page.scenarios.some(scene => scene.id === `${view}-states`))
    const browse = page.scenarios.find(scene => scene.id === `${view}-browse`)!
    assert.ok(browse)
    assert.ok(browse.limitations.some(text => text.includes('仍保留待接入')))
    assert.ok(page.entryInstructions?.length)
  }
  const resource = PREVIEW_CATALOG.find(page => page.id === 'page-resource')!
  assert.deepEqual(resource.host, { kind: 'panel', key: 'resource-tree' })
  assert.ok(resource.target?.projectId)
  assert.ok(resource.scenarios.find(scene => scene.id === 'resource-browse')?.limitations.some(text => text.includes('不恢复生产隐藏导航')))
  const literature = PREVIEW_CATALOG.find(page => page.id === 'page-literature')!
  assert.ok(literature.scenarios.find(scene => scene.id === 'literature-browse')?.limitations.some(text => text.includes('非空文献列表')))
})

test('document loading scenarios preserve real targets and distinguish HTTP failure from format decoding', () => {
  for (const kind of ['markdown', 'pdf']) {
    const page = PREVIEW_CATALOG.find(page => page.id === `viewer-${kind}`)!
    assert.equal(page.target?.target?.kind, 'document')
    assert.ok(page.entryInstructions?.some(text => text.includes('内容 GET 在途') && text.includes('App 恢复进度') && text.includes('尚无 viewer')))
    assert.ok(page.scenarios.find(scene => scene.id === `viewer-${kind}-pending`)?.limitations.some(text => text.includes('不是 viewer 内部或 Dock 加载态')))
    assert.deepEqual(page.scenarios.map(scene => scene.id), [`viewer-${kind}-states`, `viewer-${kind}-pending`, `viewer-${kind}-failed`, `viewer-${kind}-retry`])
    assert.deepEqual(page.scenarios.slice(1).map(scene => scene.simulation), [{ contentRead: { mode: 'delayed' } }, { contentRead: { mode: 'failed' } }, { contentRead: { mode: 'fail-once' } }])
    assert.deepEqual(page.scenarios.slice(1).map(scene => scene.states), [['loading', 'loaded'], ['error', 'retry-failed', 'recovered'], ['error', 'retried', 'loaded']])
    assert.ok(page.scenarios.slice(1).every(scene => scene.limitations.some(text => text.includes('HTTP') && text.includes('解码'))))
  }
})

test('project creation failure is an explicit scene policy rather than a magic project name', () => {
  const page = PREVIEW_CATALOG.find(page => page.id === 'page-projects')!
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['projects-states', 'projects-create-failure', 'projects-browse'])
  assert.equal(page.scenarios[0].simulation, undefined)
  assert.deepEqual(page.scenarios[1].simulation, { projectCreation: 'fail-once' })
})

test('existing component, fixed-view and transient surfaces bind only to their real parent entries', () => {
  const parents = new Map([
    ['development-components', 'home'], ['viewer-projects', 'projects'],
    ['viewer-literature', 'literature'], ['surface-project-form', 'home'],
    ['surface-menus', 'resource'], ['surface-approval', 'conversation'],
  ])
  for (const [id, view] of parents) {
    const page = PREVIEW_CATALOG.find(candidate => candidate.id === id)!
    assert.equal(page.target?.view, view, id)
    assert.ok(page.entryInstructions?.length, id)
    assert.equal(page.target?.settingsPage, null, id)
  }
})

test('login, renderer close and real error-boundary demos disclose their host boundaries', () => {
  const login = PREVIEW_CATALOG.find(page => page.id === 'surface-login')!
  assert.equal(login.target?.view, 'home')
  assert.ok(login.entryInstructions?.length)
  for (const kind of ['close', 'error']) {
    const page = PREVIEW_CATALOG.find(candidate => candidate.id === `surface-${kind}`)!
    assert.equal(page.target, null)
    assert.deepEqual(page.host, { kind })
    assert.ok(page.entryInstructions?.length)
  }
})

test('version comparison starts from a real document and requests a domain-owned history policy', () => {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === 'viewer-version_diff')!
  assert.equal(page.target?.target?.kind, 'document')
  if (page.target?.target?.kind === 'document') assert.equal(page.target.target.source.path, 'readme.md')
  assert.equal(page.scenarios[0].id, 'viewer-version_diff-states')
  assert.deepEqual(page.scenarios[0].simulation, { versionHistory: 'sample-change' })
  assert.ok(page.entryInstructions?.length)
})

test('feedback scenarios declare response policy independently of the user description', () => {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === 'surface-feedback')!
  assert.equal(page.target?.view, 'home')
  assert.ok(page.entryInstructions?.length)
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['feedback-normal', 'feedback-failed', 'feedback-rate-limited'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [undefined, { feedback: 'failed' }, { feedback: 'rate-limited' }])
  for (const scene of page.scenarios) assert.equal(scene.status, 'unverified')
})

test('review scenarios declare same-file pending, failed mutation and conflict policies', () => {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === 'viewer-review')!
  assert.equal(page.target?.target?.kind, 'document')
  if (page.target?.target?.kind === 'document') assert.equal(page.target.target.source.path, 'readme.md')
  assert.ok(page.entryInstructions?.length)
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['viewer-review-states', 'viewer-review-failed', 'viewer-review-conflict'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [{ reviewBatch: 'pending' }, { reviewBatch: 'fail-once' }, { reviewBatch: 'conflict' }])
  assert.deepEqual(page.host, { kind: 'panel', key: 'resource-tree' })
})

test('search viewers bind declared mock policies to public restored tabs and registered module actions', () => {
  const web = PREVIEW_CATALOG.find(page => page.id === 'viewer-web_search')!
  assert.deepEqual(web.host, { kind: 'panel', key: 'resource-tree' })
  assert.equal(web.target?.view, 'resource')
  assert.ok(web.target?.projectId)
  assert.deepEqual(web.scenarios[0].simulation, { webSearch: 'results' })
  const literature = PREVIEW_CATALOG.find(page => page.id === 'viewer-literature_search')!
  assert.equal(literature.target?.view, 'literature')
  assert.deepEqual(literature.scenarios[0].simulation, { literatureSearch: 'results' })
  assert.equal(literature.host, undefined)
  assert.ok([web, literature].every(page => page.entryInstructions?.length))
})

test('close scenarios expose renderer-local success, controlled pending and failed callbacks', () => {
  const page = PREVIEW_CATALOG.find(candidate => candidate.id === 'surface-close')!
  assert.deepEqual(page.host, { kind: 'close' })
  assert.deepEqual(page.scenarios.map(scene => scene.id), ['surface-close-states', 'surface-close-pending', 'surface-close-failed'])
  assert.deepEqual(page.scenarios.map(scene => scene.simulation), [{ close: 'success' }, { close: 'delayed' }, { close: 'fail-once' }])
})

test('sample viewers have stable real document targets while other surfaces remain explicit gaps', () => {
  const samples = new Map([['review', 'readme.md'], ['version_diff', 'readme.md'], ['markdown', 'readme.md'], ['code', 'hello.py'], ['pdf', 'sample.pdf'], ['image', 'sample.png'], ['office', 'sample.docx'], ['spreadsheet', 'measurements.csv'], ['table', 'measurements.tsv'], ['unsupported', 'sample.bin']])
  const fixed = new Map([['viewer-projects', 'projects'], ['viewer-literature', 'literature'], ['surface-project-form', 'home'], ['surface-approval', 'conversation'], ['surface-feedback', 'home'], ['surface-login', 'home']])
  for (const page of PREVIEW_CATALOG.filter(page => page.category === 'viewer' || page.category === 'surface')) {
    const path = samples.get(page.entry)
    if (page.category === 'viewer' && path) {
      assert.equal(page.target?.target?.kind, 'document', page.id)
      if (page.target?.target?.kind === 'document') {
        assert.equal(page.target.target.source.path, path)
        assert.equal(page.target.target.source.kind, 'project')
        assert.equal('project' in page.target.target.source && page.target.target.source.project, page.target.projectId)
      }
    } else if (fixed.has(page.id)) {
      assert.equal(page.target?.view, fixed.get(page.id), page.id)
      assert.equal(page.target?.target, null, page.id)
      assert.ok(page.entryInstructions?.length, page.id)
    } else if (page.host?.kind === 'panel') {
      assert.equal(page.target?.view, 'resource', page.id)
      assert.ok(page.target?.projectId && page.entryInstructions?.length, page.id)
    } else if (page.id === 'viewer-literature_search') {
      assert.equal(page.target?.view, 'literature')
      assert.deepEqual(page.scenarios[0].simulation, { literatureSearch: 'results' })
    } else if (page.host) {
      assert.equal(page.target, null, page.id)
      assert.ok(page.entryInstructions?.length, page.id)
    } else if (page.entryInstructions) {
      assert.equal(page.target?.view, 'resource', page.id)
      assert.equal(page.target?.target, null, page.id)
      assert.ok(page.target?.projectId && page.entryInstructions.length, page.id)
    } else assert.equal(page.target, null, page.id)
  }
})

test('component launch metadata sets only the existing development URL and ordinary launches clear it', () => {
  const components = PREVIEW_CATALOG.find(page => page.id === 'development-components')!
  assert.deepEqual(components.launch, { kind: 'components' })
  assert.deepEqual(components.target, PREVIEW_CATALOG.find(page => page.id === 'page-home')!.target)
  assert.deepEqual(PREVIEW_CATALOG.filter(page => page.launch).map(page => page.id), ['development-components'])
  const original = new URL('http://localhost:4900/?scene=components-states&page=development-components&previewInstance=isolated&other=keep#anchor')
  const opened = previewLaunchUrl(original, components.id)
  assert.equal(original.searchParams.has('dev'), false)
  assert.equal(opened.searchParams.get('dev'), 'components')
  assert.equal(opened.searchParams.get('previewInstance'), 'isolated')
  assert.equal(opened.searchParams.get('other'), 'keep')
  assert.equal(opened.hash, '#anchor')
  for (const page of PREVIEW_CATALOG.filter(candidate => !candidate.launch)) {
    assert.equal(previewLaunchUrl(opened, page.id).searchParams.has('dev'), false, page.id)
  }
  assert.throws(() => previewLaunchUrl(original, 'missing-page'), /Unknown preview page/)
})

test('viewer inventory matches the actual feature contribution object literals', () => {
  const viewers = PREVIEW_CATALOG.filter(page => page.category === 'viewer')
  for (const source of new Set(viewers.map(page => page.source))) {
    const syntax = ts.createSourceFile(source, readFileSync(new URL(`../${source}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const kinds: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === 'viewerPlugins' && ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue
          for (const property of element.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(syntax) === 'kind' && ts.isStringLiteral(property.initializer)) kinds.push(property.initializer.text)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(syntax)
    assert.deepEqual(viewers.filter(page => page.source === source).map(page => page.entry).sort(), kinds.sort(), source)
  }
})
