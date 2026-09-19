import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createInstance } from 'i18next'
import { officeFailureText } from './failure.ts'

test('native locale loads Chinese resources while retaining an English fallback', async () => {
  const localeContext: Record<string, any> = {}
  runInNewContext(readFileSync(new URL('./locale.js', import.meta.url), 'utf8'), localeContext)
  const locale = localeContext.ScholarSeedOfficeLocale
  assert.equal(locale.resolve(), 'en-US')
  assert.equal(locale.resolve('en-US'), 'en-US')
  assert.equal(locale.resolve('zh-CN'), 'zh-CN')
  assert.equal(locale.resolve('fr-FR'), 'en-US')
  let fetched = false
  localeContext.fetch = () => { fetched = true; throw new Error('English must not fetch the CJK overlay') }
  localeContext.console = { info() {}, error() {} }
  const defaultModule: any = {}
  await locale.prepare(defaultModule, 'https://office.invalid/')
  assert.equal(fetched, false)
  assert.equal(defaultModule.arguments[0], '--language=en-US')
  const writes: string[] = []
  const module: any = {}
  const fs = { mkdirTree() {}, writeFile(name: string) { writes.push(name) } }
  locale.install(module, { files: [{ path: '/instdir/program/resource/zh_CN/LC_MESSAGES/sc.mo', start: 0, end: 2 }] }, new Uint8Array([1, 2]), 'zh-CN', fs)
  assert.equal(module.arguments[0], '--language=zh-CN')
  assert.equal(writes.length, 0)
  module.preRun[0]()
  assert.equal(writes[0], '/instdir/program/resource/zh_CN/LC_MESSAGES/sc.mo')
})

const context: Record<string, any> = {}
runInNewContext(readFileSync(new URL('./policy.js', import.meta.url), 'utf8'), context)
runInNewContext(readFileSync(new URL('./governance.js', import.meta.url), 'utf8'), context)
const policy = context.ScholarSeedOfficePolicy
runInNewContext(readFileSync(new URL('./embedded.js', import.meta.url), 'utf8'), context)

test('native readonly initialization cannot dirty the shared editable document session', () => {
  for (const readonly of [true, false]) {
    const messages: any[] = []
    const source = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')
    runInNewContext(`${source}\nxModel = testModel; zetajs = testZeta; reportModified();`, {
      Module: { zetajs: { then() {} } },
      testModel: { isReadonly: () => readonly, isModified: () => true },
      testZeta: { mainPort: { postMessage: (message: any) => messages.push(message) } }
    })
    assert.equal(messages.length, readonly ? 0 : 1)
  }
})

test('Math editing is native and cannot import, export, or open documents', () => {
  const math = policy.select('math', true)
  for (const command of ['ChangeFont', 'ChangeFontSize', 'CommandWindow', 'ElementsDockingWindow', 'InsertCommandText']) {
    assert.equal(policy.allows(math, `.uno:${command}`), true)
  }
  for (const command of ['ImportFormula', 'SaveFormula', 'ImportMathMLClipboard', 'InsertGraphic', ...policy.LIFECYCLE]) {
    assert.equal(policy.allows(math, `.uno:${command}`), false)
  }
  assert.equal(policy.allows(policy.select('math', false), '.uno:InsertCommandText'), false)
})

test('Writer save deactivates only an active embedded Math object, never changes root ownership', () => {
  const states = { RUNNING: 1, INPLACE_ACTIVE: 2, UI_ACTIVE: 3 }
  const changed: string[] = []
  const objects = [
    { name: 'math', active: states.UI_ACTIVE, math: true },
    { name: 'inactive', active: states.RUNNING, math: true },
    { name: 'chart', active: states.UI_ACTIVE, math: false }
  ]
  const model = { getEmbeddedObjects: () => ({
    getElementNames: () => objects.map(object => object.name),
    getByName: (name: string) => ({ getExtendedControlOverEmbeddedObject: () => {
      const object = objects.find(candidate => candidate.name === name)!
      return {
        getCurrentState: () => object.active,
        getComponent: () => ({ supportsService: () => object.math }),
        changeState: (state: number) => { assert.equal(state, states.RUNNING); changed.push(name) }
      }
    } })
  }) }
  context.ScholarSeedOfficeEmbedded.deactivate({ embed: { EmbedStates: states } }, model)
  assert.deepEqual(changed, ['math'])
})

