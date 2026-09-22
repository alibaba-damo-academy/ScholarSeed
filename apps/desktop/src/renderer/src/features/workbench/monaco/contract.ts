import type * as Monaco from 'monaco-editor/editor/editor.api'

import type { PreferenceLanguage } from '../../../../../preferences'

export const MONACO_FRAME_MESSAGE = 'scholarseed:monaco-frame-ready'
export const MONACO_FRAME_LANGUAGE_PARAM = 'language'
export const MONACO_FRAME_TOKEN_PARAM = 'token'
export const MONACO_FRAME_HOST_ID = 'root'

export interface MonacoRuntime {
  editorFor: (
    host: HTMLElement,
    sessionId: string,
    path: string,
    text: string,
    options: Omit<Monaco.editor.IStandaloneEditorConstructionOptions, 'model' | 'value' | 'language'>
  ) => Monaco.editor.IStandaloneCodeEditor
  monaco: typeof Monaco
}

export interface MonacoFrameReadyMessage {
  kind: typeof MONACO_FRAME_MESSAGE
  language: PreferenceLanguage
  token: string
}

export interface MonacoFrameWindow extends Window {
  scholarseedMonaco?: MonacoRuntime
}

export interface MonacoFrameContext {
  element: HTMLIFrameElement
  host: HTMLElement
  runtime: MonacoRuntime
}
