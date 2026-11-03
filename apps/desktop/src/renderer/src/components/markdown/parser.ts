import type { Root } from 'mdast'
import type { Parser, Plugin } from 'unified'

export function createMarkdownParseCache(): Plugin<[], Root> {
  let cached: { source: string; tree: ReturnType<Parser> } | undefined
  return function cacheParser(): void {
    const parse = this.parser
    if (!parse) throw new Error('Markdown parse cache requires an installed parser')
    this.parser = (document, file) => {
      if (cached?.source === document) return structuredClone(cached.tree)
      const tree = parse(document, file)
      cached = { source: document, tree: structuredClone(tree) }
      return tree
    }
  }
}
