import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer'
import { parseAsync, renderDocument } from 'docx-preview'

import { markWordParagraphs, slideMarkers, wordAnchors, wordParagraphs, type TextAnchor } from './selection'
import { mediaPreview } from './media'
import { diagramPreview } from './diagram'

export interface DocumentReader {
  anchors(): TextAnchor[]
  search(query: string, step: number): Promise<{ current: number; total: number }>
  zoom(percent: number): void | Promise<void>
  pages?(): { current: number; total: number }
  navigate?(step: number): Promise<void>
  dispose(): void
}

function searchDom(root: HTMLElement): DocumentReader['search'] {
  let previous = ''
  let current = -1
  return async (query, step) => {
    const matches: Range[] = []
    if (query) {
      // Runs with different fonts still form one searchable paragraph.
      for (const paragraph of root.querySelectorAll('p')) {
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
        const nodes: { node: Node; start: number; end: number }[] = []
        let node: Node | null
        let content = ''
        while ((node = walker.nextNode())) {
          const start = content.length
          content += node.textContent ?? ''
          nodes.push({ node, start, end: content.length })
        }
        const text = content.toLocaleLowerCase()
        const needle = query.toLocaleLowerCase()
        for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) {
          const range = document.createRange()
          const first = nodes.find((item) => item.end > index)
          const last = nodes.find((item) => item.end >= index + query.length)
          if (!first || !last) continue
          range.setStart(first.node, index - first.start)
          range.setEnd(last.node, index + query.length - last.start)
          matches.push(range)
        }
      }
    }
    current = query !== previous || step === 0 ? 0 : (current + step + matches.length) % matches.length
    previous = query
    const match = matches[current]
    if (match) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(match)
      match.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    }
    return { current: match ? current + 1 : 0, total: matches.length }
  }
}

export async function mountWord(bytes: Uint8Array, root: HTMLElement): Promise<DocumentReader> {
  const source = wordParagraphs(bytes)
  const options = {
    renderAltChunks: false,
    useBase64URL: true,
    className: `scholarseed-docx-${crypto.randomUUID()}`,
    renderChanges: false,
  }
  const model = await parseAsync(await mediaPreview(bytes), options)
  markWordParagraphs(source.body, model.documentPart.body.children)
  const nodes = await renderDocument(model, options)
  root.replaceChildren(...nodes)
  return {
    anchors: () => wordAnchors(root, source.paragraphs),
    search: searchDom(root),
    // Zoom is document geometry, not a product visual token.
    zoom: (percent) => {
      root.style.zoom = String(percent / 100)
    },
    dispose: () => root.replaceChildren(),
  }
}

export async function mountSlides(bytes: Uint8Array, root: HTMLElement): Promise<DocumentReader> {
  const anchors = new Map<number, TextAnchor[]>()
  const viewer = new PptxViewer(root, {
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    scrollContainer: root.parentElement ?? root,
    pdfjs: false,
    onSlideUnmounted: (index) => anchors.delete(index),
    onSlideRendered: (index, element) => {
      const slide = viewer.presentationData?.slides[index]
      if (!slide) return
      // Pinned renderer 1.3.0 appends exactly one root per slide node, after master/layout roots.
      const elements = Array.from(element.children).slice(-slide.nodes.length)
      const mapped = slide.nodes.flatMap((node, nodeIndex): TextAnchor[] => {
        const body = node.source.child('txBody')
        if (
          node.nodeType !== 'shape' ||
          !body.exists() ||
          slide.nodes.filter((other) => other.name === node.name).length !== 1
        )
          return []
        const target = elements[nodeIndex]
        if (!(target instanceof HTMLElement)) return []
        const paragraphs = body.children('p').map((paragraph) =>
          paragraph
            .allChildren()
            .map((run) => {
              if (run.localName === 'br') return '\v'
              return run.localName === 'r' || run.localName === 'fld' ? run.child('t').text() : ''
            })
            .join('')
        )
        const text = paragraphs.join('\n')
        target.dataset.previewShape = node.name
        return [
          {
            element: target,
            ignored: slideMarkers(target, paragraphs),
            text,
            locator: { kind: 'impress', slide: index + 1, shape: node.name },
          },
        ]
      })
      anchors.set(index, mapped)
    },
  })
  try {
    await viewer.open(diagramPreview(await mediaPreview(bytes)), {
      listOptions: { windowed: true },
      lazyMedia: true,
    })
  } catch (error) {
    viewer.destroy()
    throw error
  }
  let previous = ''
  let current = -1
  let searchGeneration = 0
  return {
    anchors: () => Array.from(anchors.values()).flat(),
    search: async (query, step) => {
      const generation = ++searchGeneration
      viewer.clearSearchHighlights()
      const matches = query ? viewer.searchText(query) : []
      current =
        query !== previous || step === 0 ? 0 : (current + step + matches.length) % matches.length
      previous = query
      if (matches[current]) {
        const highlight = await viewer.highlightSearchResult(matches[current])
        if (generation !== searchGeneration) highlight?.dispose()
      }
      return { current: matches.length ? current + 1 : 0, total: matches.length }
    },
    zoom: (percent) => viewer.setZoom(percent),
    pages: () => ({ current: viewer.currentSlideIndex + 1, total: viewer.slideCount }),
    navigate: (step) =>
      viewer.goToSlide(
        Math.max(0, Math.min(viewer.slideCount - 1, viewer.currentSlideIndex + step))
      ),
    dispose: () => {
      searchGeneration++
      viewer.destroy()
    },
  }
}

export const DOCUMENT_READERS = { docx: mountWord, pptx: mountSlides }
