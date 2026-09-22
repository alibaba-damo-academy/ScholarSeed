import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Redo2, Replace, Save, Search, TextWrap, Undo2 } from 'lucide-react'
import type * as Monaco from 'monaco-editor/editor/editor.api'

import {
  BadgeDot,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Tooltip,
  useToast
} from '../../components/ui'
import { useApp } from '../../store'
import { writeClipboard } from '../../components/primitive/clipboard'
import {
  currentShortcutPlatform,
  effectiveShortcutBindings,
  matchesBinding,
  shortcutBindings,
  type ShortcutBinding,
  type ShortcutCommandId,
  type ShortcutModifier,
  type ShortcutOverrides
} from '../../shortcuts'

import {
  useSelectionActionContribution,
  type SelectionReplacement
} from './actions'
import { bindAdaptiveFindSpace } from './find'
import { formatTextOnSave } from './format'
import { languageFor } from './language'
import { encodeTextForSave, textForMonaco } from './text'
import './editor.css'
import { editorPerformanceFor } from './limits'
import { restoreView, saveView } from './monaco'
import { MonacoFrame } from './monaco/host'
import type { MonacoFrameContext, MonacoRuntime } from './monaco/contract'
import {
  documentTextReveal,
  selectionFingerprint,
  selectionViewport,
  useDocumentWorkspace,
  useWorkspaceController,
  type DocumentViewKind,
  type SelectionViewport
} from './workspace'

function editorSelectionViewport(
  editor: Monaco.editor.IStandaloneCodeEditor,
  selection: Monaco.Selection
): SelectionViewport | null {
  const host = editor.getDomNode()
  const end = editor.getScrolledVisiblePosition(selection.getEndPosition())
  if (!host || !end) return null
  const start = editor.getScrolledVisiblePosition(selection.getStartPosition()) ?? end
  const bounds = host.getBoundingClientRect()
  const left = bounds.left + Math.min(start.left, end.left)
  const top = bounds.top + Math.min(start.top, end.top)
  const right = bounds.left + Math.max(start.left, end.left) + 1
  const bottom = bounds.top + Math.max(start.top + start.height, end.top + end.height)
  return selectionViewport(
    { left, top, right, bottom, width: right - left, height: bottom - top },
    { x: bounds.left + end.left + 1, y: bounds.top + end.top + end.height }
  )
}

const FIND_ACTION = 'actions.find'
const REPLACE_ACTION = 'editor.action.startFindReplaceAction'
const GO_TO_LINE_ACTION = 'editor.action.gotoLine'
const LINE_COMMENT_ACTION = 'editor.action.commentLine'
const INDENT_ACTION = 'editor.action.indentLines'
const OUTDENT_ACTION = 'editor.action.outdentLines'
const COPY_ACTION = 'editor.action.clipboardCopyAction'
const SELECTION_COPY_ACTION = 'workbench.copySelection'
const CLIPBOARD_PASTE_ACTION = 'workbench.pasteClipboard'
const EDITOR_WRITABLE_FOCUS = 'editorTextFocus && !editorReadonly'
const EDITOR_TEXT_FOCUS = 'editorTextFocus'
const CLIPBOARD_TEXT_TYPE = 'text/plain'
const UNDO_COMMAND = 'undo'
const REDO_COMMAND = 'redo'
const HISTORY_ACTION_SOURCE = 'markdown-source-toolbar'
const SHORTCUT_ACTION_SOURCE = 'shortcut-command'
const FIND_WIDGET_SELECTOR = '.find-widget'
const CLOSE_FIND_WIDGET_COMMAND = 'closeFindWidget'
const FIND_WIDGET_BLUR_SOURCE = 'find-widget-blur'
const USER_SELECTION_SOURCES = new Set(['keyboard', 'mouse'])
type MonacoKeyCodeName =
  | 'Backquote' | 'Backslash' | 'BracketLeft' | 'BracketRight' | 'Comma'
  | 'DownArrow' | 'End' | 'Enter' | 'Equal' | 'Home' | 'LeftArrow' | 'Minus'
  | 'PageDown' | 'PageUp' | 'Period' | 'Quote' | 'RightArrow' | 'Semicolon'
  | 'Slash' | 'Space' | 'Tab' | 'UpArrow'

