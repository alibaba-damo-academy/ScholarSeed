// Vite bundles the installed PDF.js resources into local assets, including the
// CMaps required by non-embedded CJK fonts. No CDN or user network is involved.
const CMAPS = import.meta.glob<string>('../../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url', import: 'default' })
const FONTS = import.meta.glob<string>('../../../../../../node_modules/pdfjs-dist/standard_fonts/*.{ttf,pfb}', { eager: true, query: '?url', import: 'default' })
const WASM = import.meta.glob<string>('../../../../../../node_modules/pdfjs-dist/wasm/*.wasm', { eager: true, query: '?url', import: 'default' })

const resources: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries({ cMapUrl: CMAPS, standardFontDataUrl: FONTS, wasmUrl: WASM }).map(([kind, files]) => [
    kind, Object.fromEntries(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]))
  ])
)

export class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = resources[kind]?.[filename]
    if (!url) throw new Error(`PDF resource unavailable: ${kind}/${filename}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`PDF resource load failed: ${kind}/${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