test('new Math activation is governed after the native event publishes the embedded object', () => {
  const tasks: (() => void)[] = []
  let documentListener: any
  let published = false
  let activated = 0
  let removed = 0
  const root = { addFrameActionListener() {}, removeFrameActionListener() {} }
  const component: any = {
    supportsService: () => true, addModifyListener() {}, removeModifyListener() {},
    getCurrentController: () => ({ getFrame: () => child })
  }
  const child = { getController: () => ({ getModel: () => component }) }
  const object = {
    getCurrentState: () => 4, getComponent: () => component,
    addStateChangeListener() {}, removeStateChangeListener() { removed++ }
  }
  const model = {
    getCurrentController: () => ({ getFrame: () => root }),
    getEmbeddedObjects: () => ({
      getElementNames: () => published ? ['new'] : [],
      getByName: () => ({ getExtendedControlOverEmbeddedObject: () => object })
    }),
    addDocumentEventListener(listener: any) { documentListener = listener }, removeDocumentEventListener() {}
  }
  const desktop = {
    ...root, getFrames: () => ({ queryFrames: () => published ? [child] : [] })
  }
  const sandbox: Record<string, any> = {
    console: { info() {} }, setTimeout: (task: () => void) => { tasks.push(task); return tasks.length }, clearTimeout() {},
    ScholarSeedOfficePolicy: { select: () => ({}) },
    ScholarSeedOfficeGovernance: { prepareEmbedded() {}, install() {
      return Object.assign(() => {}, { activateEmbedded: () => { activated++ } })
    } }
  }
  runInNewContext(readFileSync(new URL('./embedded.js', import.meta.url), 'utf8'), sandbox)
  const release = sandbox.ScholarSeedOfficeEmbedded.observe({
    getUnoComponentContext() {}, sameUnoObject: (a: any, b: any) => a === b,
    unoObject: (_types: any, object: any) => object
  }, {
    frame: { Desktop: { create: () => desktop }, FrameSearchFlag: { ALL: 0 } },
    util: {}, document: {}, embed: { EmbedStates: { RUNNING: 1, INPLACE_ACTIVE: 3, UI_ACTIVE: 4 } }
  }, model, true, () => {}, (error: any) => assert.fail(String(error)))
  documentListener.documentEventOccured()
  published = true
  tasks.shift()!()
  assert.equal(activated, 1)
  published = false
  release.scan()
  assert.equal(removed, 1, 'deleted objects lose their observers')
  release.dispose()
})

