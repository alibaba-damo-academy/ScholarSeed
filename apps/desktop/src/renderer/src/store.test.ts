import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block } from '../../test-helpers/source-contract.ts'

import { StoreContext } from './storeContext.ts'

/**
 * store.tsx 是 JSX，`node --experimental-transform-types` 只剥类型不转 JSX，运行时
 * import 它会以 `Unknown file extension ".tsx"` 失败；仓库既有做法（resources.test.ts、
 * features/workbench/scope.test.ts、contracts/tasks.test.ts）是把 .tsx 当契约文本钉住。
 * 所以这里分两段：
 * - storeContext.ts 能被真实 import，它的行为用真断言（context 默认值、Provider 可用性）；
 * - store.tsx 的初值、reducer 与 selector 不变量用源码契约钉住，改一处就要同时改断言。
 */
const storeSource = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')

const initialBlock = block(storeSource, 'const INITIAL: AppState = {', 'const MENU_KEYS')
const menuKeysBlock = block(storeSource, 'const MENU_KEYS', 'const SURFACE_RESET')
const selectorBlock = block(storeSource, 'export const activeThread', 'function currentLiteratureContextCandidate')
const storeInterface = block(storeSource, 'export interface Store {', 'function PreferenceFailure')

test('the store context is a real React context whose default value is null', () => {
  const context = StoreContext as unknown as {
    $$typeof: symbol
    _currentValue: unknown
    Provider: unknown
    Consumer: unknown
  }
  assert.equal(context.$$typeof, Symbol.for('react.context'))
  // 默认值必须是 null：useApp 才能在 provider 之外显式抛错，而不是把 undefined 当 state 用。
  assert.equal(context._currentValue, null)
  assert.ok(context.Provider)
  assert.ok(context.Consumer)
})

test('the context lives in its own module so store.tsx stays a single Fast Refresh boundary', () => {
  assert.match(storeSource, /import \{ StoreContext \} from '\.\/storeContext'/)
  // store.tsx 里再建一个 context，就会让 provider 与 consumer 分属两个实例（见 storeContext.ts 注释）。
  assert.doesNotMatch(storeSource, /createContext/)
  assert.match(storeSource, /<StoreContext\.Provider value=\{value\}>\{children\}<\/StoreContext\.Provider>/)
  assert.match(storeSource, /const value = useContext\(StoreContext\)/)
  assert.match(storeSource, /if \(!value\) throw new Error\('useApp outside StoreProvider'\)/)
})

test('the store surface handed to consumers is exactly state plus the five entry points', () => {
  for (const member of [
    'state: AppState',
    'set: (patch: Patch) => void',
    'closeMenus: () => void',
    'act: Actions',
    'patchThread:',
    'appendThread:'
  ]) {
    assert.match(storeInterface, new RegExp(member.replace(/[()]/g, '\\$&')))
  }
  assert.match(
    storeSource,
    /const value = useMemo\(\s*\(\) => \(\{ state, set, closeMenus, act, patchThread, appendThread \}\),\s*\[state, set, closeMenus, act, patchThread, appendThread\]\s*\)/
  )
})

test('initial state starts on the home space with no project, session or backend', () => {
  assert.match(initialBlock, /mainView: 'home'/)
  assert.match(initialBlock, /homeSelectedProjectId: null/)
  assert.match(initialBlock, /workspacePath: null/)
  assert.match(initialBlock, /defaultWorkspacePath: null/)
  assert.match(initialBlock, /projects: \[\]/)
  assert.match(initialBlock, /activeSession: null/)
  assert.match(initialBlock, /threads: \{\}/)
  assert.match(initialBlock, /sessions: \[\]/)
  assert.match(initialBlock, /turnLaunch: null/)
  assert.match(initialBlock, /backendReady: false/)
  assert.match(initialBlock, /workspaceLoadState: 'loading'/)
  assert.match(initialBlock, /serviceInstanceId: null/)
  assert.match(initialBlock, /runtimeReadiness: null/)
  assert.match(initialBlock, /runtimeCapabilities: null/)
  assert.match(initialBlock, /foregroundError: null/)
  assert.match(initialBlock, /foregroundNotice: null/)
})

