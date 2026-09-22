const OFFSET_WIDTH = 10
const START_FRAGMENT_MARKER = '<!--StartFragment-->'
const END_FRAGMENT_MARKER = '<!--EndFragment-->'

type CfHtmlOffsetName = 'StartHTML' | 'EndHTML' | 'StartFragment' | 'EndFragment'

export interface ParsedCfHtml {
  fragment: string
  fragmentByteLength: number
  fragmentImageCount: number
  headerLineEnding: '\n' | '\r\n'
  html: string
  offsets: Record<CfHtmlOffsetName, number>
}

function formatOffset(offset: number): string {
  return offset.toString().padStart(OFFSET_WIDTH, '0')
}

function byteOffset(source: string, characterOffset: number): number {
  return Buffer.byteLength(source.slice(0, characterOffset), 'utf8')
}

function readOffset(header: string, name: CfHtmlOffsetName): number {
  const match = header.match(new RegExp(`^${name}:(\\d+)\\r?$`, 'm'))
  if (!match) throw new Error(`CF_HTML is missing ${name}`)
  return Number.parseInt(match[1], 10)
}

export function createCfHtmlFixture(fragment: string, lineEnding: '\n' | '\r\n'): string {
  const html = `<html><body>${START_FRAGMENT_MARKER}${fragment}${END_FRAGMENT_MARKER}</body></html>`
  const placeholder = '0'.repeat(OFFSET_WIDTH)
  const headerTemplate = [
    'Version:1.0',
    `StartHTML:${placeholder}`,
    `EndHTML:${placeholder}`,
    `StartFragment:${placeholder}`,
    `EndFragment:${placeholder}`,
    ''
  ].join(lineEnding)
  const startHtml = Buffer.byteLength(headerTemplate, 'utf8')
  const combined = `${headerTemplate}${html}`
  const fragmentStartCharacter = combined.indexOf(START_FRAGMENT_MARKER) + START_FRAGMENT_MARKER.length
  const fragmentEndCharacter = combined.indexOf(END_FRAGMENT_MARKER)
  const offsets: Record<CfHtmlOffsetName, number> = {
    StartHTML: startHtml,
    EndHTML: Buffer.byteLength(combined, 'utf8'),
    StartFragment: byteOffset(combined, fragmentStartCharacter),
    EndFragment: byteOffset(combined, fragmentEndCharacter)
  }

  return headerTemplate
    .replace(`StartHTML:${placeholder}`, `StartHTML:${formatOffset(offsets.StartHTML)}`)
    .replace(`EndHTML:${placeholder}`, `EndHTML:${formatOffset(offsets.EndHTML)}`)
    .replace(`StartFragment:${placeholder}`, `StartFragment:${formatOffset(offsets.StartFragment)}`)
    .replace(`EndFragment:${placeholder}`, `EndFragment:${formatOffset(offsets.EndFragment)}`) + html
}

export function parseCfHtml(raw: string): ParsedCfHtml {
  const headerBoundary = raw.search(/<html[\s>]/i)
  if (headerBoundary < 0) throw new Error('CF_HTML is missing an HTML document')
  const header = raw.slice(0, headerBoundary)
  const offsets: Record<CfHtmlOffsetName, number> = {
    StartHTML: readOffset(header, 'StartHTML'),
    EndHTML: readOffset(header, 'EndHTML'),
    StartFragment: readOffset(header, 'StartFragment'),
    EndFragment: readOffset(header, 'EndFragment')
  }
  const bytes = Buffer.from(raw, 'utf8')
  if (!(offsets.StartHTML <= offsets.StartFragment && offsets.StartFragment <= offsets.EndFragment && offsets.EndFragment <= offsets.EndHTML && offsets.EndHTML <= bytes.length)) {
    throw new Error('CF_HTML byte offsets are out of order or exceed the payload')
  }
  const html = bytes.subarray(offsets.StartHTML, offsets.EndHTML).toString('utf8')
  const fragmentBytes = bytes.subarray(offsets.StartFragment, offsets.EndFragment)
  const fragment = fragmentBytes.toString('utf8')
  if (!Buffer.from(fragment, 'utf8').equals(fragmentBytes)) {
    throw new Error('CF_HTML fragment offsets split a UTF-8 character')
  }

  return {
    fragment,
    fragmentByteLength: fragmentBytes.length,
    fragmentImageCount: (fragment.match(/<img\b/gi) ?? []).length,
    headerLineEnding: header.includes('\r\n') ? '\r\n' : '\n',
    html,
    offsets
  }
}
