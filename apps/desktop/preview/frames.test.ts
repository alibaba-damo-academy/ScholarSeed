import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PREVIEW_OFFICE_FRAME_PATH, attachPreviewOfficeCleanup, previewOfficeFrameParameters, previewOfficeFrameUrl } from './frames.ts'

test('the preview Office transport has one fixed route with only a UUID token and supported locale', () => {
  for (const locale of ['zh', 'en'] as const) {
    const parameters = { token: randomUUID(), locale }
    const url = previewOfficeFrameUrl('http://localhost:4900', parameters)
    assert.equal(url.pathname, PREVIEW_OFFICE_FRAME_PATH)
    assert.equal(url.origin, 'http://localhost:4900')
    assert.deepEqual(previewOfficeFrameParameters(url), parameters)
  }
})

test('child frame disposal accepts only its own parent and token, detaches listeners and revokes once', () => {
  const target = Object.assign(new EventTarget(), { location: { origin: 'http://localhost:4900' } })
  const parentWindow = {} as Window
  const token = randomUUID()
  let disposals = 0
  const close = attachPreviewOfficeCleanup(target as unknown as Window, parentWindow, token, () => { disposals++ })
  const send = (source: unknown, origin: string, data: unknown): void => {
    const event = new Event('message')
    Object.assign(event, { source, origin, data })
    target.dispatchEvent(event)
  }
  const valid = { kind: 'scholarseed-office-control', token, type: 'dispose' }
  send({}, target.location.origin, valid)
  send(parentWindow, 'http://example.com', valid)
  send(parentWindow, target.location.origin, { ...valid, token: randomUUID() })
  send(parentWindow, target.location.origin, { ...valid, type: 'prepare' })
  assert.equal(disposals, 0)
  send(parentWindow, target.location.origin, valid)
  close()
  target.dispatchEvent(new Event('pagehide'))
  assert.equal(disposals, 1)
})

test('pagehide releases child-owned blob resources even without a parent dispose message', () => {
  const target = Object.assign(new EventTarget(), { location: { origin: 'http://localhost:4900' } })
  let disposals = 0
  attachPreviewOfficeCleanup(target as unknown as Window, {} as Window, randomUUID(), () => { disposals++ })
  target.dispatchEvent(new Event('pagehide'))
  target.dispatchEvent(new Event('pagehide'))
  assert.equal(disposals, 1)
})

test('preview Office parameters reject unknown, repeated, missing, malformed and executable inputs', () => {
  const valid = previewOfficeFrameUrl('http://localhost:4900', { token: randomUUID(), locale: 'zh' })
  for (const mutate of [
    (url: URL) => url.searchParams.set('html', '<script>alert(1)</script>'),
    (url: URL) => url.searchParams.append('token', randomUUID()),
    (url: URL) => url.searchParams.set('token', 'not-a-token'),
    (url: URL) => url.searchParams.delete('token'),
    (url: URL) => url.searchParams.set('locale', 'zh-CN'),
    (url: URL) => { url.pathname += '/other' },
    (url: URL) => { url.hash = 'script' },
  ]) {
    const url = new URL(valid)
    mutate(url)
    assert.throws(() => previewOfficeFrameParameters(url), /Invalid preview Office frame request/)
  }
})
