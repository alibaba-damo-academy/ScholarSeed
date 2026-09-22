import { languages } from 'monaco-editor/editor/editor.api'
import { conf as cppConfiguration, language as cppLanguage } from 'monaco-editor/languages/definitions/cpp/cpp'
import { conf as cssConfiguration, language as cssLanguage } from 'monaco-editor/languages/definitions/css/css'
import { conf as htmlConfiguration, language as htmlLanguage } from 'monaco-editor/languages/definitions/html/html'
import { conf as javaConfiguration, language as javaLanguage } from 'monaco-editor/languages/definitions/java/java'
import { conf as javascriptConfiguration, language as javascriptLanguage } from 'monaco-editor/languages/definitions/javascript/javascript'
import { conf as markdownConfiguration, language as markdownLanguage } from 'monaco-editor/languages/definitions/markdown/markdown'
import { conf as pythonConfiguration, language as pythonLanguage } from 'monaco-editor/languages/definitions/python/python'
import { conf as rConfiguration, language as rLanguage } from 'monaco-editor/languages/definitions/r/r'
import { conf as shellConfiguration, language as shellLanguage } from 'monaco-editor/languages/definitions/shell/shell'
import { conf as typescriptConfiguration, language as typescriptLanguage } from 'monaco-editor/languages/definitions/typescript/typescript'
import { conf as xmlConfiguration, language as xmlLanguage } from 'monaco-editor/languages/definitions/xml/xml'
import { conf as yamlConfiguration, language as yamlLanguage } from 'monaco-editor/languages/definitions/yaml/yaml'
import { createTokenizationSupport } from 'monaco-editor/languages/features/json/tokenization.js'

import { LANGUAGE_BY_SUFFIX, TOML_CONFIGURATION, TOML_LANGUAGE } from './language'

const definitions: ReadonlyArray<{ id: string; configuration: languages.LanguageConfiguration; language: languages.IMonarchLanguage }> = [
  { id: 'c', configuration: cppConfiguration, language: cppLanguage },
  { id: 'cpp', configuration: cppConfiguration, language: cppLanguage },
  { id: 'css', configuration: cssConfiguration, language: cssLanguage },
  { id: 'html', configuration: htmlConfiguration, language: htmlLanguage },
  { id: 'java', configuration: javaConfiguration, language: javaLanguage },
  { id: 'javascript', configuration: javascriptConfiguration, language: javascriptLanguage },
  { id: 'markdown', configuration: markdownConfiguration, language: markdownLanguage },
  { id: 'python', configuration: pythonConfiguration, language: pythonLanguage },
  { id: 'r', configuration: rConfiguration, language: rLanguage },
  { id: 'shell', configuration: shellConfiguration, language: shellLanguage },
  { id: 'typescript', configuration: typescriptConfiguration, language: typescriptLanguage },
  { id: 'xml', configuration: xmlConfiguration, language: xmlLanguage },
  { id: 'yaml', configuration: yamlConfiguration, language: yamlLanguage },
  { id: 'toml', configuration: TOML_CONFIGURATION, language: TOML_LANGUAGE }
]

for (const { id, configuration, language } of definitions) {
  languages.register({ id, extensions: Object.entries(LANGUAGE_BY_SUFFIX).filter(([, value]) => value === id).map(([suffix]) => `.${suffix}`) })
  languages.setLanguageConfiguration(id, configuration)
  languages.setMonarchTokensProvider(id, language)
}

languages.register({ id: 'json', extensions: ['.json'] })
languages.setTokensProvider('json', createTokenizationSupport(false))
languages.setLanguageConfiguration('json', {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }]
})
