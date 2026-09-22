import * as prettier from 'prettier/standalone'
import babelPlugin from 'prettier/plugins/babel'
import estreePlugin from 'prettier/plugins/estree'
import htmlPlugin from 'prettier/plugins/html'
import markdownPlugin from 'prettier/plugins/markdown'
import postcssPlugin from 'prettier/plugins/postcss'
import typescriptPlugin from 'prettier/plugins/typescript'
import yamlPlugin from 'prettier/plugins/yaml'

import { endOfLineFor } from './text.ts'

const SUPPORTED_SUFFIXES = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.markdown',
  '.md',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml'
])
const PRETTIER_PLUGINS = [
  babelPlugin,
  estreePlugin,
  htmlPlugin,
  markdownPlugin,
  postcssPlugin,
  typescriptPlugin,
  yamlPlugin
]
export type FormatTextResult =
  | { status: 'failed'; error: unknown }
  | { status: 'formatted'; text: string; cursorOffset: number | null }
  | { status: 'unchanged'; text: string; cursorOffset: number | null }
  | { status: 'unsupported' }

export interface FormatTextInput {
  path: string
  text: string
  savedBytes: Uint8Array
  cursorOffset?: number
}

function suffixFor(path: string): string {
  const name = path.split(/[\\/]/u).at(-1) ?? path
  const separator = name.lastIndexOf('.')
  return separator < 0 ? '' : name.slice(separator).toLowerCase()
}

export function supportsFormatOnSave(path: string): boolean {
  return SUPPORTED_SUFFIXES.has(suffixFor(path))
}

export async function formatTextOnSave(input: FormatTextInput): Promise<FormatTextResult> {
  if (!supportsFormatOnSave(input.path)) return { status: 'unsupported' }
  const options = {
    endOfLine: endOfLineFor(input.savedBytes),
    filepath: input.path,
    plugins: PRETTIER_PLUGINS
  } as const
  try {
    if (input.cursorOffset !== undefined) {
      const result = await prettier.formatWithCursor(input.text, {
        ...options,
        cursorOffset: input.cursorOffset
      })
      return result.formatted === input.text
        ? { status: 'unchanged', text: input.text, cursorOffset: input.cursorOffset }
        : { status: 'formatted', text: result.formatted, cursorOffset: result.cursorOffset }
    }
    const formatted = await prettier.format(input.text, options)
    return formatted === input.text
      ? { status: 'unchanged', text: input.text, cursorOffset: null }
      : { status: 'formatted', text: formatted, cursorOffset: null }
  } catch (error) {
    return { status: 'failed', error }
  }
}
