import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { resolveDocumentWorkspaceProject } from './scope.ts'

const dockSource = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../app/root.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../../design/layout.css', import.meta.url), 'utf8')
const literatureSource = readFileSync(
  new URL('../literature/LiteratureList.tsx', import.meta.url),
  'utf8'
)
const preferencesSource = readFileSync(
  new URL('../../components/business/Preferences.tsx', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
const assistantPanelSource = readFileSync(
  new URL('../assistant/AiPanel.tsx', import.meta.url),
  'utf8'
)
const workspaceSource = readFileSync(new URL('./workspace.ts', import.meta.url), 'utf8')
const railSource = readFileSync(new URL('../../shell/ActivityRail.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../../shell/WorkbenchShell.tsx', import.meta.url), 'utf8')
const projectWorkspaceSource = readFileSync(
  new URL('../../shell/Workspace.tsx', import.meta.url),
  'utf8'
)
const topBarSource = readFileSync(new URL('../../shell/TopBar.tsx', import.meta.url), 'utf8')
const resizableSource = readFileSync(
  new URL('../../components/ui/Resizable.tsx', import.meta.url),
  'utf8'
)
const workbenchSplitSource = shellSource.slice(
  shellSource.indexOf('const WORKBENCH_SPLIT_CLASS_NAME'),
  shellSource.indexOf('function readStoredAiPanelWidth')
)

test('project navigation shares the in-memory module width and literature resize limits', () => {
  assert.match(shellSource, /useState\(readStoredModulePanelWidth\)/)
  assert.match(shellSource, /localStorage\.getItem\(MODULE_PANEL_WIDTH_STORAGE_KEY\)/)
  assert.match(shellSource, /raw \? parseModulePanelWidth\(raw\) : MODULE_PANEL_DEFAULT_WIDTH/)
  assert.match(
    shellSource,
    /localStorage\.setItem\(MODULE_PANEL_WIDTH_STORAGE_KEY, String\(nextWidth\)\)/
  )
  assert.match(shellSource, /navigationWidth=\{modulePanelResizeWidth\}/)
  assert.match(shellSource, /onNavigationWidthChange=\{updateModulePanelWidth\}/)
  assert.match(shellSource, /onWidthChangeEnd=\{updateModulePanelWidth\}/)
  assert.match(projectWorkspaceSource, /leftWidth=\{navigationWidth\}/)
  assert.match(projectWorkspaceSource, /minLeftWidth=\{MODULE_PANEL_DEFAULT_WIDTH\}/)
  assert.match(projectWorkspaceSource, /maxLeftWidth=\{MODULE_PANEL_MAX_WIDTH\}/)
  assert.match(projectWorkspaceSource, /leftWidthStep=\{MODULE_PANEL_WIDTH_STEP\}/)
  assert.match(projectWorkspaceSource, /onWidthChangeEnd=\{onNavigationWidthChange\}/)
  assert.doesNotMatch(projectWorkspaceSource, /onWidthChange=\{onNavigationWidthChange\}/)
  assert.doesNotMatch(projectWorkspaceSource, /\[navigationWidth,\s*\w+\]\s*=\s*useState/)
})

test('workbench module divider spans the top bar and only bridges marked content toolbars', () => {
  assert.match(shellSource, /className=\{WORKBENCH_SPLIT_CLASS_NAME\}/)
  assert.match(
    workbenchSplitSource,
    /--vds-resizable-handle-active-guide-color:var\(--vds-divider-default\)/
  )
  assert.match(
    workbenchSplitSource,
    /--vds-resizable-handle-active-guide-edge-color:var\(--vds-divider-default\)/
  )
  assert.match(
    workbenchSplitSource,
    /--vds-resizable-handle-current-guide-color:var\(--vds-divider-default\)/
  )
  assert.match(
    workbenchSplitSource,
    /--vds-resizable-handle-current-guide-edge-color:var\(--vds-divider-default\)/
  )
  assert.doesNotMatch(workbenchSplitSource, /--vds-resizable-handle-drag-guide(?:-edge)?-color:/)
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-image:linear-gradient`
    ),
    true
  )
  assert.match(
    workbenchSplitSource,
    /var\(--vds-border-default\)_0_var\(--vds-workbench-content-toolbar-height\)/
  )
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-position:right_top]`
    ),
    true
  )
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-repeat:no-repeat]`
    ),
    true
  )
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:[background-size:50%_100%]`
    ),
    true
  )
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:left-1/2`
    ),
    true
  )
  assert.equal(
    shellSource.includes(
      String.raw`[&:has([data-workbench-divider])>.vds-resizable-split\_\_handle]:before:translate-x-0`
    ),
    true
  )
  assert.equal(
    shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel--left]:shrink-0`),
    true
  )
  assert.match(shellSource, /var\(--vds-workbench-content-toolbar-height\)/)
  assert.doesNotMatch(workbenchSplitSource, /var\(--vds-workbench-header-height\)/)
  assert.match(
    literatureSource,
    /<header\s+className=\{\s*projectPresentation\s*\? returnProject\s*\? '[^']*'\s*: 'contents'\s*: 'lit-toolbar[^']*'\s*\}\s*data-workbench-divider\s*>/
  )
  const selectionPortalContract =
    /projectPresentation && toolbarTarget \? createPortal\(content, toolbarTarget\) : content/
  assert.match(literatureSource, selectionPortalContract)
  const wrongTarget = literatureSource.replace(
    'createPortal(content, toolbarTarget)',
    'createPortal(content, wrongTarget)'
  )
  assert.notEqual(wrongTarget, literatureSource)
  assert.doesNotMatch(wrongTarget, selectionPortalContract)
  assert.match(
    literatureSource,
    /\{selected\.length > 0 \? \(\s*renderSelection\(\s*<div\s+data-testid="literature-selection-toolbar"/
  )
  assert.match(literatureSource, /min-h-\[var\(--vds-workbench-content-toolbar-height\)\]/)
  assert.match(layoutSource, /--vds-workbench-content-toolbar-height: 52px;/)
  assert.match(
    shellSource,
    /const modulePanelWidthValue = modulePanelVisible\s*\? `calc\(var\(\$\{MODULE_PANEL_WIDTH_PROPERTY\}\) \+ var\(--vds-layout-rail-width\) \+ var\(--vds-resizable-handle-size\) \/ 2 \+ var\(--vds-border-width-1\)\)`\s*:\s*topBarLeftWidth\(modulePanelWidth, false\)/
  )
  assert.match(
    shellSource,
    /style=\{\{ \[MODULE_PANEL_WIDTH_PROPERTY\]: modulePanelResizeWidth \} as React\.CSSProperties\}/
  )
  assert.match(shellSource, /style\.setProperty\(MODULE_PANEL_WIDTH_PROPERTY, width\)/)
  assert.match(shellSource, /parseModulePanelWidth\(width\)/)
  assert.match(shellSource, /leftWidthStep=\{MODULE_PANEL_WIDTH_STEP\}/)
  assert.match(
    resizableSource,
    /Math\.round\(constrainedPixels \/ leftWidthStep\) \* leftWidthStep/
  )
  assert.match(
    railSource,
    /vds-activity-rail[^'\n]*box-border[^'\n]*w-\[var\(--vds-layout-rail-width\)\][^'\n]*flex-none/
  )
  assert.match(
    topBarSource,
    /items-center gap-\[var\(--vds-space-2\)\] border-y border-l border-\[var\(--vds-divider-default\)\]/
  )
  assert.match(
    topBarSource,
    /after:right-0 after:top-0 after:h-full after:w-\[var\(--vds-border-width-1\)\]/
  )
  assert.match(
    topBarSource,
    /showRightBorder && !compactLiteratureHeader \? TOPBAR_RIGHT_DIVIDER_CLASS_NAME : ''/
  )
  assert.doesNotMatch(topBarSource, /showRightBorder \? ' border-r'/)
  assert.match(shellSource, /var\(--vds-border-default\)_0_var\(--vds-workbench-header-height\)/)
  assert.match(
    assistantPanelSource,
    /vds-ai-head[^\n]*border-b border-\[var\(--vds-border-default\)\]/
  )
})

test('module splitter panels preserve the workbench height chain', () => {
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:flex`), true)
  assert.equal(shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:min-h-0`), true)
  assert.equal(
    shellSource.includes(String.raw`[&>.vds-resizable-split\_\_panel]:overflow-hidden`),
    true
  )
})

