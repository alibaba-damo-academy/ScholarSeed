/* SPDX-License-Identifier: MIT */
'use strict';

// Loaded unchanged in the UNO worker and contract tests. IDs are native LibreOffice IDs.
globalThis.ScholarSeedOfficePolicy = (() => {
  const TOOLBAR_PREFIX = 'private:resource/toolbar/'
  const UNO_PREFIX = '.uno:'
  const STATUSBAR = 'private:resource/statusbar/statusbar'
  const MENUBAR = 'private:resource/menubar/menubar'
  // SID_SMA_START (30256) + SID_CMDBOXWINDOW (122) / SID_ELEMENTSDOCKINGWINDOW (126).
  const MATH_WINDOWS = ['private:resource/dockingwindow/30378', 'private:resource/dockingwindow/30382']
  const SEARCH_COMMAND = 'ExecuteSearch'
  const SEARCH_ACTION_PROPERTY = 'SearchItem.Command'
  const SEARCH_READ_ACTIONS = Object.freeze([0, 1]) // SvxSearchCmd::FIND / FIND_ALL
  const NAVIGATION = Object.freeze([
    'GoLeft', 'GoRight', 'GoUp', 'GoDown',
    'GoLeftSel', 'GoRightSel', 'GoUpSel', 'GoDownSel',
    'GoLeftBlock', 'GoRightBlock', 'GoUpBlock', 'GoDownBlock',
    'GoLeftBlockSel', 'GoRightBlockSel', 'GoUpBlockSel', 'GoDownBlockSel',
    'GoToPrevWord', 'GoToNextWord', 'GoToStartOfLine', 'GoToEndOfLine',
    'StartOfLineSel', 'EndOfLineSel', 'StartOfDocumentSel', 'EndOfDocumentSel',
    'PageUpSel', 'PageDownSel'
  ])
  const LIFECYCLE = Object.freeze([
    'NewDoc', 'NewWindow', 'Open', 'OpenFromWriter', 'OpenRemote', 'RecentFileList',
    'Save', 'SaveAll', 'SaveAs', 'SaveAsRemote', 'SaveACopy', 'SaveTo', 'SaveAsTemplate',
    'Export', 'ExportTo', 'ExportToPDF', 'ExportDirectToPDF', 'ExportToEPUB',
    'Print', 'PrintDefault', 'PrintPreview', 'CloseDoc', 'CloseWin', 'Quit',
    'SendMail', 'SendMailDocAsPDF', 'SendMailDocAsMS', 'SendMailDocAsOOo',
    'SetDocumentProperties', 'DocumentProperties', 'Properties', 'Import',
    'Signature', 'MacroDialog', 'RunMacro', 'EditDoc', 'ConfigureDialog',
    'ToolbarMode', 'ToolbarMenu', 'OptionsTreeDialog'
  ])
  const VIEW = Object.freeze([
    'Copy', 'SelectAll', 'Findbar', 'FindText', 'FindNext', 'FindPrevious',
    'ExitSearch', 'UpSearch', 'DownSearch', 'FindAll', 'MatchCase', 'SearchLabel', SEARCH_COMMAND,
    'Zoom', 'ZoomIn', 'ZoomOut', 'ZoomSlider', 'Zoom100Percent', 'FullScreen',
    'StatusBarVisible', 'PageUp', 'PageDown', 'GoToStartOfDoc', 'GoToEndOfDoc', ...NAVIGATION
  ])
  const EDIT = Object.freeze(['Undo', 'Redo', 'Cut', 'Paste', 'PasteUnformatted', 'InsertText', 'Delete'])
  const TEXT = Object.freeze([
    'CharFontName', 'FontHeight', 'Bold', 'Italic', 'Underline',
    'LeftPara', 'CenterPara', 'RightPara', 'JustifyPara',
    'DefaultBullet', 'DefaultNumbering', 'IncrementIndent', 'DecrementIndent'
  ])
  // File bytes are brokered by the host; native Writer owns insertion and editing.
  const WRITER_ACTIONS = Object.freeze([
    'StyleApply', 'FontDialog', 'ParagraphDialog', 'OutlineBullet',
    'HyperlinkDialog', 'EditHyperlink', 'RemoveHyperlink',
    'InsertBreak', 'InsertPagebreak', 'InsertLinebreak', 'InsertPara', 'InsertTab', 'PageDialog', 'SwBackspace',
    'DelToStartOfWord', 'DelToEndOfWord', 'DelToStartOfLine', 'DelToEndOfLine',
    'GraphicDialog', 'InsertGraphic', 'InsertObjectStarMath'
  ])
  const MODULES = Object.freeze({
    math: Object.freeze({
      service: 'com.sun.star.formula.FormulaProperties', name: 'Math',
      embedded: true, toolbars: ['standardbar', 'toolbar'], menus: [MENUBAR], resources: MATH_WINDOWS,
      view: ['Draw', 'CommandWindow', 'ElementsDockingWindow', 'NextMark', 'PrevMark', 'NextError', 'PrevError', 'Select'],
      edit: ['ChangeFont', 'ChangeFontSize', 'ChangeDistance', 'ChangeAlignment', 'Textmode',
        'SymbolCatalogue', 'InsertSymbol', 'InsertCommandText', 'InsertSpecial', 'RedrawAutomatic'],
      contentGuard: 'text'
    }),
    calc: Object.freeze({
      service: 'com.sun.star.sheet.SpreadsheetDocument', name: 'Calc',
      toolbars: ['standardbar', 'formulabar'],
      nativeToolbars: ['formulabar'],
      view: ['StatusDocPos', 'StatusBarFunc', 'JumpToTable', 'PrevTable', 'NextTable',
        'GoToCell', 'GoToCurrentCell', 'JumpToNextCell', 'JumpToPreviousCell'],
      edit: ['InputLineVisible', 'InputLine', 'EnterString', 'InputLineEnter', 'FocusInputLine'],
      // Direct input and drag/drop require model-level protection as well as dispatch policy.
      contentGuard: 'cells'
    }),
    writer: Object.freeze({
      service: 'com.sun.star.text.TextDocument', name: 'Writer',
      toolbars: ['standardbar', 'textobjectbar'],
      menus: [MENUBAR],
      view: ['StatusPage', 'StatePageNumber', 'StateWordCount', 'ShowSinglePage', 'ShowTwoPages', 'PrintLayout', 'BrowseView'],
      edit: [...TEXT, ...WRITER_ACTIONS], contentGuard: 'text'
    }),
    impress: Object.freeze({
      service: 'com.sun.star.presentation.PresentationDocument', name: 'Impress',
      toolbars: ['standardbar', 'textobjectbar'],
      view: ['StatusPage', 'PageStatus', 'PreviousPage', 'NextPage', 'FirstPage', 'LastPage', 'DrawingMode', 'ZoomPage'],
      edit: TEXT, contentGuard: 'slides'
    })
  })
  function select(kind, editable) {
    const module = MODULES[kind]
    if (!module) throw new Error(`Unsupported Office module: ${kind}`)
    editable = Boolean(editable && !module.readonlyReason)
    return Object.freeze({
      kind, module, editable: Boolean(editable),
      readonlyReason: module.readonlyReason || '',
      contextMenus: editable,
      statusbar: editable,
      toolbars: editable ? module.toolbars.map(name => TOOLBAR_PREFIX + name) : [],
      nativeToolbars: editable ? (module.nativeToolbars || []).map(name => TOOLBAR_PREFIX + name) : [],
      menus: editable ? (module.menus || []) : [],
      resources: editable ? (module.resources || []) : [],
      commands: Object.freeze([...VIEW, ...module.view, ...(editable ? [...EDIT, ...module.edit] : [])])
    })
  }
  function allows(policy, url) {
    if (typeof url !== 'string' || !url.startsWith(UNO_PREFIX)) return false
    const name = url.slice(UNO_PREFIX.length).split('?')[0]
    return !LIFECYCLE.includes(name) && policy.commands.includes(name)
  }
  function allowsResource(policy, resource) {
    return (policy.statusbar && resource === STATUSBAR) || policy.toolbars.includes(resource) || policy.menus.includes(resource) || policy.resources.includes(resource)
  }
  function filterItems(policy, items) {
    return items.flatMap(item => {
      if (item.children) {
        const children = filterItems(policy, item.children)
        return children.length ? [{ ...item, children }] : []
      }
      return allows(policy, item.command) ? [{ ...item }] : []
    })
  }
  function allowsDispatch(policy, url, args) {
    if (!allows(policy, url)) return false
    if (url.slice(UNO_PREFIX.length).split('?')[0] !== SEARCH_COMMAND) return true
    const action = args.find(arg => arg.Name === SEARCH_ACTION_PROPERTY)?.Value
    return !url.includes('?') && SEARCH_READ_ACTIONS.includes(action)
  }
  function requiresArgumentCheck(url) {
    return url.slice(UNO_PREFIX.length).split('?')[0] === SEARCH_COMMAND
  }
  return Object.freeze({ MODULES, LIFECYCLE, TOOLBAR_PREFIX, select, allows, allowsResource, allowsDispatch, requiresArgumentCheck, filterItems })
})();