function protectedWorkbook() {
  const state = { dirty: false, formula: false, sheetProtected: false, documentProtected: false, locked: true, redo: false, stored: false, undoFails: false }
  const range = {
    getPropertyState: () => 0,
    getPropertyValue: () => ({ IsLocked: true }),
    setPropertyValue: (_name: string, value: { IsLocked: boolean }) => { state.locked = value.IsLocked }
  }
  const sheet = {
    getCellRangeByPosition: () => range,
    getColumns: () => ({ getCount: () => 10 }), getRows: () => ({ getCount: () => 10 }),
    isProtected: () => state.sheetProtected,
    protect: () => { state.sheetProtected = true }, unprotect: () => { state.sheetProtected = false },
    queryContentCells: () => ({ getCount: () => state.formula ? 1 : 0 })
  }
  let undoListener: any
  let historyLocked = false
  const undo = {
    addUndoManagerListener(value: any) { undoListener = value }, removeUndoManagerListener() {},
    getCurrentUndoActionTitle: () => 'test',
    lock() { historyLocked = true }, unlock() { historyLocked = false }, isUndoPossible: () => true,
    undo() { if (!state.undoFails) state.formula = false; else state.dirty = false; state.redo = true },
    redo() { state.dirty = true; state.redo = false }, clearRedo() { state.redo = false }
  }
  const model = {
    getCurrentController: () => ({ getFrame: () => ({ getContainerWindow: () => ({ setEnable() {} }) }) }),
    getSheets: () => ({ getCount: () => 1, getByIndex: () => sheet }), getUndoManager: () => undo,
    isModified: () => state.dirty, setModified: (dirty: boolean) => { state.dirty = dirty },
    isProtected: () => state.documentProtected,
    protect: () => { state.documentProtected = true }, unprotect: () => { state.documentProtected = false },
    addModifyListener() {}, removeModifyListener() {},
    store() {
      assert.equal(historyLocked, false, 'native store may switch the active undo manager and must never run under a history lock')
      assert.equal(state.sheetProtected, false)
      assert.equal(state.documentProtected, false)
      assert.equal(state.locked, true)
      state.stored = true
      state.dirty = false
    }
  }
  const guardContext: Record<string, any> = { crypto: { randomUUID: () => 'test' }, clearTimeout() {}, setTimeout: () => 1 }
  runInNewContext(readFileSync(new URL('./protection.js', import.meta.url), 'utf8'), guardContext)
  const css = { document: { XUndoManagerListener: {} }, util: { CellProtection: function (value: object) { return value }, XModifyListener: {} }, sheet: { CellFlags: { FORMULA: 16 } }, beans: { PropertyState: { AMBIGUOUS_VALUE: 2 } } }
  const guard = guardContext.ScholarSeedOfficeProtection.install({ unoObject: (_types: unknown, value: unknown) => value }, css, model, () => {}, 'cells')
  return { state, guard, undoListener }
}

test('Calc protection restores original metadata for save and reapplies only in memory', () => {
  const { guard, state } = protectedWorkbook()
  assert.equal(state.locked, false)
  assert.equal(state.sheetProtected, true)
  state.dirty = true
  guard.store()
  assert.equal(state.stored, true)
  assert.equal(state.dirty, true, 'only a successful host commit clears dirty')
  assert.equal(state.locked, false)
  assert.equal(state.sheetProtected, true)
  assert.equal(state.documentProtected, true)
})

test('Calc rejects newly entered formulas without losing accepted ordinary edits or retaining redo', () => {
  const { guard, state, undoListener } = protectedWorkbook()
  state.dirty = true
  guard.validate()
  state.formula = true
  guard.validate()
  assert.equal(state.formula, true, 'a modify event alone must not undo the previous edit')
  undoListener.undoActionAdded({ UndoContextDepth: 0 })
  guard.validate()
  assert.equal(state.formula, false)
  assert.equal(state.redo, false)
  assert.equal(state.dirty, true)
  guard.saved()
  state.formula = true
  undoListener.undoActionAdded({ UndoContextDepth: 0 })
  guard.validate()
  assert.equal(state.dirty, false)
})

test('content validation waits for the native undo context to close and cannot save an unfinished transaction', () => {
  const { state, guard, undoListener } = protectedWorkbook()
  undoListener.enteredContext({ UndoContextDepth: 1 })
  state.formula = true
  guard.validate()
  assert.equal(state.formula, true)
  assert.throws(() => guard.store(), { message: 'office_finish_editing' })
  undoListener.leftContext({ UndoContextDepth: 0 })
  guard.validate()
  assert.equal(state.formula, false)
})

test('a mismatched rollback restores accepted edits and latches save failure without repeated undo', () => {
  const { state, guard, undoListener } = protectedWorkbook()
  state.dirty = true
  guard.validate()
  state.formula = true
  state.undoFails = true
  undoListener.undoActionAdded({ UndoContextDepth: 0 })
  assert.throws(() => guard.validate(), { message: 'office_protection_failed' })
  assert.equal(state.dirty, true)
  assert.equal(state.formula, true)
  assert.throws(() => guard.store(), { message: 'office_protection_failed' })
  assert.equal(state.stored, false)
  assert.equal(state.dirty, true)
})