test('project center stays above global navigation and preserves existing scope transitions', () => {
  assert.match(railSource, /const items = \[HOME_ACTIVITY_ITEM, \.\.\.contributed\]\s*\.sort/)
  assert.match(railSource, /const HOME_SPACE_KEYS = \['home', 'literature', 'skills'\]/)
  assert.match(railSource, /HOME_SPACE_KEYS\.includes\(view\.key\)/)
  assert.match(railSource, /home: <Box size=\{MENU_ICON_SIZE\}/)
  assert.match(
    railSource,
    /view\.key === 'home'\s*\? act\.openProjectCenter\(\)\s*:\s*act\.openWorkbenchView\(view\.key\)/
  )
  assert.doesNotMatch(shellSource, /modulePanelOpen && <ActivityRail/)
  assert.equal(shellSource.match(/<ActivityRail \/>/g)?.length, 3)
  const start = storeSource.indexOf('openWorkbenchView: (view, options)')
  const navigation = storeSource.slice(start, storeSource.indexOf('toggleModulePanel: ()', start))
  assert.match(
    navigation,
    /const leavesProjectScope =\s*view === 'home' \|\|\s*\(\(view === 'skills' \|\| view === 'literature'\) && !options\?\.preserveProject\)/
  )
  assert.match(navigation, /homeSelectedProjectId: null/)
  assert.doesNotMatch(navigation, /requestClose|discard|dispose/)
})

