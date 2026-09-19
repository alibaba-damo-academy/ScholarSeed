import assert from 'node:assert/strict'
import test from 'node:test'

import { feedbackImageRoom, mergeFeedbackImages, toScreenshotFile } from './attachments.ts'

function png(name: string, byte: number): File {
  return new File([new Uint8Array([byte]).buffer], name, { type: 'image/png' })
}

test('toScreenshotFile 拷贝字节并产出带时间戳的 png File', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const file = toScreenshotFile(bytes, 1_700_000_000_000)
  assert.equal(file.name, 'feedback-screenshot-1700000000000.png')
  assert.equal(file.type, 'image/png')
  assert.equal(file.size, 4)
  // 拷贝语义：构造后改源字节，不应污染已生成的 File。
  bytes[0] = 99
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [1, 2, 3, 4])
})

test('feedbackImageRoom 为自动截图保留一个名额', () => {
  assert.equal(feedbackImageRoom(0, false, 5), 5)
  assert.equal(feedbackImageRoom(0, true, 5), 4)
  assert.equal(feedbackImageRoom(4, true, 5), 0)
  assert.equal(feedbackImageRoom(4, false, 5), 1)
  assert.equal(feedbackImageRoom(5, false, 5), 0)
})

test('mergeFeedbackImages 有自动截图时排在首位', () => {
  const auto = png('auto.png', 1)
  const manual = png('manual.png', 2)
  assert.deepEqual(mergeFeedbackImages(auto, [manual]).map((f) => f.name), ['auto.png', 'manual.png'])
  assert.deepEqual(mergeFeedbackImages(null, [manual]).map((f) => f.name), ['manual.png'])
  assert.deepEqual(mergeFeedbackImages(null, []).map((f) => f.name), [])
})
