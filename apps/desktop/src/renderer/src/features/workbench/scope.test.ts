import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../../design/layout.css', import.meta.url), 'utf8')
const literatureSource = readFileSync(new URL('../literature/LiteratureList.tsx', import.meta.url), 'utf8')
const literatureStyles = readFileSync(new URL('../literature/literature.css', import.meta.url), 'utf8')
const preferencesSource = readFileSync(new URL('../../components/business/Preferences.tsx', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('./Workbench.tsx', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('./workspace.ts', import.meta.url), 'utf8')
const railSource = readFileSync(new URL('../../shell/ActivityRail.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../../shell/WorkbenchShell.tsx', import.meta.url), 'utf8')
const topBarSource = readFileSync(new URL('../../shell/TopBar.tsx', import.meta.url), 'utf8')
const resizableSource = readFileSync(new URL('../../components/ui/Resizable.tsx', import.meta.url), 'utf8')
const workbenchSplitSource = shellSource.slice(
  shellSource.indexOf('const WORKBENCH_SPLIT_CLASS_NAME'),
  shellSource.indexOf('function readStoredModulePanelWidth')
)

test('workbench module divider spans the top bar and only bridges marked content toolbars', () => {
  assert.match(shellSource, /className=\{WORKBENCH_SPLIT_CLASS_NAME\}/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-active-guide-color:var\(--vds-border-default\)/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-active-guide-edge-color:var\(--vds-border-default\)/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-current-guide-color:var\(--vds-border-default\)/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-current-guide-edge-color:var\(--vds-border-default\)/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-drag-guide-color:var\(--vds-border-default\)/)
  assert.match(workbenchSplitSource, /--vds-resizable-handle-drag-guide-edge-color:var\(--vds-border-default\)/)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-image:linear-gradient`), true)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-position:right_top]`), true)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-repeat:no-repeat]`), true)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-size:50%_100%]`), true)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:left-1/2`), true)
  assert.equal(shellSource.includes(String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:translate-x-0`), true)
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel--left]:shrink-0`), true)
  assert.match(shellSource, /var\(--vds-workbench-content-toolbar-height\)/)
  assert.doesNotMatch(workbenchSplitSource, /var\(--vds-workbench-header-height\)/)
  assert.match(literatureSource, /<header className="lit-toolbar" data-workbench-divider>/)
  assert.match(literatureStyles, /min-height: var\(--vds-workbench-content-toolbar-height\)/)
  assert.match(layoutSource, /--vds-workbench-content-toolbar-height: 52px;/)
  assert.match(shellSource, /topBarLeftWidth\(modulePanelWidth, modulePanelVisible\)/)
  assert.match(shellSource, /parseModulePanelWidth\(width\)/)
  assert.match(shellSource, /leftWidthStep=\{MODULE_PANEL_WIDTH_STEP\}/)
  assert.match(resizableSource, /Math\.round\(constrainedPixels \/ leftWidthStep\) \* leftWidthStep/)
  assert.match(railSource, /vds-activity-rail[^'\n]*box-border[^'\n]*w-14[^'\n]*flex-none/)
  assert.match(topBarSource, /items-center border-y border-l border-\[var\(--vds-border-default\)\]/)
  assert.match(topBarSource, /after:right-0 after:top-0 after:h-full after:w-px/)
  assert.match(topBarSource, /showRightBorder \? TOPBAR_RIGHT_DIVIDER_CLASS_NAME : ''/)
  assert.doesNotMatch(topBarSource, /showRightBorder \? ' border-r'/)
})

test('module splitter panels preserve the workbench height chain', () => {
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:flex`), true)
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:min-h-0`), true)
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:overflow-hidden`), true)
})