const MONACO_SHORTCUT_KEYS: Readonly<Record<string, MonacoKeyCodeName>> = {
  '/': 'Slash',
  '`': 'Backquote',
  ',': 'Comma',
  '-': 'Minus',
  '.': 'Period',
  ';': 'Semicolon',
  '=': 'Equal',
  '[': 'BracketLeft',
  '\\': 'Backslash',
  ']': 'BracketRight',
  "'": 'Quote',
  ArrowDown: 'DownArrow',
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow',
  ArrowUp: 'UpArrow',
  End: 'End',
  Enter: 'Enter',
  Home: 'Home',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Space: 'Space',
  Tab: 'Tab'
}

function monacoShortcutModifiers(monaco: MonacoRuntime['monaco']): Record<ShortcutModifier, number> {
  return {
    alt: monaco.KeyMod.Alt,
    primary: monaco.KeyMod.CtrlCmd,
    shift: monaco.KeyMod.Shift
  }
}

function monacoKeyCode(monaco: MonacoRuntime['monaco'], key: string): Monaco.KeyCode | undefined {
  if (/^[a-z]$/i.test(key)) return monaco.KeyCode.KeyA + key.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0)
  if (/^[0-9]$/.test(key)) return monaco.KeyCode.Digit0 + Number(key)
  const keyName = MONACO_SHORTCUT_KEYS[key]
  return keyName ? monaco.KeyCode[keyName] as Monaco.KeyCode : undefined
}

function monacoBinding(monaco: MonacoRuntime['monaco'], binding: ShortcutBinding): number {
  const key = monacoKeyCode(monaco, binding.key)
  if (key === undefined) throw new Error(`Unsupported Monaco shortcut key: ${binding.key}`)
  const modifiers = monacoShortcutModifiers(monaco)
  return binding.modifiers.reduce((value, modifier) => value | modifiers[modifier], key)
}

function monacoShortcut(monaco: MonacoRuntime['monaco'], id: ShortcutCommandId, overrides: ShortcutOverrides): number | undefined {
  const binding = effectiveShortcutBindings(id, overrides)[0]
  return binding ? monacoBinding(monaco, binding) : undefined
}

const CODE_ACTIONS: Readonly<Partial<Record<ShortcutCommandId, string>>> = {
  'code.find': FIND_ACTION,
  'code.replace': REPLACE_ACTION,
  'code.goToLine': GO_TO_LINE_ACTION,
  'code.lineComment': LINE_COMMENT_ACTION,
  'code.indent': INDENT_ACTION,
  'code.outdent': OUTDENT_ACTION
}
const CODE_EDIT_ACTION_COMMANDS = [
  'code.lineComment',
  'code.indent',
  'code.outdent'
] as const satisfies readonly ShortcutCommandId[]

const CODE_COMMANDS = [
  'code.save',
  'code.saveAll',
  'code.undo',
  'code.redo',
  ...Object.keys(CODE_ACTIONS)
] as readonly ShortcutCommandId[]

const CODE_NATIVE_BINDINGS: Readonly<Partial<Record<ShortcutCommandId, readonly ShortcutBinding[]>>> = {
  'code.redo': [...shortcutBindings('code.redo'), { key: 'y', modifiers: ['primary'] }]
}

function sameBinding(left: ShortcutBinding, right: ShortcutBinding): boolean {
  return left.key.toLowerCase() === right.key.toLowerCase()
    && left.modifiers.length === right.modifiers.length
    && left.modifiers.every(modifier => right.modifiers.includes(modifier))
}