test('module and docked assistant panels collapse without remounting the workbench', () => {
  assert.match(shellSource, /const modulePanelVisible = state\.modulePanelOpen && !panelBlocked/)
  assert.match(shellSource, /isLeftCollapsed=\{!modulePanelVisible\}/)
  assert.match(shellSource, /isCollapsed=\{!dockedAiPanel\}/)
  assert.equal(shellSource.match(/renderMainWorkbench\(\)/g)?.length, 2)
  assert.equal(shellSource.match(/renderMainSurface\(/g)?.length, 2)
  assert.match(resizableSource, /hidden=\{!animateSplit && isLeftCollapsed\}/)
  assert.match(resizableSource, /aria-hidden=\{isLeftCollapsed \|\| undefined\}/)
  assert.match(resizableSource, /element\.inert = isLeftCollapsed/)
  assert.match(resizableSource, /width: isLeftCollapsed\s*\? '0%'/)
  assert.match(resizableSource, /isLeftCollapsed\s*\? '100%'/)
})

test('renderer selects one real document workspace controller per project without a global facade', () => {
  assert.match(mainSource, /const projectId = resolveDocumentWorkspaceProject\(/)
  assert.match(mainSource, /documentWorkspaces\.forProject\(projectId\)/)
  assert.match(mainSource, /<DocumentWorkspaceContext\.Provider value=\{workspace\}>/)
  assert.match(storeSource, /documentWorkspaces\.forProject\(project\)/)
  assert.match(storeSource, /current\.homeSelectedProjectId === project/)
  assert.match(
    storeSource,
    /const projectActiveTab = restoreProjectWorkbenchTab\(\s*projectId,\s*rememberedProjectTabs\.current\.get\(projectId\),\s*current\.tabs,\s*projectWorkspace\s*\)/
  )
  assert.doesNotMatch(workspaceSource, /export const documentWorkspace =/)
})

test('literature attachment opening shares the rendered workspace scope and reports open failures', () => {
  assert.match(mainSource, /resolveDocumentWorkspaceProject\(/)
  const action = storeSource.slice(
    storeSource.indexOf('openLiteratureAttachment: async'),
    storeSource.indexOf(
      'closeLiteratureAttachment:',
      storeSource.indexOf('openLiteratureAttachment: async')
    )
  )
  assert.equal(action.match(/resolveDocumentWorkspaceProject\(/g)?.length, 3)
  assert.doesNotMatch(action, /stateRef\.current\.homeSelectedProjectId !== project/)
  assert.match(action, /catch \(error\)/)
  assert.match(action, /noticeLiterature\('error'/)
  assert.match(action, /console\.error\('\[literature\] attachment open failed'/)
})

test('document workspace scope follows explicit, selected, assistant, then global priority', () => {
  assert.equal(resolveDocumentWorkspaceProject('selected', 'assistant'), 'selected')
  assert.equal(resolveDocumentWorkspaceProject(null, 'assistant'), 'assistant')
  assert.equal(resolveDocumentWorkspaceProject(null, null), null)
  assert.equal(resolveDocumentWorkspaceProject('selected', 'assistant', 'explicit'), 'explicit')
  assert.equal(resolveDocumentWorkspaceProject('selected', 'assistant', null), null)
})

test('personal auto-save setting persists and leaving the document dock saves only the focused session', () => {
  assert.match(preferencesSource, /<Switch[\s\S]*checked=\{state\.autoSave\}/)
  assert.match(preferencesSource, /onCheckedChange=\{act\.setAutoSave\}/)
  assert.match(storeSource, /setAutoSave: \(autoSave\)/)
  assert.match(storeSource, /autoSave: state\.autoSave/)
  assert.match(dockSource, /document\.addEventListener\('focusin', handleOutsideFocus, true\)/)
  assert.match(
    dockSource,
    /document\.addEventListener\('pointerdown', handleOutsidePointer, true\)/
  )
  assert.match(dockSource, /window\.addEventListener\('blur', handleWindowBlur\)/)
  assert.match(dockSource, /host\.contains\(event\.target\)/)
  assert.match(dockSource, /workspace\.saveFocused\(\)/)
  assert.doesNotMatch(dockSource, /onBlurCapture=/)
  assert.match(workspaceSource, /saveFocused\(\)[\s\S]*return this\.save\(session\.id\)/)
})

test('workbench navigation preserves the assistant inside one project and resets it across project scope', () => {
  const action = storeSource.slice(
    storeSource.indexOf('openWorkbenchView: (view, options)'),
    storeSource.indexOf(
      'toggleModulePanel:',
      storeSource.indexOf('openWorkbenchView: (view, options)')
    )
  )
  assert.match(
    action,
    /const targetProjectId = leavesProjectScope \? null : current\.homeSelectedProjectId/
  )
  assert.match(
    action,
    /const changesAssistantScope = assistantProject\(current\)\.projectId !== targetProjectId/
  )
  assert.match(action, /changesAssistantScope \? assistantScopeReset\(current\) : \{\}/)
  assert.doesNotMatch(action, /activeSession: null/)
})

test('project changes reload literature and reject responses from the previous project', () => {
  assert.match(
    storeSource,
    /useEffect\(\(\) => \{\s*void actRef\.current\.reloadLiterature\(\)\s*\}, \[state\.homeSelectedProjectId\]\)/
  )
  assert.match(storeSource, /homeSelectedProjectId !== stateRef\.current\.homeSelectedProjectId/)
  assert.match(
    storeSource,
    /if \(current\.homeSelectedProjectId !== homeSelectedProjectId\) return current/
  )
})

test('workbench return project belongs only to an explicitly contextual navigation', () => {
  const action = storeSource.slice(
    storeSource.indexOf('openWorkbenchView: (view, options)'),
    storeSource.indexOf(
      'toggleModulePanel:',
      storeSource.indexOf('openWorkbenchView: (view, options)')
    )
  )
  assert.match(action, /workbenchReturnProjectId: options\?\.returnProjectId \?\? null/)
  const reset = storeSource.slice(
    storeSource.indexOf('const SURFACE_RESET:'),
    storeSource.indexOf('const COMPOSER_RESET:')
  )
  assert.match(reset, /workbenchReturnProjectId: null/)
  const resultStart = storeSource.indexOf('openLiteratureResult: (result) =>')
  const resultAction = storeSource.slice(
    resultStart,
    storeSource.indexOf('openLiteratureSearch:', resultStart)
  )
  assert.match(resultAction, /projectId \? \{\} : \{ workbenchReturnProjectId: null/)
  for (const [start, end] of [
    ['selectProject: (projectId) =>', 'toggleSessionChildren:'],
    ['openLiteratureSearch: (task) =>', 'restoreLiteratureSearches:'],
    ['openLiteratureItem: async', 'markLiteratureFulltext:'],
  ]) {
    const from = storeSource.indexOf(start)
    const to = storeSource.indexOf(end, from)
    assert.ok(from >= 0 && to > from)
    assert.match(storeSource.slice(from, to), /workbenchReturnProjectId: null/)
  }
})
