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
import { textForMonaco } from '../text'
import '../syntax'

const models = new Map<string, monaco.editor.ITextModel>()

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
  const editor = monaco.editor.create(host, { ...options, model: null })
  const model = monaco.editor.createModel(textForMonaco(text), languageFor(path), uri)
  editor.setModel(model)
  models.set(sessionId, model)
  return editor
}

export { monaco }