test('initial state starts with an empty composer, the overview tab and closed overlays', () => {
  assert.match(initialBlock, /composerText: ''/)
  assert.match(initialBlock, /composerTaskType: ''/)
  assert.match(initialBlock, /composerRefs: \[\]/)
  assert.match(initialBlock, /tabs: \[OVERVIEW_TAB\]/)
  assert.match(initialBlock, /activeTab: OVERVIEW_TAB\.id/)
  assert.match(initialBlock, /globalSearchOpen: false/)
  assert.match(initialBlock, /globalSearchMode: 'all'/)
  assert.match(initialBlock, /recallOpen: false/)
  assert.match(initialBlock, /loginOpen: false/)
  assert.match(initialBlock, /feedbackOpen: false/)
  assert.match(initialBlock, /accountMenuOpen: false/)
  assert.match(initialBlock, /accountSettingsPage: null/)
  assert.match(initialBlock, /skillUploadOpen: false/)
  assert.match(initialBlock, /workspaceFilesOpen: false/)
  assert.match(initialBlock, /confirmDelete: null/)
  assert.match(initialBlock, /projectForm: null/)
  // 模块面板是唯一默认展开的常驻面板；PDF 侧栏默认收起。
  assert.match(initialBlock, /modulePanelOpen: true/)
  assert.match(initialBlock, /pdfSidePanelOpen: false/)
})

test('permission, collaboration and usage defaults fail closed at zero', () => {
  assert.match(initialBlock, /collaborationMode: 'default'/)
  assert.match(initialBlock, /globalPermissionMode: 'ask'/)
  assert.match(initialBlock, /judgment: 'pending'/)
  assert.match(initialBlock, /usage: EMPTY_USAGE/)
  assert.match(initialBlock, /catalog: EMPTY_CATALOG/)
  assert.match(initialBlock, /resource: INITIAL_RESOURCE_STATE/)
  assert.match(initialBlock, /literature: INITIAL_LITERATURE_STATE/)
  assert.match(initialBlock, /aiPanel: INITIAL_AI_PANEL_STATE/)

  const usage = block(storeSource, 'const EMPTY_USAGE: UsageTotals = {', 'function collectionError')
  const totals = [...usage.matchAll(/(\w+): ([0-9]+)/g)].map(([, field, value]) => [field, Number(value)])
  assert.ok(totals.length >= 4, 'usage totals lost fields')
  for (const [, value] of totals) assert.equal(value, 0)

  const catalog = block(storeSource, 'const EMPTY_CATALOG: ModelCatalog = {', 'const EMPTY_USAGE')
  assert.match(catalog, /models: \[\]/)
  assert.match(catalog, /hiddenModels: \[\]/)
  assert.match(catalog, /subscriptionGroups: \[\]/)
  assert.match(catalog, /personalProfiles: null/)

  const homeThread = block(storeSource, 'const HOME_THREAD: Thread = {', 'const EMPTY_CATALOG')
  assert.match(homeThread, /id: 'home'/)
  assert.match(homeThread, /conversation: \[\]/)
  assert.match(homeThread, /sessionId: null/)
  assert.match(homeThread, /lastSeq: 0/)
})

