import {
  MONACO_FRAME_LANGUAGE_PARAM,
  MONACO_FRAME_MESSAGE,
  MONACO_FRAME_TOKEN_PARAM,
  type MonacoFrameWindow,
  type MonacoFrameReadyMessage
} from './contract'
import type { PreferenceLanguage } from '../../../../../preferences'

const params = new URLSearchParams(window.location.search)
const language: PreferenceLanguage = params.get(MONACO_FRAME_LANGUAGE_PARAM) === 'zh' ? 'zh' : 'en'
const token = params.get(MONACO_FRAME_TOKEN_PARAM) ?? ''
const nlsHost = globalThis as typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[]
  _VSCODE_NLS_LANGUAGE?: string
}

if (language === 'zh') {
  await import('monaco-editor/nls/lang/zh-cn')
} else {
  delete nlsHost._VSCODE_NLS_MESSAGES
  nlsHost._VSCODE_NLS_LANGUAGE = 'en'
}

document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
const runtime = await import('./runtime')
;(window as MonacoFrameWindow).scholarseedMonaco = runtime

const ready: MonacoFrameReadyMessage = {
  kind: MONACO_FRAME_MESSAGE,
  language,
  token
}
window.parent.postMessage(ready, window.location.origin)
