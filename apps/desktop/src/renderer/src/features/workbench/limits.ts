import type { ViewerKind } from '../../contracts/workbench'

const MEBIBYTE = 1024 * 1024
const DEFAULT_TOKENIZATION_LINE_LENGTH = 20_000

export const MARKDOWN_VISUAL_MAX_BYTES = 10 * MEBIBYTE
export const LARGE_EDITOR_BYTES = 20 * MEBIBYTE
export const LARGE_EDITOR_LINES = 300_000

export interface EditorPerformanceOptions {
  largeFileOptimizations: boolean
  maxTokenizationLineLength: number
  folding: boolean
  bracketPairColorization: { enabled: boolean }
}

export function countEditorLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length && lines <= LARGE_EDITOR_LINES; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

export function editorPerformanceFor(byteLength: number, lineCount: number): EditorPerformanceOptions {
  const large = byteLength > LARGE_EDITOR_BYTES || lineCount > LARGE_EDITOR_LINES
  return {
    largeFileOptimizations: large,
    maxTokenizationLineLength: DEFAULT_TOKENIZATION_LINE_LENGTH,
    folding: !large,
    bracketPairColorization: { enabled: !large }
  }
}

export function usesLightweightTextState(viewer: ViewerKind, byteLength: number): boolean {
  return viewer === 'code' || (viewer === 'markdown' && byteLength > MARKDOWN_VISUAL_MAX_BYTES)
}
