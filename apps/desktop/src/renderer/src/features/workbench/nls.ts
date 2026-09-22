// Monaco's official NLS bundle must run before any editor or contribution module.
import 'monaco-editor/nls/lang/zh-cn'

import { rendererLocalization } from '../../app/localization'
import { DEFAULT_LANGUAGE } from '../../../../localization/catalog'
import type { PreferenceLanguage } from '../../../../preferences'

const nlsHost = globalThis as typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[]
  _VSCODE_NLS_LANGUAGE?: string
}

// Vendor bootstrap globals are confined here. Monaco registers some labels at
// module evaluation, so this language stays fixed for the renderer lifetime.
export const MONACO_LANGUAGE: PreferenceLanguage = rendererLocalization.resolvedLanguage === 'en'
  ? 'en' : DEFAULT_LANGUAGE
if (MONACO_LANGUAGE === 'en') {
  delete nlsHost._VSCODE_NLS_MESSAGES
  nlsHost._VSCODE_NLS_LANGUAGE = 'en'
}
