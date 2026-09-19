import type { ViewerKind } from '../../contracts/workbench'

const MEBIBYTE = 1024 * 1024
const DEFAULT_TOKENIZATION_LINE_LENGTH = 20_000
const TOKENIZATION_SENTINEL = 1

export const MARKDOWN_VISUAL_MAX_BYTES = MEBIBYTE
export const LARGE_EDITOR_BYTES = MEBIBYTE

export interface EditorPerformanceOptions {
  largeFileOptimizations: false
  maxTokenizationLineLength: number
  folding: boolean
  bracketPairColorization: { enabled: boolean }
}

/** Keep Monarch active while removing helpers that traverse the whole large model. */
export function editorPerformanceFor(byteLength: number): EditorPerformanceOptions {
  const large = byteLength > LARGE_EDITOR_BYTES
  return {
    largeFileOptimizations: false,
    maxTokenizationLineLength: Math.max(DEFAULT_TOKENIZATION_LINE_LENGTH, byteLength + TOKENIZATION_SENTINEL),
    folding: !large,
    bracketPairColorization: { enabled: !large }
  }
}

export function usesLightweightTextState(viewer: ViewerKind, byteLength: number): boolean {
  return viewer === 'code' || (viewer === 'markdown' && byteLength > MARKDOWN_VISUAL_MAX_BYTES)
}
