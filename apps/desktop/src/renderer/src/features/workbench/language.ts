import type { languages } from 'monaco-editor/editor/editor.api'

/** Workbench suffix vocabulary; registration uses the same language identifiers. */
export const LANGUAGE_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  css: 'css',
  html: 'html',
  htm: 'html',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  lean: 'lean',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  r: 'r',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  txt: 'plaintext',
  log: 'plaintext',
})

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const suffix = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
  return LANGUAGE_BY_SUFFIX[suffix] ?? 'plaintext'
}

export const TOML_CONFIGURATION: languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
}

/** TOML has no bundled Monaco 0.56 definition. States preserve multiline strings. */
export const TOML_LANGUAGE: languages.IMonarchLanguage = {
  tokenPostfix: '.toml',
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/#.*$/, 'comment'],
      [/\[\[?[^\]\r\n]+\]\]?/, 'type.identifier'],
      [
        /(?:[\w-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[\w-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*(?=\s*=)/,
        'key',
      ],
      [/"""/, 'string', '@multilineBasic'],
      [/'''/, 'string', '@multilineLiteral'],
      [/"/, 'string', '@basic'],
      [/'/, 'string', '@literal'],
      [/\b(?:true|false)\b/, 'keyword'],
      [
        /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/,
        'number.date',
      ],
      [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number.date'],
      [/0x[\da-fA-F](?:_?[\da-fA-F])*/, 'number.hex'],
      [/0[ob][\d_]+/, 'number'],
      [/[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?|inf|nan)\b/, 'number'],
      [/[=.,{}[\]]/, 'delimiter'],
    ],
    basic: [
      [/\\(?:[btnfr"\\]|u[\da-fA-F]{4}|U[\da-fA-F]{8})/, 'string.escape'],
      [/[^"\\]+/, 'string'],
      [/"/, 'string', '@pop'],
      [/\\./, 'invalid'],
    ],
    literal: [
      [/[^']+/, 'string'],
      [/'/, 'string', '@pop'],
    ],
    multilineBasic: [
      [/"""/, 'string', '@pop'],
      [/\\(?:[btnfr"\\]|u[\da-fA-F]{4}|U[\da-fA-F]{8})/, 'string.escape'],
      [/\\\s*$/, 'string.escape'],
      [/[^"\\]+/, 'string'],
      [/"/, 'string'],
      [/\\./, 'invalid'],
    ],
    multilineLiteral: [
      [/'''/, 'string', '@pop'],
      [/[^']+/, 'string'],
      [/'/, 'string'],
    ],
  },
}
