import type { languages } from 'monaco-editor/editor/editor.api'

export const LEAN_LANGUAGE_ID = 'lean'

/**
 * Lean 4 grammar. Monaco 0.56 ships no Lean definition, so it is owned here the same way
 * `TOML_LANGUAGE` is owned in `language.ts`.
 *
 * Three Lean specifics shape the design:
 * - Names and operators are Unicode (`α`, `Nat.le`, `∀ ε > 0`), so the definition sets
 *   `unicode: true`. Monarch rebuilds every pattern with the `u` flag (`monarchCompile.js`),
 *   which is what `\p{XID_Start}` names and `\p{Sm}` operators require.
 * - Block comments nest, so `/-` pushes this same state and `-/` pops it. A flat comment rule
 *   would desynchronize every token after the first nested comment.
 * - `s"..."` interpolates `{expr}`, so the interpolation state re-enters `@root` and tracks its
 *   own brace depth.
 *
 * Tactic names are deliberately **not** keyword-listed: they are ordinary identifiers, and a
 * stale list would miscolour user-defined names.
 */
const COMMAND_KEYWORDS: readonly string[] = [
  'abbrev', 'alias', 'attribute', 'axiom', 'builtin_initialize', 'class', 'coinductive',
  'corollary', 'declare_syntax_cat', 'def', 'derive', 'elab', 'example', 'export', 'extern',
  'guard_msgs', 'import', 'inductive', 'infix', 'infixl', 'infixr', 'initialize', 'instance',
  'lemma', 'local', 'macro', 'macro_rules', 'module', 'mutual', 'namespace', 'noncomputable',
  'notation', 'opaque', 'open', 'partial', 'postfix', 'prefix', 'prelude', 'private',
  'protected', 'reassign', 'register_option', 'scoped', 'section', 'set_option', 'structure',
  'syntax', 'theorem', 'universe', 'unsafe', 'variable', 'where'
]

/** Term-level keywords, plus the two proof holes worth flagging while reading. */
const TERM_KEYWORDS: readonly string[] = [
  'admit', 'by', 'calc', 'catch', 'continue', 'do', 'else', 'false', 'finally', 'for', 'fun',
  'have', 'if', 'in', 'let', 'match', 'return', 'show', 'sorry', 'suffices', 'then', 'true',
  'try', 'unless', 'with'
]

const SORTS: readonly string[] = ['Prop', 'Sort', 'Type']

/**
 * One qualified Lean name: dotted (`Nat.add`) and allowed to end in `'` (`h₁'`).
 *
 * The continuation class needs `\p{No}` on top of `\p{XID_Continue}`: hypothesis names such as
 * `h₁` use subscript digits, which Unicode files as Number-other and XID_Continue excludes, while
 * Lean's own `isIdContinue` accepts them.
 */
const QUALIFIED_NAME = /[_\p{XID_Start}][_\p{XID_Continue}\p{No}']*(?:\.[_\p{XID_Start}][_\p{XID_Continue}\p{No}']*)*/u

export const LEAN_CONFIGURATION: languages.LanguageConfiguration = {
  comments: { lineComment: '--', blockComment: ['/-', '-/'] },
  brackets: [['(', ')'], ['[', ']'], ['{', '}'], ['⟨', '⟩'], ['⦃', '⦄']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '⟨', close: '⟩' },
    { open: '"', close: '"', notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '⟨', close: '⟩' },
    { open: '"', close: '"' }
  ],
  wordPattern: QUALIFIED_NAME,
  // Lean is indentation-sensitive like Python, so fold by indentation rather than by markers.
  folding: { offSide: true }
}

export const LEAN_LANGUAGE: languages.IMonarchLanguage = {
  tokenPostfix: '.lean',
  unicode: true,
  keywords: [...COMMAND_KEYWORDS, ...TERM_KEYWORDS],
  sorts: SORTS,
  tokenizer: {
    root: [
      { include: '@whitespace' },
      [/0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*/, 'number.hex'],
      [/0[oO][0-7](?:_?[0-7])*/, 'number.octal'],
      [/0[bB][01](?:_?[01])*/, 'number.binary'],
      [/[0-9](?:_?[0-9])*\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?/, 'number.float'],
      [/[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*/, 'number.float'],
      [/[0-9](?:_?[0-9])*/, 'number'],
      [/[sm]"/, { token: 'string.quote', next: '@interpolated' }],
      [/"/, { token: 'string.quote', next: '@string' }],
      [/'(?:\\.|[^'\\])'/, 'string'],
      [/#[_\p{XID_Start}][_\p{XID_Continue}']*/u, 'keyword'],
      [/λ/, 'keyword'],
      [QUALIFIED_NAME, { cases: { '@sorts': 'type', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[\p{Sm}\p{So}]+/u, 'operator'],
      [/[()[\]{},;`⟨⟩⦃⦄]/, 'delimiter'],
      [/[:=|+\-/<>.!^~?&%$@]+/, 'operator']
    ],
    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/--/, { token: 'comment.doc', next: '@doccomment' }],
      [/\/-/, { token: 'comment', next: '@blockcomment' }],
      [/--.*$/, 'comment']
    ],
    blockcomment: [
      [/\/-/, { token: 'comment', next: '@push' }],
      [/-\//, { token: 'comment', next: '@pop' }],
      [/[^-/]+/, 'comment'],
      [/[/-]/, 'comment']
    ],
    doccomment: [
      [/\/-/, { token: 'comment.doc', next: '@push' }],
      [/-\//, { token: 'comment.doc', next: '@pop' }],
      [/[^-/]+/, 'comment.doc'],
      [/[/-]/, 'comment.doc']
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }]
    ],
    interpolated: [
      [/[^\\{}"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/\{/, { token: 'delimiter.bracket', next: '@interpolation' }]
    ],
    interpolation: [
      [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
      [/\{/, { token: 'delimiter.bracket', next: '@push' }],
      { include: '@root' }
    ]
  }
}
