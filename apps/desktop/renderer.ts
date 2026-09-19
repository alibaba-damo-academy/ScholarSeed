import type { DepOptimizationOptions } from 'vite'

// Crepe and every Kit entry must share one prebundle. Discovering a new deep
// import after an editor has loaded can replace the ProseMirror module graph
// while selections from the previous graph are still alive. Code block editors
// are resolved from the same CodeMirror view module Crepe renders with.
export const RENDERER_OPTIMIZE_DEPS: DepOptimizationOptions = {
  include: ['@milkdown/crepe', '@milkdown/kit/**', '@codemirror/view']
}
