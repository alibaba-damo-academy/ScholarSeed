import { linkAttr } from '@milkdown/kit/preset/commonmark'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Ctx } from '@milkdown/kit/ctx'

import { isCitationUrl } from '../../contracts/citations'

const CITATION_ATTRIBUTE = 'data-saved-citation'
const CITATION_SELECTOR = `a[${CITATION_ATTRIBUTE}]`
const CITATION_PREFIX = 'scholarseed-cite:'
export const DOCUMENT_FRAGMENT_ATTRIBUTE = 'data-document-fragment'

/** Keep the editor's URL sanitizer; route citation marks exclusively inside the app. */
export function configureCitationLinks(ctx: Ctx): void {
  ctx.update(linkAttr.key, previous => mark => {
    const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : ''
    return {
      ...previous(mark),
      ...(isCitationUrl(href) ? { [CITATION_ATTRIBUTE]: href.slice(CITATION_PREFIX.length) } : {}),
      ...(href.startsWith('#') && href.length > 1 ? { [DOCUMENT_FRAGMENT_ATTRIBUTE]: href } : {})
    }
  })
}

export function savedCitationPlugin(open: (handle: string) => void) {
  return $prose(() => new Plugin({
    props: {
      handleDOMEvents: {
        click: (_view, event) => {
          const link = event.target instanceof Element ? event.target.closest(CITATION_SELECTOR) : null
          const handle = link?.getAttribute(CITATION_ATTRIBUTE)
          if (!handle) return false
          event.preventDefault()
          open(handle)
          return true
        }
      }
    }
  }))
}