test('project home entry stays above project modules and uses existing scope navigation', () => {
  assert.match(railSource, /const items = \[HOME_ACTIVITY_ITEM, \.\.\.contributed\]\s*\.sort/)
  assert.match(railSource, /hasProject \? 'navigation.returnHome' : 'navigation.projects'/)
  assert.match(railSource, /home: <House size=\{MENU_ICON_SIZE\}/)
  assert.match(railSource, /const dividerBefore = homeSpace\s*\? null\s*:\s*\(\s*items\.find/)
  assert.match(railSource, /onClick=\{\(\) => act\.openWorkbenchView\(view\.key, \{ preserveProject: true \}\)\}/)
  assert.doesNotMatch(shellSource, /modulePanelOpen && <ActivityRail/)
  assert.equal(shellSource.match(/<ActivityRail \/>/g)?.length, 2)
  const start = storeSource.indexOf('openWorkbenchView: (view, options)')
  const navigation = storeSource.slice(start, storeSource.indexOf('toggleModulePanel: ()', start))
  assert.match(navigation, /const leavesProjectScope = view === 'home'/)
  assert.match(navigation, /homeSelectedProjectId: null/)
  assert.doesNotMatch(navigation, /requestClose|discard|dispose/)
})

test('module and docked assistant panels collapse without remounting the workbench', () => {
  assert.match(shellSource, /const modulePanelVisible = state\.modulePanelOpen && !panelBlocked/)
  assert.match(shellSource, /isLeftCollapsed=\{!modulePanelVisible\}/)
  assert.match(shellSource, /isCollapsed=\{!dockedAiPanel\}/)
  assert.equal(shellSource.match(/renderMainWorkbench\(\)/g)?.length, 2)
  assert.equal(shellSource.match(/renderMainSurface\(/g)?.length, 2)
  assert.match(resizableSource, /hidden=\{isLeftCollapsed\}/)
  assert.match(resizableSource, /width: isLeftCollapsed \? '0%'/)
  assert.match(resizableSource, /isLeftCollapsed \? '100%'/)
})

test('renderer selects one real document workspace controller per project without a global facade', () => {
  assert.match(mainSource, /const projectId = state\.homeSelectedProjectId \?\? assistantProject\(state\)\.projectId/)
  assert.match(mainSource, /documentWorkspaces\.forProject\(projectId\)/)
  assert.match(mainSource, /<DocumentWorkspaceContext\.Provider value=\{workspace\}>/)
  assert.match(storeSource, /documentWorkspaces\.forProject\(project\)/)
  assert.match(storeSource, /current\.homeSelectedProjectId === project/)
  assert.match(storeSource, /const projectActiveTab = projectWorkspace\.focusedTabId \?\? OVERVIEW_TAB\.id/)
  assert.doesNotMatch(workspaceSource, /export const documentWorkspace =/)
})

test('personal auto-save setting persists and leaving the document dock saves only the focused session', () => {
  assert.match(preferencesSource, /<Switch[\s\S]*checked=\{state\.autoSave\}/)
  assert.match(preferencesSource, /onCheckedChange=\{act\.setAutoSave\}/)
  assert.match(storeSource, /setAutoSave: \(autoSave\)/)
  assert.match(storeSource, /autoSave: state\.autoSave/)
  assert.match(dockSource, /onBlurCapture=/)
  assert.match(dockSource, /if \(!appState\.autoSave\) return/)
  assert.match(dockSource, /workspace\.saveFocused\(\)/)
  assert.match(workspaceSource, /saveFocused\(\)[\s\S]*return this\.save\(session\.id\)/)
})

test('workbench navigation preserves the assistant inside one project and resets it across project scope', () => {
  const action = storeSource.slice(
    storeSource.indexOf('openWorkbenchView: (view, options)'),
    storeSource.indexOf('toggleModulePanel:', storeSource.indexOf('openWorkbenchView: (view, options)'))
  )
  assert.match(action, /const targetProjectId = leavesProjectScope \? null : current\.homeSelectedProjectId/)
  assert.match(action, /const changesAssistantScope = assistantProject\(current\)\.projectId !== targetProjectId/)
  assert.match(action, /changesAssistantScope \? assistantScopeReset\(current\) : \{\}/)
  assert.doesNotMatch(action, /activeSession: null/)
})

// Bug 86837971: 新建项目后空项目总览的「导入文献」必须保留当前项目作用域，
// 落在本项目「文献库」，而不是清空作用域跳到全局「文献总览」。
test('project overview literature import keeps the selected project scope', () => {
  const button = workbenchSource.slice(
    workbenchSource.indexOf('data-testid="overview-import-literature"'),
    workbenchSource.indexOf('data-testid="overview-import-resource"')
  )
  assert.match(button, /openWorkbenchView\('literature', \{ preserveProject: true \}\)/)
  assert.doesNotMatch(button, /openWorkbenchView\('literature'\)/)
})

test('workbench return project belongs only to an explicitly contextual navigation', () => {
  const action = storeSource.slice(
    storeSource.indexOf('openWorkbenchView: (view, options)'),
    storeSource.indexOf('toggleModulePanel:', storeSource.indexOf('openWorkbenchView: (view, options)'))
  )
  assert.match(action, /workbenchReturnProjectId: options\?\.returnProjectId \?\? null/)
  const reset = storeSource.slice(
    storeSource.indexOf('const SURFACE_RESET:'),
    storeSource.indexOf('const COMPOSER_RESET:')
  )
  assert.match(reset, /workbenchReturnProjectId: null/)
  for (const [start, end] of [
    ['selectProject: (projectId) =>', 'toggleSessionChildren:'],
    ['openLiteratureResult: (result) =>', 'openLiteratureSearch:'],
    ['openLiteratureSearch: (task) =>', 'restoreLiteratureSearches:'],
    ['openLiteratureItem: async', 'markLiteratureFulltext:']
  ]) {
    const from = storeSource.indexOf(start)
    const to = storeSource.indexOf(end, from)
    assert.ok(from >= 0 && to > from)
    assert.match(storeSource.slice(from, to), /workbenchReturnProjectId: null/)
  }
})
