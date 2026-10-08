import type { DepOptimizationOptions, Plugin } from 'vite'

// Crepe and every Kit entry must share one prebundle. Discovering a new deep
// import after an editor has loaded can replace the ProseMirror module graph
// while selections from the previous graph are still alive. Code block editors
// are resolved from the same CodeMirror view module Crepe renders with.
export const RENDERER_OPTIMIZE_DEPS: DepOptimizationOptions = {
  include: ['@milkdown/crepe', '@milkdown/kit/**', '@codemirror/view']
}

const FONTSOURCE_MARKER = '@fontsource'
const CSS_EXTENSION = '.css'
const SOURCE_DECLARATION = /src:\s*([^;}]+)/g
const WOFF_FALLBACK = /^url\([^)]*\.woff\)\s*format\(\s*['"]woff['"]\s*\)$/
const RESIDUAL_WOFF = /\.woff\)/

function keepSupportedSources(declaration: string, origin: string): string {
  const value = declaration.slice(declaration.indexOf(':') + 1)
  const candidates = value.split(',').map(candidate => candidate.trim()).filter(candidate => candidate !== '')
  if (candidates.length === 0) throw new Error(`font-face src in ${origin} has no candidate`)
  const supported = candidates.filter(candidate => !WOFF_FALLBACK.test(candidate))
  if (supported.length === 0) throw new Error(`font-face src in ${origin} only offers a woff fallback`)
  return supported.length === candidates.length ? declaration : `src: ${supported.join(', ')}`
}

/**
 * `@fontsource` declares every face as woff2 plus a woff fallback, so a build
 * ships two copies of each subset. Every Chromium that can run this renderer
 * supports woff2, which makes the fallback pure package weight; dropping it
 * here keeps the published CSS as the only source of subset and unicode-range
 * truth instead of restating it in a hand-written `@font-face`.
 *
 * An unrecognized declaration fails the build rather than shipping the
 * fallback, so a reshaped upstream stylesheet cannot silently undo the saving.
 */
export function supportedFontSources(): Plugin {
  return {
    name: 'scholarseed-supported-font-sources',
    enforce: 'pre',
    transform(code, id) {
      const [filename] = id.split('?')
      if (!filename.endsWith(CSS_EXTENSION) || !filename.includes(FONTSOURCE_MARKER)) return null
      const rewritten = code.replace(SOURCE_DECLARATION, declaration => keepSupportedSources(declaration, filename))
      if (RESIDUAL_WOFF.test(rewritten)) {
        throw new Error(`unhandled woff declaration in ${filename}; extend the rewrite instead of packaging the fallback`)
      }
      return { code: rewritten, map: null }
    }
  }
}