test('Impress rolls back page and object structure but retains existing object content changes', () => {
  const shape = { text: 'original' }
  const shapes = [shape]
  const page = { getCount: () => shapes.length, getByIndex: (index: number) => shapes[index] }
  const pages = [page]
  let dirty = false
  let rollback = () => {}
  let rejected = 0
  let redoCleared = 0
  let undoListener: any
  const model = {
    getDrawPages: () => ({ getCount: () => pages.length, getByIndex: (index: number) => pages[index] }),
    getCurrentController: () => ({ getFrame: () => ({ getContainerWindow: () => ({ setEnable() {} }) }) }),
    getUndoManager: () => ({ addUndoManagerListener(value: any) { undoListener = value }, removeUndoManagerListener() {}, lock() {}, unlock() {}, isUndoPossible: () => true, undo() { rollback() }, clearRedo() { redoCleared += 1 } }),
    isModified: () => dirty, setModified: (value: boolean) => { dirty = value },
    addModifyListener() {}, removeModifyListener() {}
  }
  const guardContext: Record<string, any> = { clearTimeout() {}, setTimeout: () => 1 }
  runInNewContext(readFileSync(new URL('./protection.js', import.meta.url), 'utf8'), guardContext)
  const guard = guardContext.ScholarSeedOfficeProtection.install({
    unoObject: (_types: unknown, value: unknown) => value,
    sameUnoObject: (left: unknown, right: unknown) => left === right
  }, { document: { XUndoManagerListener: {} }, util: { XModifyListener: {} } }, model, () => { rejected += 1 }, 'slides')
  shape.text = 'edited'
  dirty = true
  guard.validate()
  assert.equal(rejected, 0)
  pages.push(page)
  rollback = () => { pages.pop() }
  undoListener.undoActionAdded({ UndoContextDepth: 0 })
  guard.validate()
  shapes.pop()
  rollback = () => { shapes.push(shape) }
  undoListener.undoActionAdded({ UndoContextDepth: 0 })
  guard.validate()
  assert.equal(rejected, 2)
  assert.equal(redoCleared, 2)
  assert.equal(shape.text, 'edited')
  assert.equal(dirty, true)
})

test('readonly layout hides every native menu, toolbar, status bar and sidebar resource', () => {
  for (const kind of ['writer', 'calc', 'impress', 'math']) {
    const selected = policy.select(kind, false)
    assert.deepEqual(Array.from(selected.toolbars), [])
    assert.deepEqual(Array.from(selected.nativeToolbars), [])
    assert.deepEqual(Array.from(selected.menus), [])
    assert.deepEqual(Array.from(selected.resources), [])
    for (const resource of [
      'private:resource/toolbar/standardbar',
      'private:resource/toolbar/formulabar',
      'private:resource/toolbar/textobjectbar',
      'private:resource/statusbar/statusbar',
      'private:resource/menubar/menubar',
      'private:resource/dockingwindow/Sidebar'
    ]) {
      assert.equal(policy.allowsResource(selected, resource), false, `${kind}/${resource}`)
    }
  }
})

test('editable layout still rejects unrelated contextual chrome', () => {
  const selected = policy.select('impress', true)
  for (const resource of ['private:resource/toolbar/slideviewtoolbar', 'private:resource/menubar/menubar', 'private:resource/dockingwindow/Sidebar']) {
    assert.equal(policy.allowsResource(selected, resource), false)
  }
})

test('Impress preview allows governed paging and whole-slide fitting', () => {
  const preview = policy.select('impress', false)
  for (const command of ['PreviousPage', 'NextPage', 'ZoomPage']) {
    assert.equal(policy.allows(preview, `.uno:${command}`), true, command)
  }
  assert.equal(policy.allows(policy.select('writer', false), '.uno:ZoomPage'), false)
  assert.equal(policy.allows(policy.select('calc', false), '.uno:NextPage'), false)
})

