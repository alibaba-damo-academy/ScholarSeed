const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])
const CARRIAGE_RETURN = 0x0d
const LINE_FEED = 0x0a
const UTF8 = new TextEncoder()

export type EndOfLine = 'cr' | 'crlf' | 'lf'

export function endOfLineFor(bytes: Uint8Array): EndOfLine {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === CARRIAGE_RETURN) {
      return bytes[index + 1] === LINE_FEED ? 'crlf' : 'cr'
    }
    if (bytes[index] === LINE_FEED) return 'lf'
  }
  return 'lf'
}

function lineBreakFor(endOfLine: EndOfLine): string {
  if (endOfLine === 'crlf') return '\r\n'
  if (endOfLine === 'cr') return '\r'
  return '\n'
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((value, index) => bytes[index] === value)
}

export function textForMonaco(text: string): string {
  return text.replace(/\r\n?|\n/gu, '\n')
}

export function encodeTextForSave(text: string, savedBytes: Uint8Array): Uint8Array {
  const lineBreak = lineBreakFor(endOfLineFor(savedBytes))
  const encoded = UTF8.encode(textForMonaco(text).replace(/\n/gu, lineBreak))
  if (!hasUtf8Bom(savedBytes)) return encoded
  const bytes = new Uint8Array(UTF8_BOM.byteLength + encoded.byteLength)
  bytes.set(UTF8_BOM)
  bytes.set(encoded, UTF8_BOM.byteLength)
  return bytes
}
