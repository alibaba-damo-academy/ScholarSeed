import assert from 'node:assert/strict'
import test from 'node:test'

import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api'

import { PdfFonts } from './fonts.ts'

test('PDF text stream uses the text layer language when PDF metadata omits it', async () => {
  const content = { items: [], styles: {}, lang: null } as TextContent
  const page = { getTextContent: async () => content } as unknown as PDFPageProxy
  const fonts = new PdfFonts()

  const chinese = await fonts.textPage(page, 'zh-CN').streamTextContent().getReader().read()
  const english = await fonts.textPage(page, 'en-US').streamTextContent().getReader().read()

  assert.equal(chinese.value?.lang, 'zh-CN')
  assert.equal(english.value?.lang, 'en-US')
  assert.equal(content.lang, null)
})

test('PDF text stream preserves explicit document language', async () => {
  const content = { items: [], styles: {}, lang: 'fr-FR' } as TextContent
  const page = { getTextContent: async () => content } as unknown as PDFPageProxy
  const fonts = new PdfFonts()

  const result = await fonts.textPage(page, 'zh-CN').streamTextContent().getReader().read()

  assert.equal(result.value?.lang, 'fr-FR')
})