test('Calc offers value editing while native protection owns formula and structure constraints', () => {
  const selected = policy.select('calc', true)
  assert.equal(selected.editable, true)
  assert.equal(policy.allows(selected, '.uno:EnterString'), true)
  assert.equal(policy.allows(selected, '.uno:Paste'), true)
  assert.equal(policy.allows(selected, '.uno:Protect'), false)
  assert.deepEqual(Array.from(selected.toolbars), [
    'private:resource/toolbar/standardbar',
    'private:resource/toolbar/formulabar'
  ])
  assert.deepEqual(Array.from(policy.select('calc', false).toolbars), [])
})

test('Writer rich document commands stay module-scoped and disappear in preview mode', () => {
  const editable = policy.select('writer', true)
  const preview = policy.select('writer', false)
  for (const command of ['StyleApply', 'HyperlinkDialog', 'ParagraphDialog', 'OutlineBullet', 'InsertPagebreak', 'PageDialog', 'GraphicDialog', 'InsertGraphic', 'InsertObjectStarMath']) {
    assert.equal(policy.allows(editable, `.uno:${command}`), true)
    assert.equal(policy.allows(preview, `.uno:${command}`), false)
    assert.equal(policy.allows(policy.select('calc', true), `.uno:${command}`), false)
    assert.equal(policy.allows(policy.select('impress', true), `.uno:${command}`), false)
  }
  assert.equal(policy.allowsResource(editable, 'private:resource/menubar/menubar'), true)
  assert.equal(policy.allowsResource(preview, 'private:resource/menubar/menubar'), false)
  assert.equal(preview.contextMenus, false)
  for (const command of policy.LIFECYCLE) {
    assert.equal(policy.allows(editable, `.uno:${command}`), false)
  }
})

test('editable Office modules allow native keyboard navigation and deletion commands', () => {
  for (const kind of ['writer', 'calc', 'impress'] as const) {
    const editable = policy.select(kind, true)
    for (const command of [
      'GoLeft', 'GoRight', 'GoUp', 'GoDown',
      'GoLeftSel', 'GoRightSel', 'GoUpSel', 'GoDownSel',
      'GoLeftBlock', 'GoRightBlock', 'GoUpBlock', 'GoDownBlock',
      'GoToPrevWord', 'GoToNextWord', 'GoToStartOfLine', 'GoToEndOfLine',
      'StartOfLineSel', 'EndOfLineSel', 'StartOfDocumentSel', 'EndOfDocumentSel',
      'PageUpSel', 'PageDownSel',
      'Delete'
    ]) assert.equal(policy.allows(editable, `.uno:${command}`), true, `${kind}/${command}`)
  }
  for (const command of ['SwBackspace', 'DelToStartOfWord', 'DelToEndOfWord', 'DelToStartOfLine', 'DelToEndOfLine']) {
    assert.equal(policy.allows(policy.select('writer', true), `.uno:${command}`), true)
    assert.equal(policy.allows(policy.select('writer', false), `.uno:${command}`), false)
  }
})

test('native search allows find and find-all but cannot execute replacement', () => {
  assert.equal(policy.requiresArgumentCheck('.uno:InputLineEnter'), false)
  assert.equal(policy.requiresArgumentCheck('.uno:ExecuteSearch'), true)
  const selected = policy.select('writer', false)
  for (const action of [0, 1]) {
    assert.equal(policy.allowsDispatch(selected, '.uno:ExecuteSearch', [{ Name: 'SearchItem.Command', Value: action }]), true)
  }
  for (const action of [2, 3, undefined]) {
    assert.equal(policy.allowsDispatch(selected, '.uno:ExecuteSearch', [{ Name: 'SearchItem.Command', Value: action }]), false)
  }
  assert.equal(policy.allowsDispatch(selected, '.uno:ExecuteSearch?SearchItem.Command=2', []), false)
})

function container<T>(values: T[]) {
  return {
    getCount: () => values.length,
    getByIndex: (index: number) => values[index],
    replaceByIndex: (index: number, value: T) => { values[index] = value },
    removeByIndex: (index: number) => { values.splice(index, 1) }
  }
}

