import type { Link, Parent, Root, Text } from 'mdast'
import remarkGfm, { type Options as RemarkGfmOptions } from 'remark-gfm'
import type { Plugin } from 'unified'

const BARE_URL_PREFIX = /^(?:https?:\/\/|www\.)/i
const BARE_URL_BOUNDARY = /[）。，]/u
const BARE_URL_CITATION = /\[(?=[0-9]+(?:\](?![\w=/?#-])|$))/u
const BARE_URL_CITATION_LOOKAHEAD = 2
const WWW_URL_PREFIX = 'http://'

function splitBareUrl(node: Link, source: string): [Link, Text] | null {
  const label = node.children[0]
  const position = node.position
  const start = position?.start.offset
  const end = position?.end.offset
  if (
    node.children.length !== 1 ||
    label?.type !== 'text' ||
    !position ||
    start === undefined ||
    end === undefined ||
    !BARE_URL_PREFIX.test(source.slice(start, end)) ||
    source.slice(start, end) !== label.value ||
    (node.url !== label.value && node.url !== WWW_URL_PREFIX + label.value)
  )
    return null
  const boundaries = [
    label.value.search(BARE_URL_BOUNDARY),
    source.slice(start, end + BARE_URL_CITATION_LOOKAHEAD).search(BARE_URL_CITATION),
  ].filter((boundary) => boundary >= 0 && boundary < label.value.length)
  if (!boundaries.length) return null
  const boundary = Math.min(...boundaries)
  const point = {
    line: position.start.line,
    column: position.start.column + boundary,
    offset: start + boundary,
  }
  const value = label.value.slice(0, boundary)
  return [
    {
      ...node,
      url: node.url.slice(0, node.url.length - label.value.length) + value,
      children: [{ ...label, value, position: { start: position.start, end: point } }],
      position: { start: position.start, end: point },
    },
    {
      type: 'text',
      value: label.value.slice(boundary),
      position: { start: point, end: position.end },
    },
  ]
}

const remarkScholarSeedGfm: Plugin<[RemarkGfmOptions], Root> = function (options) {
  remarkGfm.call(this, options)
  return (tree, file): void => {
    const source = String(file)
    const visit = (parent: Parent): void => {
      parent.children = parent.children.flatMap((node) => {
        const split = node.type === 'link' ? splitBareUrl(node, source) : null
        if (split) return split
        if ('children' in node) visit(node)
        return [node]
      })
    }
    visit(tree)
  }
}

export const GFM_OPTIONS: RemarkGfmOptions = { singleTilde: false }
export const GFM_PLUGIN: [typeof remarkScholarSeedGfm, RemarkGfmOptions] = [
  remarkScholarSeedGfm,
  GFM_OPTIONS,
]