function wordWrapFor(enabled: boolean): 'on' | 'off' {
  return enabled ? 'on' : 'off'
}

export function MonacoDocument({
  sessionId,
  tabId,
  toolbarHost,
  toolbarActions,
  formatOnSave,
  viewKind
}: {
  sessionId: string
  tabId: string
  toolbarHost?: HTMLElement | null
  toolbarActions?: ReactNode
  formatOnSave?: boolean
  viewKind: DocumentViewKind
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: uiText } = useTranslation('ui')
  const { toast } = useToast()
  const { state: appState, set, act } = useApp()
  const state = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const session = state.sessions[sessionId]
  const tab = state.tabs[tabId]
  const reveal = documentTextReveal(tab)
  const [frame, setFrame] = useState<MonacoFrameContext | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const wrapEnabledRef = useRef(appState.editorWordWrap)
  wrapEnabledRef.current = appState.editorWordWrap
  const savedVersionRef = useRef<number | null>(null)
  const serializedVersionRef = useRef<number | null>(null)
  const applyingExternalRef = useRef(false)
  const applyingRevealRef = useRef(false)
  const handledRevealRef = useRef('')
  const [goToLineOpen, setGoToLineOpen] = useState(false)
  const [goToLineValue, setGoToLineValue] = useState('')

  const replaceSelection = useCallback<SelectionReplacement>(async (request) => {
    const editor = editorRef.current
    const current = controller.getSnapshot().sessions[sessionId]
    const currentSelection = editor?.getSelection()
    const model = editor?.getModel()
    if (
      !editor
      || !model
      || !current
      || !currentSelection
      || current.changeVersion !== request.expectedChangeVersion
      || !current.selection
      || selectionFingerprint(current.selection) !== request.expectedFingerprint
      || model.getValueInRange(currentSelection) !== request.selection.text
    ) return { ok: false, error: 'selection_changed' }
    editor.pushUndoStop()
    const applied = editor.executeEdits('ai-selection-replacement', [{
      range: currentSelection,
      text: request.replacement,
      forceMoveMarkers: true
    }])
    editor.pushUndoStop()
    return applied ? { ok: true } : { ok: false, error: 'replacement_failed' }
  }, [controller, sessionId])
  const replacementContribution = useMemo(() => ({
    actions: null,
    expanded: false,
    id: 'markdown-source-replacement',
    order: 300,
    replaceSelection
  }), [replaceSelection])
  useSelectionActionContribution(tabId, replacementContribution)

  useEffect(() => {
    const host = frame?.host
    if (!host || !session || session.text === null || session.loadState !== 'ready') return
    const monaco = frame.runtime.monaco
    const isMarkdownSource = session.viewer === 'markdown' && viewKind === 'preview'
    const lightweight = session.lightweightText
    const performance = editorPerformanceFor(session.bytes.byteLength)
    const editor = frame.runtime.editorFor(host, sessionId, session.source.path, session.text, {
      readOnly: (!isMarkdownSource && viewKind === 'preview') || !session.capabilities.can_edit,
      editContext: false,
      automaticLayout: true,
      ...performance,
      find: { addExtraSpaceOnTop: false },
      showFoldingControls: 'always',
      minimap: { enabled: false },
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 20,
      padding: { top: 12, bottom: 24 },
      scrollBeyondLastLine: false,
      // 编辑器内容不足以滚动时放行滚轮，让外层 split panel 的横向/纵向滚动生效。
      scrollbar: { alwaysConsumeMouseWheel: false },
      renderWhitespace: 'selection',
      wordWrap: wordWrapFor(wrapEnabledRef.current)
    })
    const model = editor.getModel()
    if (!model) {
      editor.dispose()
      return
    }
    editorRef.current = editor
    const adaptiveFindSpace = bindAdaptiveFindSpace(editor, host, monaco.editor.EditorOption.padding)
    savedVersionRef.current ??= model.getAlternativeVersionId()
    const prior = restoreView(tabId)
    if (prior) editor.restoreViewState(prior)
    const contentListener = model.onDidChangeContent(() => {
      if (applyingExternalRef.current) return
      if (lightweight) {
        controller.setExternalDirty(
          sessionId,
          model.getAlternativeVersionId() !== savedVersionRef.current
        )
      } else {
        controller.updateText(sessionId, model.getValue())
      }
    })
    const selectionListener = editor.onDidChangeCursorSelection(({ selection, source }) => {
      if (
        applyingRevealRef.current
        || selection.isEmpty()
        || !USER_SELECTION_SOURCES.has(source)
      ) {
        controller.setSelection(tabId, null)
        return
      }
      const current = controller.getSnapshot().sessions[sessionId]
      const viewport = editorSelectionViewport(editor, selection)
      if (!current || !viewport) {
        controller.setSelection(tabId, null)
        return
      }
      controller.setSelection(tabId, {
        document_id: current.documentId,
        document_session_id: current.id,
        revision: current.revision,
        status: 'exact',
        text: model.getValueInRange(selection),
        locator: {
          kind: 'text',
          start_line: selection.startLineNumber - 1,
          start_column: selection.startColumn - 1,
          end_line: selection.endLineNumber - 1,
          end_column: selection.endColumn - 1
        }
      }, viewport)
    })
    let pendingFindBlurFrame: number | null = null
    const handleFindWidgetFocusOut = (event: FocusEvent): void => {
      const target = event.target
      if (!target || typeof (target as Element).closest !== 'function') return
      const widget = (target as Element).closest(FIND_WIDGET_SELECTOR)
      if (!widget || !host.contains(widget)) return
      const nextTarget = event.relatedTarget
      if (nextTarget && widget.contains(nextTarget as Node)) return
      if (pendingFindBlurFrame !== null) cancelAnimationFrame(pendingFindBlurFrame)
      pendingFindBlurFrame = requestAnimationFrame(() => {
        pendingFindBlurFrame = null
        if (widget.contains(host.ownerDocument.activeElement)) return
        editor.trigger(FIND_WIDGET_BLUR_SOURCE, CLOSE_FIND_WIDGET_COMMAND, null)
      })
    }
    host.addEventListener('focusout', handleFindWidgetFocusOut)
    const handleEditActionShortcut = (event: KeyboardEvent): void => {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return
      for (const commandId of CODE_EDIT_ACTION_COMMANDS) {
        if (!effectiveShortcutBindings(commandId, appState.shortcutOverrides).some(binding => matchesBinding(event, binding))) continue
        event.preventDefault()
        event.stopImmediatePropagation()
        editor.trigger(SHORTCUT_ACTION_SOURCE, CODE_ACTIONS[commandId]!, null)
        return
      }
    }
    host.addEventListener('keydown', handleEditActionShortcut, true)
    const selectedText = (): string | null => {
      if (!editor.hasTextFocus()) return null
      const selections = editor.getSelections()?.filter(selection => !selection.isEmpty()) ?? []
      if (!selections.length) return null
      return selections.map(selection => model.getValueInRange(selection)).join(model.getEOL())
    }
    const handleCopy = (event: ClipboardEvent): void => {
      const text = selectedText()
      if (text === null || !event.clipboardData) return
      event.clipboardData.setData(CLIPBOARD_TEXT_TYPE, text)
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const copyCommand = (): void => {
      const text = selectedText()
      if (text === null) {
        editor.trigger(SHORTCUT_ACTION_SOURCE, COPY_ACTION, null)
        return
      }
      void writeClipboard(text).catch(() => toast({ title: t('markdown.codeCopyFailed'), tone: 'error' }))
    }
    host.addEventListener('copy', handleCopy, true)
    const copyKeybindings = [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC]
    if (currentShortcutPlatform() === 'mac') {
      copyKeybindings.push(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyC)
    }
    const copyAction = editor.addAction({
      id: SELECTION_COPY_ACTION,
      label: uiText('copy.idle'),
      keybindings: copyKeybindings,
      precondition: EDITOR_TEXT_FOCUS,
      run: copyCommand
    })
    const pasteAction = editor.addAction({
      id: CLIPBOARD_PASTE_ACTION,
      label: t('code.paste'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
      precondition: EDITOR_WRITABLE_FOCUS,
      run: async () => { await window.scholarseed.pasteClipboard() }
    })
    for (const commandId of CODE_COMMANDS) {
      const effective = effectiveShortcutBindings(commandId, appState.shortcutOverrides)
      const nativeBindings = CODE_NATIVE_BINDINGS[commandId] ?? shortcutBindings(commandId)
      for (const nativeBinding of nativeBindings) {
        if (!effective.some(candidate => sameBinding(candidate, nativeBinding))) {
          editor.addCommand(monacoBinding(monaco, nativeBinding), () => undefined)
        }
      }
      const shortcut = monacoShortcut(monaco, commandId, appState.shortcutOverrides)
      if (shortcut === undefined) continue
      if ((CODE_EDIT_ACTION_COMMANDS as readonly ShortcutCommandId[]).includes(commandId)) continue
      editor.addCommand(shortcut, () => {
        if (commandId === 'code.save') void controller.save(sessionId)
        else if (commandId === 'code.saveAll') void controller.saveAll()
        else if (commandId === 'code.goToLine') {
          setGoToLineValue(String(editor.getPosition()?.lineNumber ?? 1))
          setGoToLineOpen(true)
        }
        else if (commandId === 'code.undo') {
          if (lightweight) editor.trigger(HISTORY_ACTION_SOURCE, UNDO_COMMAND, null)
          else controller.undo(sessionId)
        } else if (commandId === 'code.redo') {
          if (lightweight) editor.trigger(HISTORY_ACTION_SOURCE, REDO_COMMAND, null)
          else controller.redo(sessionId)
        } else {
          const action = CODE_ACTIONS[commandId]
          if (action) editor.trigger(SHORTCUT_ACTION_SOURCE, action, null)
        }
      })
    }
    const unregisterSave = lightweight
      ? controller.registerSaveDelegate(sessionId, {
          prepare: () => controller.updateText(sessionId, model.getValue()),
          beforeSave: async () => {
            if (!formatOnSave) return
            const current = controller.getSnapshot().sessions[sessionId]
            const position = editor.getPosition()
            if (!current || !position) return
            const source = model.getValue()
            const result = await formatTextOnSave({
              path: current.source.path,
              text: source,
              savedBytes: current.savedBytes,
              cursorOffset: model.getOffsetAt(position)
            })
            if (result.status === 'failed') {
              toast({ title: t('formatOnSaveFailed'), tone: 'warning' })
              return
            }
            if (result.status !== 'formatted' || model.getValue() !== source) return
            editor.pushUndoStop()
            const applied = editor.executeEdits('format-on-save', [{
              range: model.getFullModelRange(),
              text: result.text,
              forceMoveMarkers: true
            }])
            editor.pushUndoStop()
            if (applied && result.cursorOffset !== null) {
              editor.setPosition(model.getPositionAt(result.cursorOffset))
            }
          },
          serialize: async () => {
            const current = controller.getSnapshot().sessions[sessionId]
            if (!current) return null
            const bytes = encodeTextForSave(model.getValue(), current.savedBytes)
            serializedVersionRef.current = model.getAlternativeVersionId()
            return bytes
          }
        })
      : () => {}
    return () => {
      saveView(tabId, editor.saveViewState())
      host.removeEventListener('focusout', handleFindWidgetFocusOut)
      host.removeEventListener('keydown', handleEditActionShortcut, true)
      host.removeEventListener('copy', handleCopy, true)
      copyAction.dispose()
      pasteAction.dispose()
      if (pendingFindBlurFrame !== null) cancelAnimationFrame(pendingFindBlurFrame)
      selectionListener.dispose()
      contentListener.dispose()
      adaptiveFindSpace.dispose()
      unregisterSave()
      editor.dispose()
      editorRef.current = null
    }
  }, [appState.shortcutOverrides, controller, formatOnSave, frame, sessionId, set, tabId, t, toast, toolbarHost, viewKind, session?.loadState])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ wordWrap: wordWrapFor(appState.editorWordWrap) })
  }, [appState.editorWordWrap])

  useEffect(() => {
    if (serializedVersionRef.current === null) return
    savedVersionRef.current = serializedVersionRef.current
    serializedVersionRef.current = null
  }, [session?.revision])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (
      !model
      || session?.text === null
      || session?.text === undefined
      || (session.lightweightText && session.dirty)
    ) return
    const editorText = textForMonaco(session.text)
    if (model.getValue() === editorText) return
    const viewState = editorRef.current?.saveViewState()
    applyingExternalRef.current = true
    try {
      model.setValue(editorText)
      savedVersionRef.current = model.getAlternativeVersionId()
    } finally {
      applyingExternalRef.current = false
    }
    if (viewState) editorRef.current?.restoreViewState(viewState)
  }, [session?.revision, session?.text])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !reveal || session?.loadState !== 'ready') return
    const requestKey = `${tabId}:${reveal.sequence}`
    if (handledRevealRef.current === requestKey) return
    handledRevealRef.current = requestKey
    const match = model.findMatches(
      reveal.query,
      false,
      false,
      false,
      null,
      false,
      1
    )[0]
    if (!match) return
    applyingRevealRef.current = true
    try {
      editor.setSelection(match.range)
      editor.revealRangeInCenter(match.range)
      editor.focus()
    } finally {
      applyingRevealRef.current = false
    }
  }, [reveal, session?.loadState, session?.revision, tabId])

  if (!session || session.loadState === 'loading') {
    return <div className="vds-viewer-empty">{t('code.loading')}</div>
  }
  if (session.loadState === 'error' || session.text === null) {
    return <div className="vds-viewer-empty">{t('code.unavailable')}</div>
  }
  const readOnly = !session.capabilities.can_edit
  const requestedLine = Number(goToLineValue)
  const lineCount = editorRef.current?.getModel()?.getLineCount() ?? 0
  const canGoToLine = Number.isInteger(requestedLine) && requestedLine >= 1 && requestedLine <= lineCount
  const goToLine = (): void => {
    const targetEditor = editorRef.current
    if (!targetEditor || !canGoToLine) return
    targetEditor.setPosition({ lineNumber: requestedLine, column: 1 })
    targetEditor.revealLineInCenter(requestedLine)
    setGoToLineOpen(false)
    targetEditor.focus()
  }
  const goToLineDialog = (
    <Dialog open={goToLineOpen} onOpenChange={setGoToLineOpen}>
      <DialogContent data-testid="code-go-to-line-dialog">
        <DialogHeader>
          <DialogTitle>{t('code.goToLine.title')}</DialogTitle>
          <DialogDescription>{t('code.goToLine.description', { count: lineCount })}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          data-testid="code-go-to-line-input"
          inputMode="numeric"
          min={1}
          max={lineCount}
          type="number"
          value={goToLineValue}
          onChange={(event) => setGoToLineValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canGoToLine) goToLine()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setGoToLineOpen(false)}>{uiText('cancel')}</Button>
          <Button disabled={!canGoToLine} onClick={goToLine}>{t('code.goToLine.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  const runAction = (action: string): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    void editor.getAction(action)?.run()
  }
  const runHistoryAction = (command: typeof UNDO_COMMAND | typeof REDO_COMMAND): void => {
    const editor = editorRef.current
    if (!editor || readOnly) return
    editor.focus()
    if (session.lightweightText) {
      editor.trigger(HISTORY_ACTION_SOURCE, command, null)
      return
    }
    if (command === UNDO_COMMAND) controller.undo(sessionId)
    else controller.redo(sessionId)
  }
  const wrapEnabled = appState.editorWordWrap
  const sourceActions = (
    <div className="vds-code-actions flex min-w-0 flex-nowrap items-center overflow-x-auto !gap-[var(--vds-toolbar-icon-gap)] !border-b-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="toolbar" aria-label={t('code.toolbar')}>
      <Tooltip portalled content={t('code.undo')}><IconButton data-testid="markdown-undo" variant="ghostIcon" size="sm" title={undefined} label={t('code.undo')} icon={<Undo2 />} disabled={readOnly} onClick={() => runHistoryAction(UNDO_COMMAND)} /></Tooltip>
      <Tooltip portalled content={t('code.redo')}><IconButton data-testid="markdown-redo" variant="ghostIcon" size="sm" title={undefined} label={t('code.redo')} icon={<Redo2 />} disabled={readOnly} onClick={() => runHistoryAction(REDO_COMMAND)} /></Tooltip>
      <span className="mx-[var(--vds-space-1)] h-5 w-px bg-[var(--vds-divider-default)]" role="separator" />
      <Tooltip portalled content={t('code.find')}><IconButton data-testid="markdown-find" variant="ghostIcon" size="sm" title={undefined} label={t('code.find')} icon={<Search />} onClick={() => runAction(FIND_ACTION)} /></Tooltip>
      <Tooltip portalled content={t('code.replace')}><IconButton data-testid="markdown-replace" variant="ghostIcon" size="sm" title={undefined} label={t('code.replace')} icon={<Replace />} disabled={readOnly} onClick={() => runAction(REPLACE_ACTION)} /></Tooltip>
      <span className="mx-[var(--vds-space-1)] h-5 w-px bg-[var(--vds-divider-default)]" role="separator" />
      <Tooltip portalled content={t('code.wrap')}>
        <IconButton
          aria-pressed={wrapEnabled}
          data-testid="source-document-wrap-toggle"
          icon={<TextWrap />}
          label={t('code.wrap')}
          size="sm"
          title={undefined}
          variant="ghostIcon"
          onClick={() => act.setEditorWordWrap(!wrapEnabled)}
        />
      </Tooltip>
    </div>
  )
  const editor = (
    <div className="vds-code-document is-actions-external" data-shortcut-scope="code" data-testid="document-editor" data-language={languageFor(session.source.path)}>
      <MonacoFrame
        language={appState.lang}
        onReady={setFrame}
        testId="monaco-editor"
        theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
      />
    </div>
  )
  if (!toolbarHost) {
    return (
      <>
      <section className="grid size-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--vds-bg-page)]">
        <div
          className="flex min-h-12 min-w-0 flex-nowrap items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-page)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]"
          data-save-state={session.saveState}
          data-testid="source-document-toolbar"
        >
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">{sourceActions}</div>
          <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]">
            {toolbarActions}
            <Tooltip portalled content={uiText('save')}>
              <span className="relative inline-flex">
                <IconButton
                  variant="ghostIcon"
                  size="sm"
                  title={undefined}
                  label={uiText('save')}
                  icon={<Save />}
                  data-testid="source-document-save"
                  disabled={!session.dirty || !session.capabilities.can_save || session.saveState === 'saving'}
                  onClick={() => void controller.save(sessionId)}
                />
                {session.dirty && <BadgeDot className="pointer-events-none absolute right-0 top-0" data-testid="source-document-save-dirty" />}
              </span>
            </Tooltip>
          </div>
        </div>
        {editor}
      </section>
      {goToLineDialog}
      </>
    )
  }
  return (
    <>
      {createPortal(sourceActions, toolbarHost)}
      {editor}
      {goToLineDialog}
    </>
  )
}