function configuration(values: any[][]) {
  const settings: any = container(values)
  settings.$precise = {
    getByIndex(index: number) {
      return { type: 'sequence<PropertyValue>', val: values[index].map(value => ({
        ...value,
        Value: { type: typeof value.Value, val: value.Value }
      })) }
    },
    replaceByIndex(index: number, wrapped: any) {
      values[index] = wrapped.val.map((value: any) => ({
        ...value,
        Value: value.Value?.val ?? value.Value
      }))
    }
  }
  return settings
}

test('Math document menus are filtered without changing read-only module configuration', () => {
  const selected = policy.select('math', true)
  const resources: string[] = []
  const manager = {
    hasSettings: () => true,
    getSettings: () => configuration([
      [{ Name: 'CommandURL', Value: '.uno:InsertCommandText' }],
      [{ Name: 'CommandURL', Value: '.uno:ImportFormula' }],
      [{ Name: 'CommandURL', Value: '.uno:RunMacro' }]
    ]),
    replaceSettings: (resource: string, settings: ReturnType<typeof container>) => {
      resources.push(resource)
      assert.equal(settings.getCount(), 1)
    },
    store: () => assert.fail('must not persist runtime policy')
  }
  context.ScholarSeedOfficeGovernance.prepareEmbedded({
    getUnoComponentContext: () => ({ getValueByName: () => ({ getUIConfigurationManager: () => manager }) })
  }, { getUIConfigurationManager: () => manager }, selected)
  assert.deepEqual(resources, [...selected.menus, ...selected.toolbars])
})

test('native configuration filtering removes file actions from nested UNO containers', () => {
  const nested = container([[{ Name: 'CommandURL', Value: '.uno:Print' }]])
  const values = [
    [{ Name: 'CommandURL', Value: '.uno:Copy' }],
    [{ Name: 'CommandURL', Value: '.uno:Save' }],
    [{ Name: 'ItemDescriptorContainer', Value: nested }]
  ]
  context.ScholarSeedOfficeGovernance.trimSettings(container(values), policy.select('writer', false))
  assert.equal(values.length, 1)
  assert.equal(values[0][0].Value, '.uno:Copy')
})

test('Writer native menu retains nested editing entries without restoring file operations', () => {
  const editItems = [[{ Name: 'CommandURL', Value: '.uno:ParagraphDialog' }], [{ Name: 'CommandURL', Value: '.uno:SaveAs' }]]
  const fileItems = [[{ Name: 'CommandURL', Value: '.uno:Open' }]]
  const values = [
    [{ Name: 'CommandURL', Value: '.uno:FormatMenu' }, { Name: 'ItemDescriptorContainer', Value: container(editItems) }],
    [{ Name: 'CommandURL', Value: '.uno:PickList' }, { Name: 'ItemDescriptorContainer', Value: container(fileItems) }]
  ]
  context.ScholarSeedOfficeGovernance.trimSettings(container(values), policy.select('writer', true))
  assert.equal(values.length, 2, 'empty File anchor is required by native embedded menu merging')
  assert.equal(editItems.length, 1)
  assert.equal(editItems[0][0].Value, '.uno:ParagraphDialog')
  assert.equal(fileItems.length, 0)
})

test('the complete menubar hierarchy is fixed in English while other native resources remain localized', () => {
  const zetajs = {
    Any: class { constructor(public type: unknown, public val: unknown) {} }
  }
  const nestedValues = [[{ Name: 'CommandURL', Value: '.uno:ParagraphDialog' }, { Name: 'Label', Value: '段落' }]]
  const values = [
    [{ Name: 'CommandURL', Value: '.uno:PickList' }, { Name: 'Label', Value: '文件' }, { Name: 'ItemDescriptorContainer', Value: configuration([]) }],
    [{ Name: 'CommandURL', Value: '.uno:EditMenu' }, { Name: 'Label', Value: '编辑' }, { Name: 'ItemDescriptorContainer', Value: configuration(nestedValues) }],
    [{ Name: 'CommandURL', Value: '.uno:TableMenu' }, { Name: 'Label', Value: '表格' }]
  ]

  const settings = configuration(values)
  context.ScholarSeedOfficeGovernance.labelMenubar(zetajs, settings)

  assert.equal(values[0][1].Value, 'File')
  assert.equal(values[1][1].Value, 'Edit')
  assert.equal(nestedValues[0][1].Value, 'Paragraph Dialog')
  assert.equal(values[2][1].Value, 'Table')
})

