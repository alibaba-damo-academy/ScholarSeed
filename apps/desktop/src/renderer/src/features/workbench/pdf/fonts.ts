import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api'

const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_FONT_PATH = 'fonts/NotoSansCJKsc-Regular.otf'

type SubstitutionStyle = TextContent['styles'][string] & {
  fontSubstitution?: unknown
  fontSubstitutionLoadedName?: unknown
}

/** Document-owned font faces: never install OS fonts or mutate PDF.js objects. */
export class PdfFonts {
  private faces = new Map<string, Promise<FontFace>>()
  private content = new WeakMap<PDFPageProxy, Promise<TextContent>>()
  private disposed = false

  /** PDF.js viewer owns selection handling; supply its text stream with prepared fonts. */
  textPage(page: PDFPageProxy): PDFPageProxy {
    return new Proxy(page, {
      get: (target, property, receiver) => property === 'streamTextContent'
        ? () => new ReadableStream<TextContent>({
          start: async controller => {
            try { controller.enqueue(await this.prepare(page)); controller.close() }
            catch (error) { controller.error(error) }
          }
        })
        : Reflect.get(target, property, receiver)
    })
  }

  prepare(page: PDFPageProxy): Promise<TextContent> {
    let pending = this.content.get(page)
    if (!pending) {
      pending = this.load(page)
      this.content.set(page, pending)
    }
    return pending
  }

  private async load(page: PDFPageProxy): Promise<TextContent> {
    const content = await page.getTextContent()
    const styles = { ...content.styles }
    const names = new Set(content.items.flatMap(item => 'str' in item && CJK_TEXT.test(item.str) ? [item.fontName] : []))
    for (const name of names) {
      const style: SubstitutionStyle = styles[name]
      // Only PDF.js system-substitution fonts qualify; embedded fonts stay intact.
      if (typeof style?.fontSubstitutionLoadedName !== 'string' || typeof style.fontSubstitution !== 'string') continue
      const family = style.fontSubstitutionLoadedName
      let pending = this.faces.get(family)
      if (!pending) {
        const url = new URL(CJK_FONT_PATH, document.baseURI).href
        const face = new FontFace(family, `url(${JSON.stringify(url)})`)
        pending = face.load().then(loaded => {
          if (!this.disposed) document.fonts.add(loaded)
          return loaded
        })
        this.faces.set(family, pending)
      }
      await pending
      styles[name] = { ...style, fontFamily: style.fontSubstitution }
    }
    return { ...content, styles }
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.faces.values()) void pending.then(face => document.fonts.delete(face), () => undefined)
    this.faces.clear()
  }
}
