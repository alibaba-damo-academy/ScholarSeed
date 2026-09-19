import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8')
const preferencesSource = readFileSync(new URL('../../components/business/Preferences.tsx', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('./workspace.ts', import.meta.url), 'utf8')
const railSource = readFileSync(new URL('../../shell/ActivityRail.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../../shell/WorkbenchShell.tsx', import.meta.url), 'utf8')

test('workbench header divider bridges the module splitter independently of the selected view', () => {
  assert.match(shellSource, /className=\{WORKBENCH_SPLIT_CLASS_NAME\}/)
  assert.match(shellSource, /background-image:linear-gradient\(to_bottom,transparent_calc\(var\(--vds-workbench-header-height\)_-_var\(--vds-border-width-1\)\),var\(--vds-border-default\)_0_var\(--vds-workbench-header-height\),transparent_0\)/)
})

test('project home entry stays above project modules and uses existing scope navigation', () => {
  assert.match(railSource, /const items = \[HOME_ACTIVITY_ITEM, \.\.\.contributed\]\s*\.sort/)
  assert.match(railSource, /hasProject \? 'navigation.returnHome' : 'navigation.projects'/)
  assert.match(railSource, /home: <House size=\{MENU_ICON_SIZE\}/)
  assert.match(railSource, /const dividerBefore = homeSpace\s*\? null\s*:\s*\(\s*items\.find/)
  assert.match(railSource, /onClick=\{\(\) => act\.openWorkbenchView\(view\.key, \{ preserveProject: true \}\)\}/)
  assert.doesNotMatch(shellSource, /modulePanelOpen && <ActivityRail/)
  assert.equal(shellSource.match(/<ActivityRail \/>/g)?.length, 3)
  const start = storeSource.indexOf('openWorkbenchView: (view, options)')
  const navigation = storeSource.slice(start, storeSource.indexOf('toggleModulePanel: ()', start))
  assert.match(navigation, /const leavesProjectScope = view === 'home'/)
  assert.match(navigation, /homeSelectedProjectId: null/)
  assert.doesNotMatch(navigation, /requestClose|discard|dispose/)
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
    ['openLiteratureItem: async', 'setLiteratureDetail:']
  ]) {
    const from = storeSource.indexOf(start)
    const to = storeSource.indexOf(end, from)
    assert.ok(from >= 0 && to > from)
    assert.match(storeSource.slice(from, to), /workbenchReturnProjectId: null/)
  }
})
