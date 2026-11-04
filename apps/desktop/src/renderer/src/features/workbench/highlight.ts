import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const MARKDOWN_FIND_MATCH_CLASS =
  'bg-[var(--vds-warning-light-bg-active)] text-[var(--vds-text-primary)] outline outline-[var(--vds-warning-text-primary)]'

export const markdownFindKey = new PluginKey<DecorationSet>('workbenchMarkdownFind')

export function createMarkdownFindPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: markdownFindKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (transaction, decorations) => {
        const match = transaction.getMeta(markdownFindKey) as
          { from: number; to: number } | null | undefined
        if (match === null || transaction.docChanged) return DecorationSet.empty
        if (match === undefined) return decorations
        return DecorationSet.create(transaction.doc, [
          Decoration.inline(match.from, match.to, {
            class: MARKDOWN_FIND_MATCH_CLASS,
            'data-testid': 'markdown-find-match',
          }),
        ])
      },
    },
    props: {
      decorations: (state) => markdownFindKey.getState(state),
    },
  })
}
