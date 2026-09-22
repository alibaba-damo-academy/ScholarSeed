import './nls'
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/features/codicon/register'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'

import { languageFor } from './language'
import { registerDocumentResourceReclaimer } from './reclaim'
import { textForMonaco } from './text'
import './syntax'

const models = new Map<string, monaco.editor.ITextModel>()
const views = new Map<string, monaco.editor.ICodeEditorViewState | null>()

const monacoHost = self as typeof self & {
  MonacoEnvironment: { getWorker: () => Worker }
}
monacoHost.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
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
    return monaco.editor.create(host, { ...options, model: existing })
  }
  if (existing) models.delete(sessionId)
  const uri = monaco.Uri.parse(`inmemory://scholarseed/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}`)
  // Construct the editor without a model first. This applies model-level options to
  // Monaco's configuration service while keeping ownership outside the editor; an
  // editor unmount must not dispose the shared session model used by another pane.
  const editor = monaco.editor.create(host, { ...options, model: null })
  const model = monaco.editor.createModel(textForMonaco(text), languageFor(path), uri)
  editor.setModel(model)
  models.set(sessionId, model)
  return editor
}

export function saveView(tabId: string, state: monaco.editor.ICodeEditorViewState | null): void {
  views.set(tabId, state)
}

export function restoreView(tabId: string): monaco.editor.ICodeEditorViewState | null {
  return views.get(tabId) ?? null
}

function sweepModels(activeSessionIds: ReadonlySet<string>, activeTabIds: ReadonlySet<string>): void {
  for (const [sessionId, model] of models) {
    if (activeSessionIds.has(sessionId)) continue
    model.dispose()
    models.delete(sessionId)
  }
  for (const tabId of views.keys()) {
    if (!activeTabIds.has(tabId)) views.delete(tabId)
  }
}

registerDocumentResourceReclaimer(sweepModels)

export { monaco }