test('persisted UX state is rehydrated from the host bridge instead of being hardcoded', () => {
  assert.match(
    storeSource,
    /const INITIAL_PREFERENCES = window\.scholarseed\?\.preferences \?\? DEFAULT_RENDERER_PREFERENCES/
  )
  assert.match(storeSource, /setActiveShortcutOverrides\(INITIAL_PREFERENCES\.shortcutOverrides\)/)
  for (const field of [
    'theme: INITIAL_PREFERENCES.theme',
    'lang: INITIAL_PREFERENCES.language',
    'sidebarOpen: INITIAL_PREFERENCES.sidebarOpen',
    'shortcutOverrides: INITIAL_PREFERENCES.shortcutOverrides',
    'dataSharingMode: INITIAL_PREFERENCES.dataSharingMode',
    'desktopNotifications: INITIAL_PREFERENCES.desktopNotifications',
    'soundAlerts: INITIAL_PREFERENCES.soundAlerts',
    'autoSave: INITIAL_PREFERENCES.autoSave',
    'formatOnSave: INITIAL_PREFERENCES.formatOnSave',
    'editorWordWrap: INITIAL_PREFERENCES.editorWordWrap',
    'recentFiles: INITIAL_PREFERENCES.recentFiles',
    'recentLiterature: INITIAL_PREFERENCES.recentLiterature',
    'recentSessions: INITIAL_PREFERENCES.recentSessions',
    'sessionActivityInitialized: INITIAL_PREFERENCES.sessionActivityInitialized',
    'sessionActivitySeen: INITIAL_PREFERENCES.sessionActivitySeen'
  ]) {
    assert.match(initialBlock, new RegExp(field.replace(/[.?]/g, '\\$&')))
  }
  // 落库前还要过一遍归一：偏好文件可能是旧版本或被人手改过。
  assert.match(initialBlock, /onboarding: sanitizeOnboarding\(INITIAL_PREFERENCES\.onboarding\)/)
  assert.match(initialBlock, /selectionPrompts: sanitizeSelectionPrompts\(INITIAL_PREFERENCES\.selectionPrompts\)/)
  assert.match(initialBlock, /reasoningPreferences: INITIAL_PREFERENCES\.reasoningPreferences \?\? \{\}/)
  assert.doesNotMatch(initialBlock, /theme: '/)
  assert.doesNotMatch(initialBlock, /lang: '/)
})

test('every transient menu flag starts closed and closeMenus clears exactly that list', () => {
  const menuKeys = [...menuKeysBlock.matchAll(/'([A-Za-z]+)'/g)].map(([, key]) => key)
  assert.deepEqual(menuKeys, [
    'newChooser',
    'modelMenuOpen',
    'wdMenuOpen',
    'notifPanelOpen',
    'accountMenuOpen',
    'homeProjectMenuOpen',
    'searchHint'
  ])
  for (const key of menuKeys) {
    assert.match(initialBlock, new RegExp(`${key}: false`), `${key} must start closed`)
  }
  const closeMenus = block(storeSource, 'const closeMenus = useCallback', 'const showAnswerAnnotationMutationFailure')
  assert.match(closeMenus, /const next = \{ \.\.\.current \}/)
  assert.match(closeMenus, /for \(const key of MENU_KEYS\) \(next as Record<string, unknown>\)\[key\] = false/)
  assert.match(closeMenus, /return next/)
  // 常驻面板不属于「菜单」：closeMenus 不能顺手把模块面板也收起。
  assert.doesNotMatch(closeMenus, /modulePanelOpen/)
})

test('set merges an object patch or a functional patch computed from the current state', () => {
  assert.match(storeSource, /type Patch = Partial<AppState> \| \(\(state: AppState\) => Partial<AppState>\)/)
  assert.match(
    storeSource,
    /const set = useCallback\(\(patch: Patch\) => \{\s*setState\(\(current\) => \(\{\s*\.\.\.current,\s*\.\.\.\(typeof patch === 'function' \? patch\(current\) : patch\)\s*\}\)\)\s*\}, \[\]\)/
  )
})

test('patchThread is a no-op for a missing id or unknown thread and never invents one', () => {
  const patchThread = block(storeSource, 'const patchThread = useCallback', 'const appendThread = useCallback')
  assert.match(patchThread, /if \(!id\) return current/)
  assert.match(patchThread, /const thread = current\.threads\[id\]\s*if \(!thread\) return current/)
  assert.match(patchThread, /const delta = typeof patch === 'function' \? patch\(thread\) : patch/)
  assert.match(patchThread, /const nextThread = \{ \.\.\.thread, \.\.\.delta \}/)
  assert.match(patchThread, /threads: \{ \.\.\.current\.threads, \[id\]: nextThread \}/)
})

test('thread status changes project onto the session tree only when status or running moved', () => {
  const patchThread = block(storeSource, 'const patchThread = useCallback', 'const appendThread = useCallback')
  assert.match(patchThread, /findSessionNode\(current\.sessions, thread\.sessionId \?\? id\)/)
  assert.match(patchThread, /let sessions = current\.sessions/)
  assert.match(patchThread, /if \(node && \('status' in delta \|\| 'running' in delta\)\)/)
  assert.match(patchThread, /if \(nextThread\.status === 'waiting'\) status = 'waiting'/)
  assert.match(patchThread, /else if \(nextThread\.running === true \|\| nextThread\.status === 'running'\) status = 'running'/)
  // 收尾态要区分「用户正在看的会话」：当前会话回 dormant，其它会话才是 done。
  assert.match(patchThread, /status = current\.activeSession === id \? 'dormant' : 'done'/)
  assert.match(patchThread, /sessions = upsertSessionNode\(sessions, \{ \.\.\.node, status \}\)/)
})

test('appendThread appends to an existing thread conversation without mutating it', () => {
  const appendThread = block(storeSource, 'const appendThread = useCallback', 'const persistAssistantContext')
  assert.match(appendThread, /if \(!id\) return current/)
  assert.match(appendThread, /const thread = current\.threads\[id\]\s*if \(!thread\) return current/)
  assert.match(appendThread, /conversation: \[\.\.\.thread\.conversation, item\]/)
})

test('reset bundles compose so returning home cannot keep a stale composer or surface', () => {
  const surfaceReset = block(storeSource, 'const SURFACE_RESET: Partial<AppState> = {', 'const COMPOSER_RESET')
  assert.match(surfaceReset, /workbenchReturnProjectId: null/)
  assert.match(surfaceReset, /foregroundError: null/)
  assert.match(surfaceReset, /capGallery: null/)
  assert.match(surfaceReset, /skillUploadOpen: false/)
  assert.match(surfaceReset, /workspaceFilesOpen: false/)
  assert.match(surfaceReset, /workspaceFilesSessionId: null/)
  assert.match(surfaceReset, /sessionRename: null/)

  const composerReset = block(storeSource, 'const COMPOSER_RESET: Partial<AppState> = {', 'function assistantScopeReset')
  assert.match(composerReset, /composerText: ''/)
  assert.match(composerReset, /composerTaskType: ''/)
  assert.match(composerReset, /composerRefs: \[\]/)

  const homeReset = block(storeSource, 'const HOME_RESET: Partial<AppState> = {', 'const SESSION_META')
  assert.match(homeReset, /\.\.\.SURFACE_RESET/)
  assert.match(homeReset, /\.\.\.COMPOSER_RESET/)
  assert.match(homeReset, /mainView: 'home'/)
  assert.match(homeReset, /activeSession: null/)
  assert.match(homeReset, /turnLaunch: null/)
  assert.match(homeReset, /homeSelectedProjectId: null/)
  assert.match(homeReset, /homeProjectLocked: false/)
  assert.match(homeReset, /confirmDelete: null/)
  assert.match(homeReset, /searchHint: false/)

  // 换助手作用域时清空会话与草稿，但保留面板的展开/停靠/遮罩与已注册的来源列表。
  const assistantReset = block(storeSource, 'function assistantScopeReset', 'const HOME_RESET')
  assert.match(assistantReset, /\.\.\.COMPOSER_RESET/)
  assert.match(assistantReset, /activeSession: null/)
  assert.match(assistantReset, /turnLaunch: null/)
  assert.match(assistantReset, /\.\.\.INITIAL_AI_PANEL_STATE/)
  for (const preserved of ['open', 'docked', 'cover', 'contextSources']) {
    assert.match(assistantReset, new RegExp(`${preserved}: current\\.aiPanel\\.${preserved}`))
  }
})

test('selectors return the home fallback and null scopes instead of undefined', () => {
  assert.match(
    selectorBlock,
    /export const activeThread = \(state: AppState\): Thread => \(\s*state\.activeSession \? state\.threads\[state\.activeSession\] : undefined\s*\) \?\? HOME_THREAD/
  )
  assert.match(
    selectorBlock,
    /export const selectedProject = \(state: AppState\): Project \| null => \(\s*state\.homeSelectedProjectId\s*\? state\.projects\.find\(\(project\) => project\.id === state\.homeSelectedProjectId\) \?\? null\s*: null\s*\)/
  )
  assert.match(selectorBlock, /export const selectedProjectPath = \(state: AppState\): string \| null =>\s*selectedProject\(state\)\?\.path \?\? null/)
  // 草稿项目解析必须继续走 assistant 域的同一份口径，不能在 store 里另算一遍。
  assert.match(
    selectorBlock,
    /export const assistantProject = \(state: AppState\) => resolveAssistantProject\(\s*state\.activeSession, activeThread\(state\)\.projectPath, state\.homeSelectedProjectId, state\.projects\s*\)/
  )
  // 项目范围有两个来源：已选项目，或用 SCHOLARSEED_DEFAULT_WORKSPACE 直接打开的目录。
  assert.match(
    selectorBlock,
    /export const hasProjectScope = \(state: AppState\): boolean =>\s*Boolean\(selectedProject\(state\) \|\| state\.resource\.root\)/
  )
})
