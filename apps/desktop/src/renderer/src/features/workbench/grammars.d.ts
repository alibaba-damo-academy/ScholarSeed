/** Monaco publishes definition JS without declaration files. These are its public grammar shapes. */
declare module 'monaco-editor/languages/definitions/*' {
  import type { languages } from 'monaco-editor/editor/editor.api'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/languages/features/json/tokenization.js' {
  import type { languages } from 'monaco-editor/editor/editor.api'
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider
}
