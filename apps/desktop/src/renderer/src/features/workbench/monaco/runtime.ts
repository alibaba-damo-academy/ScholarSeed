import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/features/codicon/register'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'

import { languageFor } from '../language'
import { LEAN_LANGUAGE_ID } from '../lean'
import { registerDocumentResourceReclaimer } from '../reclaim'
import { textForMonaco } from '../text'
import '../syntax'
import { matchAbbreviation } from '../abbreviations'
import { sweepModels } from './models'

const models = new Map<string, monaco.editor.ITextModel>()

registerDocumentResourceReclaimer((activeSessionIds) => sweepModels(models, activeSessionIds))

const monacoHost = self as typeof self & {
  MonacoEnvironment: { getWorker: () => Worker }
}
monacoHost.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

const ABBREVIATION_EDIT_SOURCE = 'lean-abbreviation-tab'

function installLeanAbbreviationTab(
  host: HTMLElement,
  editor: monaco.editor.IStandaloneCodeEditor
): void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
      return
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return
    const model = editor.getModel()
    if (model === null || model.getLanguageId() !== LEAN_LANGUAGE_ID) return
    const selections = editor.getSelections()
    if (selections === null) return
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = []
    const nextSelections: monaco.Selection[] = []
    for (const selection of selections) {
      if (!selection.isEmpty()) {
        nextSelections.push(selection)
        continue
      }
      const lineNumber = selection.positionLineNumber
      const beforeCursor = model
        .getLineContent(lineNumber)
        .substring(0, selection.positionColumn - 1)
      const match = matchAbbreviation(beforeCursor)
      if (match === null) {
        nextSelections.push(selection)
        continue
      }
      const startColumn = match.start + 1
      edits.push({
        range: new monaco.Range(lineNumber, startColumn, lineNumber, selection.positionColumn),
        text: match.replacement,
      })
      const caret = startColumn + match.cursorOffset
      nextSelections.push(new monaco.Selection(lineNumber, caret, lineNumber, caret))
    }
    if (edits.length === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    editor.executeEdits(ABBREVIATION_EDIT_SOURCE, edits, nextSelections)
  }
  host.addEventListener('keydown', handleKeyDown, true)
  editor.onDidDispose(() => {
    host.removeEventListener('keydown', handleKeyDown, true)
  })
}

function createEditor(
  host: HTMLElement,
  options: Omit<monaco.editor.IStandaloneEditorConstructionOptions, 'model' | 'value' | 'language'>,
  model: monaco.editor.ITextModel | null
): monaco.editor.IStandaloneCodeEditor {
  const editor = monaco.editor.create(host, { ...options, model })
  installLeanAbbreviationTab(host, editor)
  return editor
}

export function editorFor(
  host: HTMLElement,
  sessionId: string,
  path: string,
  text: string,
  options: Omit<monaco.editor.IStandaloneEditorConstructionOptions, 'model' | 'value' | 'language'>
): monaco.editor.IStandaloneCodeEditor {
  const existing = models.get(sessionId)
  if (existing && !existing.isDisposed()) {
    return createEditor(host, options, existing)
  }
  if (existing) models.delete(sessionId)
  const uri = monaco.Uri.parse(
    `inmemory://scholarseed/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}`
  )
  const editor = createEditor(host, options, null)
  const model = monaco.editor.createModel(textForMonaco(text), languageFor(path), uri)
  editor.setModel(model)
  models.set(sessionId, model)
  return editor
}

export { monaco }