test('every Office policy denies lifecycle commands, protocols and unknown commands', () => {
  for (const kind of ['calc', 'writer', 'impress', 'math']) {
    for (const editable of [true, false]) {
      const selected = policy.select(kind, editable)
      for (const command of ['Save', 'SaveAs', 'Open', 'NewDoc', 'Print', 'ExportToPDF', 'CloseDoc', 'SetDocumentProperties', 'SendMail', 'UnknownCommand']) {
        assert.equal(policy.allows(selected, `.uno:${command}`), false, `${kind}/${editable}/${command}`)
      }
      assert.equal(policy.allows(selected, 'slot:5500'), false)
      assert.equal(policy.allows(selected, 'private:factory/swriter'), false)
      assert.equal(policy.allows(selected, '.uno:Copy'), true)
      assert.equal(policy.allows(selected, '.uno:Save?Silent:bool=true'), false)
    }
  }
})

test('read-only profiles exclude mutation and editable profiles are module-specific', () => {
  for (const kind of ['calc', 'writer', 'impress', 'math']) {
    const selected = policy.select(kind, false)
    for (const command of ['Paste', 'Cut', 'Undo', 'Redo', 'Bold', 'InsertText']) {
      assert.equal(policy.allows(selected, `.uno:${command}`), false)
    }
  }
  assert.equal(policy.allows(policy.select('writer', true), '.uno:Bold'), true)
  assert.equal(policy.allows(policy.select('calc', true), '.uno:Bold'), false)
  for (const command of ['AutoSum', 'InsertRows', 'Remove', 'InsertTable', 'RenameTable', 'FunctionDialog']) {
    assert.equal(policy.allows(policy.select('calc', true), `.uno:${command}`), false)
  }
  for (const command of ['InsertPage', 'DeletePage', 'DuplicatePage', 'MovePageDown', 'SlideChangeWindow', 'MasterPage']) {
    assert.equal(policy.allows(policy.select('impress', true), `.uno:${command}`), false)
  }
  assert.throws(() => policy.select('unknown', true), /Unsupported Office module/)
})

test('resource filtering removes forbidden nested entries and empty containers', () => {
  const items = [
    { command: '.uno:Copy' },
    { command: '.uno:Save' },
    { command: '.uno:UnknownMenu', children: [{ command: '.uno:Print' }] },
    { command: '.uno:UnknownMenu', children: [{ command: '.uno:Copy' }, { command: '.uno:Cut' }] }
  ]
  const result = policy.filterItems(policy.select('writer', false), items)
  assert.equal(result.length, 2)
  assert.equal(result[1].children.length, 1)
  assert.equal(result[1].children[0].command, '.uno:Copy')
  assert.equal(items.length, 4)
})


