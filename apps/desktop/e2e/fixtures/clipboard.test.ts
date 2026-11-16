import assert from 'node:assert/strict'
import test from 'node:test'

import { createCfHtmlFixture, parseCfHtml } from './cf-html.ts'

test('CF_HTML parser validates UTF-8 byte offsets, line endings, and image counts', () => {
  for (const lineEnding of ['\n', '\r\n'] as const) {
    for (const imageCount of [0, 1, 2]) {
      const images = Array.from({ length: imageCount }, (_, index) => `<img src="data:image/png;base64,image-${index}" alt="截图 ${index + 1}">`).join('')
      const fragment = `<section><h1>反馈报告 😀</h1><p>中文正文</p>${images}</section>`
      const raw = createCfHtmlFixture(fragment, lineEnding)
      const parsed = parseCfHtml(raw)

      assert.equal(parsed.fragment, fragment)
      assert.equal(parsed.fragmentByteLength, Buffer.byteLength(fragment, 'utf8'))
      assert.equal(parsed.fragmentImageCount, imageCount)
      assert.equal(parsed.headerLineEnding, lineEnding)
    }
  }

  const unicodePayload = createCfHtmlFixture('<p>😀</p>', '\r\n')
  const unicodeOffsets = parseCfHtml(unicodePayload).offsets
  const splitEmojiOffset = unicodeOffsets.StartFragment + Buffer.byteLength('<p>', 'utf8') + 1
  const malformedPayload = unicodePayload.replace(
    `EndFragment:${unicodeOffsets.EndFragment.toString().padStart(10, '0')}`,
    `EndFragment:${splitEmojiOffset.toString().padStart(10, '0')}`
  )
  assert.throws(() => parseCfHtml(malformedPayload), { message: 'CF_HTML fragment offsets split a UTF-8 character' })
})
