import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { TFunction } from 'i18next'
import { isOfficeFrameToken, resolveOfficeFrame, type OfficeFrameRequest } from './transport.ts'

const request: OfficeFrameRequest = {
  translation: (() => '') as unknown as TFunction<'workbench'>,
  language: 'zh',
  locale: 'zh-CN',
}

test('Office transport preserves the lazy default source-document factory without preview dependencies', () => {
  const token = randomUUID()
  const result = resolveOfficeFrame(null, request, (received) => {
    assert.equal(received, request)
    return { kind: 'srcdoc', token, html: '<!doctype html>', dispose() {} }
  })
  assert.deepEqual(result.kind, 'srcdoc')
  assert.equal(result.token, token)
})

test('an injected typed URL transport does not allocate the default HTML or change request data', () => {
  const token = randomUUID()
  const frame = { kind: 'url' as const, token, src: '/fixed-frame', dispose() {} }
  const result = resolveOfficeFrame(
    (received) => {
      assert.equal(received, request)
      return frame
    },
    request,
    () => {
      throw new Error('Default factory must remain unallocated')
    }
  )
  assert.equal(result, frame)
})

test('invalid Office transport tokens fail closed and dispose the allocated frame', () => {
  let disposals = 0
  assert.throws(
    () =>
      resolveOfficeFrame(
        () => ({
          kind: 'url',
          token: 'not-a-token',
          src: '/fixed-frame',
          dispose() {
            disposals++
          },
        }),
        request,
        () => {
          throw new Error('unused')
        }
      ),
    /Invalid Office frame token/
  )
  assert.equal(disposals, 1)
  assert.equal(isOfficeFrameToken(randomUUID()), true)
  for (const token of [
    '',
    'null',
    randomUUID() + '<script>',
    '00000000-0000-0000-0000-000000000000',
  ])
    assert.equal(isOfficeFrameToken(token), false)
})