test('Office errors resolve stable codes in the current language and retain unknown diagnostics', async () => {
  const i18n = createInstance()
  const resources = Object.fromEntries(['zh', 'en'].map(language => [language, {
    workbench: JSON.parse(readFileSync(new URL(`../../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8'))
  }]))
  await i18n.init({ lng: 'zh', resources, defaultNS: 'workbench', interpolation: { escapeValue: false } })
  assert.equal(officeFailureText('Error: office_fonts_unreadable', i18n.getFixedT(null, 'workbench')), resources.zh.workbench.officeFrame.fontsEmpty)
  const code = 'office_finish_editing'
  assert.equal(officeFailureText(code, i18n.getFixedT(null, 'workbench')), '请先结束当前编辑，再保存文件。')
  await i18n.changeLanguage('en')
  assert.equal(officeFailureText('Error: office_fonts_unreadable', i18n.getFixedT(null, 'workbench')), 'No usable system fonts were found')
  assert.equal(officeFailureText(code, i18n.getFixedT(null, 'workbench')), 'Finish the current edit before saving the file.')
  assert.equal(officeFailureText(`Error: ${code}`, i18n.getFixedT(null, 'workbench')), 'Finish the current edit before saving the file.')
  assert.equal(officeFailureText('native diagnostic: failed at item 42', i18n.getFixedT(null, 'workbench')), 'Office operation failed: native diagnostic: failed at item 42')
  assert.equal(officeFailureText('__proto__', i18n.getFixedT(null, 'workbench')), 'Office operation failed: __proto__')
})


test('Office replacement undo labels use the actual frame locale while retaining the native undo boundary', () => {
  const frame = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')
  assert.match(frame, /undoPolish: t\('officeDocument\.undoPolish'\)/)
  assert.match(frame, /undoLabel:config\.text\.undoPolish/)
  assert.match(worker, /undo\.enterUndoContext\(undoLabel\)/)
  assert.match(worker, /try \{ current\.writerRange\.setString\(replacement\) \}\s*finally \{ undo\.leaveUndoContext\(\) \}/)
  assert.match(worker, /event\.data\.replacement, event\.data\.undoLabel\)/)
  const labels = ['zh', 'en'].map(language => JSON.parse(readFileSync(new URL(`../../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).officeDocument.undoPolish)
  assert.deepEqual(labels, ['AI 润色', 'AI polish'])
})

test('Office image insertion uses the frame language and closes its undo transaction on success and failure', () => {
  const frame = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('./office-thread.js', import.meta.url), 'utf8')
  assert.match(frame, /undoInsertImage: t\('officeDocument\.undoInsertImage'\)/)
  assert.match(frame, /cmd:'image_result'[^\n]+undoLabel:config\.text\.undoInsertImage/)
  for (const language of ['zh', 'en']) {
    const undoLabel = JSON.parse(readFileSync(new URL(`../../../../../localization/locales/${language}/workbench.json`, import.meta.url), 'utf8')).officeDocument.undoInsertImage
    assert.equal(undoLabel, language === 'zh' ? '插入图片' : 'Insert image')
    for (const fails of [false, true]) {
      const calls: unknown[] = []
      const messages: any[] = []
      const cursor = {
        getPropertyValue() { return 'Standard' },
        getText() { return { insertTextContent() { calls.push('insert'); if (fails) throw new Error('native insertion failed') } } }
      }
      const page = { getPropertyValue(name: string) { return name === 'Width' ? 1000 : 0 } }
      const model = {
        getCurrentController() { return {
          getViewCursor() { return cursor },
          getFrame() { return { getContainerWindow() { return { setEnable() {} } } } }
        } },
        getStyleFamilies() { return { getByName() { return { getByName() { return page } } } } },
        createInstance() { return { setPropertyValue() {} } },
        getUndoManager() { return {
          enterUndoContext(label: string) { calls.push(['enter', label]) },
          leaveUndoContext() { calls.push('leave') }
        } },
        isReadonly() { return false },
        isModified() { return true }
      }
      runInNewContext(`${worker}\nxModel = testModel; zetajs = testZeta; css = testCss; pendingImage = { requestId: '1' }; receiveImage(testMessage);`, {
        Module: { zetajs: { then() {} } },
        console: { info() {}, error() {} },
        testModel: model,
        testMessage: { requestId: '1', status: 'image', undoLabel },
        testZeta: { getUnoComponentContext() {}, mainPort: { postMessage(message: any) { messages.push(message) } } },
        testCss: {
          graphic: { GraphicProvider: { create() { return { queryGraphic() { return { getPropertyValue() { return { Width: 10, Height: 20 } } } } } } } },
          beans: { PropertyValue: class {} },
          text: { TextContentAnchorType: { AS_CHARACTER: 1 } }
        }
      })
      assert.equal(calls.length, 3)
      assert.deepEqual(Array.from(calls[0] as string[]), ['enter', undoLabel])
      assert.deepEqual(calls.slice(1), ['insert', 'leave'])
      assert.equal(messages.some(message => message.cmd === 'modified'), !fails)
      assert.equal(messages.some(message => message.cmd === 'image_failed'), fails)
    }
  }
})
